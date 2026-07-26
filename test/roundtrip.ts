#!/usr/bin/env bun
/**
 * roundtrip.ts — prove the whole machine except the LLM.
 *
 * clone image -> stage a request -> boot -> guest runs -> guest writes meta.kv + DONE ->
 * host parses it. No tokens spent, which is the property you want when the expensive
 * component is the nondeterministic one.
 *
 * The fake-pi harness is what makes the interactive era testable: /yeet/bin comes first on
 * the guest PATH, so a shell script staged as bin/pi stands in for the real agent. That
 * covers the question bridge, mid-iteration verify binding, the STOP escalation, the
 * chat-phase discard, and the commit machinery — every moving part but the model.
 *
 *   bun test/roundtrip.ts
 */
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cloneTree, tryLock, CURRENT_IMAGE, YEET_HOME } from "../src/host";
import { writeRequest, readMeta, sawDone, num, bool, ContractError, type Phase, type Meta } from "../src/contract";
import { runVM, type VmOutcome } from "../src/vm";
import { Bridge, type VerifyDecision } from "../src/bridge";
import { parseLcov } from "../src/coverage";

const SCRATCH = join(YEET_HOME, "scratch-roundtrip");
const REPO_ROOT = new URL("..", import.meta.url).pathname;

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  \x1b[32m✓\x1b[0m" : "  \x1b[31m✗\x1b[0m"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

type GuestRun = {
  outcome: VmOutcome;
  meta: Meta | null;
  done: boolean;
  iterDir: string;
  workspace: string;
  bridge: Bridge;
};

async function runGuest(
  name: string,
  opts: {
    phase: Phase;
    runAgent: boolean;
    runTest: boolean;
    testCommand?: string;
    fakePi?: string;
    stallMs?: number;
    onVerify?: (iterDir: string) => VerifyDecision;
    timeoutMs?: number;
  },
): Promise<GuestRun> {
  const runDir = join(SCRATCH, name);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true, mode: 0o700 });

  const iterDir = join(runDir, "iter-000");
  const workspace = join(runDir, "workspace");
  mkdirSync(iterDir, { recursive: true });
  mkdirSync(join(iterDir, "qa"), { recursive: true });
  mkdirSync(join(runDir, "bin"), { recursive: true });
  mkdirSync(join(runDir, "session"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  copyFileSync(join(REPO_ROOT, "guest/yeet-run"), join(runDir, "bin/yeet-run"));
  Bun.spawnSync(["chmod", "+x", join(runDir, "bin/yeet-run")]);
  if (opts.fakePi) {
    writeFileSync(join(runDir, "bin/pi"), opts.fakePi);
    Bun.spawnSync(["chmod", "+x", join(runDir, "bin/pi")]);
  }

  // a real git repo, so the commit/tree-SHA machinery is exercised
  for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
    Bun.spawnSync(["git", "-C", workspace, ...args]);
  }
  writeFileSync(join(workspace, "seed.txt"), "seed\n");
  writeFileSync(join(workspace, "seed.test.js"), "// pre-existing test\n");
  Bun.spawnSync(["git", "-C", workspace, "add", "-A"]);
  Bun.spawnSync(["git", "-C", workspace, "commit", "-qm", "seed"]);
  const baseHead = Bun.spawnSync(["git", "-C", workspace, "rev-parse", "HEAD"]).stdout.toString().trim();

  writeRequest(iterDir, "/yeet/iter-000", {
    runId: "smoke",
    iteration: 0,
    phase: opts.phase,
    runAgent: opts.runAgent,
    runTest: opts.runTest,
    model: "none",
    sessionDir: "/yeet/session",
    baseHead,
    prompt: opts.runAgent ? "fake task" : undefined,
    commitMessage: opts.phase === "agent" ? "yeet: fake iteration" : undefined,
    testCommand: opts.testCommand,
  });

  const bridge = new Bridge({
    iterDir,
    sessionDir: join(runDir, "session"),
    stallMs: opts.stallMs ?? 10 * 60 * 1000,
    agentPhase: opts.runAgent,
    onAsk: async (q) => q.recommended,
    onVerify: async (v) => {
      const decision = opts.onVerify
        ? opts.onVerify(iterDir)
        : { command: v.command, testFiles: v.testFiles, coverageCommand: v.coverageCommand };
      if (opts.runTest) writeFileSync(join(iterDir, "test-cmd.sh"), decision.command + "\n", { mode: 0o700 });
      return decision;
    },
    tickMs: 250,
  });

  const rootfs = join(runDir, "rootfs");
  cloneTree(CURRENT_IMAGE, rootfs);
  const outcome = await runVM(
    {
      root: rootfs,
      mounts: { yeet: runDir },
      env: { YEET_DIR: "/yeet/iter-000" },
      workdir: "/yeet/workspace",
      stderrPath: join(iterDir, "vm.stderr"),
      timeoutMs: opts.timeoutMs ?? 120_000,
      watcher: bridge,
    },
    ["/usr/local/bin/yeet-init", "/yeet/bin/yeet-run"],
  );
  rmSync(rootfs, { recursive: true, force: true });

  let meta: Meta | null = null;
  const done = sawDone(iterDir);
  if (done) {
    try {
      meta = readMeta(iterDir);
    } catch (e) {
      check(`${name}: meta.kv parses`, false, e instanceof ContractError ? e.message : String(e));
    }
  }
  return { outcome, meta, done, iterDir, workspace, bridge };
}

// ── the original no-agent verify paths ────────────────────────────────────────────────────

async function baselines() {
  for (const [name, testCommand, expectExit] of [
    ["green", "echo all-good; exit 0", 0],
    ["red", "echo boom >&2; exit 1", 1],
    // 127 is the "verify command is broken" signal iteration 0 aborts on, rather than letting
    // the agent chase a phantom for the whole budget.
    ["broken-verify", "definitely-not-a-real-command", 127],
  ] as const) {
    console.log(`\n\x1b[36m▪\x1b[0m baseline: ${name}`);
    const t0 = Date.now();
    const r = await runGuest(`baseline-${name}`, { phase: "baseline", runAgent: false, runTest: true, testCommand });
    check("clone + boot + DONE", r.outcome.kind === "ok" && r.done, `${Date.now() - t0}ms, ${JSON.stringify(r.outcome)}`);
    if (!r.meta) continue;
    check(`testExit is ${expectExit}`, num(r.meta, "testExit", -1) === expectExit, `got ${r.meta.testExit}`);
    check("no agent ran", r.meta.agentRan === "0");
    check("tree unchanged (no agent ⇒ no commit)", !bool(r.meta, "treeChanged"));
    check("test.log captured", existsSync(join(r.iterDir, "test.log")));
  }
}

// ── fake-pi: the interactive era ──────────────────────────────────────────────────────────

async function askRoundTrip() {
  console.log(`\n\x1b[36m▪\x1b[0m ask_user round trip (fake pi)`);
  const fakePi = `#!/bin/bash
# fake pi: asks a question via the qa/ protocol, acts on the answer, edits the workspace.
D="$YEET_DIR"
mkdir -p "$D/qa"
cat > "$D/qa/001.ask.json.tmp" <<'EOF'
{"id":"001","kind":"ask","question":"File or database?","options":["file","sqlite"],"recommended":"file"}
EOF
mv "$D/qa/001.ask.json.tmp" "$D/qa/001.ask.json"
for i in $(seq 1 200); do [ -f "$D/qa/001.answer.json" ] && break; sleep 0.3; done
[ -f "$D/qa/001.answer.json" ] || exit 3
grep -o '"answer"[^,}]*' "$D/qa/001.answer.json" > answer.txt
exit 0
`;
  const r = await runGuest("ask", { phase: "agent", runAgent: true, runTest: false, fakePi });
  check("run completed", r.outcome.kind === "ok" && r.done, JSON.stringify(r.outcome));
  check("bridge answered with the recommendation", r.bridge.qa.length === 1 && r.bridge.qa[0]?.answer === "file");
  const answerFile = join(r.workspace, "answer.txt");
  check("guest saw the answer", existsSync(answerFile) && readFileSync(answerFile, "utf8").includes("file"));
  if (r.meta) {
    check("agent exited 0", num(r.meta, "agentExit", -1) === 0);
    check("edit was committed", bool(r.meta, "committed"));
    check("tree changed", bool(r.meta, "treeChanged"));
  }
}

async function verifyLateBinding() {
  console.log(`\n\x1b[36m▪\x1b[0m set_verify binds mid-iteration (fake pi)`);
  const fakePi = `#!/bin/bash
D="$YEET_DIR"
mkdir -p "$D/qa"
printf '%s' '{"id":"001","kind":"verify","command":"exit 7","testFiles":["*.test.js"],"coverageCommand":null}' > "$D/qa/001.verify.json.tmp"
mv "$D/qa/001.verify.json.tmp" "$D/qa/001.verify.json"
for i in $(seq 1 200); do [ -f "$D/qa/001.answer.json" ] && break; sleep 0.3; done
[ -f "$D/qa/001.answer.json" ] || exit 3
exit 0
`;
  // The host EDITS the proposal ("exit 7" -> echo) — proving the decision, not the proposal,
  // is what binds. No test-cmd.sh was staged at request time; runTest=1 picks it up late.
  const r = await runGuest("verify-bind", {
    phase: "agent", runAgent: true, runTest: true, fakePi,
    onVerify: () => ({ command: "echo verified-ok", testFiles: ["*.test.js"], coverageCommand: null }),
  });
  check("run completed", r.outcome.kind === "ok" && r.done, JSON.stringify(r.outcome));
  if (r.meta) {
    check("late-bound verify ran and passed", num(r.meta, "testExit", -1) === 0, `testExit=${r.meta.testExit}`);
  }
  const log = join(r.iterDir, "test.log");
  check("verify output captured", existsSync(log) && readFileSync(log, "utf8").includes("verified-ok"));
}

async function stallEscalation() {
  console.log(`\n\x1b[36m▪\x1b[0m stall ⇒ STOP ⇒ graceful wrap-up (fake pi, silent)`);
  const fakePi = `#!/bin/bash
sleep 300
exit 0
`;
  const t0 = Date.now();
  const r = await runGuest("stall", {
    phase: "agent", runAgent: true, runTest: false, fakePi,
    stallMs: 4000, timeoutMs: 90_000,
  });
  check("controller dropped STOP for stall", r.bridge.stopReason === "stall");
  check("guest wrapped up gracefully (DONE, exit 0)", r.outcome.kind === "ok" && r.done, `${Date.now() - t0}ms, ${JSON.stringify(r.outcome)}`);
  if (r.meta) {
    check("runner recorded the stop", bool(r.meta, "stopRequested"));
    check("agent was terminated, not finished", num(r.meta, "agentExit", 0) !== 0);
  }
}

async function chatDiscards() {
  console.log(`\n\x1b[36m▪\x1b[0m chat phase leaves no fingerprints (fake pi)`);
  const fakePi = `#!/bin/bash
echo "junk" > junk.txt
echo "the answer is 42"
exit 0
`;
  const r = await runGuest("chat", { phase: "chat", runAgent: true, runTest: false, fakePi });
  check("run completed", r.outcome.kind === "ok" && r.done, JSON.stringify(r.outcome));
  check("workspace edit was discarded", !existsSync(join(r.workspace, "junk.txt")));
  if (r.meta) {
    check("tree unchanged", !bool(r.meta, "treeChanged"));
    check("nothing committed", !bool(r.meta, "committed"));
  }
}

// ── pure host-side units ──────────────────────────────────────────────────────────────────

function lcovUnit() {
  console.log(`\n\x1b[36m▪\x1b[0m lcov parsing`);
  const fixture = [
    "SF:src/app.js", "DA:1,1", "DA:2,0", "LF:2", "LH:1", "end_of_record",
    "SF:src/lib.js", "DA:1,1", "DA:2,1", "LF:2", "LH:2", "end_of_record",
    "SF:app.test.js", "DA:1,1", "LF:1", "LH:1", "end_of_record",
  ].join("\n");
  const cov = parseLcov(fixture, ["*.test.js"]);
  check("parses", cov !== null);
  if (cov) {
    check("test files excluded from the denominator", cov.totalLines === 4, `total=${cov.totalLines}`);
    check("percentage is right", cov.pct === 75, `pct=${cov.pct}`);
    check("worst file sorts first", cov.files[0]?.path === "src/app.js");
  }
  check("empty lcov -> null", parseLcov("", []) === null);
}

async function main() {
  if (!existsSync(CURRENT_IMAGE)) {
    console.error("no image — run guest/setup.sh first");
    process.exit(1);
  }
  mkdirSync(SCRATCH, { recursive: true });

  console.log("\x1b[1myeet round trip (no LLM)\x1b[0m");

  await baselines();
  await askRoundTrip();
  await verifyLateBinding();
  await stallEscalation();
  await chatDiscards();
  lcovUnit();

  console.log(`\n\x1b[36m▪\x1b[0m flock liveness`);
  const lockPath = join(SCRATCH, ".lock");
  const a = tryLock(lockPath);
  check("first lock acquired", a !== null);
  check("second lock refused while held", tryLock(lockPath) === null);
  a?.release();
  const c = tryLock(lockPath);
  check("lock reacquired after release", c !== null);
  c?.release();

  rmSync(SCRATCH, { recursive: true, force: true });
  console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m" : `\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
