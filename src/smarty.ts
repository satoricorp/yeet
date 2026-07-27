/**
 * smarty.ts — the developer view.
 *
 * pleb mode answers "did it work". smarty answers "what did it actually do", in the register of
 * a debugger rather than a narrator: tool calls in order, exit codes, token and latency
 * accounting, SHAs. No voice, no jokes, no reassurance — VOICE.md puts the personality in pleb
 * mode and keeps it out of anything a developer reads while debugging.
 *
 * Colour is gated on an interactive stdout here, unlike `C` in ui.ts which emits SGR
 * unconditionally. This view is the one people pipe — `yeet ask --name x --smarty | grep '⏺ bash'`
 * — and escape codes in the middle of a grep pattern make that fail confusingly.
 */
import type { Agent } from "./agent";
import { stripGuestPaths, describe, type PhaseTrace, type ToolCall } from "./trace";
import { num, bool } from "./contract";

const TTY = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const S = {
  dim: paint("2"), bold: paint("1"), red: paint("31"),
  green: paint("32"), yellow: paint("33"), cyan: paint("36"),
};

const cols = () => Math.max(60, Math.min(process.stdout.columns || 100, 120));

/** Code-point aware, so a clipped multi-byte character cannot be split in half. */
function clip(s: string, max: number): string {
  const cp = [...s];
  return cp.length <= max ? s : cp.slice(0, Math.max(0, max - 1)).join("") + "…";
}

const dur = (ms: number | null): string => {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  // Round to whole seconds FIRST, then split. Rounding the remainder independently produces
  // "3m60s" for anything in the last half-second of a minute.
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
};

const kilo = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Runs of the same call collapse to one row. One agent here issued 78 calls of which 66 were
 *  the same failing command; printing all of them buries the one line that differs. */
type Fold = { call: ToolCall; n: number };
export function fold(calls: ToolCall[]): Fold[] {
  const out: Fold[] = [];
  for (const c of calls) {
    const prev = out[out.length - 1];
    if (prev && prev.call.tool === c.tool && prev.call.target === c.target && prev.call.isError === c.isError) {
      prev.n++;
    } else {
      out.push({ call: c, n: 1 });
    }
  }
  return out;
}

function toolRow(c: ToolCall, n: number, width: number): string[] {
  // "repeated N times" and "N edits in one call" are different facts, so they get different
  // shapes — `×3  ×9` side by side reads as one number twice.
  const right = [c.extra, dur(c.ms), n > 1 ? `${n} identical` : ""].filter(Boolean).join("  ");
  const glyph = c.isError ? S.red("⏺") : "⏺";
  const name = c.tool.padEnd(11);
  const budget = width - 2 - 11 - (right.length ? right.length + 2 : 0);
  const target = clip(c.target, Math.max(10, budget));
  const pad = right ? Math.max(1, width - 2 - 11 - [...target].length - right.length) : 0;
  const lines = [(`${glyph} ${S.bold(name)}${target}${" ".repeat(pad)}${S.dim(right)}`).trimEnd()];

  // One line of result, plus how much was withheld — enough to confirm what happened without
  // turning the trace into a log dump.
  if (c.head) {
    const more = c.lines > 1 ? `… +${c.lines - 1} lines` : "";
    const headBudget = width - 5 - (more.length ? more.length + 2 : 0);
    // The tools echo absolute guest paths back in their own success messages, so the prefix
    // has to come off the RESULT as well as the argument or half the trace is /yeet/workspace/.
    const head = clip(stripGuestPaths(c.head), Math.max(10, headBudget));
    const gap = more ? Math.max(1, width - 5 - [...head].length - more.length) : 0;
    const body = (`${head}${" ".repeat(gap)}${more}`).trimEnd();
    lines.push(`  ${S.dim("⎿")}  ${c.isError ? S.red(body) : S.dim(body)}`);
  }
  if (c.isError && c.exit != null) lines.push(`  ${S.dim(`   exit ${c.exit}`)}`);
  return lines;
}

