# Scheduling: agents that fire on a clock, and the cloud they force

```bash
yeet schedule --name deps --every "daily at 4pm" "update dependencies; keep the tests green"
```

Cloud-only is definitional, not a business choice: a scheduler that needs your laptop awake is
launchd with extra steps. Which makes this the first feature that cannot exist without yeet's
cloud existing — so this doc is half feature design, half a forcing function on the decisions
data.md and secrets.md deliberately left open. Identity stops being hypothetical here.

Four decisions are taken as settled below, argued in place: a fire runs a **fresh session on a
persistent agent**; the result is **delivered as a notification, never auto-pushed**; tokens
burn on the **user's own provider key** (BYOK); and the runner speaks **--agent mode** to an
empty room.

## The shape

A schedule is four things: **which agent** (`agentId` — names rename, schedules must survive
that), **a standing prompt**, **a cadence**, and **a budget**. One schedule per agent: two
cadences is two agents, and `pause`/`rm` never need a second identifier. If that ever feels
cramped it can grow ids later; the reverse migration is the painful one.

```bash
yeet schedule --name deps --every "daily at 4pm" "update deps; keep tests green"
yeet schedule ls                      every schedule, next fire, last outcome, month spend
yeet schedule pause --name deps       stops firing; keeps the schedule
yeet schedule resume --name deps
yeet schedule rm --name deps
yeet schedule run --name deps         fire NOW, attended, at your terminal — the test run
```

The cadence rides a flag, not a bare word — a deliberate deviation from the first sketch
(`yeet schedule "daily at 4pm"`). The parser's one rule is that bare words are task text and
flags cannot be ambiguous; a positional spec next to a positional prompt is exactly the
guessing the parser rewrite killed. So: bare words remain the (standing) prompt, `--every`
carries the when.

`schedule` joins `ls`/`ask`/`config`/`rm` as a first-word verb. `yeet schedule run` does not
collide with the proposed `yeet run <agent>` from networking.md — different first word.

## What a fire is

At the scheduled instant the cloud controller materializes the agent (the four resume steps in
data.md), opens a **new session file**, and runs the ordinary loop with the standing prompt —
in `--agent` semantics: recommendations auto-accepted, `approvedBy:"auto"` on anything bound,
per-fire budget = the agent's `maxCostUsd`, enforced live as always.

Fresh-session-per-fire is the only shape that survives a calendar. Resuming one conversation
daily grows the transcript without bound and the per-fire cost with it; a disposable agent per
fire litters `yeet ls` and abandons the continuing workspace. The agent keeps its branch,
verify contract, and event history; it just doesn't remember Tuesday's conversation on
Wednesday. Anything worth remembering is in the code, the events, or `yeet ask`.

The schedule itself is agent state, so it lives in the event log and syncs for free:

| kind | means |
|---|---|
| `schedule_set` | cadence + standing prompt + caps bound (create and update; last wins) |
| `schedule_paused` | by user, or by the monthly cap — `reason` says which |
| `schedule_resumed` | firing again |
| `schedule_removed` | gone |
| `fire` | a fire began: trigger (`cron` \| `manual`), `scheduledFor`, new session file |
| `fire_skipped` | a fire that should have happened and didn't — `reason:"overlap"` |

```json
{"id":"01JN6…","at":"2026-07-26T20:00:04.101Z","kind":"schedule_set",
 "every":"daily at 4pm","cron":"0 16 * * *","tz":"America/New_York",
 "prompt":"update deps; keep tests green","monthlyCapUsd":25,"setBy":"user"}
```

```json
{"id":"01JN7…","at":"2026-07-27T20:00:00.412Z","kind":"fire","trigger":"cron",
 "scheduledFor":"2026-07-27T20:00:00.000Z",
 "session":{"program":"pi","file":"session/2026-07-27T20-00-00-412Z_02af1c88.jsonl"}}
```

Inside the fire, everything downstream is ordinary events — `prompt`, `iteration`,
`verify_run`, `status` — so `ask`, cost totals, and the fold change nothing. `prompt.from`
grows a third value, `"schedule"`, because "who asked for this" is the one thing you cannot
reconstruct later.

A `fire` that should happen while the previous fire is still running is **skipped and
recorded**, never queued (a backlog of stale fires is never what you meant) and never a reason
to kill the running one (it is doing the same job). The skip shows up in the next notification.

## Time

The spec is parsed by a **small deterministic grammar, not a model**. A schedule silently
misparsed fires wrong for months; this is the same reasoning as "a typo must not become task
text". Accepted: `daily at 4pm` · `weekdays at 9:30am` · `mondays at 4pm` · `every 6 hours` ·
`hourly` · raw cron (`0 16 * * *`). Everything else is a hard error listing those forms.

