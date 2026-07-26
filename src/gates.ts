/**
 * gates.ts — the checks that make "green" mean something.
 *
 * Green currently means one thing: the command exited 0. It does NOT mean tests ran, that they
 * touch the code they claim to, or that they test what was asked for. Each gate here closes one
 * of those, and each exists because of a specific way green has already lied:
 *
 *   - A run reported "Ran 1 test" when the suite had nine — the file would not parse. It
 *     exited 1 so we caught it, but a runner that collects ZERO tests exits 0 in bun, go and
 *     cargo, which would have been a clean pass over nothing.
 *   - A page with 9/9 passing rendered dark text on a dark background. The suite asserted
 *     content-type and structure and never that a human could read it. No gate catches that
 *     one; it is what the human checkpoint is for.
 *
 * These are advisory, not blocking. A gate that halts a run on a parse it got wrong is worse
 * than the problem — so they annotate the result and let the human decide.
 */

export type TestCounts = { ran: number; passed: number; failed: number; skipped: number };

/**
 * Test counts out of raw runner output, across the runners the image can actually run.
 *
 * Returns null when nothing matches, and null must NOT be treated as zero: "I could not tell"
 * and "no tests ran" are opposite conclusions, and conflating them would fail every project
 * using a runner we do not recognise.
 */
