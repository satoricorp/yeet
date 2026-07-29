#!/usr/bin/env bun
/**
 * session.ts — billing arithmetic has to be exact, because nobody re-checks a cost total.
 *
 * costDelta is the only place spend is attributed to an iteration, and it has one hard case:
 * the session FILE identity changing under it. The old code treated "different file" as "fresh
 * session" and charged the new file's full cumulative total — which recharges every
 * already-billed turn the moment anything rotates or replays a session. A rewind writing a
 * truncated copy of the transcript would phantom-bill the whole replayed prefix.
 *
 *   bun test/session.ts
 */
import { costDelta, EMPTY_SESSION, type SessionStats } from "../src/session";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  \x1b[32m✓\x1b[0m" : "  \x1b[31m✗\x1b[0m"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const cur = (file: string, costUsd: number): SessionStats => ({ ...EMPTY_SESSION, file, costUsd });
// Money is floats here (usage.cost.total is a float upstream), so equality is epsilon —
// 0.15 - 0.10 is not 0.05 in IEEE 754, and a billing test that fails on that teaches nothing.
const eq = (a: number, b: number) => Math.abs(a - b) < 1e-12;

console.log("\n\x1b[36m▪\x1b[0m the ordinary appending session");
{
  check("growth in the same file is the delta",
    eq(costDelta({ file: "a.jsonl", costUsd: 0.10 }, cur("a.jsonl", 0.15)), 0.05));
  check("no growth bills nothing",
    costDelta({ file: "a.jsonl", costUsd: 0.10 }, cur("a.jsonl", 0.10)) === 0);
  check("a shrinking total never bills negative",
    costDelta({ file: "a.jsonl", costUsd: 0.10 }, cur("a.jsonl", 0.02)) === 0);
}

console.log("\n\x1b[36m▪\x1b[0m the first session ever");
{
  check("a brand-new file bills in full against an empty baseline",
    costDelta({ file: null, costUsd: 0 }, cur("a.jsonl", 0.03)) === 0.03);
  check("a null prev bills in full",
    Math.abs(costDelta(null, cur("a.jsonl", 0.03)) - 0.03) < 1e-12);
  check("no session file at all bills nothing",
    costDelta({ file: "a.jsonl", costUsd: 0.10 }, { ...EMPTY_SESSION }) === 0);
}

console.log("\n\x1b[36m▪\x1b[0m the file identity changes — THE bug this pins");
{
  // A rewind writes session-2.jsonl containing a replayed prefix that already cost $0.087,
  // then the retry iteration spends $0.012 on top. The charge must be the $0.012, not the
  // $0.099 cumulative total of the new file.
  const billed = costDelta({ file: "session-1.jsonl", costUsd: 0.087 }, cur("session-2.jsonl", 0.099));
  check("a replayed prefix is not recharged", Math.abs(billed - 0.012) < 1e-12, `charged $${billed.toFixed(4)}`);

  check("a replaced file with no new spend bills nothing",
    costDelta({ file: "session-1.jsonl", costUsd: 0.087 }, cur("session-2.jsonl", 0.087)) === 0);

  // A truncated copy is CHEAPER than the original — the discarded suffix's cost went with it.
  // Nothing new has been spent yet, so nothing is billed.
  check("a truncated-shorter file bills nothing rather than negative",
    costDelta({ file: "session-1.jsonl", costUsd: 0.087 }, cur("session-2.jsonl", 0.041)) === 0);
}

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m" : `\n\x1b[31m${failures} failed\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