Creation echoes the resolution back and waits for Enter, the same interaction grammar as a
verify proposal:

```
0 16 * * *, America/New_York — next: today 4:00pm, tomorrow 4:00pm, Wed 4:00pm
```

Stored: wall-clock + the IANA timezone captured from the creating machine, evaluated in that
zone. Storing UTC is the bug — "daily at 4pm" that drifts an hour twice a year is wrong by
every human definition of *daily at 4pm*. One-shots (`--every "tomorrow at 4pm"`) are deferred;
they are a different feature (run-later) wearing the same flag.

## Unattended, on purpose

Nobody is at the terminal at 4pm, and the run must not pretend otherwise. The `--agent`
machinery already models an empty room: questions take their own recommendation, verify
proposals bind with `approvedBy:"auto"`, and the trail records that nobody was there.

The soft spot is a schedule on an agent that has **never run attended**: its first fire would
propose a verify contract to the empty room and approve it itself — the "suite proves what the
agent chose to prove" trap, unattended. So `yeet schedule` **warns when the agent has no
`verify_set` yet** and points at `yeet schedule run` — fire once, attended, answer its
questions, bind the contract — before trusting the cron. A warning, not a refusal: refusing
would make cloud-born agents impossible to schedule.

Money gets a second wall. `maxCostUsd` already caps one fire, live; `monthlyCapUsd` (default
$25, `--max-monthly` to change) caps the calendar. Crossing it pauses the schedule
(`schedule_paused`, `reason:"monthly_cap"`) and notifies; the schedule resumes at month
rollover, with a notification, so a runaway is loud monthly rather than silent forever. The
$1.15 overrun bought the per-fire watchdog; the multiplication by 30 is what this one is for.

## Delivery

Every fire ends in a **notification**: status, the plain-English summary the agent left
behind, cost, and the command that shows the rest (`yeet ask --name deps`). Failures and
stalls are the loud ones — the 4am stall is the notification the feature exists for. Email
first (identity brings a verified address for free, below); push later. Notifications speak
VOICE.md's pleb voice — they are yeet talking, not a pager.

No auto-push, no auto-PR. That would put git write-credentials in the cloud and spend trust
the README explicitly refuses to extend — an unattended green proves what the agent chose to
prove. The work waits on its branch; merging stays a human act, which is what `yeet merge` is
for. When someone wants PRs badly enough, it can be a per-agent opt-in with its own doc.

## The cloud it forces

Everything data.md postponed, in dependency order — and one thing it never needed before:

- **Identity: GitHub device flow** (`yeet cloud login`). The same mechanism Juice uses, which
  collapses secrets.md's open identity question: one namespace, reconciliation becomes a
  non-event. It also yields a verified email, which is the notification channel.
- **Event sync**: `append` / `since` against Postgres — "the whole cloud port is two methods."
  The scheduler folds schedule state from the same log everyone else reads.
- **A git remote the cloud can reach.** Code moves over git (data.md), so a fire needs a
  fetchable branch: the user's `origin` when set (read token stored as an agent secret), else
  a yeet-internal bare repo per agent — which materialization needs anyway, so it is substrate,
  not a special case.
- **Secrets, BYOK**: `yeet cloud key openrouter` — hidden prompt, TLS in, KMS-encrypted
  per-user row. The laptop store never syncs; data.md's "secrets: nowhere" rule survives
  because this is a *second store behind the same interface* (`src/secrets.ts` already assumes
  swappable backends), not replication. Agent secrets get the same per-agent scope; the
  injection point is unchanged — `run.env`, rewritten every iteration.
- **The runner**: Graviton, KVM, the identical arm64 image — data.md's "the runner does not
  know where it is", now made to prove it. The controller is bridge.ts's logic as a worker; the
  scheduler is a boring loop over next-fire times in Postgres. No Temporal, no EventBridge; a
  single process scanning a table is enough until it measurably isn't, and `fire` events make
  retries idempotent.
