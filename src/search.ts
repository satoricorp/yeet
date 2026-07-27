/**
 * search.ts — find an agent by what it built, without booting anything.
 *
 * `ask` is a word yeet owns, so it gets a guarantee: **it never boots a VM as its first move.**
 * `yeet ask "<question>"` with no --name answers from disk — instantly, free, offline. Naming an
 * agent AND passing a question stays the only path under `ask` that spends money, because a
 * forgotten flag must never turn into a paid fan-out across every agent you own.
 *
 * The ranking is lexical, and that is a decision rather than a shortcut. The corpus is the
 * agent's task plus its own `summary.md` — tens of KiB in total, and the summary is already the
 * agent's answer to "what did you build and how do I run it." Semantic search would need an
 * embedding model, so either a network call and a key or weights to load, which contradicts
 * *instant, free, offline* and buys nothing at a scale where scanning everything costs a
 * millisecond. turbopuffer is for the cloud, where the corpus is session-scale and lexical
 * scanning stops being possible. See docs/data.md.
 *
 * BM25F over three fields, because plain term-frequency loses here in two specific ways: common
 * words ("build", "function") would otherwise swamp the rare word that actually identifies the
 * agent, and long summaries would outrank short precise tasks purely by length. IDF fixes the
 * first, length normalisation the second.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as store from "./agent";
import { finalText } from "./trace";

/** Field weights. The name and task are the user's OWN words and are short, so a hit there says
 *  more than a hit buried in generated prose. The summary is richer but far longer. */
const FIELD_WEIGHT = { name: 3, task: 2, summary: 1 } as const;

const K1 = 1.2; // term-frequency saturation — the 4th mention of a word adds little over the 3rd
const B = 0.75; // how hard to normalise for length

/** Classic closed-class words only. Deliberately NOT including "build"/"make"/"cli" — those are
 *  common in tasks, but IDF already discounts them, and a user searching "build" should get the
 *  agents whose text really is about building rather than nothing at all. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "that", "this", "for", "on", "with",
  "as", "by", "at", "be", "are", "was", "were", "from", "but", "not", "have", "has", "had", "i",
  "you", "we", "my", "me", "do", "does", "did", "what", "which", "who", "how", "why", "when",
  "where", "can", "could", "should", "would", "will", "if", "then", "there", "their", "them",
  "its", "so", "than", "too", "very", "just", "about", "into", "over", "some", "any", "all",
  "one", "up", "out", "no", "yes", "was", "been", "being", "am",
]);

const tokenize = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2 && !STOP.has(t));

export type Hit = {
  name: string;
  state: string;
  score: number;
  task: string;
  /** The agent's own prose, or null if it never left any. */
  summary: string | null;
  /** Whether that prose is a real summary, the agent's closing words, or just its task. Worth
   *  showing: "it never wrote a summary" is information about the run, not a rendering detail. */
  source: Source;
  /** The best-matching sentence, for showing WHY this ranked. */
  snippet: string | null;
  /** Which of the user's words actually landed. Empty is impossible for a returned hit. */
  matched: string[];
};

/** Where an agent's description came from. Shown to the user, because "this is the summary it
 *  wrote" and "this is the last thing it happened to say" deserve different amounts of trust. */
export type Source = "summary" | "answer" | "task";

/**
 * When this agent was last doing something, in epoch ms.
 *
 * From the event log's mtime rather than a field, because IterationRecord carries no timestamp
 * — the log is append-only and written on every event, so its mtime is the closest honest
 * answer available. Falls back to agent.json, then gives up rather than guessing: "just now"
 * on an agent from last week would be worse than saying nothing.
 */
export function lastActive(name: string): number | null {
  for (const f of ["events.jsonl", "agent.json"]) {
    try {
      return statSync(join(store.agentDir(name), f)).mtimeMs;
    } catch { /* try the next one */ }
  }
  return null;
}

/** "3h", "2d" — coarse on purpose. Nobody looking one up three days later cares about minutes. */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** A cap on how much prose one agent contributes. Logs run ~1–5 KiB today; a runaway one should
 *  not be able to dominate the index by sheer length. */
const MAX_PROSE = 20_000;

/**
 * The best description an agent has of itself.
 *
 * `summary.md` first, latest iteration first — it is what `yeet ask --name <n>` shows, and
 * searching text the user cannot then see would be a small betrayal. An agent that merged three
 * times has three summaries, and only the last describes what it is now.
 *
 * Falling back to `agent.log` matters more than it sounds: 6 of 16 agents here never wrote a
 * summary at all, and they are disproportionately the interesting ones — the runs that stalled
 * or got capped stop before the summary step. Their closing words are still prose, and still
 * say what the thing was. Without this they would be searchable only by their one-line task.
 */