/** The trace for one agent: every phase it ran, and what happened inside each. */
export function renderTrace(agent: Agent, phases: PhaseTrace[], opts: { calls?: boolean; dir?: string } = {}): void {
  const w = cols();
  const showCalls = opts.calls !== false;

  console.log(`${S.bold(agent.name)}  ${S.dim(agent.state)}`);
  console.log(`${S.dim("model   ")}${agent.model}`);
  console.log(`${S.dim("branch  ")}${agent.branch}${agent.baseHead ? S.dim(`  base ${agent.baseHead.slice(0, 7)}`) : ""}`);
  if (agent.verify) console.log(`${S.dim("verify  ")}${agent.verify.command}  ${S.dim(`(${agent.verify.source})`)}`);
  if (agent.origin) console.log(`${S.dim("origin  ")}${agent.origin}`);

  let calls = 0, errs = 0, cost = 0, model = 0, tool = 0, wall = 0;

  for (const p of phases) {
    const m = p.win.meta;
    // The real phase duration, from the recorded epochs. p.win.endMs carries a +999ms pad so
    // the window captures entries in its final second; showing that pad would report every
    // sub-second phase as "999ms".
    const secs = Math.max(0, num(m, "endedAtEpoch", 0) - num(m, "startedAtEpoch", 0));
    wall += secs;
    calls += p.stats.tools; errs += p.stats.errs; cost += p.stats.costUsd;
    model += p.stats.modelMs; tool += p.stats.toolMs;

    // "<1s" rather than "0ms": the contract stores integer seconds, so a sub-second phase
    // records zero. Printing 0ms would claim a precision that is not in the file (task #24).
    const head = ` ${p.win.dir} · ${p.win.phase} · ${secs === 0 ? "<1s" : dur(secs * 1000)} `;
    console.log("");
    console.log(S.dim("──" + head + "─".repeat(Math.max(0, w - head.length - 2))));

    if (showCalls && p.turns.length) {
      for (const { call, n } of fold(p.calls)) for (const l of toolRow(call, n, w)) console.log(l);
    }

    // The accounting block. Every number here is derived from the session log or meta.kv; none
    // of it is inferred.
    const s = p.stats;
    if (s.turns) {
      console.log(S.dim(`  turns  ${s.turns} · tools ${s.tools} (${s.errs} err) · ctx ${kilo(s.ctxPeak)} peak · out ${kilo(s.out)} · p50 ${dur(s.latP50)} · $${s.costUsd.toFixed(4)}`));
      const byTool = Object.entries(s.byTool).sort((a, b) => b[1].n - a[1].n)
        .map(([t, v]) => `${t} ${v.n}${v.err ? S.red(`/${v.err}e`) : ""}`).join(" · ");
      if (byTool) console.log(S.dim(`  tools  ${byTool}`));
      console.log(S.dim(`  time   ${dur(secs * 1000)} wall · model ${dur(s.modelMs)} · tool ${dur(s.toolMs)}`));
    }

    const testExit = m.testExit != null ? num(m, "testExit", -1) : null;
    const bits: string[] = [];
    if (m.afterHead) bits.push(m.afterHead.slice(0, 7));
    if (bool(m, "committed")) bits.push("committed");
    if (!bool(m, "treeChanged") && m.treeChanged != null) bits.push(S.yellow("tree unchanged"));
    if (testExit != null) bits.push(testExit === 0 ? S.green("test exit 0") : S.red(`test exit ${testExit}`));
    if (m.agentExit && num(m, "agentExit", 0) !== 0) bits.push(S.red(`agent exit ${m.agentExit}`));
    if (bits.length) console.log(S.dim("  state  ") + bits.join(S.dim(" · ")));
  }

  console.log("");
  console.log(S.dim("─".repeat(w)));
  console.log(`  ${phases.length} phases · ${calls} tool calls${errs ? S.red(` · ${errs} errors`) : " · 0 errors"} · $${cost.toFixed(4)}`);
  console.log(S.dim(`  ${dur(wall * 1000)} wall · model ${dur(model)} (${wall ? Math.round(model / 10 / wall) : 0}%) · tool ${dur(tool)} (${wall ? Math.round(tool / 10 / wall) : 0}%)`));
  if (agent.coverage) console.log(S.dim(`  coverage ${agent.coverage.pct}% (${agent.coverage.coveredLines}/${agent.coverage.totalLines} lines)`));
  if (opts.dir) console.log(S.dim(`  ${opts.dir}`));
}

/**
 * The live trace — pi's events rendered as they arrive.
 *
 * Strictly append-only: no cursor movement, no redraw. A terminal that is being piped, resized,
 * or scrolled cannot be rewritten safely, and the moment this tries it stops composing with
 * everything else the run prints. That is also why runs of identical calls are NOT folded here
 * the way the replay view folds them — you cannot collapse rows you have already emitted.
 *
 * Only text deltas are streamed, not thinking deltas: thinking is long, arrives in bulk, and
 * would bury the tool calls that are the point of watching.
 */
export class LiveTrace {
  private open = new Map<string, { tool: string; target: string; at: number }>();
  private streaming = false;
  private col = 0;
  private readonly w = cols();

