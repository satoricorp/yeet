/**
 * agent.ts — the durable unit.
 *
 * An agent is not a run. It owns a workspace, a git branch, and a pi session, so
 * `yeet --name <n> "<follow-up>"` is a real continuation rather than a fresh attempt.
 *
 * Isolation is the default and only starting state: every agent begins in a blank workspace
 * that has never seen the user's repos. The outside world arrives exclusively through config —
 * `yeet config --name <n> origin <url>` imports a repo as the base if nothing has been built yet,
 * and unlocks `yeet --name <n> push`, which pushes FROM THE HOST. The guest never has a remote,
 * so nothing that runs inside a VM can reach anything the user owns.
 *
 * Layout (0700 throughout — run.env holds a bridged API key):
 *   ~/.yeet/agents/<name>/
 *     agent.json      state, config, cost, iteration history
 *     .lock           flock held for the duration of a run
 *     workspace/      a git repo on branch yeet/<name>
 *     session/        pi's session JSONL — survives every VM, which is what lets -c resume
 *     bin/            yeet-run + yeet-tools.ts, staged per run
 *     iter-000/…      per-iteration request + logs + qa/ + meta.kv + DONE
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AGENTS_DIR } from "./host";
// Aliased: agent.ts already exports `AgentState` for the status enum, while events.ts uses the
// name for the folded state object. Two different things, one word.
import { fold, log, record, ulid, type AgentState as FoldedState } from "./events";

export type IterationRecord = {
  n: number;
  phase: string;
  agentSeconds: number;
  costUsd: number;
  insertions: number;
  deletions: number;
  filesChanged: number;
  treeChanged: boolean;
  testExit: number | null;
  verdict: "green" | "red" | "none";
  /** A green earned in the same breath as editing frozen (pre-existing) tests is suspect. */
  touchedFrozenTests?: boolean;
  stopReason?: "budget" | "stall";
};

export type AgentState = "running" | "passed" | "stalled" | "capped" | "failed" | "unverified";

/** How the work gets proven. Registered by the agent via the set_verify tool (source
 *  "agent") or set by a human via `yeet config --name <n> test` (source "user"). */
export type Verify = {
  command: string;
  /** Glob patterns for test files, used to freeze pre-existing tests and to exclude tests
   *  from the coverage denominator. */
  testFiles: string[];
  /** Must leave an lcov file in the workspace, or null when the stack can't produce one. */
  coverageCommand: string | null;
  source: "agent" | "user";
  /** path -> blob sha of test files as they existed at baseHead. Changing THESE is the
   *  cheat we watch for; tests the agent writes fresh are its own to iterate on. */
  frozen: Record<string, string>;
};

export type CoverageRecord = { pct: number; coveredLines: number; totalLines: number; at: string };

export type Agent = {
  /** Stable identity, unlike `name` which `rename` changes. Optional so agent.json files
   *  written before the event log still load; `load()` backfills one. */
  id?: string;
  name: string;
  createdAt: string;
  /** Legacy field from the era when yeet cloned the repo containing cwd. New agents never
   *  set it; kept so old agent.json files still load and label correctly. */
  repo?: string | null;
  /** Git URL or path. Set via config; enables push, and imports as base when nothing is built. */
  origin: string | null;
  baseHead: string | null;
  branch: string;
  model: string;
  task: string;
  verify: Verify | null;
  coverage: CoverageRecord | null;
  state: AgentState;
  costUsd: number;
  iterations: IterationRecord[];
};

/**
 * Names that would read as a command. Since the name moved to --name nothing PARSES wrong if
 * an agent is called "test" — `yeet --name test test` is unambiguous. It just reads terribly,
 * in `yeet ls` most of all, so these stay refused.
 */
export const RESERVED = new Set(["ls", "help", "ask", "rm", "config", "push", "test", "merge", "-h", "--help"]);

