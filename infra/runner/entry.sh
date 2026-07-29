#!/bin/bash
#
# entry.sh — one cloud iteration: hydrate from S3, run yeet-run, sync back, exit.
#
# The exit is the shutdown. A Fargate task that returns from PID 1 stops and stops billing,
# so "shut down after the run" is not a feature anyone has to build — `yeet cloud stop` only
# exists for killing a run that is still going.
#
# This script is the cloud twin of what src/loop.ts does host-side before a VM boots: build
# the iteration directory, write request.env (mirroring contract.ts writeRequest — schema
# yeet.request/2), stage the prompt, then hand over to the SAME yeet-run the VM executes.
# yeet-run cannot tell it is in a container, which is the entire design.
set -euo pipefail

: "${YEET_S3_BUCKET:?}"; : "${YEET_AGENT:?}"; : "${YEET_TASK:?}"
YEET_MODEL="${YEET_MODEL:-openrouter/z-ai/glm-5.2}"
PREFIX="s3://${YEET_S3_BUCKET}/agents/${YEET_AGENT}"

log() { printf 'yeet-cloud: %s\n' "$*"; }

# ── lease ────────────────────────────────────────────────────────────────────────────────
# One writer per agent, because flock cannot cross machines. Check-then-put is racy for a
# few hundred milliseconds; acceptable for v1 where the only other writer is the owner's
# laptop, and noted rather than hidden. (S3 conditional writes close the race later.)
if aws s3 cp "${PREFIX}/lease.json" /tmp/lease.json 2>/dev/null; then
  holder=$(grep -o '"host":"[^"]*"' /tmp/lease.json || true)
  log "agent is leased (${holder:-unknown}) — refusing to double-run"; exit 75
fi
printf '{"host":"fargate","at":"%s"}\n' "$(date -u +%FT%TZ)" > /tmp/lease.json
aws s3 cp /tmp/lease.json "${PREFIX}/lease.json" >/dev/null
release() { aws s3 rm "${PREFIX}/lease.json" >/dev/null 2>&1 || true; }
trap release EXIT

# ── hydrate ──────────────────────────────────────────────────────────────────────────────
mkdir -p /yeet/session /yeet/workspace
aws s3 cp "${PREFIX}/agent.json" /yeet/agent.json 2>/dev/null || true
aws s3 cp "${PREFIX}/events.jsonl" /yeet/events.jsonl 2>/dev/null || true
aws s3 sync "${PREFIX}/session/" /yeet/session/ >/dev/null 2>&1 || true

if aws s3 cp "${PREFIX}/workspace.bundle" /tmp/workspace.bundle 2>/dev/null; then
  log "hydrating workspace from bundle"
  git clone --quiet /tmp/workspace.bundle /yeet/workspace
  # The bundle carries the agent branch; land on it if it exists, whatever it is called.
  branch=$(git -C /yeet/workspace for-each-ref --format='%(refname:short)' 'refs/heads/yeet/*' | head -1)
  [ -n "$branch" ] && git -C /yeet/workspace checkout --quiet "$branch"
else
  log "no bundle — fresh workspace, same shape store.create makes locally"
  git -C /yeet/workspace init --quiet
  git -C /yeet/workspace commit --quiet --allow-empty -m "yeet: empty base"
  git -C /yeet/workspace checkout --quiet -b "yeet/${YEET_AGENT}"
fi
BASE_HEAD=$(git -C /yeet/workspace rev-parse HEAD)

# ── the iteration, exactly as the host would stage it ────────────────────────────────────
ITER="cloud-$(date +%s | tail -c 8)"
D="/yeet/${ITER}"
mkdir -p "$D/qa"
printf '%s' "$YEET_TASK" > "$D/prompt.txt"
printf 'yeet: cloud iteration\n' > "$D/commit-msg.txt"
cat > "$D/request.env" <<REQ
YEET_SCHEMA=yeet.request/2
YEET_RUN_ID=${YEET_AGENT}
YEET_ITER=001
YEET_DIR=${D}
YEET_PHASE=agent
YEET_RUN_AGENT=1
YEET_RUN_TEST=0
YEET_WORKSPACE=/yeet/workspace
YEET_MODEL=${YEET_MODEL}
YEET_SESSION_DIR=/yeet/session
YEET_BASE_HEAD=${BASE_HEAD}
REQ
# yeet-run sources this for the provider key; ECS injected it from Secrets Manager.
printf 'export OPENROUTER_API_KEY=%s\n' "${OPENROUTER_API_KEY:?}" > /yeet/run.env
chmod 600 /yeet/run.env

log "running agent ${YEET_AGENT} (${YEET_MODEL})"
YEET_DIR="$D" /usr/local/bin/yeet-run || log "yeet-run exited $? (DONE decides validity)"
[ -f "$D/DONE" ] || { log "no DONE sentinel — infrastructure failure"; exit 1; }

# ── sync back ────────────────────────────────────────────────────────────────────────────
# The bundle is --all: cheap at this scale, and correct even if branches moved. Suffix-only
# shipping is the optimization documented in docs/data.md, not a v1 requirement.
git -C /yeet/workspace bundle create /tmp/workspace.bundle --all --quiet
aws s3 cp /tmp/workspace.bundle "${PREFIX}/workspace.bundle" >/dev/null
aws s3 sync /yeet/session/ "${PREFIX}/session/" >/dev/null
aws s3 sync "$D" "${PREFIX}/${ITER}/" >/dev/null
log "synced — $(grep -c . "$D/meta.kv" 2>/dev/null || echo 0) facts, iteration ${ITER}"
