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
import { parseCounts, checkCounts, checkCheats, implementationFiles } from "../src/gates";

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
