/**
 * loop.ts — one iteration, and the loop around it.
 *
 * The loop is the point of the whole tool: "the agent stopped calling tools" is not "the goal
 * is met". Every iteration boots a fresh microVM, because the two things a persistent VM would
 * buy already survive on the shared filesystem for free — the workspace *is* a host directory,
 * and pi's session JSONL lets `-c` resume the conversation across a boot boundary.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloneTree, CURRENT_IMAGE } from "./host";
import { writeRequest, readMeta, sawDone, num, bool, type Phase } from "./contract";
import { runVM } from "./vm";
import { findSessionFile, readSession, agentVerdict, EMPTY_SESSION, type SessionStats } from "./session";
import { bridgeKey, describeMissingKey } from "./keys";
import * as store from "./agent";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

export type Limits = { maxIterations: number; maxCostUsd: number; agentTimeoutS: number; testTimeoutS: number };
export const DEFAULT_LIMITS: Limits = { maxIterations: 5, maxCostUsd: 2, agentTimeoutS: 900, testTimeoutS: 300 };

export type IterationResult = {
  n: number;
  phase: Phase;
  valid: boolean;
  invalidReason?: string;
  treeChanged: boolean;
  committed: boolean;
  afterTree: string;
  insertions: number;
  deletions: number;
  filesChanged: number;
  testExit: number | null;
  testLog: string;
  agentSeconds: number;
  agentExit: number | null;
  /** edited | no_edit | error | timeout — derived from three independent signals, not prose.
   *  "error" is materially different from "no_edit": a model that cannot emit a valid tool
   *  call will never make progress, so reporting it as a stall misdirects the user. */
  agentVerdict: "edited" | "no_edit" | "error" | "timeout" | null;
  /** The budget watchdog stopped the agent mid-work. */
  stoppedByBudget: boolean;
  /** The agent was killed mid-edit (timeout or budget), so the committed tree may be
   *  syntactically inconsistent — measured once as a file ending `export { Parser as default;`.
   *  Keeping the partial work is right; presenting it as an ordinary red iteration is not. */
  interrupted: boolean;
  session: SessionStats;
  verdict: "green" | "red" | "none";
};

export async function runIteration(
  agent: store.Agent,
  opts: {
    n: number; phase: Phase; runAgent: boolean; runTest: boolean; prompt?: string;
    /** Enforced DURING the iteration, not just between iterations. */
    budget?: { capUsd: number; spentUsd: number };
  },
): Promise<IterationResult> {
  const dir = store.agentDir(agent.name);
  const iterName = `iter-${String(opts.n).padStart(3, "0")}`;
  const iterDir = join(dir, iterName);
  rmSync(iterDir, { recursive: true, force: true });
  mkdirSync(iterDir, { recursive: true });

  // Stage the runner fresh each iteration so editing it takes effect without an image rebuild.
  copyFileSync(join(REPO_ROOT, "guest/yeet-run"), join(dir, "bin/yeet-run"));
  Bun.spawnSync(["chmod", "+x", join(dir, "bin/yeet-run")]);

  if (opts.runAgent) {
    const key = bridgeKey(agent.model);
    if (!key) throw new Error(describeMissingKey(agent.model));
    writeFileSync(join(dir, "run.env"), `export ${key.name}=${key.value}\n`, { mode: 0o600 });
  }

  writeRequest(iterDir, `/yeet/${iterName}`, {
    runId: agent.name,
    iteration: opts.n,
    phase: opts.phase,
    runAgent: opts.runAgent,
    runTest: opts.runTest,
    model: agent.model,
    sessionDir: "/yeet/session",
    baseHead: agent.baseHead ?? "",
    agentTimeoutS: DEFAULT_LIMITS.agentTimeoutS,
    testTimeoutS: DEFAULT_LIMITS.testTimeoutS,
    prompt: opts.prompt,
    commitMessage: opts.runAgent ? commitMessage(agent, opts.n) : undefined,
    testCommand: opts.runTest && agent.testCommand ? agent.testCommand : undefined,
  });

  const rootfs = join(dir, "rootfs");
  rmSync(rootfs, { recursive: true, force: true });
  cloneTree(CURRENT_IMAGE, rootfs);

  const outcome = await runVM(
    {
      root: rootfs,
      mounts: { yeet: dir },
      env: { YEET_DIR: `/yeet/${iterName}` },
      workdir: "/yeet/workspace",
      consolePath: join(iterDir, "console.log"),
      stderrPath: join(iterDir, "vm.stderr"),
      timeoutMs: (DEFAULT_LIMITS.agentTimeoutS + DEFAULT_LIMITS.testTimeoutS + 120) * 1000,
      budget:
        opts.runAgent && opts.budget
          ? {
              stopFile: join(iterDir, "STOP"),
              // Read the live session file the guest is still appending to. Costs nothing —
              // it is a host-side file read of a shared-mount path.
              check: () => {
                const live = readSession(findSessionFile(join(dir, "session")));
                return opts.budget!.spentUsd + live.costUsd >= opts.budget!.capUsd;
              },
            }
          : undefined,
    },
    ["/usr/local/bin/yeet-init", "/yeet/bin/yeet-run"],
  );
  rmSync(rootfs, { recursive: true, force: true });

  const base: IterationResult = {
    n: opts.n, phase: opts.phase, valid: false, treeChanged: false, committed: false,
    afterTree: "", insertions: 0, deletions: 0, filesChanged: 0, testExit: null, testLog: "",
    agentSeconds: 0, agentExit: null, agentVerdict: null, stoppedByBudget: false,
    interrupted: false, session: EMPTY_SESSION, verdict: "none",
  };

  if (outcome.kind !== "ok" || !sawDone(iterDir)) {
    return { ...base, invalidReason: outcome.kind === "ok" ? "no DONE sentinel" : JSON.stringify(outcome) };
  }

  let meta;
  try {
    meta = readMeta(iterDir);
  } catch (e) {
    return { ...base, invalidReason: `meta.kv: ${(e as Error).message}` };
  }

  const testLog = existsSync(join(iterDir, "test.log")) ? readFileSync(join(iterDir, "test.log"), "utf8") : "";
  const session = readSession(findSessionFile(join(dir, "session")));
  const diffstat = existsSync(join(iterDir, "diffstat.txt"))
    ? readFileSync(join(iterDir, "diffstat.txt"), "utf8")
    : "";
  const grab = (re: RegExp) => Number(diffstat.match(re)?.[1] ?? 0);

  const testExit = meta.testExit !== undefined ? num(meta, "testExit", -1) : null;
  const treeChanged = bool(meta, "treeChanged");
  const agentExit = meta.agentExit !== undefined ? num(meta, "agentExit", -1) : null;
  return {
    n: opts.n,
    phase: opts.phase,
    valid: true,
    agentExit,
    agentVerdict: opts.runAgent
      ? agentVerdict(session, treeChanged, agentExit ?? -1, bool(meta, "agentTimedOut"))
      : null,
    stoppedByBudget: bool(meta, "stoppedByBudget"),
    interrupted: bool(meta, "agentTimedOut") || bool(meta, "stoppedByBudget"),
    treeChanged,
    committed: bool(meta, "committed"),
    afterTree: meta.afterTree ?? "",
    insertions: grab(/(\d+) insertion/),
    deletions: grab(/(\d+) deletion/),
    filesChanged: grab(/(\d+) file/),
    testExit,
    testLog,
    agentSeconds: num(meta, "agentSeconds"),
    session,
    verdict: testExit === null ? "none" : testExit === 0 ? "green" : "red",
  };
}

