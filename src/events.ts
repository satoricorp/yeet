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

export type Outcome = "edited" | "no_change" | "error" | "stopped";
export type StoppedBy = "budget" | "stall" | null;
export type Status = "running" | "passed" | "stalled" | "capped" | "failed" | "unverified";
export type VerifyReason = "baseline" | "confirm" | "coverage";
export type MergeResult = "clean" | "conflicted" | "resolved" | "aborted";

/** What the agent did to the code during one iteration. `commit` is null when nothing changed —
 *  there are no empty commits, so absence is the signal. */
export type GitChange = {
  commit: string | null;
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
  | { kind: "created"; name: string; userPrompt: string; model: string;
      session: { program: string; file: string };
      git: { branch: string; baseCommit: string | null; origin: string | null } }
  | { kind: "prompt"; from: "user" | "agent"; text: string }
  | { kind: "config"; key: "origin" | "target" | "model"; value: string | null; setBy: "user" | "agent" }
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
  append(agent: string, bodies: EventBody[]): AgentEvent[];
  since(agent: string, afterId?: string): AgentEvent[];
  agents(): string[];
}

const logPath = (agent: string) => join(AGENTS_DIR, agent, "events.jsonl");

export class FileEventStore implements EventStore {
  append(agent: string, bodies: EventBody[]): AgentEvent[] {
    const dir = join(AGENTS_DIR, agent);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const at = new Date().toISOString();
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

// ── the fold ──────────────────────────────────────────────────────────────────────────────

export type Checkpoint = { id: string; commit: string; sessionEnd: number };

export type AgentState = {
  name: string;
  userPrompt: string;
  model: string;
  status: Status;
  costUsd: number;
  git: { branch: string; baseCommit: string | null; origin: string | null; target: string };
  session: { program: string; file: string } | null;
  verify: {
    command: string; testFiles: string[]; coverageCommand: string | null;
    proposedBy: "agent" | "user"; protectedTests: Record<string, string>;
  } | null;
  iterations: number;
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
    name: created.name,
    userPrompt: created.userPrompt,
    model: created.model,
    status: "running",
    costUsd: 0,
    git: { ...created.git, target: "main" },
    session: created.session,
    verify: null,
    iterations: 0,
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
        break;
      case "verify_set":
        state.verify = {
          command: e.command, testFiles: e.testFiles, coverageCommand: e.coverageCommand,
          proposedBy: e.proposedBy, protectedTests: e.protectedTests,
        };
        break;
      case "iteration":
        state.iterations++;
        state.costUsd += e.agent.costUsd;
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