export function latestProse(name: string): { text: string; source: Source } | null {
  const dir = store.agentDir(name);
  if (!existsSync(dir)) return null;

  // Reverse-alphabetical puts iter-003 before iter-001, and every iter-* before chat-*,
  // confirm-* and coverage-* — which is exactly the order of how much they are worth.
  const subdirs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();

  for (const file of ["summary.md", "agent.log"] as const) {
    for (const sub of subdirs) {
      const p = join(dir, sub, file);
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8");
      // agent.log is now pi's NDJSON event stream, and was prose before that. finalText reads
      // both, so agents that ran under either shape stay findable.
      const text = (file === "summary.md" ? raw.trim() : finalText(raw)) ?? "";
      if (text) return { text: text.slice(0, MAX_PROSE), source: file === "summary.md" ? "summary" : "answer" };
    }
  }
  return null;
}

type Doc = {
  hit: Omit<Hit, "score" | "snippet" | "matched">;
  /** Weighted term frequency across all fields. */
  tf: Map<string, number>;
  /** Weighted length, for BM25 normalisation. */
  len: number;
  haystack: string;
};

/** What ranking actually needs. Kept free of the store so the scoring can be tested against a
 *  fixed corpus rather than against whatever agents happen to exist on this machine. */
export type SearchDoc = {
  name: string;
  state: string;
  task: string;
  /** The agent's own prose, from wherever it could be found. */
  summary: string | null;
  /** Where that prose came from. Defaults to summary when present, task otherwise. */
  source?: Source;
};

function build(docs: SearchDoc[]): Doc[] {
  return docs.map((d) => {
    const fields: Array<[string, number]> = [
      [d.name.replace(/[-_]/g, " "), FIELD_WEIGHT.name],
      [d.task, FIELD_WEIGHT.task],
      [d.summary ?? "", FIELD_WEIGHT.summary],
    ];
    const tf = new Map<string, number>();
    let len = 0;
    for (const [text, w] of fields) {
      for (const t of tokenize(text)) {
        tf.set(t, (tf.get(t) ?? 0) + w);
        len += w;
      }
    }
    return {
      hit: {
        name: d.name, state: d.state, task: d.task, summary: d.summary,
        source: d.source ?? (d.summary ? "summary" : "task"),
      },
      tf,
      len,
      haystack: `${d.name} ${d.task} ${d.summary ?? ""}`.toLowerCase(),
    };
  });
}

/**
 * Expand one query word to the document words it should match.
 *
 * Prefix matching in both directions, so "revers" finds "reverses" and "fibonacci" finds "fib".
 * The 4-character floor is what stops it degenerating: without it "cli" would match "client",
 * and every 2-letter fragment would match half the vocabulary.
 */
function expand(q: string, vocab: Set<string>): string[] {
  const out = new Set<string>();
  if (vocab.has(q)) out.add(q);
  for (const t of vocab) {
    if (t === q) continue;
    if (q.length >= 4 && t.startsWith(q)) out.add(t);
    else if (t.length >= 4 && q.startsWith(t)) out.add(t);
  }
  return [...out];
}

/**
 * Pick the sentence that best explains the match, so a hit can justify itself.
 *
 * Summaries are markdown, hard-wrapped at about 80 columns. Treating a newline as a sentence
 * break therefore cuts sentences at the wrap point and surfaces fragments — "up to read stdin
 * and print the result." instead of the sentence that says what the thing IS. So unwrap first:
 * a blank line separates paragraphs, a single newline is only wrapping.
 */
