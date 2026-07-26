/**
 * events.ts — the log is the truth; state is a fold over it.
 *
 * `agent.json` used to be a mutable blob rewritten every iteration. That has no history, it is
 * a silent last-write-wins the moment two machines touch it, and it maps to an UPDATE-heavy
 * table. Making the log authoritative buys sync as "everything after id X", a checkpoint for
 * free (the last event), an insert-only Postgres table, and an audit trail an agent cannot
 * rewrite — the controller appends events; the guest never does.
 *
 * The whole cloud port is two methods (append/since). A blob has no such interface: syncing
 * one is "both sides changed, now what", which is a merge algorithm for arbitrary JSON with no
 * good answer. This is the difference between transport and a distributed-systems problem.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR } from "./host";

// ── ids ───────────────────────────────────────────────────────────────────────────────────
//
// ULID, not a counter. A monotonic integer is exactly what makes two writers collide: a laptop
// and a cloud worker both produce "seq 7" and one silently wins. A ULID is collision-free
// across machines, sorts lexicographically (so ordering and `since` are plain string compares),
// and carries its own timestamp — which also makes it a good Postgres primary key later.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I, L, O, U

let lastMs = 0;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = "";
  for (let i = 9; i >= 0; i--) {
    out = CROCKFORD[ms % 32]! + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

/** Within the same millisecond, increment the random field instead of redrawing it, so ids
 *  from one process are strictly ordered even at sub-millisecond rates. */
function randomPart(ms: number): string {
  if (ms === lastMs && lastRandom.length) {
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i]! < 31) { lastRandom[i]!++; break; }
      lastRandom[i] = 0;
    }
  } else {
    lastMs = ms;
    lastRandom = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
  }
  return lastRandom.map((n) => CROCKFORD[n]!).join("");
}

export function ulid(now = Date.now()): string {
  return encodeTime(now) + randomPart(now);
}

// ── event shapes ──────────────────────────────────────────────────────────────────────────

/** Matches `agentVerdict` in session.ts — one vocabulary, not two that drift. */
export type Outcome = "edited" | "no_edit" | "error" | "stopped";
export type StoppedBy = "budget" | "stall" | null;
export type Status = "running" | "passed" | "stalled" | "capped" | "failed" | "unverified";
export type VerifyReason = "baseline" | "confirm" | "coverage" | "manual";
export type MergeResult = "clean" | "conflicted" | "resolved" | "aborted";

/** What the agent did to the code during one iteration. `commit` is null when nothing changed —
 *  there are no empty commits, so absence is the signal. */
export type GitChange = {
  commit: string | null;
  /** Explicit, NOT derived from `commit !== null`. That derivation holds for live iterations
   *  (the runner only commits when the tree changed) but not for backfilled ones, where per
   *  iteration commit shas were never stored — so every earlier tree-changing iteration was
   *  being replayed as "no edit". */
  treeChanged: boolean;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  /** Pre-existing tests whose content moved. Non-empty beside passed:true is the alarm. */
  protectedTestsChanged: string[];
  /** Context files the agent created or edited (AGENTS.md, CLAUDE.md, .pi/…). Not blocked —
   *  just recorded, because an agent steering its own next iteration through a file it wrote
   *  is a feedback loop that is otherwise invisible. */
  contextFilesChanged?: string[];
};

export type VerifyRun = { command: string; exitCode: number; passed: boolean };

