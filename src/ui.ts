/**
 * ui.ts — one stream of typed events, three renderings.
 *
 *   pleb    the default: plain sentences for someone who does not know what a diffstat is.
 *   smarty  the developer view: the dense table, exit codes, SHAs-adjacent detail.
 *   json    --agent: NDJSON on stdout, nothing else on stdout, no colour, no personality.
 *
 * The loop code never calls console.log for run output; it emits events here. That is what
 * keeps machine mode honest — there is no code path where prose leaks into a parser.
 *
 * Input goes through here too (questions, verify proposals, confirmations), because WHO
 * answers is a mode decision: a human at a TTY, or the recommendation auto-accepted
 * (--agent, --yes, or stdin not being a terminal).
 */
import * as readline from "node:readline/promises";
import type { AgentState } from "./agent";
import type { AskRequest, VerifyRequest, VerifyDecision } from "./bridge";
import { lines, blameProvider, plebMoney, plebDuration, plainText, type Lines } from "./voice";
import type { Voice } from "./config";

export const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export const dur = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`);
/** Sub-cent runs are normal with small models, and rounding them to "$0.00" makes it look like
 *  cost tracking is broken when it isn't. Show enough digits to prove it is working. */
export const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export type Mode = "pleb" | "smarty" | "json";

export type UiEvent =
  | { event: "start"; agent: string; task: string; resuming: boolean; model: string; origin: string | null; verify: string | null; maxIter: number; maxCostUsd: number | null; isNew: boolean }
  | { event: "baseline"; verdict: "green" | "red" | "none"; testExit: number | null }
  | { event: "verify_bound"; command: string; testFiles: string[]; coverageCommand: string | null; source: "agent" | "user"; edited: boolean }
  | { event: "question"; id: string; question: string; options: string[]; recommended: string; why?: string }
  | { event: "answer"; id: string; answer: string; source: "user" | "auto" }
  | { event: "escalate"; action: "stop" | "kill"; reason: "budget" | "stall"; detail?: string }
  | { event: "iteration"; n: number; seconds: number; costUsd: number; insertions: number; deletions: number; filesChanged: number; treeChanged: boolean; verdict: "green" | "red" | "none"; testExit: number | null; agentVerdict: string | null; interrupted: boolean; touchedFrozenTests: boolean }
  | { event: "confirmed"; ok: boolean }
  | { event: "coverage"; pct: number | null; coveredLines: number; totalLines: number; note?: string }
  | { event: "warning"; message: string }
  | { event: "info"; message: string }
  | { event: "error"; message: string }
  | { event: "done"; state: AgentState; seconds: number; costUsd: number; note: string; branch: string; workspace: string; origin: string | null; summary: string | null; model: string; coveragePct: number | null };

export class Ui {
  /** The voice's phrasebook, resolved once. Machine mode never reads it. */
  private readonly L: Lines;

  constructor(
    public readonly mode: Mode,
    /** Recommendations are taken without asking: --agent, --yes, or no TTY to ask at. */
    public readonly autoAnswer: boolean,
    voice: Voice = "default",
  ) {
    this.L = lines(voice);
  }

  private out(line: string): void {
    console.log(line);
  }

  event(e: UiEvent): void {
    if (this.mode === "json") {
      this.out(JSON.stringify(e));
      return;
    }
    if (this.mode === "smarty") this.smarty(e);
    else this.pleb(e);
  }

  // ── input ─────────────────────────────────────────────────────────────────────────────

  async ask(q: AskRequest): Promise<{ answer: string; source: "user" | "auto" }> {
    this.event({ event: "question", id: q.id, question: q.question, options: q.options, recommended: q.recommended, why: q.why });
    let answer = q.recommended;
    let source: "user" | "auto" = "auto";

    if (!this.autoAnswer) {
      const raw = (await this.prompt(`   ${C.dim("Enter = its pick · a number picks · or type your own:")} `)).trim();
      if (raw !== "") {
        const idx = Number(raw);
        answer = Number.isInteger(idx) && idx >= 1 && idx <= q.options.length ? q.options[idx - 1]! : raw;
      }
      source = "user";
    }
    this.event({ event: "answer", id: q.id, answer, source });
    return { answer, source };
  }

  async verifyProposal(v: VerifyRequest): Promise<VerifyDecision & { edited: boolean }> {
    let command = v.command;
    let edited = false;

    if (!this.autoAnswer) {
      if (this.mode !== "json") {
        this.out("");
        this.out(`It wants to prove the work with: ${C.bold(v.command)}`);
        if (v.testFiles.length) this.out(`   ${C.dim(`test files: ${v.testFiles.join(", ")}`)}`);
        if (v.coverageCommand) this.out(`   ${C.dim(`coverage: ${v.coverageCommand}`)}`);
        if (v.why) this.out(`   ${C.dim(v.why)}`);
      }
      const raw = (await this.prompt(`   ${C.dim("Enter = accept · or type a different command:")} `)).trim();
      if (raw !== "") {
        command = raw;
        edited = true;
      }
    }
    const decision: VerifyDecision = { command, testFiles: v.testFiles, coverageCommand: v.coverageCommand };
    this.event({
      event: "verify_bound",
      command,
      testFiles: v.testFiles,
      coverageCommand: v.coverageCommand,
      source: "agent",
      edited,
    });
    return { ...decision, edited };
  }

  /** Plain yes/no. Auto mode consents — the caller only reaches this on a command the
   *  invoker explicitly ran (push, rm), so auto-invocation is the consent. */
  async confirm(text: string): Promise<boolean> {
    if (this.autoAnswer) return true;
    const raw = (await this.prompt(`${text} ${C.dim("[y/N]")} `)).trim().toLowerCase();
    return raw === "y" || raw === "yes";
  }

  private async prompt(text: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(text);
    } finally {
      rl.close();
    }
  }

  // ── pleb ──────────────────────────────────────────────────────────────────────────────

  private pleb(e: UiEvent): void {
    switch (e.event) {
      case "start": {
        this.out("");
        this.out(e.isNew ? `Meet ${C.bold(e.agent)} — that's how you'll refer to it from now on.` : `Back to work on ${C.bold(e.agent)}.`);
        this.out("");
        this.out(`  job      ${e.task}`);
        if (e.origin) this.out(`  repo     ${e.origin}`);
        this.out(`  limits   ${e.maxIter} rounds${e.maxCostUsd ? ` or ${plebMoney(e.maxCostUsd)}` : ""}`);
        if (e.isNew) this.out(`  ${C.dim(`naming   I picked it. Pass --name next time if you'd rather choose.`)}`);
        this.out("");
        break;
      }
      case "baseline":
        if (e.verdict === "red") this.out(`checked first: things fail before I touch anything. Good — that means there's a real job here.`);
        break;
      case "verify_bound":
        // Silent unless you overrode it. Testing is table stakes, not a feature to narrate —
        // and the proposal prompt has just shown you the command anyway.
        if (e.edited) this.out(C.dim(`checking with your command instead: ${e.command}`));
        break;
      case "question": {
        this.out("");
        this.out(`${C.bold("It has a question:")} ${e.question}`);
        e.options.forEach((o, i) => {
          const marker = o === e.recommended ? C.cyan(" ← its pick") : "";
          this.out(`     ${i + 1}. ${o}${marker}`);
        });
        break;
      }
      case "answer":
        if (e.source === "auto") this.out(`   ${C.dim(`went with: ${e.answer}`)}`);
        break;
      case "escalate":
        if (e.action === "stop" && e.reason === "budget") this.out(C.yellow("💸 budget cap hit mid-round — told it to wrap up; whatever's done gets kept."));
        else if (e.action === "stop") this.out(C.yellow("😴 no signs of life in there — told it to wrap up."));
        else this.out(C.yellow(`🔌 ${this.L.stallKilled(e.detail)}`));
        break;
      case "iteration": {
        const what = e.treeChanged
          ? `changed ${e.filesChanged} file${e.filesChanged === 1 ? "" : "s"}`
          : e.agentVerdict === "error"
            ? "hit an error and changed nothing"
            : "changed nothing";
        const check = e.verdict === "green" ? C.green("checks pass") : e.verdict === "red" ? C.red("checks fail") : C.dim("no checks yet");
        this.out(`round ${e.n}: ${what} — ${check}${e.interrupted ? C.yellow(" (interrupted mid-work)") : ""}`);
        if (e.touchedFrozenTests) this.out(`   ${C.yellow("it edited tests that existed before it started — a pass that moves the goalposts.")}`);
        break;
      }
      case "confirmed":
        this.out(e.ok ? `double-checked in a fresh sandbox — ${C.green("still passing")}.` : C.yellow(this.L.flaky));
        break;
      case "coverage":
        // Only worth saying when it is BAD news. A good number is the expectation, not an
        // achievement, and it already appears in the wrap-up.
        if (e.pct !== null && e.pct < 50) {
          this.out(C.yellow(`the tests only reach ${e.pct}% of the code — thin enough to be worth another round.`));
        }
        break;
      case "warning":
        this.out(C.yellow(e.message));
        break;
      case "info":
        this.out(C.dim(e.message));
        break;
      case "error":
        this.out(C.red(e.message));
        break;
      case "done": {
        this.out("");
        const line =
          e.state === "passed" ? C.green(this.L.passed)
          : e.state === "failed" ? C.red(this.L.failed(blameProvider(e.model)))
          : e.state === "stalled" ? C.yellow(this.L.stalled)
          : e.state === "unverified" ? C.yellow(this.L.unverified)
          : C.yellow(this.L.capped);
        this.out(line);
        if (e.note) this.out(C.dim(`(${e.note})`));

        const name = e.branch.replace(/^yeet\//, "");
        if (e.summary) {
          this.out("");
          this.out(`  ${plainText(e.summary, 400)}`);
        }

        this.out("");
        this.out(`  took     ${plebDuration(e.seconds)}, ${plebMoney(e.costUsd)}`);
        this.out(`  branch   ${e.branch}`);
        if (e.coveragePct !== null) this.out(C.dim(`  covered  ${e.coveragePct}% of the code`));

        // Always end with somewhere to go. Every line is a command you can paste. Widths are
        // computed rather than hand-padded, because the name length varies per agent.
        const steps: Array<[string, string]> = [
          [`yeet --name ${name} "…"`, "keep building"],
          // Deliberately NOT a path. Someone using yeet has an agent, not a filesystem — they
          // should never need to know there is a git repo or where it lives. yeet runs it.
          [`yeet --name ${name} test`, "run its checks and show the output"],
          [`yeet ask --name ${name}`, "what it did, in detail"],
          e.origin
            ? [`yeet --name ${name} push`, `send the branch to ${e.origin}`]
            : [`yeet config --name ${name} origin <url>`, "connect a repo, then push"],
        ];
        const w = Math.max(...steps.map(([cmd]) => cmd.length)) + 3;
        this.out("");
        this.out(C.dim("next"));
        for (const [cmd, why] of steps) this.out(`  ${cmd.padEnd(w)}${C.dim(why)}`);
        break;
      }
    }
  }

  // ── smarty ────────────────────────────────────────────────────────────────────────────

  private row(n: string, label: string, timing: string, cost: string, diff: string, verdict: string): void {
    this.out(` ${n.padStart(2)}  ${label.padEnd(9)}${timing.padEnd(8)}${cost.padEnd(9)}${diff.padEnd(18)}${verdict}`);
  }

  private smarty(e: UiEvent): void {
    switch (e.event) {
      case "start":
        this.out("");
        this.out(`${C.dim("agent")}   ${C.bold(e.agent)}${e.resuming ? C.dim(" · resuming") : ""}`);
        this.out(`${C.dim("task")}    ${e.task}`);
        this.out(`${C.dim("where")}   ${e.origin ?? "isolated workspace"}`);
        this.out(`${C.dim("model")}   ${e.model}`);
        this.out(`${C.dim("verify")}  ${e.verify ?? C.yellow("unset — the agent must register one (set_verify)")}`);
        this.out(`${C.dim("limits")}  ${e.maxIter} iterations${e.maxCostUsd ? ` · ${usd(e.maxCostUsd)}` : " · no cap"}`);
        this.out("");
        break;
      case "baseline":
        this.row("0", "baseline", "", "", "", e.verdict === "green" ? C.green("green") : e.verdict === "red" ? C.red(`red · exit ${e.testExit}`) : C.dim("no verifier"));
        break;
      case "verify_bound":
        this.out(`${C.cyan("▪")} verify ${e.edited ? "(edited by user)" : `(from ${e.source})`}: ${C.bold(e.command)}`);
        if (e.testFiles.length) this.out(`  ${C.dim(`testFiles: ${e.testFiles.join(" ")}`)}`);
        if (e.coverageCommand) this.out(`  ${C.dim(`coverage:  ${e.coverageCommand}`)}`);
        break;
      case "question":
        this.out(`${C.cyan("?")} ${e.question}`);
        e.options.forEach((o, i) => this.out(`    ${i + 1}. ${o}${o === e.recommended ? C.cyan("  ← recommended") : ""}`));
        if (e.why) this.out(`    ${C.dim(e.why)}`);
        break;
      case "answer":
        this.out(`  ${C.dim(`answer (${e.source}): ${e.answer}`)}`);
        break;
      case "escalate":
        this.out(C.yellow(`  ${e.action === "stop" ? "STOP dropped" : "VM killed"} — ${e.reason}${e.detail ? ` (${e.detail})` : ""}`));
        break;
      case "iteration": {
        const edits = e.treeChanged
          ? `+${e.insertions} −${e.deletions}  ${e.filesChanged} file${e.filesChanged === 1 ? "" : "s"}`
          : e.agentVerdict === "error"
            ? C.red("agent error")
            : e.agentVerdict === "stopped"
              ? C.yellow("stopped")
              : C.dim("no edit");
        const verdict = e.verdict === "green" ? C.green("green") : e.verdict === "red" ? C.red(`red · exit ${e.testExit}`) : C.dim("no verifier");
        this.row(String(e.n), "agent", dur(e.seconds), usd(e.costUsd), edits, verdict);
        if (e.interrupted) this.out(`     ${C.yellow("⚠")} ${C.dim("interrupted mid-edit — the committed tree may be inconsistent")}`);
        if (e.touchedFrozenTests) this.out(`     ${C.yellow("⚠")} ${C.dim("modified frozen (pre-existing) test files this iteration")}`);
        break;
      }
      case "confirmed":
        this.row("", "confirm", "", "", "", e.ok ? C.green("green ✓") : C.yellow("flaky — did not reproduce"));
        break;
      case "coverage":
        this.row("", "coverage", "", "", "", e.pct === null ? C.dim(`unmeasured${e.note ? ` — ${e.note}` : ""}`) : `${e.pct}% (${e.coveredLines}/${e.totalLines} lines)`);
        break;
      case "warning":
        this.out(`${C.yellow("⚠")} ${e.message}`);
        break;
      case "info":
        this.out(C.dim(e.message));
        break;
      case "error":
        this.out(`${C.red("✖")} ${e.message}`);
        break;
      case "done": {
        const banner = e.state === "passed" ? C.green("passed") : C.yellow(e.state);
        this.out("");
        this.out(`${banner} · ${dur(e.seconds)} · ${usd(e.costUsd)}${e.note ? ` · ${e.note}` : ""}${e.coveragePct !== null ? ` · cov ${e.coveragePct}%` : ""}`);
        this.out(`${C.dim("branch")}  ${e.branch}${e.origin ? C.dim(`  (push: yeet --name <n> push → ${e.origin})`) : ""}`);
        this.out(`${C.dim("ws")}      ${e.workspace}`);
        break;
      }
    }
  }
}
