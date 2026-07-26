/**
 * coverage.ts — how much of the app do the tests actually exercise?
 *
 * This is yeet's honesty check on a green result. A suite that passes but touches 12% of the
 * code is a very different fact from one that touches 85%, and a non-developer deserves that
 * fact in one number.
 *
 * The contract with the agent (enforced by prompt, tolerated by parser): the coverage command
 * registered via set_verify must leave an LCOV file somewhere in the workspace. LCOV is the
 * one interchange format everything can emit (bun test --coverage --coverage-reporter=lcov,
 * jest/vitest, pytest-cov, cargo llvm-cov, go via converters), and it is a trivially parseable
 * line format — no per-toolchain adapters.
 *
 * Test files themselves are excluded from the denominator: "your tests cover your tests" is
 * not information.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type FileCoverage = { path: string; covered: number; total: number };
export type Coverage = {
  pct: number;
  coveredLines: number;
  totalLines: number;
  files: FileCoverage[];
};

/** Newest lcov-looking file under root, or null. Bounded walk — skips the usual heavy dirs. */
export function findLcov(root: string): string | null {
  const SKIP = new Set(["node_modules", ".git", "target", "dist", "build", "__pycache__"]);
  let best: { path: string; mtime: number } | null = null;
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(join(dir, e.name), depth + 1);
      } else if (e.name === "lcov.info" || e.name.endsWith(".lcov")) {
        const p = join(dir, e.name);
        const m = statSync(p).mtimeMs;
        if (!best || m > best.mtime) best = { path: p, mtime: m };
      }
    }
  };
  walk(root, 0);
  return best ? (best as { path: string }).path : null;
}

/**
 * Parse LCOV text. Prefers the per-record LH/LF summary lines; falls back to counting DA:
 * entries when a tool omits them. Paths in `excludeGlobs` (the agent's registered test files)
 * are dropped from the totals.
 */
export function parseLcov(text: string, excludeGlobs: string[], workspaceRoot?: string): Coverage | null {
  const globs = excludeGlobs.map((g) => new Bun.Glob(g));
  const files: FileCoverage[] = [];

  let path: string | null = null;
  let lf = -1;
  let lh = -1;
  let daTotal = 0;
  let daHit = 0;

  const flush = () => {
    if (!path) return;
    const rel = workspaceRoot ? relative(workspaceRoot, path) : path;
    const clean = rel.startsWith("..") ? path : rel;
    if (!globs.some((g) => g.match(clean))) {
      const total = lf >= 0 ? lf : daTotal;
      const covered = lh >= 0 ? lh : daHit;
      if (total > 0) files.push({ path: clean, covered, total });
    }
    path = null; lf = -1; lh = -1; daTotal = 0; daHit = 0;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) { flush(); path = line.slice(3); }
    else if (line.startsWith("LF:")) lf = Number(line.slice(3)) || 0;
    else if (line.startsWith("LH:")) lh = Number(line.slice(3)) || 0;
    else if (line.startsWith("DA:")) {
      daTotal++;
      const hits = Number(line.slice(3).split(",")[1] ?? "0");
      if (hits > 0) daHit++;
    } else if (line === "end_of_record") flush();
  }
  flush();

  if (files.length === 0) return null;
  const totalLines = files.reduce((a, f) => a + f.total, 0);
  const coveredLines = files.reduce((a, f) => a + f.covered, 0);
  return {
    pct: totalLines === 0 ? 0 : Math.round((coveredLines / totalLines) * 1000) / 10,
    coveredLines,
    totalLines,
    files: files.sort((a, b) => a.covered / a.total - b.covered / b.total),
  };
}
