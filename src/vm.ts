/**
 * vm.ts — boot one microVM and classify how it ended.
 *
 * Two things the spike got wrong, both on the same line
 * (`spawnSync(AGENT_BIN, [...], {stdio: ["ignore","inherit","ignore"]})`):
 *
 *   * No timeout — a wedged guest hangs the host forever.
 *   * stderr discarded — libkrun's own failures (missing DYLD_LIBRARY_PATH, entitlement
 *     problems, bad config) become invisible, which is precisely the class of failure you
 *     most need to see.
 */
import { createWriteStream, writeFileSync } from "node:fs";
import { LAUNCHER, launcherEnv } from "./host";

export type VmOutcome =
  | { kind: "ok"; exitCode: number }
  | { kind: "launcher_config"; exitCode: 64 }
  | { kind: "guest_init"; exitCode: 125 | 126 | 127; reason: string }
  | { kind: "timeout"; afterMs: number };

export type VmOptions = {
  root: string;
  mounts?: Record<string, string>;
  env?: Record<string, string>;
  workdir?: string;
  cpus?: number;
  memMib?: number;
  /** Guest console output, captured to a host file rather than the terminal. */
  consolePath?: string;
  /** Launcher stderr — libkrun device chatter plus any real setup failure. */
  stderrPath: string;
  timeoutMs: number;
  /** Polled while the VM runs. Returning true drops the STOP sentinel, which the in-guest
   *  watchdog turns into a SIGTERM for the agent. Used to enforce the cost cap *during* an
   *  iteration — checking only between iterations lets one long run overrun the cap without
   *  limit (measured: $1.15 spent against a $1.00 cap). */
  budget?: { check: () => boolean; stopFile: string; intervalMs?: number };
};

/** libkrun reserves these for its in-guest init; documented at libkrun.h:1377. Because our
 *  runner always exits 0 once it has written DONE, these are never ambiguous. */
const GUEST_INIT_FAILURES: Record<number, string> = {
  125: "guest init could not set up the environment inside the microVM",
  126: "guest init found the executable but could not execute it",
  127: "guest init could not find the executable",
};

export async function runVM(opts: VmOptions, argv: string[]): Promise<VmOutcome> {
  const args: string[] = ["--root", opts.root];
  for (const [tag, path] of Object.entries(opts.mounts ?? {})) args.push("--mount", `${tag}=${path}`);
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);
  if (opts.workdir) args.push("--workdir", opts.workdir);
  if (opts.cpus) args.push("--cpus", String(opts.cpus));
  if (opts.memMib) args.push("--mem", String(opts.memMib));
  if (opts.consolePath) args.push("--console", opts.consolePath);
  args.push("--", ...argv);

  const stderr = createWriteStream(opts.stderrPath);
  const started = Date.now();

  const proc = Bun.spawn([LAUNCHER, ...args], {
    env: { ...process.env, ...launcherEnv() },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });

  const pump = (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) stderr.write(chunk);
  })();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9); // the backstop for a wedged guest; in-guest `timeout` handles the soft cases
  }, opts.timeoutMs);

  // Ask the guest to stop rather than killing the VM: a kill would discard this iteration's
  // commit, losing every minute of work the agent had already done.
  let budgetTimer: ReturnType<typeof setInterval> | undefined;
  if (opts.budget) {
    const { check, stopFile, intervalMs = 3000 } = opts.budget;
    budgetTimer = setInterval(() => {
      try {
        if (check()) {
          writeFileSync(stopFile, "");
          clearInterval(budgetTimer);
        }
      } catch {
        /* a torn session file mid-write is expected; try again next tick */
      }
    }, intervalMs);
  }

  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (budgetTimer) clearInterval(budgetTimer);
  await pump.catch(() => {});
  stderr.end();

  if (timedOut) return { kind: "timeout", afterMs: Date.now() - started };
  if (exitCode === 64) return { kind: "launcher_config", exitCode: 64 };
  if (exitCode in GUEST_INIT_FAILURES) {
    const code = exitCode as 125 | 126 | 127;
    return { kind: "guest_init", exitCode: code, reason: GUEST_INIT_FAILURES[code]! };
  }
  return { kind: "ok", exitCode };
}
