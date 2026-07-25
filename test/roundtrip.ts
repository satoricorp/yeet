#!/usr/bin/env bun
/**
 * roundtrip.ts — prove the whole machine except the LLM.
 *
 * clone image -> stage a request -> boot -> guest runs a verify command -> guest writes
 * meta.kv + DONE -> host parses it. No tokens spent, which is the property you want when the
 * expensive component is the nondeterministic one.
 *
 *   bun test/roundtrip.ts
 */
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cloneTree, tryLock, CURRENT_IMAGE, YEET_HOME } from "../src/host";
import { writeRequest, readMeta, sawDone, num, bool, ContractError } from "../src/contract";
import { runVM } from "../src/vm";

const SCRATCH = join(YEET_HOME, "scratch-roundtrip");
const REPO_ROOT = new URL("..", import.meta.url).pathname;

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  \x1b[32m✓\x1b[0m" : "  \x1b[31m✗\x1b[0m"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function iteration(name: string, testCommand: string, expectExit: number) {
  console.log(`\n\x1b[36m▪\x1b[0m ${name}`);
  const runDir = join(SCRATCH, name);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true, mode: 0o700 });

  // run state (mounted at guest /yeet)
  const iterDir = join(runDir, "iter-000");
  const workspace = join(runDir, "workspace");
  mkdirSync(iterDir, { recursive: true });
  mkdirSync(join(runDir, "bin"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  copyFileSync(join(REPO_ROOT, "guest/yeet-run"), join(runDir, "bin/yeet-run"));
  Bun.spawnSync(["chmod", "+x", join(runDir, "bin/yeet-run")]);

  // a real git repo, so the commit/tree-SHA machinery is exercised
  for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
    Bun.spawnSync(["git", "-C", workspace, ...args]);
  }
  writeFileSync(join(workspace, "seed.txt"), "seed\n");
  Bun.spawnSync(["git", "-C", workspace, "add", "-A"]);
  Bun.spawnSync(["git", "-C", workspace, "commit", "-qm", "seed"]);
  const baseHead = Bun.spawnSync(["git", "-C", workspace, "rev-parse", "HEAD"]).stdout.toString().trim();

  writeRequest(iterDir, "/yeet/iter-000", {
    runId: "smoke",
    iteration: 0,
    phase: "baseline",
    runAgent: false, // <- no LLM
    runTest: true,
    model: "none",
    sessionDir: "/yeet/session",
    baseHead,
    agentTimeoutS: 60,
    testTimeoutS: 60,
    testCommand,
  });

  // per-iteration rootfs
  const rootfs = join(runDir, "rootfs");
  const t0 = Date.now();
  cloneTree(CURRENT_IMAGE, rootfs);
  const cloneMs = Date.now() - t0;

  const t1 = Date.now();
  const outcome = await runVM(
    {
      root: rootfs,
      mounts: { yeet: runDir },
      env: { YEET_DIR: "/yeet/iter-000" },
      workdir: "/yeet/workspace",
      stderrPath: join(iterDir, "vm.stderr"),
      timeoutMs: 120_000,
    },
    ["/usr/local/bin/yeet-init", "/yeet/bin/yeet-run"],
  );
  const bootMs = Date.now() - t1;

  check("clone + boot", outcome.kind === "ok", `clone ${cloneMs}ms, vm ${bootMs}ms, ${JSON.stringify(outcome)}`);
  check("runner exited 0 (DONE written ⇒ always 0)", outcome.kind === "ok" && outcome.exitCode === 0);
  check("DONE sentinel present", sawDone(iterDir));

  try {
    const meta = readMeta(iterDir);
    check("meta.kv parses + passes the safe-alphabet check", true);
    check(`testExit is ${expectExit}`, num(meta, "testExit", -1) === expectExit, `got ${meta.testExit}`);
    check("no agent ran", meta.agentRan === "0");
    check("tree unchanged (no agent ⇒ no commit)", !bool(meta, "treeChanged"));
    check("beforeHead recorded", (meta.beforeHead ?? "").length === 40, meta.beforeHead);
    const log = Bun.file(join(iterDir, "test.log"));
    check("test.log captured", existsSync(join(iterDir, "test.log")) && log.size >= 0, `${log.size} bytes`);
  } catch (e) {
    check("meta.kv parses", false, e instanceof ContractError ? e.message : String(e));
  }
}

async function main() {
  if (!existsSync(CURRENT_IMAGE)) {
    console.error("no image — run guest/setup.sh first");
    process.exit(1);
  }
  mkdirSync(SCRATCH, { recursive: true });

  console.log("\x1b[1myeet round trip (no LLM)\x1b[0m");

  await iteration("green", "echo all-good; exit 0", 0);
  await iteration("red", "echo boom >&2; exit 1", 1);
  // 127 is the "verify command is broken" signal iteration 0 aborts on, rather than letting
  // the agent chase a phantom for the whole budget.
  await iteration("broken-verify", "definitely-not-a-real-command", 127);

  console.log("\n\x1b[36m▪\x1b[0m flock liveness");
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