export type EventBody =
  /** `agentId` is the stable identity. The name is a handle and `rename` changes it, so keying
   *  anything durable on the name would break the moment someone renames an agent — and would
   *  make two machines disagree about which agent they are talking about. */
  | { kind: "created"; agentId: string; name: string; userPrompt: string; model: string;
      session: { program: string; file: string };
      git: { branch: string; baseCommit: string | null; origin: string | null };
      /** Legacy passthrough: agents from the era when yeet cloned the repo containing cwd
       *  recorded a host path here. New agents never set it. Carried so replaying an old
       *  agent does not silently relabel it "isolated" in `yeet ls`. */
      legacyRepo?: string | null }
  | { kind: "prompt"; from: "user" | "agent"; text: string }
  /** `baseCommit` is present only when setting an origin also imported it as the new base,
   *  which happens for a pristine agent. The two facts always occur together, so splitting
   *  them into separate events would imply an ordering that does not exist. */
  | { kind: "config"; key: "origin" | "target" | "model"; value: string | null;
      setBy: "user" | "agent"; baseCommit?: string }
  | { kind: "renamed"; from: string; to: string; branch: string }
  /** Measured once, after a confirmed pass — the number that makes a green light worth
   *  believing. Separate from verify_run because it is a property of the agent, not of a run. */
  | { kind: "coverage"; pct: number; coveredLines: number; totalLines: number }
  /** `yeet ask <name> "…"` spends money without producing an iteration. Without this the cost
   *  total silently under-reports. */
  | { kind: "chat"; question: string; costUsd: number }
  | { kind: "verify_set"; command: string; testFiles: string[]; coverageCommand: string | null;
      proposedBy: "agent" | "user"; approvedBy: "user" | "auto"; changedOnApproval: boolean;
      protectedTests: Record<string, string> }
  | { kind: "verify_run"; reason: VerifyReason } & VerifyRun
  | { kind: "iteration"; n: number;
      agent: { seconds: number; costUsd: number; outcome: Outcome; stoppedBy: StoppedBy; sessionEnd: number };
      git: GitChange; verify: VerifyRun | null }
  | { kind: "merge"; targetBranch: string; mergeBase: string; targetCommit: string;
      agentCommit: string; result: MergeResult; conflicts: number; mergeCommit: string | null }
  | { kind: "status"; status: Status; reason: string | null };

export type AgentEvent = EventBody & { id: string; at: string };

// ── the store ─────────────────────────────────────────────────────────────────────────────

/** The entire surface a cloud backend has to implement. A file today; `INSERT` and
 *  `SELECT … WHERE id > $1` tomorrow. Nothing above this interface changes. */
export interface EventStore {
  /** `at` overrides the occurrence time. Backfill needs it: an event replayed out of an old
   *  agent.json happened in the past, and stamping it "now" rewrites history — it reset every
   *  migrated agent's creation date to the moment it was first loaded. */
  append(agent: string, bodies: EventBody[], at?: string): AgentEvent[];
  since(agent: string, afterId?: string): AgentEvent[];
  agents(): string[];
}

const logPath = (agent: string) => join(AGENTS_DIR, agent, "events.jsonl");

export class FileEventStore implements EventStore {
  append(agent: string, bodies: EventBody[], atOverride?: string): AgentEvent[] {
    const dir = join(AGENTS_DIR, agent);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const at = atOverride ?? new Date().toISOString();
    const events = bodies.map((body) => ({ id: ulid(), at, ...body }) as AgentEvent);
    if (events.length) {
      appendFileSync(logPath(agent), events.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    }
    return events;
  }

  since(agent: string, afterId?: string): AgentEvent[] {
    const path = logPath(agent);
    if (!existsSync(path)) return [];
    const out: AgentEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      let e: AgentEvent;
      try {
        e = JSON.parse(line) as AgentEvent;
      } catch {
        continue; // a torn final line means a crash mid-append; the rest of the log is still good
      }
      if (afterId === undefined || e.id > afterId) out.push(e);
    }
    // Lexicographic order is chronological order — that is the point of ULIDs.
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  agents(): string[] {
    if (!existsSync(AGENTS_DIR)) return [];
    return readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(logPath(d.name)))
      .map((d) => d.name);
  }
}

/** The process-wide log. Swapping this for a Postgres-backed store is the entire cloud port —
 *  every caller below goes through `record`, and none of them know which store they have. */
export const log: EventStore = new FileEventStore();

/** Append one event. Recording must never take down a run: a failed append costs history, but
 *  throwing here would cost the work itself, which is strictly worse. */
export function record(agent: string, body: EventBody, at?: string): AgentEvent | null {
  try {
    return log.append(agent, [body], at)[0] ?? null;
  } catch (e) {
    console.error(`yeet: could not record ${body.kind} for ${agent}: ${(e as Error).message}`);
    return null;
  }
}

// ── the fold ──────────────────────────────────────────────────────────────────────────────

export type Checkpoint = { id: string; commit: string; sessionEnd: number };

