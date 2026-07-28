/**
 * loop.ts — one iteration, and the pieces the loop is made of.
 *
 * The loop is the point of the whole tool: "the agent stopped calling tools" is not "the goal
 * is met". Every iteration boots a fresh microVM, because the two things a persistent VM would
 * buy already survive on the shared filesystem for free — the workspace *is* a host directory,
 * and pi's session JSONL lets `-c` resume the conversation across a boot boundary.
 *
 * New in this era: an iteration is a CONVERSATION, not a batch job. The Bridge watches the
 * shared mount while the VM runs — it relays the agent's ask_user questions to whoever is
 * driving (a human at the TTY, or the recommendation policy), accepts set_verify proposals
 * and binds them mid-flight (test-cmd.sh appears in the iteration dir while the guest is
 * already running — virtio-fs makes late binding an ordinary file write), enforces the cost
 * cap live, and decides when a silent guest is dead.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloneTree, CURRENT_IMAGE } from "./host";
import { writeRequest, readMeta, sawDone, num, bool, type Phase } from "./contract";
import { runVM } from "./vm";
import { Bridge, prepareQaDir, type AskRequest, type VerifyRequest, type VerifyDecision } from "./bridge";
import { findSessionFile, readSession, agentVerdict, costDelta, EMPTY_SESSION, type SessionStats } from "./session";
import { bridgeKey, describeMissingKey } from "./keys";
import { record } from "./events";
import { findLcov, parseLcov, type Coverage } from "./coverage";
import * as store from "./agent";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

export type Limits = { maxIterations: number; maxCostUsd: number; stallMs: number; hardCeilingMs: number };
export const DEFAULT_LIMITS: Limits = {
  /** Deliberately generous. The round cap is a backstop against runaway, NOT the mechanism
   *  for deciding an agent is done — that is the stall detectors and the live budget cap. A
   *  low cap cuts off agents that were still making progress, which is the worse error. */
  maxIterations: 25,
  maxCostUsd: 2,
  /** No observable sign of life for this long ⇒ the controller escalates (STOP, then kill). */
  stallMs: 10 * 60 * 1000,
  /** Absolute per-VM ceiling — the backstop for a guest that LOOKS alive forever. */
  hardCeilingMs: 2 * 60 * 60 * 1000,
};

/** How the driving side answers the guest. The CLI wires this to Ui; tests wire it to canned
 *  answers. Everything is async because a human may be on the other end. */
export type IterationIo = {
  ask(q: AskRequest): Promise<string>;
  /** The extra fields are what make the audit trail meaningful: whether a human was actually
   *  at the terminal, and whether they changed what the agent proposed. */
  verifyProposal(v: VerifyRequest): Promise<VerifyDecision & { approvedBy?: "user" | "auto"; changedOnApproval?: boolean }>;
  escalate?(action: "stop" | "kill", reason: "budget" | "stall"): void;
  /** pi's events as they arrive, for the live trace. Optional: only the terminal renderer
   *  wants them, and machine mode must never have prose streamed into its NDJSON. */
  agentEvent?(events: any[]): void;
  /** No more events are coming. Lets a streaming renderer close its last line. */
  agentEventsDone?(): void;
};

const AUTO_IO: IterationIo = {
  ask: async (q) => q.recommended,
  verifyProposal: async (v) => ({ command: v.command, testFiles: v.testFiles, coverageCommand: v.coverageCommand }),
};

export type IterationResult = {
  n: number;
  phase: Phase;
  dirName: string;
  valid: boolean;
  invalidReason?: string;
  treeChanged: boolean;
  committed: boolean;
  /** Commit sha at HEAD after this iteration — the resumable checkpoint. Distinct from
   *  afterTree, which is a TREE hash: content-identical across commits, and not something
   *  `git checkout` accepts. Confusing the two silently breaks resume. */
  afterHead: string;
  /** Tree hash, used ONLY for no-progress detection: git's own content hash of the whole
   *  worktree, so two iterations that produced identical content compare equal. */
  afterTree: string;
  insertions: number;
  deletions: number;
  filesChanged: number;
  testExit: number | null;
  testLog: string;
  agentSeconds: number;
  agentExit: number | null;
  /** edited | no_edit | error | stopped — derived from independent signals, not prose.
   *  "error" is materially different from "no_edit": a model that cannot emit a valid tool
   *  call will never make progress, so reporting it as a stall misdirects the user. */
  agentVerdict: "edited" | "no_edit" | "error" | "stopped" | null;
  /** Why the controller dropped STOP, when it did. */
  stopReason: "budget" | "stall" | null;
  /** The agent was stopped mid-edit, so the committed tree may be syntactically
   *  inconsistent — measured once as a file ending `export { Parser as default;`. Keeping the
   *  partial work is right; presenting it as an ordinary red iteration is not. */
  interrupted: boolean;
  /** Frozen (pre-existing) test files whose content at HEAD no longer matches baseHead. */
  touchedFrozen: string[];
  session: SessionStats;
  verdict: "green" | "red" | "none";
};

