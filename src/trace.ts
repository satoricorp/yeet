/**
 * trace.ts — reconstruct what an agent actually did, from what is already on disk.
 *
 * src/session.ts reduces a whole run to eight scalars, which is the right answer for the budget
 * watchdog and the wrong one for a developer asking what happened. The raw pi session JSONL
 * carries every tool call with its structured arguments, every result with its error flag, and
 * millisecond timestamps on both. This file turns that into a trace; rendering lives elsewhere,
 * so this stays pure and testable.
 *
 * **Attribution is by time window, not by file.** One cumulative session JSONL spans every phase
 * an agent ever ran, so "what happened in iteration 2" is answered by slicing it against the
 * start/end epochs each phase records in its own meta.kv.
 *
 * Two timestamp formats appear in the same record and mixing them is silent corruption: the
 * ENTRY has ISO-8601 (`2026-07-27T03:46:58.663Z`) while `message.timestamp` is epoch
 * milliseconds (`1785124015123`). Date.parse on the latter yields NaN, which propagates into
 * every duration as NaN and renders as a blank rather than an error. Everything here goes
 * through `ms()`, which accepts both.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readMeta, num, type Meta, type Phase } from "./contract";

/** Below this, a duration is noise — tool calls have a p50 around 4ms and printing "4ms" on
 *  every row costs a column and tells nobody anything. */
const DURATION_FLOOR_MS = 200;

export type ToolCall = {
  /** Position within its turn, 1-based. */
  i: number;
  id: string;
  tool: string;
  /** The argument a developer identifies the call by: a command, or a path. */
  target: string;
  /** Secondary detail for the right-hand column — byte counts, edit counts. */
  extra: string;
  /** Wall time from call to result, or null when unpaired or below the floor. */
  ms: number | null;
  isError: boolean;
  exit: number | null;
  /** First line of the result. */
  head: string;
  /** Total lines in the result, so the renderer can say "+N lines" without holding them. */
  lines: number;
  /** Stable identity of a failure, for spotting the same error N times. */
  sig: string;
};

export type Turn = {
  i: number;
  atMs: number;
  /** Model latency: how long this turn took to come back. Null for the first turn, which has
   *  no preceding result to measure from. */
  latMs: number | null;
  ctx: number;
  out: number;
  costUsd: number;
  model: string;
  stopReason: string | null;
  text: string | null;
  calls: ToolCall[];
};

export type Window = { dir: string; phase: Phase | string; startMs: number; endMs: number; meta: Meta };

export type Stats = {
  turns: number;
  tools: number;
  errs: number;
  /** Peak context, from the largest totalTokens seen — honest as a context size. */
  ctxPeak: number;
  out: number;
  costUsd: number;
  /** Median model latency. The number that explains a slow run. */
  latP50: number | null;
  modelMs: number;
  toolMs: number;
  byTool: Record<string, { n: number; err: number }>;
};

export type PhaseTrace = { win: Window; turns: Turn[]; calls: ToolCall[]; stats: Stats };