- **Egress, no longer deferrable.** An unattended agent with secrets in env and unrestricted
  outbound (networking.md's security note) is a worse proposition than the same agent with a
  human watching. The cloud runner should land with the explicit `port_map` and egress
  filtering that note describes — narrowing both directions at once.

Remote fires are auto-mode even when triggered by `schedule run` against a cloud agent; live
relay of questions from a cloud VM to your terminal is a control-channel project (vsock,
networking.md) and explicitly not part of this.

## Anatomy of a fire, v0

Three durable things, two processes, and everything else disposable. Durable: **Postgres**
(events, folds — including each schedule's precomputed `next_fire_at` in its own timezone —
accounts, KMS-wrapped secrets), **a bare git repo per agent** (the branch's home between
fires; a user's `origin` is fetched *from*, never lived *in*), and later **S3** for large
session blobs, per data.md. Runners own nothing.

- **control** — the API the CLI talks to (`append`/`since`, login, keys) plus the clock:
  a few-second tick of `SELECT … WHERE next_fire_at <= now() FOR UPDATE SKIP LOCKED`.
  Claiming a row appends the `fire` event and computes the next instant. The scheduler is
  a table scan.
- **runner** — picks up the claim, then data.md's four resume steps: replay events to state,
  clone the bare repo at the checkpoint commit, reconstruct the agent directory, export
  secrets to `run.env` — and runs the same per-iteration microVM loop a laptop runs,
  appending events as they happen. End of fire: push the branch back, final `status` event,
  email.

A fire is **at-most-once**. The `fire` event is the claim; runners heartbeat a lease, and a
lease that dies mid-fire gets a status event and a notification, never a rerun — half a
coding run is committed work and spent money, and the next fire resumes from the checkpoint
anyway. Under load fires start late rather than skip (everyone picks 4pm and 9am; the herd
is real); `at` minus `scheduledFor` is the honest record of by how much.

**The hardware constraint.** libkrun on Linux needs `/dev/kvm`, and no major cloud exposes
KVM inside a virtualized ARM instance — not EC2 Graviton VMs, not GCP's T2A, not Azure's
Ampere line. ARM plus KVM means **bare metal**:

| box | what | rough cost | note |
|---|---|---|---|
| c7g.metal | 64-vCPU Graviton3 | ~$2.3/hr | AWS-native: SES, SM task role, RDS next door |
| a1.metal | 16-vCPU Graviton1 | ~$0.4/hr | the cheap AWS toe-dip; old silicon |
| Hetzner RX | 80-core Ampere | ~€170/mo | ~10× cheaper; AWS conveniences become API keys |
| EC2 mac2.metal | M2 mini | ~$0.65/hr, 24h min | runs the macOS stack unchanged, APFS and all |

The Linux port is honest but small: recompile the launcher without the codesign dance,
XFS/Btrfs `cp --reflink` standing in for `clonefile(2)` (same copy-on-write, xattrs
preserved, so the virtio-fs mode trick survives), virtiofsd on home turf. Guest image,
yeet-run, the pi extension: byte-identical. data.md's "the runner does not know where it
is," now with a purchase order.

Tenancy: tenant code only ever executes inside a KVM guest; the host side is per-user
directories and per-user KMS rows. Iterations are mostly token-waiting, so one box runs
tens of concurrent fires — at three schedules per alpha user, one machine is capacity for
a long while. v0 is literally one box running control + runner, Postgres beside them.

## Paid

BYOK means yeet charges for scheduling and compute, not tokens — no resale, no margin
accounting, no abuse desk on day one. Eventually: a flat subscription for N schedules;
metering by fire-minutes is fairer and can wait until someone is unfair. Until billing exists,
the gate is an allowlisted account with hard caps: 3 schedules, 24 fires/day, the $25 monthly
default. "Paid, eventually" without invoicing anyone yet.

## Build order

1. **Schedule events + fold + the whole CLI, local.** `schedule run` fires attended on the
   laptop today; `ls` shows `next: — (no cloud)`. The grammar, the echo, the events, the warn
   path all get real before any infra exists.
2. **Identity + event sync.** Device flow; append/since on Postgres.
3. **Cloud secret store.** Provider key + agent scopes; `run.env` unchanged.
4. **The runner.** Materialize and fire on Graviton, manually triggered, auto-mode.
5. **The clock + notifications.** The loop over next-fire times; email. 4pm happens.
6. **Billing.** Last, honestly.

Steps 1 is useful standalone (a standing prompt you fire by hand is a feature by itself);
steps 2–4 are the cloud substrate everything else in data.md's future also wants.

## Open decisions

- **`--every` as a flag** deviates from the original sketch's positional spec — kept the
  parser's "flags cannot be ambiguous" rule instead. Cheap to flip before anything ships.
- **$25 monthly default and auto-resume at rollover** — both numbers are vibes; the shape
  (pause + notify + loud resume) is the load-bearing part.
- **Email as the only v1 channel.** Push (APNs/ntfy) is a later nicety.
- **`yeet cloud` as the namespace** for `login`/`key`, vs folding into `yeet config`. Taken
  here because login and secrets are about the *account*, and config.ts is explicit that
  config is about the human's rendering preferences.
- **One-shots** (`run-later`) — same grammar slot, different lifecycle; deliberately out.
- **Which metal.** c7g.metal keeps secrets.md's task-role story intact; Hetzner is an order
  of magnitude cheaper and turns those conveniences into API keys; mac2.metal skips the
  Linux port entirely. The software doesn't care where it runs — that was the whole point —
  so this is a money-and-ops call, not an architecture one.
