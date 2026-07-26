/**
 * vm.ts — boot one microVM and classify how it ended.
 *
 * Two things the spike got wrong, both on the same line
 * (`spawnSync(AGENT_BIN, [...], {stdio: ["ignore","inherit","ignore"]})`):
 *
 *   * No liveness control — a wedged guest hangs the host forever.
 *   * stderr discarded — libkrun's own failures (missing DYLD_LIBRARY_PATH, entitlement
 *     problems, bad config) become invisible, which is precisely the class of failure you
 *     most need to see.
 *
 * Liveness is a controller decision, not a fuse. The caller attaches a watcher (bridge.ts)
 * that observes the shared mount — session growth, log growth, questions waiting on a human —
 * and escalates on its own judgment: first a STOP file the guest honors gracefully (the
 * runner commits partial work and writes DONE), then, only if that is ignored, the kill
 * function handed to it here. timeoutMs stays as an absolute backstop for a guest that fools
 * the watcher by looking alive (e.g. spinning in a log-writing loop) without ever finishing.
 */
import { createWriteStream } from "node:fs";
import { LAUNCHER, launcherEnv } from "./host";

export type VmOutcome =
  | { kind: "ok"; exitCode: number }
  | { kind: "launcher_config"; exitCode: 64 }
  | { kind: "guest_init"; exitCode: 125 | 126 | 127; reason: string }
  | { kind: "killed"; why: string; afterMs: number }
  | { kind: "timeout"; afterMs: number };

/** Implemented by bridge.Bridge. start() receives the trigger that destroys the VM. */
export type VmWatcher = {
  start(kill: (why: string) => void): void;
  stop(): void;
};

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
  /** Absolute backstop only; real liveness decisions belong to the watcher. */
  timeoutMs: number;
  watcher?: VmWatcher;
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

  let killedWhy: string | null = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, opts.timeoutMs);

  opts.watcher?.start((why) => {
    if (killedWhy || timedOut) return;
    killedWhy = why;
    proc.kill(9);
  });

  const exitCode = await proc.exited;
  clearTimeout(timer);
  opts.watcher?.stop();
  await pump.catch(() => {});
  stderr.end();

  if (killedWhy) return { kind: "killed", why: killedWhy, afterMs: Date.now() - started };
  if (timedOut) return { kind: "timeout", afterMs: Date.now() - started };
  if (exitCode === 64) return { kind: "launcher_config", exitCode: 64 };
  if (exitCode in GUEST_INIT_FAILURES) {
    const code = exitCode as 125 | 126 | 127;
    return { kind: "guest_init", exitCode: code, reason: GUEST_INIT_FAILURES[code]! };
  }
  return { kind: "ok", exitCode };
}
