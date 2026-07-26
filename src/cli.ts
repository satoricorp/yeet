#!/usr/bin/env bun
/**
 * cli.ts — yeet.
 *
 *   yeet "make me an app"                  new agent
 *   yeet fix-auth "now add refresh tests"  continue an existing agent
 *   yeet ls                                list agents
 *
 * Disambiguation is positional: one arg is always a task, two args are ref + task. `ls` is the
 * only reserved word, so `yeet "ls"` is still a task.
 */
import { existsSync, mkdirSync } from "node:fs";
import { AGENTS_DIR, CURRENT_IMAGE, LAUNCHER, tryLock } from "./host";
import * as store from "./agent";
import { runIteration, firstPrompt, retryPrompt, DEFAULT_LIMITS, type IterationResult } from "./loop";
import { reviewWorkspace } from "./review";

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const dur = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`);
/** Sub-cent runs are normal with small models, and rounding them to "$0.00" makes it look like
 *  cost tracking is broken when it isn't. Show enough digits to prove it is working. */
const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

type Flags = {
  test: string | null; model: string; maxIter: number; maxCost: number;
  repo?: string; review: boolean;
};

function parse(argv: string[]): { rest: string[]; flags: Flags } {
  const flags: Flags = {
    test: null, model: "openrouter/z-ai/glm-5.2",
    maxIter: DEFAULT_LIMITS.maxIterations, maxCost: DEFAULT_LIMITS.maxCostUsd, review: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--test") flags.test = argv[++i] ?? null;
    else if (a === "--model") flags.model = argv[++i] ?? flags.model;
    else if (a === "--max-iter") flags.maxIter = Number(argv[++i]);
    else if (a === "--max-cost") flags.maxCost = Number(argv[++i]);
    else if (a === "--repo") flags.repo = argv[++i];
    else if (a === "--review") flags.review = true;
    else rest.push(a);
  }
  return { rest, flags };
}

function row(n: string, label: string, timing: string, cost: string, diff: string, verdict: string) {
  console.log(` ${n.padStart(2)}  ${label.padEnd(9)}${timing.padEnd(8)}${cost.padEnd(7)}${diff.padEnd(18)}${verdict}`);
}

function verdictText(r: IterationResult): string {
  if (r.verdict === "green") return C.green("green");
  if (r.verdict === "red") return C.red(`red · exit ${r.testExit}`);
  return C.dim("no verifier");
}

async function runAgentLoop(agent: store.Agent, flags: Flags, followUp?: string) {
  const dir = store.agentDir(agent.name);
  const lock = tryLock(`${dir}/.lock`);
  if (!lock) {
    console.error(`yeet: agent "${agent.name}" is already running`);
    process.exit(1);
  }

  try {
    console.log(`\n${C.dim("agent")}   ${C.bold(agent.name)}${followUp ? C.dim(" · resuming") : ""}`);
    console.log(`${C.dim("repo")}    ${store.label(agent)}${agent.baseHead ? ` @ ${agent.baseHead.slice(0, 7)}` : ""}`);
    console.log(`${C.dim("verify")}  ${agent.testCommand ?? C.yellow("none — result will be UNVERIFIED")}`);
    console.log(`${C.dim("limits")}  ${flags.maxIter} iterations · ${usd(flags.maxCost)}\n`);

    const history: IterationResult[] = [];
    const started = Date.now();
    let strikes = 0;
    let outcome: store.AgentState = "capped";
    let stopNote = "";

    // ── iteration 0: baseline. Verify only, no agent, zero tokens. This is what distinguishes
    // "the agent fixed it" from "nothing was broken", and it catches a broken verify command
    // before a single token is spent.
    let start = 1;
    if (agent.testCommand && !followUp) {
      const base = await runIteration(agent, { n: 0, phase: "baseline", runAgent: false, runTest: true });
      history.push(base);
      row("0", "baseline", "", "", "", verdictText(base));
      if (!base.valid) {
        console.log(`\n${C.red("infra_error")} — ${base.invalidReason}`);
        return;
      }
      if (base.testExit === 126 || base.testExit === 127) {
        console.log(`\n${C.red("verify_broken")} — \`${agent.testCommand}\` exits ${base.testExit}. Fix it before spending tokens.`);
        agent.state = "failed"; store.save(agent);
        return;
      }
      if (base.verdict === "green") {
        console.log(`\n${C.green("already green")} — nothing to do.`);
        agent.state = "passed"; store.save(agent);
        return;
      }
    }

    const baseIter = agent.iterations.length;
    for (let n = start; n <= flags.maxIter; n++) {
      const iterN = baseIter + n;
      const prev = history.filter((h) => h.phase === "agent").at(-1);
      const prompt = prev
        ? retryPrompt(prev, agent, `iter-${String(prev.n).padStart(3, "0")}`)
        : followUp ?? firstPrompt(agent);

      const r = await runIteration(agent, {
        n: iterN, phase: "agent", runAgent: true, runTest: !!agent.testCommand, prompt,
      });
      history.push(r);

      if (!r.valid) {
        row(String(iterN), "agent", "", "", "", C.red(`infra: ${r.invalidReason}`));
        outcome = "failed"; stopNote = r.invalidReason ?? "infrastructure failure";
        break;
      }

      agent.costUsd += r.session.costUsd;
      agent.iterations.push({
        n: iterN, phase: "agent", agentSeconds: r.agentSeconds, costUsd: r.session.costUsd,
        insertions: r.insertions, deletions: r.deletions, filesChanged: r.filesChanged,
        treeChanged: r.treeChanged, testExit: r.testExit, verdict: r.verdict,
      });
      store.save(agent);

      row(
        String(iterN), "agent", dur(r.agentSeconds), usd(r.session.costUsd),
        r.treeChanged ? `+${r.insertions} −${r.deletions}  ${r.filesChanged} file${r.filesChanged === 1 ? "" : "s"}` : C.dim("no edit"),
        verdictText(r),
      );

      // No verifier configured: one shot, and say plainly that nothing was checked.
      if (!agent.testCommand) { outcome = "capped"; stopNote = "no verifier configured"; break; }

      if (r.verdict === "green") {
        // Confirmation run: one more boot, verify only, zero tokens. The verifier deserves its
        // own verification — a green that does not reproduce is a flake, not a result.
        const confirm = await runIteration(agent, { n: iterN + 1000, phase: "confirm", runAgent: false, runTest: true });
        row("", "confirm", "", "", "", confirm.verdict === "green" ? C.green("green ✓") : C.yellow("flaky — did not reproduce"));
        if (confirm.verdict === "green") { outcome = "passed"; break; }
        strikes = 0;
        continue;
      }

      // Two detectors, one strike counter. The tree SHA is git's own content hash — exact and
      // free — and it only works because artifacts live outside the workspace.
      const prevAgent = history.filter((h) => h.phase === "agent" && h.n !== r.n).at(-1);
      if (!r.treeChanged) strikes++;
      else if (prevAgent && prevAgent.afterTree === r.afterTree) strikes++;
      else strikes = 0;

      if (strikes >= 2) { outcome = "stalled"; stopNote = "no progress for 2 iterations"; break; }
      if (agent.costUsd >= flags.maxCost) { outcome = "capped"; stopNote = `cost cap ${usd(flags.maxCost)}`; break; }
    }

    agent.state = outcome;
    store.save(agent);

    const elapsed = Math.round((Date.now() - started) / 1000);
    const banner = outcome === "passed" ? C.green("passed") : outcome === "stalled" ? C.yellow("stalled") : C.yellow(outcome);
    console.log(`\n${banner} · ${dur(elapsed)} · ${usd(agent.costUsd)}${stopNote ? ` · ${stopNote}` : ""}`);

    const exported = store.exportResult(agent);
    if (agent.repo) {
      console.log(`${C.dim("branch")}  ${exported.detail}`);
      console.log(`   ${C.dim(`git -C ${agent.repo} log --oneline HEAD..${agent.branch}`)}`);
    } else {
      console.log(`${C.dim("result")}  ${exported.detail}`);
    }

    if (flags.review) await reviewWorkspace(agent);
  } finally {
    lock.release();
  }
}

