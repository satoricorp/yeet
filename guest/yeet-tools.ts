/**
 * yeet-tools.ts — the pi extension that makes yeet interactive. Runs INSIDE the microVM.
 *
 * Staged into run state next to yeet-run (never baked into the image) and loaded with
 * `pi -e /yeet/bin/yeet-tools.ts`, so iterating on it costs nothing.
 *
 * Two tools:
 *   ask_user    — ask the human a question; blocks until the controller answers.
 *   set_verify  — register the command that proves the work; the controller (and in
 *                 interactive mode, the human) can accept or edit it before it binds.
 *
 * pi runs headless here (-p, ctx.hasUI is false), so neither tool touches pi's UI. Instead
 * they speak yeet's native dialect: write a request file into $YEET_DIR/qa/ on the shared
 * virtio-fs mount, then poll for the answer file the host writes back. Renames are atomic on
 * both sides so nobody ever parses a half-written JSON.
 *
 * The `recommended` field on ask_user is REQUIRED by schema, not convention: it is what lets
 * --agent/--yes runs auto-answer every question and keep moving with zero humans present.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ITER_DIR = process.env.YEET_DIR || "/yeet/iter-000";
const QA = join(ITER_DIR, "qa");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let seq = 0;

async function exchange(
  kind: "ask" | "verify",
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown> | null> {
  mkdirSync(QA, { recursive: true });
  const id = String(++seq).padStart(3, "0");
  const req = join(QA, `${id}.${kind}.json`);
  writeFileSync(req + ".tmp", JSON.stringify({ id, kind, ...payload }, null, 2));
  renameSync(req + ".tmp", req);

  const ansPath = join(QA, `${id}.answer.json`);
  // No deadline here: waiting on a human is legitimate for as long as the human needs, and
  // the controller pauses its own stall clock while this request is pending. If the run is
  // being torn down, pi aborts us via `signal`.
  while (!signal?.aborted) {
    if (existsSync(ansPath)) {
      try {
        return JSON.parse(readFileSync(ansPath, "utf8")) as Record<string, unknown>;
      } catch {
        /* torn read between exists and rename settling — next poll gets it whole */
      }
    }
    await sleep(300);
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask the user",
    description:
      "Ask the human a question and wait for the answer. Use this BEFORE building when the task is " +
      "ambiguous, and any time a real decision has more than one defensible answer. Keep questions " +
      "short and concrete. Always supply options plus the one you would pick (`recommended`) — " +
      "unattended runs auto-answer with your recommendation, so make it the answer you can act on.",
    parameters: Type.Object({
      question: Type.String({ description: "The question, one or two sentences, plain language" }),
      options: Type.Array(Type.String(), {
        description: "2-4 concrete answers the user can pick from",
        minItems: 2,
        maxItems: 4,
      }),
      recommended: Type.String({ description: "Which option you would pick, verbatim from options" }),
      why: Type.Optional(Type.String({ description: "One line on why this needs a human" })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const a = await exchange("ask", params as unknown as Record<string, unknown>, signal);
      if (!a) {
        return {
          content: [{ type: "text", text: "No answer arrived (run is stopping). Proceed with your recommended option." }],
          details: {},
        };
      }
      return { content: [{ type: "text", text: `Answer: ${String(a.answer ?? "")}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "set_verify",
    label: "Register verification",
    description:
      "Register THE command that proves the work is correct — yeet runs it in a fresh VM after every " +
      "iteration and it must exit 0. Call this once, early. Use the project's existing test setup when " +
      "there is one; when there is none, write tests as part of your work and register the command that " +
      "runs them. `testFiles` are glob patterns for the test files. If the toolchain can emit coverage, " +
      "also give `coverageCommand`, which must leave an lcov file (lcov.info) in the workspace, e.g. " +
      "`bun test --coverage --coverage-reporter=lcov`. The human may edit the command; the answer tells " +
      "you what was actually registered.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command, run from the workspace root, exit 0 = correct" }),
      testFiles: Type.Array(Type.String(), {
        description: "Glob patterns matching the test files, e.g. [\"*.test.ts\", \"tests/**\"]",
      }),
      coverageCommand: Type.Optional(
        Type.String({ description: "Command that runs the tests AND writes an lcov.info in the workspace" }),
      ),
      why: Type.Optional(Type.String({ description: "One line on why this command is the right proof" })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const a = await exchange("verify", params as unknown as Record<string, unknown>, signal);
      if (!a) {
        return {
          content: [{ type: "text", text: "Not registered (run is stopping)." }],
          details: {},
        };
      }
      const cmd = String(a.command ?? (params as { command: string }).command);
      return {
        content: [{ type: "text", text: `Registered. Verification command: ${cmd}` }],
        details: {},
      };
    },
  });
}
