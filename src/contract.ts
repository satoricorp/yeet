/**
 * contract.ts — the host<->guest wire.
 *
 * Design rule: **the guest writes facts, the host writes JSON.**
 *
 * The guest emits a strict key=value file whose values are restricted to a safe alphabet
 * (SHAs, integers, enum tokens), plus raw byte-exact log files. The host assembles the typed
 * result. Free text crosses the boundary ONLY as file contents, never as a serialized value.
 *
 * That is not stylistic. The guest image has no jq and no python3, so any JSON it emitted
 * would be hand-rolled shell escaping over arbitrary bytes — a guaranteed bug the first time
 * a test failure contains a quote or a backslash. It also runs in the other direction: the
 * prompt, commit message, and test command are files, not env values or argv, because
 * libkrun's argv transport corrupts arguments containing both '"' and '$' (see yeet-vm.c).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Values are restricted to this alphabet so a malformed/injected line is detectable rather
 *  than silently becoming a field. Anything else means the runner is broken — treat the whole
 *  iteration as infrastructure failure rather than trusting a partial result. */
const SAFE_VALUE = /^[A-Za-z0-9._:/+=-]*$/;

/**
 * chat: the agent talks (yeet ask), and the runner discards any file changes after.
 * coverage: run a coverage command in test-cmd.sh's slot; no agent, no commit, no cleanup —
 * the host reads the lcov artifact off the shared workspace afterwards.
 * ablation: blank the implementation and re-run the tests. A suite that still passes was
 *   never testing the code — mutation testing with a single maximally destructive mutant.
 */
export type Phase = "baseline" | "agent" | "confirm" | "chat" | "coverage" | "ablation";

export type IterationRequest = {
  runId: string;
  iteration: number;
  phase: Phase;
  runAgent: boolean;
  runTest: boolean;
  model: string;
  /** Guest-absolute. Empty on the first attempt; a populated dir makes pi resume with -c. */
  sessionDir: string;
  baseHead: string;
  /** Free text — written to prompt.txt, never passed as argv or env. */
  prompt?: string;
  commitMessage?: string;
  /** Arbitrary shell — written to test-cmd.sh and exec'd via bash. */
  testCommand?: string;
};

export type Meta = Record<string, string>;

/** Write everything the in-guest runner needs. Paths handed to the guest are guest-absolute
 *  (/yeet/...), never host paths — the guest has no notion of where the host mounted this. */
export function writeRequest(iterDir: string, guestIterDir: string, req: IterationRequest): void {
  // No timeout values cross the wire anymore: liveness is the CLI controller's job. It watches
  // the shared mount for activity and kills the VM itself — a fuse inside the guest can't know
  // that a human is mid-answer on a question, and the controller can.
  const env = [
    "YEET_SCHEMA=yeet.request/2",
    `YEET_RUN_ID=${req.runId}`,
    `YEET_ITER=${String(req.iteration).padStart(3, "0")}`,
    `YEET_DIR=${guestIterDir}`,
    `YEET_PHASE=${req.phase}`,
    `YEET_RUN_AGENT=${req.runAgent ? 1 : 0}`,
    `YEET_RUN_TEST=${req.runTest ? 1 : 0}`,
    `YEET_WORKSPACE=/yeet/workspace`,
    `YEET_MODEL=${req.model}`,
    `YEET_SESSION_DIR=${req.sessionDir}`,
    `YEET_BASE_HEAD=${req.baseHead}`,
  ].join("\n");
  writeFileSync(join(iterDir, "request.env"), env + "\n", { mode: 0o600 });

  if (req.prompt !== undefined) writeFileSync(join(iterDir, "prompt.txt"), req.prompt);
  if (req.commitMessage !== undefined) writeFileSync(join(iterDir, "commit-msg.txt"), req.commitMessage);
  if (req.testCommand !== undefined) {
    writeFileSync(join(iterDir, "test-cmd.sh"), req.testCommand + "\n", { mode: 0o700 });
  }
}

/** The runner creates DONE last, by atomic rename, after fsync. Its absence means the result
 *  is not trustworthy no matter what else is on disk. */
export function sawDone(iterDir: string): boolean {
  return existsSync(join(iterDir, "DONE"));
}

export class ContractError extends Error {}

export function readMeta(iterDir: string): Meta {
  const path = join(iterDir, "meta.kv");
  if (!existsSync(path)) throw new ContractError("meta.kv missing");

  const meta: Meta = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new ContractError(`malformed meta.kv line: ${line}`);
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!SAFE_VALUE.test(value)) {
      throw new ContractError(`meta.kv value for "${key}" left the safe alphabet: ${value}`);
    }
    meta[key] = value;
  }
  if (meta.schema !== "yeet.meta/1") {
    throw new ContractError(`unexpected meta schema: ${meta.schema ?? "(none)"}`);
  }
  return meta;
}

export const num = (meta: Meta, key: string, fallback = 0): number => {
  const v = meta[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const bool = (meta: Meta, key: string): boolean => meta[key] === "1";