/** Names double as directory names and git branch names, so they get the same cleaning
 *  whether they came from slugify or from --name. */
export function cleanName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Name from the first task, so `yeet ls` reads like a to-do list and you never type an id.
 *
 * The filter is aggressive on purpose. "build me an app that counts words from stdin" used to
 * become "build-app-that" — three words that say nothing about the job. Dropping the framing
 * (the verb that fits any task, the noun that fits any artefact, the connectives) leaves what
 * is actually distinctive: "counts-words-stdin".
 */
export function slugify(task: string, taken: (n: string) => boolean): string {
  const stop = new Set([
    // articles, connectives, pronouns
    "a", "an", "the", "to", "for", "of", "in", "on", "and", "or", "me", "my", "it", "its",
    "that", "this", "from", "with", "into", "using", "via", "some", "please", "can", "you",
    // verbs that describe every task equally
    "make", "build", "create", "write", "add", "implement", "generate", "set", "up", "do",
    // nouns that describe every artefact equally
    "app", "application", "program", "tool", "script", "thing", "project", "cli", "code",
  ]);
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !stop.has(w))
    .slice(0, 3);
  let base = words.join("-").slice(0, 32) || "agent";
  if (RESERVED.has(base)) base = `${base}-1`;
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}

export const agentDir = (name: string) => join(AGENTS_DIR, name);
export const workspaceDir = (name: string) => join(agentDir(name), "workspace");
const metaPath = (name: string) => join(agentDir(name), "agent.json");

export function exists(name: string): boolean {
  return existsSync(metaPath(name));
}

/** Rebuild the Agent shape the rest of the code expects from replayed state. Everything here
 *  is derived — there is nothing agent.json holds that the log does not. */
function fromState(s: FoldedState): Agent {
  return {
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    repo: s.legacyRepo,
    origin: s.git.origin,
    baseHead: s.git.baseCommit,
    branch: s.git.branch,
    model: s.model,
    task: s.userPrompt,
    verify: s.verify
      ? {
          command: s.verify.command,
          testFiles: s.verify.testFiles,
          coverageCommand: s.verify.coverageCommand,
          source: s.verify.proposedBy,
          frozen: s.verify.protectedTests,
        }
      : null,
    coverage: s.coverage,
    state: s.status,
    costUsd: s.costUsd,
    iterations: s.iterations.map((it) => ({
      n: it.n,
      phase: "agent",
      agentSeconds: it.seconds,
      costUsd: it.costUsd,
      insertions: it.linesAdded,
      deletions: it.linesRemoved,
      filesChanged: it.filesChanged,
      treeChanged: it.treeChanged,
      testExit: it.testExit,
      verdict: it.verdict,
      touchedFrozenTests: it.protectedTestsChanged.length > 0 || undefined,
      stopReason: it.stoppedBy ?? undefined,
    })),
  };
}

/**
 * The log is the truth; agent.json is a cache regenerated from it.
 *
 * An agent with no log yet is one that predates it: read the blob, replay it into a log, then
 * return the REPLAYED result rather than the blob. Going through the same path immediately
 * proves the backfill produced something faithful, instead of leaving that to be discovered
 * later by a sync that quietly disagrees.
 */
export function load(name: string): Agent {
  const replayed = fold(log.since(name));
  if (replayed) {
    const agent = fromState(replayed);
    const next = JSON.stringify(agent, null, 2) + "\n";
    // Only rewrite when it actually differs — `yeet ls` loads every agent, and a cache refresh
    // should not mean N pointless writes.
    if (!existsSync(metaPath(name)) || readFileSync(metaPath(name), "utf8") !== next) {
      writeFileSync(metaPath(name), next, { mode: 0o600 });
    }
    return agent;
  }
  return loadLegacy(name);
}