function cmdLs() {
  const agents = store.list();
  if (agents.length === 0) { console.log("no agents yet"); return; }
  console.log(C.dim("NAME".padEnd(24) + "STATE".padEnd(10) + "ITER".padEnd(6) + "COST".padEnd(10) + "WHERE".padEnd(16) + "LAST"));
  for (const a of agents) {
    const last = a.iterations.at(-1);
    const summary = last
      ? `${last.verdict === "green" ? "green" : last.verdict === "red" ? `red (exit ${last.testExit})` : "ran"}, +${last.insertions} −${last.deletions}`
      : a.task.slice(0, 40);
    // Pad the PLAIN text, then colour it. padEnd() counts ANSI escape bytes as width, so
    // colouring first silently breaks every column to its right.
    const paint = a.state === "passed" ? C.green : a.state === "running" ? C.cyan : C.yellow;
    console.log(
      a.name.padEnd(24) + paint(a.state.padEnd(10)) + String(a.iterations.length).padEnd(6) +
      usd(a.costUsd).padEnd(10) + store.label(a).slice(0, 15).padEnd(16) + summary,
    );
  }
}

async function main() {
  const { rest, flags } = parse(process.argv.slice(2));

  if (rest.length === 0 || rest[0] === "help" || rest[0] === "-h" || rest[0] === "--help") {
    console.log(`yeet — coding agents that loop until the work is verified

  yeet "<task>"                    start a new agent
  yeet <name> "<task>"             continue an existing agent
  yeet ls                          list agents

  --test "<cmd>"   verify command (required for the loop to mean anything)
  --model P/M      default openrouter/z-ai/glm-5.2
  --max-iter N     default ${DEFAULT_LIMITS.maxIterations}
  --max-cost USD   default ${DEFAULT_LIMITS.maxCostUsd}
  --repo PATH      target repo (default: the repo containing cwd)
  --review         run gx review on the result (reported, not yet gating)`);
    return;
  }

  if (!existsSync(LAUNCHER) || !existsSync(CURRENT_IMAGE)) {
    console.error("yeet: no image — run guest/setup.sh first");
    process.exit(1);
  }
  mkdirSync(AGENTS_DIR, { recursive: true });

  if (rest[0] === "ls") return cmdLs();

  if (rest.length >= 2 && store.exists(rest[0]!)) {
    const agent = store.load(rest[0]!);
    if (flags.test) { agent.testCommand = flags.test; store.save(agent); }
    return runAgentLoop(agent, flags, rest.slice(1).join(" "));
  }

  const task = rest.join(" ");
  const agent = store.create({ task, cwd: process.cwd(), model: flags.model, testCommand: flags.test, repoOverride: flags.repo });
  return runAgentLoop(agent, flags);
}

await main();
