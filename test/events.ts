#!/usr/bin/env bun
/**
 * events.ts — prove the log behaves like a log.
 *
 * The properties that matter are the ones the cloud port depends on: ids sort chronologically
 * across writers, `since` is a resumable cursor, and `fold` is total and forward-compatible.
 *
 *   bun test/events.ts
 */
import { mkdirSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { ulid, fold, FileEventStore, type EventBody } from "../src/events";
import { AGENTS_DIR } from "../src/host";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  \x1b[32m✓\x1b[0m" : "  \x1b[31m✗\x1b[0m"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const NAME = "__events_test__";
const dir = join(AGENTS_DIR, NAME);

function reset() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

// ── ids ───────────────────────────────────────────────────────────────────────────────────
console.log("\n\x1b[36m▪\x1b[0m ids");
{
  const ids = Array.from({ length: 500 }, () => ulid());
  check("all unique", new Set(ids).size === 500);
  check("length is 26", ids.every((i) => i.length === 26));
  const sorted = [...ids].sort();
  check("generated order == sorted order (monotonic within a ms)", JSON.stringify(ids) === JSON.stringify(sorted));

  // The property that makes two writers safe: ids minted later always sort after earlier ones,
  // even from a different process, because the first 10 chars are the timestamp.
  const past = ulid(Date.now() - 60_000);
  const now = ulid();
  check("an older timestamp sorts before a newer one", past < now, `${past.slice(0, 10)} < ${now.slice(0, 10)}`);
}

// ── store ─────────────────────────────────────────────────────────────────────────────────
console.log("\n\x1b[36m▪\x1b[0m append / since");
{
  reset();
  const store = new FileEventStore();

  const created: EventBody = {
    kind: "created", name: NAME, userPrompt: "reverse stdin", model: "openrouter/z-ai/glm-5.2",
    session: { program: "pi", file: "session/a.jsonl" },
    git: { branch: `yeet/${NAME}`, baseCommit: "8ffb35d", origin: null },
  };
  const [a] = store.append(NAME, [created]);
  check("append returns the stamped event", !!a?.id && !!a?.at);

  store.append(NAME, [
    { kind: "verify_set", command: "bun test", testFiles: ["test/**"], coverageCommand: null,
      proposedBy: "agent", approvedBy: "auto", changedOnApproval: false, protectedTests: {} },
    { kind: "iteration", n: 1,
      agent: { seconds: 55, costUsd: 0.0155, outcome: "edited", stoppedBy: null, sessionEnd: 47 },
      git: { commit: "c4f9a02", filesChanged: 9, linesAdded: 214, linesRemoved: 0, protectedTestsChanged: [] },
      verify: { command: "bun test", exitCode: 0, passed: true } },
  ]);

  const all = store.since(NAME);
  check("reads back every event in order", all.length === 3 && all[0]!.kind === "created");

  const after = store.since(NAME, all[0]!.id);
  check("since(id) is a resumable cursor", after.length === 2 && after.every((e) => e.id > all[0]!.id));

  check("since(head) returns nothing new", store.since(NAME, all.at(-1)!.id).length === 0);
  check("agents() lists agents that have a log", store.agents().includes(NAME));

  // A crash mid-append leaves a partial final line. The rest of the log must still load.
  appendFileSync(join(dir, "events.jsonl"), '{"id":"01J","kind":"iterat');
  check("tolerates a torn final line", store.since(NAME).length === 3);
}

// ── fold ──────────────────────────────────────────────────────────────────────────────────
console.log("\n\x1b[36m▪\x1b[0m fold");
{
  reset();
  const store = new FileEventStore();
  store.append(NAME, [
    { kind: "created", name: NAME, userPrompt: "reverse stdin", model: "m1",
      session: { program: "pi", file: "session/a.jsonl" },
      git: { branch: `yeet/${NAME}`, baseCommit: "8ffb35d", origin: null } },
    { kind: "config", key: "origin", value: "git@github.com:x/y.git", setBy: "user" },
    { kind: "verify_run", reason: "baseline", command: "bun test", exitCode: 1, passed: false },
    { kind: "iteration", n: 1,
      agent: { seconds: 55, costUsd: 0.02, outcome: "edited", stoppedBy: null, sessionEnd: 47 },
      git: { commit: "aaa1111", filesChanged: 9, linesAdded: 214, linesRemoved: 0, protectedTestsChanged: [] },
      verify: { command: "bun test", exitCode: 1, passed: false } },
    // No commit: the agent changed nothing, so this must NOT move the checkpoint.
    { kind: "iteration", n: 2,
      agent: { seconds: 12, costUsd: 0.03, outcome: "no_change", stoppedBy: null, sessionEnd: 61 },
      git: { commit: null, filesChanged: 0, linesAdded: 0, linesRemoved: 0, protectedTestsChanged: [] },
      verify: { command: "bun test", exitCode: 1, passed: false } },
    { kind: "status", status: "stalled", reason: "no progress for 2 iterations" },
  ]);

  const s = fold(store.since(NAME))!;
  check("status is the last status event", s.status === "stalled");
  check("cost sums every iteration", Math.abs(s.costUsd - 0.05) < 1e-9, `${s.costUsd}`);
  check("iterations counted", s.iterations === 2);
  check("config applied", s.git.origin === "git@github.com:x/y.git");
  check("target defaults to main", s.git.target === "main");
  check("checkpoint is the last COMMITTING iteration", s.checkpoint?.commit === "aaa1111", JSON.stringify(s.checkpoint));
  check("checkpoint carries the session position", s.checkpoint?.sessionEnd === 47);
  check("head is the last event id", s.head === store.since(NAME).at(-1)!.id);
  check("userPrompt preserved verbatim", s.userPrompt === "reverse stdin");

  // Forward compatibility: an older binary must survive a log written by a newer one.
  appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ id: ulid(), at: new Date().toISOString(), kind: "from_the_future", wat: 1 }) + "\n");
  const s2 = fold(store.since(NAME));
  check("unknown event kinds are ignored, not fatal", s2 !== null && s2.status === "stalled");

  check("fold of an empty log is null", fold([]) === null);
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m" : `\n\x1b[31m${failures} failed\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