function loadLegacy(name: string): Agent {
  const raw = JSON.parse(readFileSync(metaPath(name), "utf8")) as Agent & { testCommand?: string | null };
  // Migrate the pre-verify era in place: testCommand becomes a user-sourced Verify.
  if (raw.verify === undefined) {
    raw.verify = raw.testCommand
      ? { command: raw.testCommand, testFiles: [], coverageCommand: null, source: "user", frozen: {} }
      : null;
    delete raw.testCommand;
  }
  if (raw.origin === undefined) raw.origin = null;
  if (raw.coverage === undefined) raw.coverage = null;
  // Agents that predate the event log get an identity AND a log now. Backfilling only the id
  // would leave them permanently unreplayable: fold() returns null without a `created` event,
  // so every one of them would be invisible to sync and to the consistency check.
  if (!raw.id) {
    raw.id = ulid();
    save(raw);
    record(name, {
      kind: "created",
      agentId: raw.id,
      name,
      userPrompt: raw.task,
      model: raw.model,
      session: { program: "pi", file: "session" },
      git: { branch: raw.branch, baseCommit: raw.baseHead, origin: raw.origin },
      legacyRepo: raw.repo ?? null,
      // The agent was created then, not now. Stamping "now" rewrote every migrated
      // agent's creation date to the moment it was first loaded.
    }, raw.createdAt);
    // Replay the recorded history rather than seeding only the final state. agent.json still
    // holds every iteration, so a log that omitted them would disagree with the blob it is
    // replacing on cost and iteration count — and the consistency check would (correctly)
    // reject it.
    if (raw.verify) {
      record(name, {
        kind: "verify_set", command: raw.verify.command, testFiles: raw.verify.testFiles,
        coverageCommand: raw.verify.coverageCommand, proposedBy: raw.verify.source,
        approvedBy: "auto", changedOnApproval: false, protectedTests: raw.verify.frozen,
      });
    }

    // Commit shas were never stored per iteration, so they cannot be recovered — except for the
    // last one that changed the tree, which is by definition the branch head. That keeps the
    // most recent checkpoint resumable; earlier ones are honestly null.
    const agentIters = raw.iterations.filter((i) => i.phase === "agent");
    const lastChanged = agentIters.map((i) => i.treeChanged).lastIndexOf(true);
    const head = git(workspaceDir(name), "rev-parse", "HEAD");
    agentIters.forEach((it, idx) => {
      record(name, {
        kind: "iteration", n: it.n,
        agent: {
          seconds: it.agentSeconds, costUsd: it.costUsd,
          outcome: it.treeChanged ? "edited" : "no_edit",
          stoppedBy: it.stopReason ?? null, sessionEnd: 0,
        },
        git: {
          commit: idx === lastChanged && head.ok ? head.out : null,
          treeChanged: it.treeChanged,
          filesChanged: it.filesChanged, linesAdded: it.insertions, linesRemoved: it.deletions,
          protectedTestsChanged: it.touchedFrozenTests ? ["(unknown — predates the log)"] : [],
        },
        verify: it.testExit === null ? null
          : { command: raw.verify?.command ?? "", exitCode: it.testExit, passed: it.verdict === "green" },
      });
    });

    // Spend that no iteration accounts for is chat: `yeet ask` adds to costUsd without pushing
    // an iteration record, so the blob's single total silently contained both. Reconstruct the
    // remainder rather than dropping it — otherwise the replayed total under-reports what was
    // actually paid, which is the one number a budget cap depends on.
    const iterated = agentIters.reduce((sum, it) => sum + it.costUsd, 0);
    const unaccounted = raw.costUsd - iterated;
    if (unaccounted > 1e-9) {
      record(name, {
        kind: "chat", question: "(reconstructed — predates the log)", costUsd: unaccounted,
      });
    }

    if (raw.coverage) {
      record(name, {
        kind: "coverage", pct: raw.coverage.pct,
        coveredLines: raw.coverage.coveredLines, totalLines: raw.coverage.totalLines,
      }, raw.coverage.at);
    }
    if (raw.state !== "running") {
      record(name, { kind: "status", status: raw.state, reason: "backfilled from agent.json" });
    }
    // Return the replay, not the blob — same path as every other load from here on.
    const replayed = fold(log.since(name));
    if (replayed) return fromState(replayed);
  }
  return raw;
}

