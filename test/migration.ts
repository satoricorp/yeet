#!/usr/bin/env bun
/**
 * migration.ts — does replaying a legacy agent.json lose anything?
 *
 * This exists because it already happened. Flipping `load()` to replay the log silently
 * dropped the legacy `repo` field: every agent that had worked on a real repository started
 * reporting itself as "isolated" in `yeet ls`, and agent.json was rewritten without it, so the
 * value was gone.
 *
 * The old consistency check could not catch it — it compared a hand-picked list of fields, and
 * `repo` was not on the list. Nor can comparing agent.json to the fold catch it any more: once
 * the log is authoritative, agent.json is GENERATED from the fold, so they agree by
 * construction no matter what is missing from both.
 *
 * The only non-circular test is a FIXED input. This fixture is a realistic pre-log agent.json;
 * we replay it and assert the result is deep-equal. Any field that fold()/fromState() fails to
 * carry shows up as a diff, including fields nobody thought to assert on.
 *
 *   bun test/migration.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR } from "../src/host";
import * as store from "../src/agent";

const NAME = "__migration_test__";
const dir = join(AGENTS_DIR, NAME);

/** A pre-event-log agent.json, with every field the old writer could produce. */
const LEGACY = {
  name: NAME,
  createdAt: "2026-07-20T10:00:00.000Z",
  repo: "/Users/joe/some-project",
  origin: "git@github.com:acme/some-project.git",
  baseHead: "1111111111111111111111111111111111111111",
  branch: `yeet/${NAME}`,
  model: "openrouter/z-ai/glm-5.2",
  task: "make the auth tests pass",
  verify: {
    command: "bun test",
    testFiles: ["test/**/*.test.ts"],
    coverageCommand: "bun test --coverage",
    source: "agent" as const,
    frozen: { "test/auth.test.ts": "a3f19c8e2b04d7561f8a09c3e5b2d4a71c069f83" },
  },
  coverage: { pct: 87, coveredLines: 174, totalLines: 200, at: "2026-07-20T10:31:00.000Z" },
  state: "passed" as const,
  costUsd: 0.1234,
  iterations: [
    { n: 1, phase: "agent", agentSeconds: 55, costUsd: 0.1, insertions: 40, deletions: 2,
      filesChanged: 3, treeChanged: true, testExit: 1, verdict: "red" as const },
    { n: 2, phase: "agent", agentSeconds: 30, costUsd: 0.0234, insertions: 5, deletions: 1,
      filesChanged: 1, treeChanged: true, testExit: 0, verdict: "green" as const,
      touchedFrozenTests: true },
  ],
};

let failures = 0;
const fail = (msg: string) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const pass = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);

/** Every leaf path where two objects differ, so a dropped field names itself. */
function diff(a: unknown, b: unknown, path = ""): string[] {
  if (a === b) return [];
  // Money is now summed from its parts rather than stored as a total, and 0.1 + 0.0234 really
  // is 0.12340000000000001. That is IEEE754, not lost data — so compare numbers by closeness.
  // Anything that actually differs is orders of magnitude beyond this.
  if (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9) return [];
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return [`${path || "(root)"}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`];
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  const out: string[] = [];
  for (const k of keys) {
    out.push(...diff((a as any)[k], (b as any)[k], path ? `${path}.${k}` : k));
  }
  return out;
}

rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, "workspace"), { recursive: true });
writeFileSync(join(dir, "agent.json"), JSON.stringify(LEGACY, null, 2) + "\n");

// A real repo, because the backfill asks git for HEAD to recover the last checkpoint.
for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
  Bun.spawnSync(["git", "-C", join(dir, "workspace"), ...args]);
}
writeFileSync(join(dir, "workspace", "f.txt"), "x\n");
Bun.spawnSync(["git", "-C", join(dir, "workspace"), "add", "-A"]);
Bun.spawnSync(["git", "-C", join(dir, "workspace"), "commit", "-qm", "seed"]);

console.log("\n\x1b[1mlegacy agent.json → event log → Agent\x1b[0m\n");

// First load migrates; second load goes through the pure replay path.
const migrated = store.load(NAME);
const replayed = store.load(NAME);

const d1 = diff(LEGACY, migrated).filter((l) => !l.startsWith("id:"));
if (d1.length === 0) pass("migration is lossless — every legacy field survives the replay");
else { fail("migration LOST or changed fields:"); d1.forEach((l) => console.log(`      ${l}`)); }

const d2 = diff(migrated, replayed);
if (d2.length === 0) pass("replay is idempotent — loading twice yields the same agent");
else { fail("second load differs from the first:"); d2.forEach((l) => console.log(`      ${l}`)); }

if (migrated.id && migrated.id.length === 26) pass("a stable id was assigned");
else fail(`expected a 26-char ULID id, got ${JSON.stringify(migrated.id)}`);

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m" : `\n\x1b[31m${failures} failed\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