function bestSnippet(text: string, terms: Set<string>, max = 160): string | null {
  const unwrapped = text
    .replace(/\r/g, "")
    .replace(/^#{1,6}\s+.*$/gm, "") // a heading is not a sentence, and "# Summary" says nothing
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  const sentences = unwrapped.split(/(?<=[.!?])\s+|\n/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return null;
  let best = sentences[0]!;
  let bestScore = -1;
  for (const s of sentences) {
    const toks = new Set(tokenize(s));
    let score = 0;
    for (const t of toks) if (terms.has(t)) score++;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  const clean = best.replace(/\s+/g, " ");
  return clean.length > max ? clean.slice(0, max).replace(/\s+\S*$/, "") + "…" : clean;
}

/**
 * What yeet says about a search.
 *
 * These belong in src/voice.ts with every other canned line, and should move there once the
 * three-voice refactor is committed — today `lines()` exists only in an uncommitted working
 * tree, and importing it from here would make search depend on code that is not in the
 * repository. That is precisely the defect that left HEAD unable to start, so it is not a
 * mistake worth making twice.
 *
 * The house rule holds regardless of where they live: all three voices report the SAME facts.
 * Tone may shrug; the count may not change.
 */
export type SearchLines = {
  /** The opener. `n` strong hits out of `scanned` agents. */
  found: (n: number, scanned: number) => string;
  /** Why these descriptions can be trusted, and what they are not: nobody was asked. */
  sourceNote: string;
  /** Searched everything, nothing was about that. */
  nothing: (scanned: number) => string;
  /** The closing reassurance: this cost nothing and woke nothing. */
  footer: (scanned: number) => string;
};

const SEARCH_LINES: Record<string, SearchLines> = {
  default: {
    found: (n) =>
      n === 1 ? "Just the one." :
      n === 2 ? "Two of them, and they both have a claim to it." :
      `${n} of them look right.`,
    sourceNote: "I didn't ask anyone — this is what they wrote down.",
    nothing: (scanned) => `Nothing. I read all ${scanned} of them and none are about that.`,
    footer: (scanned) => `${scanned} agents, read straight off your disk. Nothing woke up.`,
  },
  professional: {
    found: (n) => (n === 1 ? "1 matching agent." : `${n} matching agents.`),
    sourceNote: "Matched against stored summaries. No agent was queried.",
    nothing: (scanned) => `No matches across ${scanned} agents.`,
    footer: (scanned) => `${scanned} agents searched locally. No sandbox was started.`,
  },
  "dad-jokes": {
    found: (n) =>
      n === 1 ? "Just the one. Needle located, haystack intact." :
      `${n} of them fit. Not a needle in a haystack after all — a needle in an index.`,
    sourceNote: "I didn't ask them, I just read their notes. Very hands-off. Very re-mote.",
    nothing: (scanned) =>
      `Nothing matched. I checked every branch and found nothing but leaves — all ${scanned} of them.`,
    footer: (scanned) => `${scanned} agents, all read locally. Nobody got booted.`,
  },
};

export const searchLines = (voice: string = "default"): SearchLines =>
  SEARCH_LINES[voice] ?? SEARCH_LINES.default!;

/** Read the corpus off disk and rank it. The only part that touches the store. */
export function search(query: string, agents: store.Agent[]): Hit[] {
  return rank(query, agents.map((a) => {
    const prose = latestProse(a.name);
    return {
      name: a.name,
      state: a.state,
      task: a.task ?? "",
      summary: prose?.text ?? null,
      source: prose?.source ?? "task",
    };
  }));
}

/**
 * Rank documents against a plain-English question. Pure, and cheap enough to run on every
 * keystroke if it ever needs to be.
 */
export function rank(query: string, input: SearchDoc[]): Hit[] {
  const docs = build(input);
  if (!docs.length) return [];

  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length) return [];

  const vocab = new Set<string>();
  for (const d of docs) for (const t of d.tf.keys()) vocab.add(t);

  const avglen = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1;
  const phrase = query.toLowerCase().trim();
  const usePhrase = phrase.length >= 6 && /\s/.test(phrase);

  const hits: Hit[] = [];
  for (const d of docs) {
    let score = 0;
    const matched: string[] = [];
    const matchedTerms = new Set<string>();

    for (const q of qTerms) {
      const group = expand(q, vocab);
      if (!group.length) continue;

      // Document frequency of the whole synonym group — a doc counts once however many
      // variants it holds, or "reverse/reverses/reversing" would look three times as rare.
      let df = 0;
      for (const other of docs) if (group.some((g) => other.tf.has(g))) df++;
      if (df === 0) continue;

      let tf = 0;
      for (const g of group) tf += d.tf.get(g) ?? 0;
      if (tf === 0) continue;

      matched.push(q);
      for (const g of group) matchedTerms.add(g);

      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.len) / avglen)));
    }

    // A literal multi-word hit ("google cloud storage") is far stronger evidence than the same
    // words scattered, and BM25 alone cannot see word order at all.
    if (usePhrase && d.haystack.includes(phrase)) score += 2;

    if (score > 0) {
      hits.push({
        ...d.hit,
        score,
        matched,
        snippet: bestSnippet(d.hit.summary ?? d.hit.task, matchedTerms),
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
