#!/usr/bin/env bun
/**
 * trace.ts — the numbers in the developer view have to be right, or the view is worse than none.
 *
 * A trace exists to answer "what did it do and where did the time go". Every check below pins a
 * way that answer can be confidently wrong: two timestamp formats in one record, a phase
 * boundary that bills yeet's own pipeline to the model, and a turn with three tool calls whose
 * durations overlap. Each of these produced a real wrong number against the real store before
 * it was fixed.
 *
 *   bun test/trace.ts
 */
import { ms, describe as describeCall, errorSig, parseEntries, summarize, relPath, stripGuestPaths, finalText, EventTail } from "../src/trace";
import { writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  \x1b[32m✓\x1b[0m" : "  \x1b[31m✗\x1b[0m"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const T0 = 1_785_124_000_000;
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/** One assistant turn with its tool calls, in the real record shape. */
const turn = (atMs: number, calls: Array<{ id: string; name: string; args?: any }>, usage: any = {}) => ({
  type: "message", id: `a${atMs}`, timestamp: iso(atMs),
  message: {
    role: "assistant", model: "openrouter/z-ai/glm-5.2", stopReason: "toolUse",
    timestamp: T0 + atMs, // epoch ms — deliberately the OTHER format, as pi really writes it
    usage: { input: 100, output: 50, cacheRead: 900, totalTokens: 1050, cost: { total: 0.001 }, ...usage },
    content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args ?? {} })),
  },
});

const result = (atMs: number, id: string, text: string, isError = false) => ({
  type: "message", id: `r${id}`, timestamp: iso(atMs),
  message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError },
});

const lines = (...objs: any[]) => objs.map((o) => JSON.stringify(o));

console.log("\n\x1b[36m▪\x1b[0m two timestamp formats in one record");
{
  // The entry carries ISO-8601; message.timestamp carries epoch millis. Date.parse on the
  // latter is NaN, which then propagates silently into every duration.
  check("ISO parses", ms("2026-07-27T03:46:58.663Z") === 1785124018663);
  check("epoch millis pass through", ms(1785124015123) === 1785124015123);
  check("NaN-producing input is rejected, not returned", ms("not-a-date") === null);
  check("undefined is null, not 0", ms(undefined) === null);
}

console.log("\n\x1b[36m▪\x1b[0m per-tool identification");
{
  const bash = describeCall("bash", { command: "cd /yeet/workspace && bun test --coverage" });
  check("the ubiquitous cd prefix is dropped", bash.target === "bun test --coverage", bash.target);

  // A command must never be rewritten beyond that: doing so misreports what actually ran.
  const inner = describeCall("bash", { command: "cat /yeet/workspace/src/a.js" });
  check("interior paths in a command are NOT rewritten", inner.target.includes("/yeet/workspace/src/a.js"));

  const multiline = describeCall("bash", { command: "a\n  b\n  c" });
  check("newlines collapse to one line", multiline.target === "a b c", multiline.target);

  const w = describeCall("write", { path: "/yeet/workspace/test/x.test.js", content: "abc" });
  check("write shows a relative path", w.target === "test/x.test.js", w.target);
  check("write shows the byte count", w.extra === "3 B", w.extra);

  const e = describeCall("edit", { path: "/yeet/workspace/src/a.js", edits: [1, 2, 3] });
  check("a multi-edit call says how many", e.extra === "3 edits", e.extra);
  const e1 = describeCall("edit", { path: "/yeet/workspace/src/a.js", edits: [1] });
  check("a single edit adds no noise", e1.extra === "");

  const r = describeCall("read", { path: "/yeet/workspace/src/a.js", offset: 10, limit: 20 });
  check("read shows a range only when present", r.target === "src/a.js:10+20", r.target);
  check("read with no range stays clean", describeCall("read", { path: "/yeet/a.js" }).target === "a.js");

  check("an unknown tool degrades to its arguments", describeCall("weird", { x: 1 }).target === '{"x":1}');
  check("an unknown tool with no arguments shows nothing", describeCall("weird", {}).target === "");
}

console.log("\n\x1b[36m▪\x1b[0m error signatures come from the tail");
{
  // Every failing `bun test` opens with the same version banner. Fingerprinting the head makes
  // nine different failures look like one problem.
  const a = errorSig("bun test v1.3.14 (0d9b296a)\n\n1 | broken\nerror: Expected 6 but got 7\nexit code: 1");
  const b = errorSig("bun test v1.3.14 (0d9b296a)\n\n1 | broken\nerror: Expected 9 but got 4\nexit code: 1");
  check("the exit code is extracted", a.exit === 1);
  check("digits are normalised so timings do not split a signature", a.sig === b.sig, `${a.sig} vs ${b.sig}`);
  check("the signature is not the banner", !a.sig.includes("bun test v"), a.sig);

  const c = errorSig("error: ENOENT no such file\nexit code: 2");
  check("a different failure gets a different signature", c.sig !== a.sig);
  check("its exit code differs too", c.exit === 2);
  check("no exit line yields null rather than 0", errorSig("just broke").exit === null);
}

console.log("\n\x1b[36m▪\x1b[0m path stripping");
{
  check("anchored strip for arguments", relPath("/yeet/workspace/src/a.js") === "src/a.js");
  check("anchored strip leaves interior paths alone", relPath("x /yeet/workspace/a.js") === "x /yeet/workspace/a.js");
  // Tools echo absolute guest paths inside their own success messages.
  check("global strip for result text",
    stripGuestPaths("Successfully wrote 237 bytes to /yeet/workspace/test/x.js") ===
    "Successfully wrote 237 bytes to test/x.js");
}

console.log("\n\x1b[36m▪\x1b[0m latency is bounded by the phase it belongs to");
{
  // THE BUG THIS PINS: between two iterations sit a verify run, the gates, coverage, a confirm
  // run, and a VM teardown and boot. Measuring the first turn's latency from the previous
  // phase's last result billed all of that to the model — it reported 362s of model latency
  // inside a 135s phase, and a 2906s median on a one-turn chat.
  const src = lines(
    turn(0, [{ id: "t1", name: "bash", args: { command: "echo hi" } }]),
    result(500, "t1", "hi"),
    // …300 seconds pass here: yeet's own pipeline, not the model…
    turn(300_000, [{ id: "t2", name: "bash", args: { command: "echo again" } }]),
    result(300_400, "t2", "again"),
  );

  // Window starting at the second turn — i.e. a new phase.
  const t = parseEntries(src, T0 + 299_000, T0 + 400_000);
  check("only the in-window turn is returned", t.length === 1);
  check("latency is clamped to the phase start, not the previous phase",
    t[0]!.latMs === 1000, `got ${t[0]!.latMs}ms`);

  const s = summarize(t);
  check("so model time cannot exceed the phase", s.modelMs === 1000, `got ${s.modelMs}ms`);
}

console.log("\n\x1b[36m▪\x1b[0m concurrent tool calls are not counted twice");
{
  // A turn issuing three calls runs them inside ONE window. Summing (result − call) per call
  // charges the same wall time three times — measured +24.6% on a real agent.
  const src = lines(
    turn(0, [
      { id: "a", name: "bash", args: { command: "one" } },
      { id: "b", name: "bash", args: { command: "two" } },
      { id: "c", name: "bash", args: { command: "three" } },
    ]),
    result(1000, "a", "1"),
    result(1000, "b", "2"),
    result(1000, "c", "3"),
  );
  const s = summarize(parseEntries(src));
  check("three 1s calls in one turn count as 1s, not 3s", s.toolMs === 1000, `got ${s.toolMs}ms`);
  check("but all three are counted as calls", s.tools === 3);
}

console.log("\n\x1b[36m▪\x1b[0m rollups");
{
  const src = lines(
    turn(0, [{ id: "a", name: "bash", args: { command: "ok" } }], { output: 10, totalTokens: 500 }),
    result(300, "a", "fine"),
    turn(5_000, [{ id: "b", name: "bash", args: { command: "bad" } }], { output: 20, totalTokens: 9000 }),
    result(5_400, "b", "error: boom\nexit code: 1", true),
  );
  const s = summarize(parseEntries(src));
  check("turns counted", s.turns === 2);
  check("errors counted", s.errs === 1);
  check("peak context is the max, not the sum", s.ctxPeak === 9000, `got ${s.ctxPeak}`);
  check("output tokens are summed", s.out === 30);
  check("per-tool breakdown records errors", s.byTool.bash?.err === 1 && s.byTool.bash?.n === 2);
  check("cost is summed", Math.abs(s.costUsd - 0.002) < 1e-9);
  check("an empty session yields zeros, not NaN", summarize([]).turns === 0 && summarize([]).latP50 === null);
}

console.log("\n\x1b[36m▪\x1b[0m malformed input");
{
  // pi is still writing; the last line is routinely torn.
  const src = [JSON.stringify(turn(0, [])), '{"type":"mess'];
  check("a torn final line is skipped, not thrown", parseEntries(src).length === 1);
  check("blank lines are ignored", parseEntries(["", "  ", JSON.stringify(turn(0, []))]).length === 1);
}

console.log("\n\x1b[36m▪\x1b[0m the agent's closing prose, in either log format");
{
  // agent.log was prose before pi ran in --mode json, and every agent that ran under the old
  // shape is still on disk and still worth finding.
  check("old prose passes through", finalText("Built a thing.\nIt works.") === "Built a thing.\nIt works.");

  const ev = (role: string, text: string) =>
    JSON.stringify({ type: "message_end", message: { role, content: [{ type: "text", text }] } });
  const stream = [
    JSON.stringify({ type: "session", version: 3 }),
    ev("user", "do the thing"),
    ev("assistant", "First pass."),
    JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } }),
    ev("assistant", "Done. It works."),
  ].join("\n");

  check("text is extracted from the event stream", finalText(stream) === "Done. It works.", finalText(stream) ?? "null");
  check("the LAST assistant message wins", !String(finalText(stream)).includes("First pass"));
  check("tool results are not mistaken for the agent's words", !String(finalText(stream)).includes("tool output"));
  check("an empty log is null, not empty string", finalText("   ") === null);
  check("a stream with no assistant text is null", finalText(JSON.stringify({ type: "agent_start" })) === null);
}

