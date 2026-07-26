#!/usr/bin/env bun
/**
 * gates.ts — the parsers have to be right, because a wrong one is worse than none.
 *
 * A false "zero tests ran" on a real suite sends someone to debug working code. A missed one
 * lets an empty suite pass as green. Both are worse than saying nothing, which is why
 * parseCounts returns null for runners it does not recognise and the tests below pin that.
 *
 *   bun test/gates.ts
 */
import { parseCounts, checkCounts, checkCheats, implementationFiles, failureSignature } from "../src/gates";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  \x1b[32m✓\x1b[0m" : "  \x1b[31m✗\x1b[0m"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── real output, copied from actual runs in this project ──────────────────────────────────
console.log("\n\x1b[36m▪\x1b[0m parsing real runner output");
{
  // From the sum-fn agent.
  check("bun test", eq(parseCounts("\n 6 pass\n 0 fail\n 12 expect() calls\nRan 6 tests across 1 file. [23.00ms]"),
    { ran: 6, passed: 6, failed: 0, skipped: 0 }));

  // The near-miss that motivated all of this: nine tests in the file, one "ran", because the
  // module would not parse.
  check("bun test, suite failed to load", eq(parseCounts("\n 0 pass\n 1 fail\n 1 error\nRan 1 test across 1 file."),
    { ran: 1, passed: 0, failed: 1, skipped: 0 }));

  // The genuinely dangerous shape: no test files at all, exit code 0.
  check("bun test with NO tests", eq(parseCounts("\n 0 pass\n 0 fail\nRan 0 tests across 0 files."),
    { ran: 0, passed: 0, failed: 0, skipped: 0 }));

  // From the reverse-cli agent.
  check("node --test", eq(parseCounts("# tests 14\n# pass 6\n# fail 8\n# cancelled 0\n# skipped 0\n# todo 0"),
    { ran: 14, passed: 6, failed: 8, skipped: 0 }));

  check("pytest", eq(parseCounts("==== 5 passed, 1 failed, 2 skipped in 0.31s ===="),
    { ran: 6, passed: 5, failed: 1, skipped: 2 }));

  check("cargo test", eq(parseCounts("test result: ok. 8 passed; 0 failed; 1 ignored; 0 measured"),
    { ran: 8, passed: 8, failed: 0, skipped: 1 }));

  check("vitest", eq(parseCounts(" Tests  8 passed (8)\n Duration  1.2s"),
    { ran: 8, passed: 8, failed: 0, skipped: 0 }));

  check("jest", eq(parseCounts("Tests:       1 failed, 7 passed, 8 total"),
    { ran: 8, passed: 7, failed: 1, skipped: 0 }));
}

console.log("\n\x1b[36m▪\x1b[0m refusing to guess");
{
  check("unknown runner returns null, not zero", parseCounts("Everything is fine!\nDone.") === null);
  check("empty output returns null", parseCounts("") === null);
  // go test prints no counts. Reporting "0 tests ran" for a passing go suite would be a lie
  // that fails every Go project.
  check("go test returns null rather than a wrong count", parseCounts("ok  \texample.com/pkg\t0.102s") === null);
}

console.log("\n\x1b[36m▪\x1b[0m the zero-test guard");
{
  check("flags a suite that ran nothing",
    checkCounts("\n 0 pass\n 0 fail\n").some((f) => f.gate === "zero-tests"));
  check("flags a one-test suite as thin",
    checkCounts("\n 1 pass\n 0 fail\n").some((f) => f.gate === "thin-suite"));
  check("flags skipped tests",
    checkCounts("\n 5 pass\n 0 fail\n 2 skip\n").some((f) => f.gate === "skipped"));
  check("says nothing about a healthy suite",
    checkCounts("\n 8 pass\n 0 fail\n").length === 0);
  check("says nothing when it cannot parse",
    checkCounts("who knows").length === 0);
}

console.log("\n\x1b[36m▪\x1b[0m cheat scan");
{
  const diff = `--- a/next.config.js\n+++ b/next.config.js\n+  typescript: { ignoreBuildErrors: true },\n`;
  check("catches ignoreBuildErrors", checkCheats(diff).some((f) => f.gate === "cheat-config"));
  check("catches .only", checkCheats("+  it.only('works', () => {})").length > 0);
  check("catches || true", checkCheats('+    "test": "bun test || true"').length > 0);

  // Only ADDED lines count. A pre-existing .only being removed is the opposite of cheating.
  check("ignores removed lines", checkCheats("-  it.only('works', () => {})").length === 0);
  check("ignores context lines", checkCheats("   it.only('works', () => {})").length === 0);
  check("quiet on an innocent diff", checkCheats("+const sum = (a, b) => a + b;").length === 0);
}

// ── the stall fingerprint ─────────────────────────────────────────────────────────────────
//
// This is the detector that decides when to stop paying for an agent, and it has two ways to
// be wrong that pull in opposite directions. Under-normalise and every run looks unique
// because a duration changed, so a real stall never fires and 25 rounds get burned.
// Over-normalise and genuinely different failures collapse together, so yeet gives up on an
// agent that was making progress. Both directions are tested here.
console.log("\n\x1b[36m▪\x1b[0m failure fingerprint");
{
  const run1 = `
 (fail) auth > rejects expired token [12.40ms]
 (fail) auth > refreshes on 401 [3.10ms]
 2 fail
Ran 8 tests across 1 file. [412.00ms]`;

  // Same two failures, every timing different. This is what a genuinely stuck agent produces.
  const run2 = `
 (fail) auth > rejects expired token [9.81ms]
 (fail) auth > refreshes on 401 [4.44ms]
 2 fail
Ran 8 tests across 1 file. [388.00ms]`;

  check("identical failures with different timings match",
    failureSignature(run1) === failureSignature(run2), `${failureSignature(run1)} vs ${failureSignature(run2)}`);

  // One fixed. That IS progress and must not be mistaken for a stall.
  const progressed = `
 (fail) auth > refreshes on 401 [4.44ms]
 1 fail
Ran 8 tests across 1 file. [377.00ms]`;
  check("fixing one failure changes the fingerprint",
    failureSignature(run1) !== failureSignature(progressed));

  // Runners reorder freely; order is not information.
  const reordered = `
 (fail) auth > refreshes on 401 [1.00ms]
 (fail) auth > rejects expired token [2.00ms]
 2 fail`;
  check("reordering the same failures does not change it",
    failureSignature(run1) === failureSignature(reordered));

  check("a different test failing changes it",
    failureSignature(run1) !== failureSignature("\n (fail) billing > applies discount [1ms]\n 1 fail"));

  // Every runner the image can run.
  check("node --test", failureSignature("not ok 1 - adds two numbers\nnot ok 2 - handles zero") ===
    failureSignature("not ok 1 - adds two numbers\nnot ok 2 - handles zero"));
  check("pytest", failureSignature("FAILED tests/test_auth.py::test_expiry") !== null);
  check("go", failureSignature("--- FAIL: TestExpiry (0.00s)") !== null);
  check("jest", failureSignature("  ✕ rejects expired token (14 ms)") !== null);

  // No recognisable test ids — fall back to the shape of the tail, scrubbed.
  const noisy1 = "Error: connect ECONNREFUSED\n    at /tmp/abc123/run.js:4:11\n  took 1.2s  pid=4412  0xdeadbeef";
  const noisy2 = "Error: connect ECONNREFUSED\n    at /tmp/zzz999/run.js:4:11\n  took 9.9s  pid=8811  0xcafef00d";
  check("falls back to a scrubbed tail when no test ids are present",
    failureSignature(noisy1) === failureSignature(noisy2), "temp paths, timings, pids and addresses are noise");

  // file:line is signal — a crash that moved to a different line is a different crash.
  check("but a different file:line IS a different failure",
    failureSignature("Error: boom\n    at src/a.ts:10:3") !== failureSignature("Error: boom\n    at src/a.ts:88:3"));

  check("empty output yields null", failureSignature("") === null);
  check("ANSI colour does not change it",
    failureSignature("\x1b[31m (fail) auth > x\x1b[0m") === failureSignature(" (fail) auth > x"));
}

console.log("\n\x1b[36m▪\x1b[0m implementation vs test files");
{
  const changed = [
    "src/sum.ts", "src/sum.test.ts", "test/cli.test.js", "package.json",
    "internal/thing.go", "internal/thing_test.go", "app/page.tsx",
  ];
  const impl = implementationFiles(changed, ["**/*.test.ts"]);
  check("keeps implementation", impl.includes("src/sum.ts") && impl.includes("app/page.tsx"));
  check("drops tests by glob", !impl.includes("src/sum.test.ts"));
  check("drops tests by directory", !impl.includes("test/cli.test.js"));
  check("drops go tests by suffix", !impl.includes("internal/thing_test.go"));
  check("drops manifests — blanking package.json proves nothing", !impl.includes("package.json"));
  check("keeps go implementation", impl.includes("internal/thing.go"));
}

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m" : `\n\x1b[31m${failures} failed\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