export function save(agent: Agent): void {
  writeFileSync(metaPath(agent.name), JSON.stringify(agent, null, 2) + "\n", { mode: 0o600 });
}

export function list(): Agent[] {
  if (!existsSync(AGENTS_DIR)) return [];
  const out: Agent[] = [];
  for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(load(entry.name));
    } catch {
      /* a half-created agent dir is not worth failing the whole listing over */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args]);
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

export type CreateOptions = {
  task: string;
  model: string;
  /** From --name; slugified from the task when absent. */
  name?: string;
};

export function create(opts: CreateOptions): Agent {
  let name: string;
  if (opts.name) {
    name = cleanName(opts.name);
    if (!name) throw new Error(`--name "${opts.name}" cleans down to nothing usable`);
    if (RESERVED.has(name)) throw new Error(`"${name}" is a yeet command; pick another name`);
    if (exists(name)) throw new Error(`agent "${name}" already exists`);
  } else {
    name = slugify(opts.task, exists);
  }

  const dir = agentDir(name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const sub of ["session", "bin"]) mkdirSync(join(dir, sub), { recursive: true });

  // Blank slate, always. No repo detection, no cloning — the agent works in isolation until
  // config explicitly connects an origin.
  const workspace = workspaceDir(name);
  const branch = `yeet/${name}`;
  mkdirSync(workspace, { recursive: true });
  git(workspace, "init", "-q");
  git(workspace, "commit", "-q", "--allow-empty", "-m", "yeet: empty base");
  const baseHead = git(workspace, "rev-parse", "HEAD").out || null;
  git(workspace, "checkout", "--quiet", "-b", branch);

  const agent: Agent = {
    name,
    createdAt: new Date().toISOString(),
    origin: null,
    baseHead,
    branch,
    model: opts.model,
    task: opts.task,
    verify: null,
    coverage: null,
    state: "running",
    costUsd: 0,
    iterations: [],
  };
  agent.id = ulid();
  save(agent);
  record(name, {
    kind: "created",
    agentId: agent.id,
    name,
    userPrompt: opts.task,
    model: opts.model,
    session: { program: "pi", file: "session" },
    git: { branch, baseCommit: baseHead, origin: null },
  });
  return agent;
}

/** True when the agent has produced nothing yet — the only state in which importing an
 *  origin as the base is a merge-free, loss-free operation. */
export function isPristine(agent: Agent): boolean {
  if (agent.iterations.length > 0) return false;
  const head = git(workspaceDir(agent.name), "rev-parse", "HEAD");
  return head.ok && head.out === agent.baseHead;
}

/**
 * Point the agent at a git origin. Always enables push; additionally, when the agent has not
 * built anything yet, the origin's default branch is imported as the new base so the agent
 * works ON that code instead of a blank slate. The workspace never gains a git remote — the
 * guest must stay unable to push anywhere (TSI gives it unrestricted egress).
 */
export function setOrigin(agent: Agent, url: string): { imported: boolean; detail: string } {
  const ws = workspaceDir(agent.name);
  agent.origin = url;

  if (!isPristine(agent)) {
    save(agent);
    record(agent.name, { kind: "config", key: "origin", value: url, setBy: "user" });
    return { imported: false, detail: "origin set; existing work kept (push will offer this branch)" };
  }

  const fetch = git(ws, "fetch", "--quiet", url, "HEAD");
  if (!fetch.ok) {
    agent.origin = null;
    return { imported: false, detail: `could not reach ${url}: ${fetch.err.slice(0, 200)}` };
  }
  const target = git(ws, "rev-parse", "FETCH_HEAD");
  if (!target.ok) {
    agent.origin = null;
    return { imported: false, detail: "fetched, but FETCH_HEAD is unreadable" };
  }
  git(ws, "reset", "--hard", "--quiet", target.out);
  agent.baseHead = target.out;
  save(agent);
  // One event, not two: setting the origin and adopting it as the base happen together, and
  // splitting them would imply an ordering between facts that were always simultaneous.
  record(agent.name, { kind: "config", key: "origin", value: url, setBy: "user", baseCommit: target.out });
  return { imported: true, detail: `imported ${url} @ ${target.out.slice(0, 7)} as the base` };
}