  feed(events: any[]): void {
    for (const e of events) this.one(e);
  }

  /** Close any half-written text line. Called before a row and at the end of a phase. */
  endText(): void {
    if (this.streaming) { process.stdout.write("\n"); this.streaming = false; this.col = 0; }
  }

  private one(e: any): void {
    switch (e?.type) {
      case "message_update": {
        const d = e.assistantMessageEvent;
        if (d?.type !== "text_delta" || typeof d.delta !== "string") return;
        this.text(d.delta);
        return;
      }
      case "tool_execution_start": {
        this.endText();
        const { target } = describe(e.toolName, e.args);
        this.open.set(e.toolCallId, { tool: e.toolName, target, at: Date.now() });
        const name = String(e.toolName).padEnd(11);
        console.log(`⏺ ${S.bold(name)}${clip(target, this.w - 13)}`);
        return;
      }
      case "tool_execution_end": {
        this.endText();
        const started = this.open.get(e.toolCallId);
        const wasAlone = this.open.size <= 1;
        this.open.delete(e.toolCallId);
        const ms = started ? Date.now() - started.at : null;
        const text = typeof e.result === "string" ? e.result
          : (e.result?.output ?? e.result?.content?.[0]?.text ?? "");
        const all = String(text).split("\n").filter((l: string) => l.trim() !== "");
        const head = stripGuestPaths(all[0] ?? "(no output)").replace(/\s+/g, " ");
        // Calls can overlap — two writes started before either finished — and append-only
        // output cannot put the result back under its own row. Name the call it answers
        // whenever more than one was in flight, or the results read as belonging to the
        // wrong tool.
        const label = wasAlone || !started ? "" : `${started.tool} ${clip(started.target, 24)} → `;
        const right = [dur(ms != null && ms >= 200 ? ms : null), all.length > 1 ? `+${all.length - 1} lines` : ""]
          .filter(Boolean).join("  ");
        const budget = Math.max(10, this.w - 5 - label.length - (right ? right.length + 2 : 0));
        const body = `${label}${clip(head, budget)}${right ? `  ${right}` : ""}`;
        console.log(`  ${S.dim("⎿")}  ${e.isError ? S.red(body) : S.dim(body)}`);
        return;
      }
      // The agent has stopped talking; close any half-written line so whatever the loop prints
      // next starts on its own row.
      case "message_end":
      case "agent_end":
      case "agent_settled":
        this.endText();
        return;
      // Both were invisible to yeet before the event stream, and both explain a slow or
      // expensive run that otherwise looks like the model simply being slow.
      case "auto_retry_start":
        this.endText();
        console.log(S.yellow(`  ↻ retry ${e.attempt}/${e.maxAttempts} in ${e.delayMs}ms — ${clip(String(e.errorMessage ?? ""), 60)}`));
        return;
      case "compaction_start":
        this.endText();
        console.log(S.yellow(`  ⧉ compacting context (${e.reason})`));
        return;
      case "turn_start":
        this.endText();
        return;
    }
  }

  /** Wrap by hand — the delta arrives in fragments, so there is no line to measure. */
  private text(delta: string): void {
    if (!this.streaming) { process.stdout.write("  "); this.col = 2; this.streaming = true; }
    for (const ch of delta) {
      if (ch === "\n") { process.stdout.write("\n  "); this.col = 2; continue; }
      if (this.col >= this.w - 1) { process.stdout.write("\n  "); this.col = 2; }
      process.stdout.write(TTY ? `\x1b[2m${ch}\x1b[0m` : ch);
      this.col++;
    }
  }
}

/** Search results, developer register: score, matched terms, provenance, paths. */
export function renderSearchSmarty(
  rows: Array<{ name: string; state: string; score: number; matched: string[]; source: string; snippet: string | null }>,
  scanned: number,
  agentDir: (n: string) => string,
): void {
  const w = cols();
  const nw = Math.max(12, ...rows.map((r) => r.name.length)) + 2;
  console.log("");
  console.log(S.dim(`${rows.length}/${scanned} agents matched · bm25f(name:3 task:2 prose:1)`));
  console.log("");
  for (const r of rows) {
    console.log(`  ${S.bold(r.name.padEnd(nw))}${S.dim(r.score.toFixed(3).padStart(7))}  ${S.cyan(r.state.padEnd(11))}${S.dim(`${r.source}  [${r.matched.join(" ")}]`)}`);
    if (r.snippet) console.log(`    ${S.dim(clip(r.snippet, w - 6))}`);
    console.log(S.dim(`    ${agentDir(r.name)}`));
  }
}
