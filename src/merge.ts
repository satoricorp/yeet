/**
 * merge.ts — combine an agent's branch with the target it was built against.
 *
 * Two rules shape this.
 *
 * **The host fetches; the guest computes nothing it needs credentials for.** The agent's
 * workspace has no git remote by design — it has unrestricted outbound network, so a remote
 * would be a way for an agent to reach something you own. Fetching the target is a host action
 * using host credentials, landing on a local ref the guest can read.
 *
 * **Detect before touching anything.** `git merge-tree --write-tree` performs a full three-way
 * merge against the object store and reports conflicts WITHOUT a worktree, an index, or a
 * checkout. So a conflicted merge costs nothing and leaves nothing to clean up — no half-merged
 * state, no conflict markers in files, no `git merge --abort` to remember.
 *
 * A clean textual merge is not a working merge, which is the whole reason the sandbox is in
 * this path: two changes can merge without a single conflicting line and still break each
 * other. Running the agent's own verify command on the merged tree is what catches that, and
 * it is the one step here that genuinely needs a VM.
 */
import { join } from "node:path";
import * as store from "./agent";

export type MergeResult = "up_to_date" | "clean" | "conflicted" | "no_origin" | "unreachable";

export type MergeReport = {
  agent: string;
  targetBranch: string;
  /** Common ancestor — NOT the head of origin, which is targetCommit. */
  mergeBase: string | null;
  targetCommit: string | null;
  agentCommit: string | null;
  result: MergeResult;
  /** Paths git could not merge on its own. Empty on a clean merge. */
  conflicts: string[];
  /** The merged tree object, written to the store even when conflicted. */
  mergedTree: string | null;
};

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args]);
  return {
    ok: r.exitCode === 0,
    code: r.exitCode,
    out: r.stdout.toString().trim(),
    err: r.stderr.toString().trim(),
  };
};

/** Where the fetched target lives. A private ref namespace, so it never shows up in
 *  `git branch` and cannot be confused for something the user made. */
const TARGET_REF = "refs/yeet/target";

/**
 * Work out whether this agent can merge, without changing anything.
 *
 * Safe to call repeatedly and safe to abandon — the only side effect is fetching objects and
 * moving a private ref.
 */
export function analyze(agent: store.Agent, targetBranch: string): MergeReport {
  const ws = store.workspaceDir(agent.name);
  const base: MergeReport = {
    agent: agent.name,
    targetBranch,
    mergeBase: null,
    targetCommit: null,
    agentCommit: null,
    result: "no_origin",
    conflicts: [],
    mergedTree: null,
  };

  if (!agent.origin) return base;

  // Host-side fetch, host credentials. Forced because the target moves as other agents land.
  const fetched = git(ws, "fetch", "--quiet", "--force", agent.origin, `${targetBranch}:${TARGET_REF}`);
  if (!fetched.ok) return { ...base, result: "unreachable" };

  const target = git(ws, "rev-parse", TARGET_REF);
  const ours = git(ws, "rev-parse", agent.branch);
  if (!target.ok || !ours.ok) return { ...base, result: "unreachable" };

  // The workspace's own `main` is frozen at whatever it was when the clone was made — for a
  // greenfield agent that is an empty base commit. So an agent handed "merge main in and resolve
  // the conflicts" would merge THAT, report success, and have changed nothing: a no-op that
  // looks like a fix. Move the local branch to what was actually fetched, so the obvious command
  // is also the correct one. Skipped if it is checked out, where the ref is not ours to move.
  if (git(ws, "symbolic-ref", "--quiet", "HEAD").out !== `refs/heads/${targetBranch}`) {
    git(ws, "update-ref", `refs/heads/${targetBranch}`, TARGET_REF);
  }

  const report = { ...base, targetCommit: target.out, agentCommit: ours.out };

  // Already contained in the target: nothing to do, and a merge would be an empty commit.
  if (git(ws, "merge-base", "--is-ancestor", ours.out, target.out).ok) {
    return { ...report, result: "up_to_date", mergeBase: target.out };
  }

  const mb = git(ws, "merge-base", target.out, ours.out);
  const merged = git(ws, "merge-tree", "--write-tree", "--name-only", agent.branch, TARGET_REF);

  // merge-tree prints the tree oid on the first line either way; conflicts follow it.
  const lines = merged.out.split("\n");
  const tree = lines[0] || null;

  if (merged.ok) {
    return { ...report, result: "clean", mergeBase: mb.ok ? mb.out : null, mergedTree: tree };
  }
  return {
    ...report,
    result: "conflicted",
    mergeBase: mb.ok ? mb.out : null,
    mergedTree: tree,
    conflicts: lines.slice(1).filter((l) => l.trim() && !l.startsWith("Auto-merging") && !l.startsWith("CONFLICT")),
  };
}

/**
 * Apply a merge that `analyze` already found clean.
 *
 * Merges the target INTO the agent's branch rather than the other way round, so the agent's
 * workspace ends up holding exactly what would be pushed — which is what makes verifying it in
 * a sandbox meaningful. The alternative (merging on a detached temp branch) would verify a
 * state nobody is going to ship.
 */
export function apply(agent: store.Agent, targetBranch: string): { ok: boolean; commit: string | null; detail: string } {
  const ws = store.workspaceDir(agent.name);
  const before = git(ws, "rev-parse", "HEAD").out;

  const merged = git(
    ws, "-c", "user.name=yeet", "-c", "user.email=yeet@local",
    "merge", "--no-ff", TARGET_REF, "-m", `yeet: merge ${targetBranch} into ${agent.branch}`,
  );
  if (!merged.ok) {
    // analyze() said clean, so reaching here means the tree moved underneath us. Leave nothing
    // half-merged behind.
    git(ws, "merge", "--abort");
    return { ok: false, commit: null, detail: merged.err.slice(0, 300) || "merge failed after reporting clean" };
  }
  const after = git(ws, "rev-parse", "HEAD").out;
  return {
    ok: true,
    commit: after,
    detail: after === before ? "nothing to merge" : `merged ${targetBranch} into ${agent.branch}`,
  };
}

/** Publish the merged branch as the new target. Host-side, like every other write to origin. */
export function publish(agent: store.Agent, targetBranch: string): { ok: boolean; detail: string } {
  if (!agent.origin) return { ok: false, detail: "no origin configured" };
  const r = git(store.workspaceDir(agent.name), "push", agent.origin, `${agent.branch}:${targetBranch}`);
  return r.ok
    ? { ok: true, detail: `pushed to ${targetBranch}` }
    : { ok: false, detail: r.err.slice(0, 300) };
}