/** Push the agent's branch to the configured origin — from the HOST, never the guest. */
export function push(agent: Agent): { ok: boolean; detail: string } {
  if (!agent.origin) return { ok: false, detail: "no origin configured — yeet config --name <n> origin <url>" };
  const r = git(workspaceDir(agent.name), "push", agent.origin, `${agent.branch}:${agent.branch}`);
  return r.ok
    ? { ok: true, detail: `pushed ${agent.branch} to ${agent.origin}` }
    : { ok: false, detail: r.err.slice(0, 400) };
}

/** Rename the agent everywhere its name appears: directory, branch, metadata. */
export function rename(agent: Agent, to: string): Agent {
  const next = cleanName(to);
  if (!next) throw new Error(`"${to}" cleans down to nothing usable`);
  if (RESERVED.has(next)) throw new Error(`"${next}" is a yeet command; pick another name`);
  if (exists(next)) throw new Error(`agent "${next}" already exists`);

  const from = agent.name;
  git(workspaceDir(from), "branch", "-m", agent.branch, `yeet/${next}`);
  renameSync(agentDir(from), agentDir(next));
  agent.name = next;
  agent.branch = `yeet/${next}`;
  save(agent);
  // Recorded AFTER the directory move, so the event lands in the log that travelled with the
  // agent rather than in an empty directory under the old name.
  record(next, { kind: "renamed", from, to: next, branch: agent.branch });
  return agent;
}

export function remove(name: string): void {
  rmSync(agentDir(name), { recursive: true, force: true });
}

/**
 * Fingerprint the test files as they existed at baseHead. These are the FROZEN tests: they
 * were the rules of the game before the agent showed up, and quietly rewriting them is the
 * classic way to make red turn green without doing the work. Tests the agent writes fresh
 * are not frozen — iterating on your own new tests is normal work, not cheating.
 */
export function frozenTests(agent: Agent, globs: string[]): Record<string, string> {
  if (!agent.baseHead || globs.length === 0) return {};
  const ls = git(workspaceDir(agent.name), "ls-tree", "-r", agent.baseHead);
  if (!ls.ok) return {};
  const matchers = globs.map((g) => new Bun.Glob(g));
  const out: Record<string, string> = {};
  for (const line of ls.out.split("\n")) {
    // <mode> blob <sha>\t<path>
    const m = line.match(/^\d+ blob ([0-9a-f]{40})\t(.+)$/);
    if (!m) continue;
    const [, sha, path] = m;
    if (matchers.some((g) => g.match(path!))) out[path!] = sha!;
  }
  return out;
}

/** Which frozen test files differ at HEAD from their frozen fingerprint? */
export function touchedFrozen(agent: Agent): string[] {
  const frozen = agent.verify?.frozen ?? {};
  const paths = Object.keys(frozen);
  if (paths.length === 0) return [];
  const ws = workspaceDir(agent.name);
  const touched: string[] = [];
  for (const path of paths) {
    const r = git(ws, "rev-parse", `HEAD:${path}`);
    if (!r.ok || r.out !== frozen[path]) touched.push(path);
  }
  return touched;
}

export const label = (agent: Agent) => {
  if (agent.origin) return basename(agent.origin.replace(/\.git$/, ""));
  if (agent.repo) return basename(agent.repo);
  return "isolated";
};