export async function runIteration(
  agent: store.Agent,
  opts: {
    n: number;
    phase: Phase;
    runAgent: boolean;
    runTest: boolean;
    prompt?: string;
    /** Directory name under the agent dir; defaults to iter-NNN. Confirm/coverage/chat use
     *  their own namespaces so they never clobber an agent iteration's artifacts. */
    dirName?: string;
    /** For the coverage phase: run this instead of verify.command in the test slot. */
    testCommandOverride?: string;
    /** Enforced live, DURING the iteration. Present only for agent phases. */
    budget?: { capUsd: number; spentBeforeUsd: number };
    io?: IterationIo;
  },
): Promise<IterationResult> {
  const dir = store.agentDir(agent.name);
  const dirName = opts.dirName ?? `iter-${String(opts.n).padStart(3, "0")}`;
  const iterDir = join(dir, dirName);
  rmSync(iterDir, { recursive: true, force: true });
  mkdirSync(iterDir, { recursive: true });
  prepareQaDir(iterDir);

  // Stage the runner and the pi extension fresh each iteration so editing either takes
  // effect without an image rebuild.
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "guest/yeet-run"), join(dir, "bin/yeet-run"));
  copyFileSync(join(REPO_ROOT, "guest/yeet-tools.ts"), join(dir, "bin/yeet-tools.ts"));
  Bun.spawnSync(["chmod", "+x", join(dir, "bin/yeet-run")]);

  if (opts.runAgent) {
    const key = bridgeKey(agent.model);
    if (!key) throw new Error(describeMissingKey(agent.model));
    writeFileSync(join(dir, "run.env"), `export ${key.name}=${key.value}\n`, { mode: 0o600 });
  }

  const testCommand = opts.testCommandOverride ?? agent.verify?.command;
  writeRequest(iterDir, `/yeet/${dirName}`, {
    runId: agent.name,
    iteration: opts.n,
    phase: opts.phase,
    runAgent: opts.runAgent,
    runTest: opts.runTest,
    model: agent.model,
    sessionDir: "/yeet/session",
    baseHead: agent.baseHead ?? "",
    prompt: opts.prompt,
    commitMessage: opts.phase === "agent" ? commitMessage(agent, opts.n) : undefined,
    // May be absent for a fresh agent — set_verify can bind it mid-iteration (below).
    testCommand: opts.runTest && testCommand ? testCommand : undefined,
  });

  const io = opts.io ?? AUTO_IO;
  const bridge = new Bridge({
    iterDir,
    sessionDir: join(dir, "session"),
    stallMs: DEFAULT_LIMITS.stallMs,
    agentPhase: opts.runAgent,
    budget: opts.runAgent && opts.budget ? { capUsd: opts.budget.capUsd, spentBeforeUsd: opts.budget.spentBeforeUsd } : undefined,
    onAsk: (q) => io.ask(q),
    onVerify: async (v) => {
      const cur = agent.verify;

      // `yeet ask` is read-only by contract: the runner reverts the guest's workspace edits
      // afterwards. But set_verify writes to agent.json and the log, which no revert touches —
      // so a question could silently rebind the acceptance contract, and under --agent it would
      // record approvedBy:"auto" as if someone had signed off. Answer the tool, change nothing.
      if (opts.phase === "chat") {
        return cur
          ? { command: cur.command, testFiles: cur.testFiles, coverageCommand: cur.coverageCommand }
          : { command: v.command, testFiles: v.testFiles, coverageCommand: v.coverageCommand };
      }

      // Models re-call set_verify with the same content more often than you'd think. An
      // identical re-proposal is a no-op: no re-prompt, no duplicate event, same binding.
      if (
        cur &&
        cur.command === v.command &&
        JSON.stringify(cur.testFiles) === JSON.stringify(v.testFiles) &&
        (cur.coverageCommand ?? null) === (v.coverageCommand ?? null)
      ) {
        return { command: cur.command, testFiles: cur.testFiles, coverageCommand: cur.coverageCommand };
      }
      const decision = await io.verifyProposal(v);
      // Bind it: persist on the agent (with the frozen fingerprint of PRE-EXISTING tests),
      // and stage test-cmd.sh into the LIVE iteration dir so this very run verifies with it.
      agent.verify = {
        command: decision.command,
        testFiles: decision.testFiles,
        coverageCommand: decision.coverageCommand,
        source: "agent",
        frozen: store.frozenTests(agent, decision.testFiles),
      };
      store.save(agent);
      record(agent.name, {
        kind: "verify_set",
        command: decision.command,
        testFiles: decision.testFiles,
        coverageCommand: decision.coverageCommand,
        proposedBy: "agent",
        approvedBy: decision.approvedBy ?? "auto",
        changedOnApproval: decision.changedOnApproval ?? false,
        protectedTests: agent.verify.frozen,
      });
      if (opts.runTest) {
        writeFileSync(join(iterDir, "test-cmd.sh"), decision.command + "\n", { mode: 0o700 });
      }
      return decision;
    },
    onEscalate: (action, reason) => io.escalate?.(action, reason),
    onAgentEvent: io.agentEvent ? (events) => io.agentEvent!(events) : undefined,
    onAgentEnd: io.agentEventsDone ? () => io.agentEventsDone!() : undefined,
  });

  const rootfs = join(dir, "rootfs");
  rmSync(rootfs, { recursive: true, force: true });
  cloneTree(CURRENT_IMAGE, rootfs);

  const outcome = await runVM(
    {
      root: rootfs,
      mounts: { yeet: dir },
      env: { YEET_DIR: `/yeet/${dirName}` },
      workdir: "/yeet/workspace",
      consolePath: join(iterDir, "console.log"),
      stderrPath: join(iterDir, "vm.stderr"),
      timeoutMs: DEFAULT_LIMITS.hardCeilingMs,
      watcher: bridge,
    },
    ["/usr/local/bin/yeet-init", "/yeet/bin/yeet-run"],
  );
  rmSync(rootfs, { recursive: true, force: true });

  const base: IterationResult = {
    n: opts.n, phase: opts.phase, dirName, valid: false, treeChanged: false, committed: false,
    afterHead: "", afterTree: "", insertions: 0, deletions: 0, filesChanged: 0, testExit: null, testLog: "",
    agentSeconds: 0, agentExit: null, agentVerdict: null, stopReason: bridge.stopReason,
    interrupted: false, touchedFrozen: [], session: EMPTY_SESSION, verdict: "none",
  };

  if (outcome.kind !== "ok" || !sawDone(iterDir)) {
    return {
      ...base,
      invalidReason:
        outcome.kind === "killed"
          ? `controller killed the VM: ${outcome.why}`
          : outcome.kind === "ok"
            ? "no DONE sentinel"
            : JSON.stringify(outcome),
    };
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
  const stopped = bool(meta, "stopRequested");
  return {
    n: opts.n,
    phase: opts.phase,
    dirName,
    valid: true,
    agentExit,
    agentVerdict: opts.runAgent ? agentVerdict(session, treeChanged, agentExit ?? -1, stopped) : null,
    stopReason: bridge.stopReason,
    interrupted: stopped,
    touchedFrozen: opts.phase === "agent" && treeChanged ? store.touchedFrozen(agent) : [],
    treeChanged,
    committed: bool(meta, "committed"),
    afterHead: meta.afterHead ?? "",
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

/** One coverage run: boots a VM, runs verify.coverageCommand in the test slot, then reads
 *  whatever lcov file it left on the shared workspace. Returns null when unmeasurable. */
export async function runCoverage(agent: store.Agent, n: number): Promise<Coverage | null> {
  const verify = agent.verify;
  if (!verify?.coverageCommand) return null;
  const r = await runIteration(agent, {
    n,
    phase: "coverage",
    runAgent: false,
    runTest: true,
    dirName: `coverage-${String(n).padStart(3, "0")}`,
    testCommandOverride: verify.coverageCommand,
  });
  if (!r.valid) return null;
  const lcov = findLcov(store.workspaceDir(agent.name));
  if (!lcov) return null;
  try {
    return parseLcov(readFileSync(lcov, "utf8"), verify.testFiles, store.workspaceDir(agent.name));
  } catch {
    return null;
  }
}

/** `yeet ask --name <n> "<question>"` — a conversation with the agent about its work. Same
 *  session, fresh VM, zero commits (the runner discards chat-phase edits). Returns the
 *  answer text and what the exchange cost. */
export async function runChat(
  agent: store.Agent,
  question: string,
  io: IterationIo,
  /** Ceiling for THIS question. Without one the chat path runs uncapped: the live watchdog in
   *  bridge.ts only fires when a budget is present, so an answer that never converges was
   *  bounded by the stall detector and the two-hour wall clock and nothing else.
   *
   *  Measured from zero rather than from the agent's lifetime spend, because a question is its
   *  own transaction — an agent that has already built a lot should not become unable to answer
   *  a question about what it built. */
  capUsd?: number,
): Promise<{ answer: string | null; costUsd: number; valid: boolean; reason?: string }> {
  const before = readSession(findSessionFile(join(store.agentDir(agent.name), "session")));
  const r = await runIteration(agent, {
    n: 0,
    phase: "chat",
    runAgent: true,
    runTest: false,
    dirName: `chat-${Date.now().toString(36)}`,
    prompt: chatPrompt(agent, question),
    io,
    budget: capUsd ? { capUsd, spentBeforeUsd: 0 } : undefined,
  });
  if (!r.valid) return { answer: null, costUsd: 0, valid: false, reason: r.invalidReason };
  return {
    answer: r.session.finalMessage,
    costUsd: costDelta({ file: before.file, costUsd: before.costUsd }, r.session),
    valid: true,
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
 *  cost far less than another whole VM round trip.
 *
 *  The register here is deliberately flat. Personality belongs to yeet's own strings
 *  (voice.ts), not to the prompt of the thing writing code — with ONE scoped exception: how
 *  ask_user questions may open when the task itself is off. That is where "you sure you want
 *  me to make this?" comes from, and it is the only personality the worker is permitted. */
/**
 * The prompt for a plain build — `yeet "<task>"` and every follow-up.
 *
 * Deliberately says nothing about tests. Nothing will run them on this path, and instructing an
 * agent to register verification that is then never used is how the follow-up trap worked: the
 * command got bound, inherited by the next task, and its stale green reported as a pass.
 *
 * `verifyPrompt` (used by `yeet verify`) is where testing is asked for, in detail, at the moment
 * it is actually going to happen.
 */
export function buildPrompt(agent: store.Agent, dirName: string, task?: string): string {
  const lines = [
    task ?? agent.task,
    "",
    `You are in /yeet/workspace, a git repository on branch ${agent.branch}.`,
    "",
    "Before you build: if the task is ambiguous or a real decision has more than one defensible",
    "answer, use the ask_user tool first. Ask at most a few sharp questions, always with options",
    "and a recommended answer. If the task is vague or plain silly, you may open your question",
    "with one dry line — then get to work. Do not ask about things you can decide yourself.",
    "",
    "Build the thing and make sure it actually runs. You are not being asked to write a test",
    "suite right now, and nothing will run one after you finish — so do not spend the user's",
    "time on scaffolding they did not ask for. If tests already exist, keep them working.",
    "",
    `Before you finish, write /yeet/${dirName}/summary.md: 2-4 plain sentences saying what the`,
    "thing does and the exact command to run it. No jargon, no markdown headings. Someone who",
    "does not read code should be able to use it from that alone.",
  ];
  return lines.join("\n");
}

export function firstPrompt(agent: store.Agent, dirName: string): string {
  const lines = [
    agent.task,
    "",
    `You are in /yeet/workspace, a git repository on branch ${agent.branch}.`,
    "",
    "Before you build: if the task is ambiguous or a real decision has more than one defensible",
    "answer, use the ask_user tool first. Ask at most a few sharp questions, always with options",
    "and a recommended answer. If the task is vague or plain silly, you may open your question",
    "with one dry line — then get to work. Do not ask about things you can decide yourself.",
    "",
    // Telling a model to "write tests" is close to a no-op — measured across frontier models,
    // test-writing rates do not distinguish solved tasks from failed ones, and what gets
    // written is mostly value-printing rather than assertions. What moves the number is saying
    // concretely what a real suite DOES. Hence the specifics below rather than an exhortation.
    "Verification is not optional and the user does not have to ask for it. Early on, register",
    "how your work gets proven with the set_verify tool: one shell command that exits 0 only",
    "when the work is correct. If the workspace already has a test setup, use it; otherwise",
    "write the tests as part of the job.",
    "",
    "What the tests have to actually do:",
    "  - Exercise the REAL entry point, end to end — not only internal functions. For a CLI,",
    "    spawn the built binary as a subprocess and assert its exit code and its stdout. For an",
    "    HTTP service, make a real request and read the result back out. For a page, load the",
    "    built page and assert no console errors. For a library, import from the package entry",
    "    point, not from a source path.",
    "  - Include at least one test that uses two features together, in sequence. Every feature",
    "    passing alone while nothing works in combination is the most common way this fails.",
    "  - Assert on real values. A test that only checks a mock was called proves nothing.",
    "  - Cover the error paths, not just the happy one.",
    "",
    "Also register testFiles globs and a coverageCommand that writes lcov.info when the stack",
    "can produce one (e.g. `bun test --coverage --coverage-reporter=lcov --coverage-dir=.`).",
    "RUN that command yourself and confirm an lcov.info actually appears in the workspace —",
    "several runners accept the flags and silently write nothing, or write somewhere else. A",
    "coverage command that produces no file is worse than none: yeet reports that it could not",
    "measure, and nobody can tell whether the tests are thin or the command was wrong. If the",
    "stack genuinely cannot produce one, say so in your summary rather than leaving it empty.",
    "",
    "Watch for runners that exit 0 when they collect NO tests — confirm your command actually",
    "fails when the tests fail, not merely when they are absent.",
    "",
    "After every iteration yeet runs the registered command in a fresh VM; it must exit 0.",
    "Run it yourself before you finish.",
    "",
    "Do not weaken or rewrite tests that existed before you started to make them pass — yeet",
    "fingerprints those and will flag it. If a pre-existing test is wrong, say so via ask_user.",
    "",
    // The register matters as much as the length: this text is read aloud in yeet's wrap-up,
    // so a markdown document with headings and a "Verification" section reads as a foreign
    // object dropped into the terminal. Two sentences of plain prose land better than four.
    `Before you finish, write /yeet/${dirName}/summary.md — plain prose, 2-3 sentences, no`,
    "markdown, no headings, no bullet points, no title. Say what the thing DOES and what it is",
    "for. Do NOT give shell commands, file paths, or instructions like \"run this from the repo",
    "root\" — the person reading has no idea where any of this lives and never needs to: yeet",
    "runs things for them. Skip the testing; that is assumed and reported separately. Write it",
    "the way you'd tell a competent colleague in passing: matter-of-fact, no salesmanship, no",
    `"I have successfully implemented".`,
    "",
    "Do not commit; yeet commits for you after you stop.",
  ];
  return lines.join("\n");
}

/** Iteration N gets only the delta. pi's session already holds every file it read and every
 *  edit it made, so re-narrating that would be redundant and expensive. The full log stays at a
 *  stable guest path — the prompt is an index into it, not a container for it. */
export function retryPrompt(prev: IterationResult, agent: store.Agent, dirName: string): string {
  if (!agent.verify) {
    return [
      "You have not registered verification yet, and yeet will not call this done until you do.",
      "Use the set_verify tool NOW: the command that proves the work, testFiles globs, and a",
      "coverageCommand if the stack supports lcov. Write tests first if none exist.",
      "",
      `Then continue the task. Before you finish, update /yeet/${dirName}/summary.md.`,
    ].join("\n");
  }

  const clean = prev.testLog.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = clean.split("\n");
  const tail = lines.slice(-120);
  const head = lines.slice(0, 20);
  const headMatters = head.some((l) => /error|cannot find|no such file|Traceback|ModuleNotFound/i.test(l));
  const excerpt = (headMatters ? [...head, "…", ...tail] : tail).join("\n").slice(-4096);

  return [
    `The verifier ran \`${agent.verify.command}\` in /yeet/workspace on your last change.`,
    `It FAILED (exit ${prev.testExit}).`,
    "",
    "--- output (truncated) ---",
    excerpt,
    "--- end ---",
    "",
    `Full output: /yeet/${prev.dirName}/test.log  (read it if you need more)`,
    prev.committed
      ? `Your last change was committed: ${prev.filesChanged} file(s), +${prev.insertions}/-${prev.deletions}.`
      : "You made no committed change last time.",
    "",
    `Fix the failures. Before you finish, update /yeet/${dirName}/summary.md (2-4 plain sentences).`,
  ].join("\n");
}

function chatPrompt(agent: store.Agent, question: string): string {
  return [
    "The person you built this for has a question about the work. Answer it in plain text.",
    "Do NOT modify any files — this is a conversation, not a work order (any edits you make",
    "will be discarded). Read the workspace if you need to check something.",
    "",
    "Answer like a seasoned developer explaining to a smart friend: direct, concrete, no",
    "jargon unless they used it first, a little dry wit welcome.",
    "",
    `Question: ${question}`,
  ].join("\n");
}