function commitMessage(agent: store.Agent, n: number): string {
  return [
    `yeet: iteration ${n}`,
    "",
    `task: ${agent.task}`,
    "",
    `Yeet-Agent: ${agent.name}`,
    `Yeet-Iteration: ${n}`,
    `Yeet-Model: ${agent.model}`,
  ].join("\n");
}

/** Iteration 1 gets the task and the rules. Telling the agent how it will be judged turns it
 *  into its own first-line verifier, which collapses iterations — the extra in-agent test runs
 *  cost far less than another whole VM round trip. */
export function firstPrompt(agent: store.Agent): string {
  const lines = [
    agent.task,
    "",
    `You are in /yeet/workspace, a git repository on branch ${agent.branch}.`,
  ];
  if (agent.testCommand) {
    lines.push(
      "",
      "Your work will be verified by running, in that directory:",
      `    ${agent.testCommand}`,
      "It must exit 0. Run it yourself to check your work before you finish — please do.",
      "",
      "Do not modify test files. If you believe a test is wrong, say so explicitly and explain why.",
    );
  }
  lines.push("", "Do not commit; yeet commits for you after you stop.");
  return lines.join("\n");
}

/** Iteration N gets only the delta. pi's session already holds every file it read and every
 *  edit it made, so re-narrating that would be redundant and expensive. The full log stays at a
 *  stable guest path — the prompt is an index into it, not a container for it. */
export function retryPrompt(prev: IterationResult, agent: store.Agent, iterName: string): string {
  const clean = prev.testLog.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = clean.split("\n");
  const tail = lines.slice(-120);
  const head = lines.slice(0, 20);
  const headMatters = head.some((l) => /error|cannot find|no such file|Traceback|ModuleNotFound/i.test(l));
  const excerpt = (headMatters ? [...head, "…", ...tail] : tail).join("\n").slice(-4096);

  return [
    `The verifier ran \`${agent.testCommand}\` in /yeet/workspace on your last change.`,
    `It FAILED (exit ${prev.testExit}).`,
    "",
    "--- output (truncated) ---",
    excerpt,
    "--- end ---",
    "",
    `Full output: /yeet/${iterName}/test.log  (read it if you need more)`,
    prev.committed ? `Your last change was committed: ${prev.filesChanged} file(s), +${prev.insertions}/-${prev.deletions}.` : "You made no committed change last time.",
    "",
    "Fix the failures.",
  ].join("\n");
}