/** ISO-8601 or epoch-millis, both of which occur in the same record. */
export function ms(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Every phase this agent ran, in order, with the time window it occupied.
 *
 * `endedAtEpoch` is integer seconds, so a phase that ended at 03:46:58.7 records 03:46:58 and
 * would drop its own last entries. The +999ms closes that, bounded by the next phase's start so
 * windows can never overlap. See task #24 — the fix is millisecond epochs in the contract.
 */
export function phaseWindows(agentDir: string): Window[] {
  if (!existsSync(agentDir)) return [];
  const wins: Window[] = [];
  for (const e of readdirSync(agentDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    // An agent dir also holds workspace/, session/ and bin/, and readMeta throws rather than
    // returning empty when meta.kv is absent. Missing simply means "not a phase".
    let meta: Meta;
    try { meta = readMeta(join(agentDir, e.name)); } catch { continue; }
    const start = num(meta, "startedAtEpoch", 0);
    if (!start) continue; // a phase that never got far enough to report one
    wins.push({
      dir: e.name,
      phase: meta.phase ?? "unknown",
      startMs: start * 1000,
      endMs: num(meta, "endedAtEpoch", start) * 1000 + 999,
      meta,
    });
  }
  wins.sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < wins.length - 1; i++) {
    wins[i]!.endMs = Math.min(wins[i]!.endMs, wins[i + 1]!.startMs - 1);
  }
  return wins;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Guest paths are absolute and the prefix is the same on every one of them, so it is pure noise. */
export const relPath = (p: string) => p.replace(/^\/yeet\/workspace\//, "").replace(/^\/yeet\//, "");

/** The same, anywhere in a line. Tools echo absolute guest paths back inside their own success
 *  messages ("Successfully wrote 237 bytes to /yeet/workspace/test/shapes.test.js"), so an
 *  anchored strip cleans the argument column and leaves the result column full of prefixes. */
export const stripGuestPaths = (s: string) => s.replace(/\/yeet\/workspace\//g, "").replace(/\/yeet\//g, "");

/**
 * How a developer identifies each tool call.
 *
 * A command is shown verbatim because rewriting what ran would misreport it — only the
 * ubiquitous `cd /yeet/workspace &&` prefix goes, since it is on the majority of commands and
 * carries no information. Paths are relative for the same reason.
 */
export function describe(tool: string, args: Record<string, any> | undefined): { target: string; extra: string } {
  const a = args ?? {};
  switch (tool) {
    case "bash":
      return { target: clean(String(a.command ?? "")).replace(/^cd \/yeet\/workspace && /, ""), extra: "" };
    case "write":
      return { target: relPath(String(a.path ?? a.file_path ?? "?")), extra: typeof a.content === "string" ? `${a.content.length} B` : "" };
    case "edit": {
      const n = Array.isArray(a.edits) ? a.edits.length : 0;
      return { target: relPath(String(a.path ?? a.file_path ?? "?")), extra: n > 1 ? `${n} edits` : "" };
    }
    case "read": {
      const range = [a.offset, a.limit].some((x) => x != null) ? `:${a.offset ?? 0}+${a.limit ?? ""}` : "";
      return { target: relPath(String(a.path ?? a.file_path ?? "?")) + range, extra: "" };
    }
    case "set_verify":
      return { target: clean(String(a.command ?? "")).replace(/^cd \/yeet\/workspace && /, ""), extra: "" };
    default: {
      const s = clean(JSON.stringify(a) ?? "");
      return { target: s === "{}" ? "" : s, extra: "" };
    }
  }
}

/**
 * A stable fingerprint for a failure, so the same error twenty times reads as one problem.
 *
 * Taken from the TAIL for shell output, not the head: a failing `bun test` opens with its own
 * version banner, which is identical across every failure and identifies nothing. Digits are
 * normalised because timings and counts move between otherwise identical failures.
 */
export function errorSig(text: string): { sig: string; exit: number | null } {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const exitLine = lines.find((l) => /exit code:?\s*\d+/i.test(l));
  const exit = exitLine ? Number(/exit code:?\s*(\d+)/i.exec(exitLine)![1]) : null;
  const meaningful = lines.filter((l) => !/^exit code:?\s*\d+$/i.test(l.trim()));
  const tail = meaningful[meaningful.length - 1] ?? "";
  return { sig: clean(tail).replace(/\d+/g, "N").slice(0, 70), exit };
}

/** Parse a session JSONL into turns, keeping only entries inside [startMs, endMs]. */
export function parseEntries(lines: string[], startMs = -Infinity, endMs = Infinity): Turn[] {
  type Res = { text: string; isError: boolean; atMs: number | null };
  const results = new Map<string, Res>();
  const entries: any[] = [];

  for (const line of lines) {
    if (line.trim() === "") continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; } // a torn final line while pi writes is expected
    entries.push(e);
    const m = e?.message;
    if (m?.role === "toolResult") {
      results.set(m.toolCallId, {
        text: (m.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("\n"),
        isError: Boolean(m.isError),
        atMs: ms(e.timestamp) ?? ms(m.timestamp),
      });
    }
  }

  const turns: Turn[] = [];
  let prevEndMs: number | null = null;
  let i = 0;

  for (const e of entries) {
    const m = e?.message;
    const atMs = ms(e?.timestamp) ?? ms(m?.timestamp);

    if (m?.role === "toolResult" && atMs != null) prevEndMs = atMs;
    if (m?.role !== "assistant") continue;
    if (atMs == null || atMs < startMs || atMs > endMs) { continue; }

    // Never measure latency from before this phase began. The previous result can be minutes
    // earlier — between two iterations sit a verify run, the gates, coverage, a confirm run and
    // a VM teardown and boot — and billing that gap to the model produced 362s of "model
    // latency" inside a 135s phase, and a 2906s median on a one-turn chat. Clamping bounds
    // every latency by the phase it belongs to. The first turn still includes VM boot and the
    // prompt write, which is the honest limit of what these timestamps can separate.
    const base = prevEndMs != null && Number.isFinite(startMs)
      ? Math.max(prevEndMs, startMs)
      : prevEndMs ?? (Number.isFinite(startMs) ? startMs : null);

    const u = m.usage ?? {};
    const content: any[] = m.content ?? [];
    const text = content.filter((c) => c?.type === "text" && c.text).map((c) => c.text).join("\n").trim() || null;

    const calls: ToolCall[] = [];
    let ci = 0;
    for (const c of content) {
      if (c?.type !== "toolCall") continue;
      ci++;
      const r = results.get(c.id);
      const { target, extra } = describe(c.name, c.arguments);
      const raw = r?.text ?? "";
      const all = raw.split("\n");
      const { sig, exit } = r?.isError ? errorSig(raw) : { sig: "", exit: null };
      const d = r?.atMs != null && atMs != null ? r.atMs - atMs : null;
      calls.push({
        i: ci, id: c.id, tool: c.name ?? "?", target, extra,
        ms: d != null && d >= DURATION_FLOOR_MS ? d : null,
        isError: Boolean(r?.isError), exit,
        head: clean(all.find((l) => l.trim() !== "") ?? ""),
        lines: all.filter((l) => l.trim() !== "").length,
        sig,
      });
    }

    turns.push({
      i: ++i, atMs,
      latMs: base != null && atMs > base ? atMs - base : null,
      ctx: u.totalTokens ?? 0,
      out: u.output ?? 0,
      costUsd: u.cost?.total ?? 0,
      model: String(m.model ?? "").split("/").pop() || "?",
      stopReason: m.stopReason ?? null,
      text,
      calls,
    });
    prevEndMs = atMs;
  }
  return turns;
}

/**
 * Roll turns up into the numbers a developer reads first.
 *
 * `toolMs` takes the LAST result of each turn rather than summing per-call durations: a turn
 * that issues three tool calls has them run back to back inside one window, so summing
 * (result − call) counts the same wall time once per call and inflates the total.
 */
export function summarize(turns: Turn[]): Stats {
  const byTool: Stats["byTool"] = {};
  let tools = 0, errs = 0, out = 0, ctxPeak = 0, costUsd = 0, modelMs = 0, toolMs = 0;
  const lats: number[] = [];

  for (const t of turns) {
    out += t.out;
    costUsd += t.costUsd;
    ctxPeak = Math.max(ctxPeak, t.ctx);
    if (t.latMs != null) { lats.push(t.latMs); modelMs += t.latMs; }

    let last = 0;
    for (const c of t.calls) {
      tools++;
      if (c.isError) errs++;
      (byTool[c.tool] ??= { n: 0, err: 0 }).n++;
      if (c.isError) byTool[c.tool]!.err++;
      if (c.ms != null) last = Math.max(last, c.ms);
    }
    toolMs += last;
  }

  lats.sort((a, b) => a - b);
  return {
    turns: turns.length, tools, errs, ctxPeak, out, costUsd,
    latP50: lats.length ? lats[Math.floor(lats.length / 2)]! : null,
    modelMs, toolMs, byTool,
  };
}

/** Read an agent's whole history as one trace per phase. */
export function readTrace(agentDir: string, sessionDir: string): PhaseTrace[] {
  const wins = phaseWindows(agentDir);
  if (!wins.length || !existsSync(sessionDir)) return [];

  const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort();
  const lines: string[] = [];
  for (const f of files) lines.push(...readFileSync(join(sessionDir, f), "utf8").split("\n"));

  return wins.map((win) => {
    const turns = parseEntries(lines, win.startMs, win.endMs);
    return { win, turns, calls: turns.flatMap((t) => t.calls), stats: summarize(turns) };
  });
}