console.log("\n\x1b[36m▪\x1b[0m following a log that is still being written");
{
  const tmp = join(tmpdir(), `yeet-tail-${process.pid}.jsonl`);
  try {
    writeFileSync(tmp, "");
    const tail = new EventTail(tmp);
    check("an empty file yields nothing", tail.drain().length === 0);

    writeFileSync(tmp, '{"type":"a"}\n{"type":"b"}\n');
    const first = tail.drain();
    check("complete lines are returned", first.length === 2 && first[1]!.type === "b");
    check("already-seen lines are not returned twice", tail.drain().length === 0);

    // The guest writes while the host reads, so the last line is routinely half-written.
    appendFileSync(tmp, '{"type":"c"}\n{"type":"par');
    const second = tail.drain();
    check("a torn final line is withheld", second.length === 1 && second[0]!.type === "c");

    appendFileSync(tmp, 'tial"}\n');
    const third = tail.drain();
    check("and delivered once it completes", third.length === 1 && third[0]!.type === "partial",
      JSON.stringify(third));

    // Truncated or replaced underneath us: reading from a stale offset would return garbage.
    writeFileSync(tmp, '{"type":"fresh"}\n');
    const after = tail.drain();
    check("a truncated file restarts from zero", after.length === 1 && after[0]!.type === "fresh");

    check("malformed JSON is skipped, not thrown", (() => {
      appendFileSync(tmp, "not json at all\n{\"type\":\"ok\"}\n");
      const r = tail.drain();
      return r.length === 1 && r[0]!.type === "ok";
    })());
  } finally {
    rmSync(tmp, { force: true });
  }
  check("a missing file yields nothing rather than throwing",
    new EventTail(join(tmpdir(), "yeet-does-not-exist.jsonl")).drain().length === 0);
}

console.log(failures === 0 ? "\n\x1b[32mall checks passed\x1b[0m" : `\n\x1b[31m${failures} failed\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