export function parseCounts(log: string): TestCounts | null {
  const text = log.replace(/\x1b\[[0-9;]*m/g, "");

  // bun test  →  " 8 pass" / " 0 fail" / " 2 skip"
  const bunPass = text.match(/^\s*(\d+)\s+pass$/m);
  const bunFail = text.match(/^\s*(\d+)\s+fail$/m);
  if (bunPass && bunFail) {
    const passed = +bunPass[1]!, failed = +bunFail[1]!;
    const skipped = +(text.match(/^\s*(\d+)\s+skip$/m)?.[1] ?? 0);
    return { ran: passed + failed, passed, failed, skipped };
  }

  // node --test  →  "# pass 6" / "# fail 8" / "# skipped 0"
  const nPass = text.match(/^#\s*pass\s+(\d+)$/m);
  const nFail = text.match(/^#\s*fail\s+(\d+)$/m);
  if (nPass && nFail) {
    const passed = +nPass[1]!, failed = +nFail[1]!;
    return { ran: passed + failed, passed, failed, skipped: +(text.match(/^#\s*skipped\s+(\d+)$/m)?.[1] ?? 0) };
  }

  // pytest  →  "5 passed, 1 failed, 2 skipped in 0.3s"
  const py = text.match(/^=+\s*(.*?(?:passed|failed|error).*?)\s+in\s+[\d.]+s\s*=+$/m);
  if (py) {
    const grab = (w: string) => +(py[1]!.match(new RegExp(`(\\d+)\\s+${w}`))?.[1] ?? 0);
    const passed = grab("passed"), failed = grab("failed") + grab("error");
    return { ran: passed + failed, passed, failed, skipped: grab("skipped") };
  }

  // cargo test  →  "test result: ok. 8 passed; 0 failed; 1 ignored"
  const rust = text.match(/test result:.*?(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored/);
  if (rust) {
    const passed = +rust[1]!, failed = +rust[2]!;
    return { ran: passed + failed, passed, failed, skipped: +rust[3]! };
  }

  // vitest / jest  →  "Tests  8 passed (8)"  or  "Tests:  1 failed, 7 passed, 8 total"
  const vit = text.match(/^\s*Tests[:\s]+(.+)$/m);
  if (vit) {
    const grab = (w: string) => +(vit[1]!.match(new RegExp(`(\\d+)\\s+${w}`))?.[1] ?? 0);
    const passed = grab("passed"), failed = grab("failed");
    if (passed || failed) return { ran: passed + failed, passed, failed, skipped: grab("skipped") };
  }

  // go test  →  "ok  pkg 0.1s" per package; no counts, so only presence is knowable
  if (/^(ok|FAIL|---\s+FAIL)/m.test(text)) return null;

  return null;
}

/**
 * A stable fingerprint of WHICH tests are failing, so "busy but going nowhere" is detectable.
 *
 * The existing no-progress check compares tree hashes, which only catches an agent that edits
 * nothing or edits back to identical content. It misses the far more common shape: the agent
 * rewrites something every round, the tree differs every round, and the same four tests fail
 * every round. Without this, raising the round cap just buys more of that.
 *
 * Normalisation is the whole difficulty. Too little and every run looks unique because a
 * duration changed, so a real stall never fires. Too much and genuinely different failures
 * collapse together, so yeet gives up on an agent that was making progress. Timings, temp
 * paths, addresses and PIDs are noise; file:line is signal and stays.
 */
export function failureSignature(log: string): string | null {
  const text = log.replace(/\x1b\[[0-9;]*m/g, "");

  // Prefer the identities of the failing tests: stable against reordering and unrelated churn.
  const ids = new Set<string>();
  const patterns = [
    /^\s*\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/gm, // bun
    /^not ok \d+ - (.+?)(?:\s+#.*)?$/gm,            // node --test / TAP
    /^FAILED\s+(\S+)/gm,                            // pytest
    /^\s*---- (\S+) stdout ----$/gm,                // cargo
    /^\s*[×✗]\s+(.+?)(?:\s+\d+ms)?$/gm,             // vitest
    /^\s*✕\s+(.+?)(?:\s+\(\d+\s*ms\))?$/gm,         // jest
    /^--- FAIL: (\S+)/gm,                           // go
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) if (m[1]) ids.add(m[1].trim());

  if (ids.size > 0) return hash([...ids].sort().join("\n"));

  // No recognisable test identities — fall back to the shape of the tail, scrubbed of the
  // things that differ between two runs of the same failure.
  const tail = text
    .split("\n")
    .slice(-200)
    .join("\n")
    .replace(/\d+(\.\d+)?\s*(ms|µs|s|sec|seconds)\b/g, "T")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, "TS")
    .replace(/0x[0-9a-f]+/gi, "ADDR")
    .replace(/\/(?:tmp|var\/folders)\/[\w./-]+/g, "TMP")
    .replace(/\bpid[= ]\d+/gi, "PID")
    .replace(/\s+/g, " ")
    .trim();
  return tail ? hash(tail) : null;
}

/** FNV-1a. Not cryptographic — this only ever compares two of its own outputs. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export type Finding = { gate: string; detail: string };

/** Minimum tests before a pass is worth believing. Low on purpose — this catches "nothing
 *  ran", not "not enough coverage", and coverage is measured separately. */
const MIN_TESTS = 2;

/**
 * The zero-test guard. `bun test` with no test files exits 0. So does `go test ./...` with
 * none, and `cargo test`. `go test -run NoSuchTest` passes too. A green exit code is simply
 * not evidence that anything was checked.
 */
export function checkCounts(log: string): Finding[] {
  const c = parseCounts(log);
  if (!c) return []; // unrecognised runner — say nothing rather than guess
  const out: Finding[] = [];
  if (c.ran === 0) {
    out.push({ gate: "zero-tests", detail: "the suite passed without running a single test" });
  } else if (c.ran < MIN_TESTS) {
    out.push({ gate: "thin-suite", detail: `only ${c.ran} test ran` });
  }
  if (c.skipped > 0) {
    out.push({ gate: "skipped", detail: `${c.skipped} test${c.skipped === 1 ? " was" : "s were"} skipped` });
  }
  return out;
}

/** Things that turn red green by changing the rules rather than the code. Grepped against the
 *  diff of an iteration, so it only fires on what the agent actually just did. */
const CHEATS: Array<[RegExp, string]> = [
  [/ignoreBuildErrors\s*:\s*true/, "typescript.ignoreBuildErrors disables type checking at build"],
  [/ignoreDuringBuilds\s*:\s*true/, "eslint.ignoreDuringBuilds disables linting at build"],
  [/@ts-nocheck/, "@ts-nocheck disables type checking for a whole file"],
  [/#\s*type:\s*ignore/, "# type: ignore silences a type error"],
  [/\b(?:it|test|describe)\.only\(|\bfdescribe\(|\bfit\(/, "an .only() leaves the rest of the suite unrun"],
  [/@pytest\.mark\.skip|\bt\.Skip\(|#\[ignore\]/, "a test was marked skipped"],
  [/--passWithNoTests|--pass-with-no-tests/, "--passWithNoTests makes an empty suite exit 0"],
  [/\|\|\s*true\b|;\s*exit\s+0\b/, "|| true or ; exit 0 discards the real exit code"],
];

/** Scan added lines only — a pre-existing `.only` is not this iteration's doing. */
export function checkCheats(diff: string): Finding[] {
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
  const out: Finding[] = [];
  for (const [re, detail] of CHEATS) if (re.test(added)) out.push({ gate: "cheat-config", detail });
  return out;
}

/**
 * Which of the changed files are implementation rather than tests. Used by the ablation check:
 * blank these, and a suite that still passes was never testing them.
 */
export function implementationFiles(changed: string[], testGlobs: string[]): string[] {
  const globs = testGlobs.map((g) => new Bun.Glob(g));
  return changed.filter((f) => {
    if (globs.some((g) => g.match(f))) return false;
    if (/(^|\/)(test|tests|spec|__tests__)\//.test(f)) return false;
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(f)) return false;
    if (/_test\.(go|py)$|^test_.*\.py$/.test(f)) return false;
    // Config and metadata are not implementation; blanking them proves nothing.
    if (/(^|\/)(package\.json|tsconfig\.json|go\.mod|Cargo\.toml|pyproject\.toml)$/.test(f)) return false;
    return true;
  });
}
