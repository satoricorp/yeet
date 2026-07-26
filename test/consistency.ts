#!/usr/bin/env bun
/**
 * consistency.ts — does replaying the log reproduce agent.json?
 *
 * This is the gate on making the log authoritative. Right now `agent.json` is still the truth
 * and the event log runs alongside it; the day we flip that around, any field the log fails to
 * reproduce becomes a field we silently lose. So the useful question is not "does the log
 * parse" but "does folding it agree with the blob it is replacing, on a real agent".
 *
 * A mismatch here is not a test bug. It means a mutation site is missing its `record()` call.
 *
 *   bun test/consistency.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR } from "../src/host";
import { FileEventStore, fold } from "../src/events";
import type { Agent } from "../src/agent";

let failures = 0;
let checked = 0;
const check = (agentName: string, field: string, ok: boolean, detail = "") => {
  if (!ok) {
    console.log(`  \x1b[31m✗\x1b[0m ${agentName}.${field}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
  checked++;
};

const store = new FileEventStore();
const names = store.agents();

if (names.length === 0) {
  console.log("no agents with an event log yet — run one first:");
  console.log("  yeet \"write a function that sums an array, with tests\" --name sum-fn");
  process.exit(0);
}

console.log(`\n\x1b[1mfold(events) vs agent.json\x1b[0m — ${names.length} agent(s) with a log\n`);

for (const name of names) {
  const jsonPath = join(AGENTS_DIR, name, "agent.json");
  if (!existsSync(jsonPath)) continue;

  const blob = JSON.parse(readFileSync(jsonPath, "utf8")) as Agent;
  const events = store.since(name);
  const state = fold(events);

  if (!state) {
    console.log(`  \x1b[31m✗\x1b[0m ${name} — log has no \`created\` event, so it cannot be replayed`);
    failures++;
    continue;
  }

  const kinds = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  \x1b[2m${name}: ${events.length} events — ${Object.entries(kinds).map(([k, n]) => `${k}×${n}`).join(", ")}\x1b[0m`);

  check(name, "name", state.name === blob.name, `${state.name} vs ${blob.name}`);
  check(name, "model", state.model === blob.model, `${state.model} vs ${blob.model}`);
  check(name, "status", state.status === blob.state, `${state.status} vs ${blob.state}`);
  check(name, "git.branch", state.git.branch === blob.branch, `${state.git.branch} vs ${blob.branch}`);
  check(name, "git.origin", (state.git.origin ?? null) === (blob.origin ?? null),
    `${state.git.origin} vs ${blob.origin}`);
  check(name, "git.baseCommit", (state.git.baseCommit ?? null) === (blob.baseHead ?? null),
    `${state.git.baseCommit} vs ${blob.baseHead}`);

  // Cost is the one most likely to drift, because it accumulates from two sources (iterations
  // and chat) and a missed record() shows up as a quiet under-count rather than an error.
  check(name, "costUsd", Math.abs(state.costUsd - blob.costUsd) < 1e-9,
    `${state.costUsd} vs ${blob.costUsd}`);

  const agentIterations = blob.iterations.filter((i) => i.phase === "agent").length;
  check(name, "iterations", state.iterations === agentIterations,
    `${state.iterations} vs ${agentIterations} agent-phase records`);

  check(name, "verify.command", (state.verify?.command ?? null) === (blob.verify?.command ?? null),
    `${state.verify?.command} vs ${blob.verify?.command}`);
  check(name, "coverage.pct", (state.coverage?.pct ?? null) === (blob.coverage?.pct ?? null),
    `${state.coverage?.pct} vs ${blob.coverage?.pct}`);

  // The checkpoint has no counterpart in agent.json — it is new capability, not a copy — so
  // comparing fields cannot validate it. Check it against GIT ITSELF instead.
  //
  // This exists because comparing-only-shared-fields let a real bug through: the checkpoint
  // was storing afterTree (a TREE hash) rather than afterHead (a COMMIT). Both are 40 hex
  // chars, both were non-empty, and agent.json had nothing to disagree with — so every
  // structural check passed while `git checkout <commit>` would have failed. The only
  // assertion that catches it is asking git what the object actually is.
  if (state.checkpoint) {
    const ws = join(AGENTS_DIR, name, "workspace");
    check(name, "checkpoint.id", state.checkpoint.id.length === 26, state.checkpoint.id);

    const type = Bun.spawnSync(["git", "-C", ws, "cat-file", "-t", state.checkpoint.commit])
      .stdout.toString().trim();
    check(name, "checkpoint.commit is a COMMIT, not a tree", type === "commit",
      `git says "${type}" for ${state.checkpoint.commit.slice(0, 12)}`);

    // And it must be reachable — a commit sha that is not an ancestor of the branch is a
    // checkpoint you cannot actually resume from.
    const reachable = Bun.spawnSync(
      ["git", "-C", ws, "merge-base", "--is-ancestor", state.checkpoint.commit, "HEAD"],
    ).exitCode === 0;
    check(name, "checkpoint.commit is reachable from HEAD", reachable,
      `${state.checkpoint.commit.slice(0, 12)} is not an ancestor of HEAD`);
  }
}

console.log(
  failures === 0
    ? `\n\x1b[32m${checked} field comparisons, all agree\x1b[0m`
    : `\n\x1b[31m${failures} mismatch(es) — a mutation site is missing its record() call\x1b[0m`,
);
process.exit(failures === 0 ? 0 : 1);
