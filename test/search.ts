#!/usr/bin/env bun
/**
 * search.ts — ranking has to be right, because a confidently wrong order is worse than a list.
 *
 * `yeet ask "<question>"` exists to answer "which one of these built the thing that…". If the
 * agent you wanted is fourth, you scroll past it and conclude yeet does not know. So the tests
 * below pin ORDER, not just membership — and they pin the two ways lexical ranking classically
 * goes wrong: a common word drowning the rare one that actually identifies the agent, and a long
 * document outranking a short precise one purely by having more words in it.
 *
 *   bun test/search.ts
 */
import { rank, type SearchDoc } from "../src/search";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  \x1b[32m✓\x1b[0m" : "  \x1b[31m✗\x1b[0m"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const doc = (name: string, task: string, summary: string | null = null): SearchDoc =>
  ({ name, state: "passed", task, summary });

// A corpus shaped like the real one: several agents that all "build a CLI", differing only in
// the one word that matters. This is the case ranking has to get right.
const CORPUS: SearchDoc[] = [
  doc("reverse-cli", "make a cli that reverses stdin",
    "Built a small Node CLI that reads text from stdin and writes it back reversed, by Unicode code point."),
  doc("wc-clean", "build me an app that counts words from stdin",
    "A small Node CLI that reads stdin and prints counts of lines, words, and bytes, like wc."),
  doc("fib-gates", "build a function that returns the nth fibonacci number",
    "Exports a fibonacci(n) function that returns the nth Fibonacci number as a BigInt using fast doubling."),
  doc("gcs-probe", "build a CLI that lists the files in a Google Cloud Storage bucket", null),
  doc("shape-circle", "add a circle(radius) area function alongside the existing rectangle",
    "Adds a circle(radius) area function to the shapes module returning pi times r squared."),
];

const names = (q: string, c = CORPUS) => rank(q, c).map((h) => h.name);
const top = (q: string, c = CORPUS) => names(q, c)[0] ?? null;

console.log("\n\x1b[36m▪\x1b[0m finding the obvious one");
{
  check("a rare word goes straight to it", top("fibonacci") === "fib-gates", `got ${top("fibonacci")}`);
  check("only that one comes back", names("fibonacci").length === 1);
  check("reversing", top("reverses") === "reverse-cli", `got ${top("reverses")}`);
  check("word counting", top("counts words") === "wc-clean", `got ${top("counts words")}`);
}

console.log("\n\x1b[36m▪\x1b[0m the common word must not decide it");
{
  // Four of the five say "build" or "cli". If term frequency alone drove this, the longest
  // document would win every one of these queries regardless of what was asked.
  const r = names("build a cli that reverses");
  check("reverse-cli wins despite 'build' and 'cli' being everywhere", r[0] === "reverse-cli", `got ${r[0]}`);

  // "cli" appears in most docs, so on its own it is nearly worthless — but it must not crash
  // or return nothing, because a user may well type it.
  check("a word shared by most docs still returns them", names("cli").length >= 2);
}

console.log("\n\x1b[36m▪\x1b[0m length must not win on its own");
{
  const short = doc("tiny", "sqlite backup tool", null);
  const long = doc("verbose", "a general purpose utility",
    "This project does many things. ".repeat(20) + " It also mentions sqlite once.");
  check("a short precise task beats a long doc mentioning it in passing",
    top("sqlite", [short, long]) === "tiny", `got ${top("sqlite", [short, long])}`);
}

console.log("\n\x1b[36m▪\x1b[0m field weight");
{
  const byName = doc("slugify-src", "implement it", null);
  const byBody = doc("other", "do a thing", "Some prose that happens to mention slugify deep inside it.");
  check("a hit in the name outranks one buried in prose",
    top("slugify", [byName, byBody]) === "slugify-src", `got ${top("slugify", [byName, byBody])}`);
}

console.log("\n\x1b[36m▪\x1b[0m partial words");
{
  check("'revers' finds 'reverses'", top("revers") === "reverse-cli", `got ${top("revers")}`);
  check("'fibo' finds 'fibonacci'", top("fibo") === "fib-gates", `got ${top("fibo")}`);

  // The floor that stops prefix matching degenerating. Without it "cli" matches "client",
  // "clip", "climate" — and every short query matches everything.
  const client = [doc("a", "a client library for redis", null), doc("b", "a cli that prints things", null)];
  check("'cli' does NOT match 'client'", top("cli", client) === "b", `got ${top("cli", client)}`);
}

console.log("\n\x1b[36m▪\x1b[0m phrases");
{
  // The words "google", "cloud", "storage" scattered across a doc is much weaker evidence than
  // the literal phrase, and BM25 alone cannot see word order at all.
  const scattered = doc("scattered",
    "a storage helper that talks to the cloud, inspired by google", null);
  const literal = CORPUS.find((d) => d.name === "gcs-probe")!;
  check("the literal phrase outranks the same words scattered",
    top("google cloud storage", [scattered, literal]) === "gcs-probe",
    `got ${top("google cloud storage", [scattered, literal])}`);
}

console.log("\n\x1b[36m▪\x1b[0m refusing to guess");
{
  check("nonsense returns nothing, not everything", rank("quantum blockchain", CORPUS).length === 0);
  check("stopwords alone return nothing", rank("the a of and", CORPUS).length === 0);
  check("an empty query returns nothing", rank("", CORPUS).length === 0);
  check("an empty corpus is fine", rank("anything", []).length === 0);
  check("every returned hit names the word that matched",
    rank("fibonacci cli", CORPUS).every((h) => h.matched.length > 0));
}

console.log("\n\x1b[36m▪\x1b[0m snippets explain the hit");
{
  // Regression: summaries are markdown hard-wrapped at ~80 columns. Splitting on newlines cut
  // sentences at the wrap point and surfaced fragments like "up to read stdin and print the
  // result." instead of the sentence saying what the thing is.
  const wrapped = doc("wrapped", "count words",
    "# Summary\n\nBuilt a small command-line app that reads text from standard input and prints the\nnumber of words. The logic lives in `wordcount.js` and `index.js` wires it\nup to read stdin and print the result.");
  const snip = rank("words", [wrapped])[0]?.snippet ?? "";
  check("a hard-wrapped sentence is not cut at the wrap point",
    !snip.startsWith("up to read"), `got "${snip.slice(0, 45)}…"`);
  check("the snippet is a whole sentence", snip.startsWith("Built a small command-line app"), `got "${snip.slice(0, 45)}…"`);
  check("markdown headings never become the snippet", !snip.includes("# Summary"));

  check("an agent with no summary still explains itself from its task",
    (rank("bucket", CORPUS)[0]?.snippet ?? "").includes("Google Cloud Storage"));
}

console.log("\n\x1b[36m▪\x1b[0m stability");
{
  // Same input, same order — a search that reshuffles between runs is unusable.
  check("ranking is deterministic",
    JSON.stringify(names("cli stdin")) === JSON.stringify(names("cli stdin")));
  const tied = [doc("bbb", "identical text here", null), doc("aaa", "identical text here", null)];
  check("exact ties break by name, not by directory order",
    JSON.stringify(rank("identical", tied).map((h) => h.name)) === JSON.stringify(["aaa", "bbb"]));
}

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m" : `\n\x1b[31m${failures} failed\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