/** One iteration, flattened for consumers. Everything here is derived from the event — the
 *  log is the only place iteration history lives once agent.json becomes a cache. */
export type IterationSummary = {
  n: number;
  seconds: number;
  costUsd: number;
  outcome: Outcome;
  stoppedBy: StoppedBy;
  commit: string | null;
  treeChanged: boolean;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  protectedTestsChanged: string[];
  testExit: number | null;
  verdict: "green" | "red" | "none";
};

export type AgentState = {
  /** Stable across renames and across machines. The name is only a handle. */
  id: string;
  name: string;
  createdAt: string;
  userPrompt: string;
  model: string;
  status: Status;
  /** Every dollar spent: iterations and chat both. */
  costUsd: number;
  coverage: { pct: number; coveredLines: number; totalLines: number; at: string } | null;
  git: { branch: string; baseCommit: string | null; origin: string | null; target: string };
  /** See EventBody.created.legacyRepo. */
  legacyRepo: string | null;
  session: { program: string; file: string } | null;
  verify: {
    command: string; testFiles: string[]; coverageCommand: string | null;
    proposedBy: "agent" | "user"; protectedTests: Record<string, string>;
  } | null;
  iterations: IterationSummary[];
  /** Resume position: the last iteration that actually produced a commit. */
  checkpoint: Checkpoint | null;
  /** Id of the last event folded, so a caller knows what to ask `since()` for next. */
  head: string | null;
};

/** Pure, total, no I/O — so it produces identical state on a laptop and on a cloud worker.
 *  Unknown event kinds are ignored rather than throwing, so an older binary can still read a
 *  log written by a newer one. */
export function fold(events: AgentEvent[]): AgentState | null {
  const created = events.find((e) => e.kind === "created");
  if (!created || created.kind !== "created") return null;

  const state: AgentState = {
    id: created.agentId,
    name: created.name,
    createdAt: created.at,
    userPrompt: created.userPrompt,
    model: created.model,
    status: "running",
    costUsd: 0,
    coverage: null,
    git: { ...created.git, target: "main" },
    legacyRepo: created.legacyRepo ?? null,
    session: created.session,
    verify: null,
    iterations: [],
    checkpoint: null,
    head: null,
  };

  for (const e of events) {
    state.head = e.id;
    switch (e.kind) {
      case "config":
        if (e.key === "model" && e.value) state.model = e.value;
        else if (e.key === "origin") state.git.origin = e.value;
        else if (e.key === "target" && e.value) state.git.target = e.value;
        // Setting an origin on a pristine agent also imports it as the new base.
        if (e.baseCommit) state.git.baseCommit = e.baseCommit;
        break;
      case "renamed":
        state.name = e.to;
        state.git.branch = e.branch;
        break;
      case "coverage":
        state.coverage = { pct: e.pct, coveredLines: e.coveredLines, totalLines: e.totalLines, at: e.at };
        break;
      case "chat":
        state.costUsd += e.costUsd;
        break;
      case "verify_set":
        state.verify = {
          command: e.command, testFiles: e.testFiles, coverageCommand: e.coverageCommand,
          proposedBy: e.proposedBy, protectedTests: e.protectedTests,
        };
        break;
      case "iteration":
        state.costUsd += e.agent.costUsd;
        state.iterations.push({
          n: e.n,
          seconds: e.agent.seconds,
          costUsd: e.agent.costUsd,
          outcome: e.agent.outcome,
          stoppedBy: e.agent.stoppedBy,
          commit: e.git.commit,
          treeChanged: e.git.treeChanged,
          filesChanged: e.git.filesChanged,
          linesAdded: e.git.linesAdded,
          linesRemoved: e.git.linesRemoved,
          protectedTestsChanged: e.git.protectedTestsChanged,
          testExit: e.verify?.exitCode ?? null,
          verdict: e.verify ? (e.verify.passed ? "green" : "red") : "none",
        });
        if (e.git.commit) {
          state.checkpoint = { id: e.id, commit: e.git.commit, sessionEnd: e.agent.sessionEnd };
        }
        break;
      case "status":
        state.status = e.status;
        break;
    }
  }
  return state;
}
