#!/usr/bin/env bun
/**
 * cli.ts — yeet.
 *
 *   yeet "make me an app"                  new agent (isolated; asks questions; always verifies)
 *   yeet fix-auth "now add refresh"        continue an existing agent
 *   yeet ask fix-auth                      full detail of the last run (free)
 *   yeet ask fix-auth "why that lib?"      talk to the agent about its work
 *   yeet fix-auth config origin <url>      connect a repo (import if unbuilt; enables push)
 *   yeet fix-auth push                     push the branch to origin — from the host
 *   yeet ls / yeet rm <name>               list / delete
 *   yeet config smarty on                  dev detail by default
 *
 * Disambiguation stays positional, with a small reserved-word set (see agent.RESERVED).
 * Unknown --flags are hard errors: in machine mode a typo'd flag silently becoming task text
 * would be a debugging session nobody deserves.
 *
 * Exit codes are part of the interface: 0 passed · 1 usage/infra · 2 stalled · 3 capped ·
 * 4 failed · 5 unverified.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR, CURRENT_IMAGE, LAUNCHER, tryLock } from "./host";
import * as store from "./agent";
import {
  runIteration, runChat, runCoverage, firstPrompt, retryPrompt, DEFAULT_LIMITS,
  type IterationIo, type IterationResult,
} from "./loop";
import { Ui, C, usd, dur, type Mode } from "./ui";
import { loadConfig, saveConfig, DEFAULT_MODEL } from "./config";
import { costDelta, findSessionFile, readSession } from "./session";
import { record } from "./events";
import { checkCounts, checkCheats, implementationFiles } from "./gates";
import { reviewWorkspace } from "./review";

const EXIT = { passed: 0, usage: 1, stalled: 2, capped: 3, failed: 4, unverified: 5 } as const;

type Flags = {
  model: string | null;
  maxIter: number;
  maxCost: number;
  smarty: boolean;
  agentMode: boolean;
  yes: boolean;
  name: string | null;
  rename: string | null;
  review: boolean;
};

function parse(argv: string[]): { rest: string[]; flags: Flags } {
  const flags: Flags = {
    model: null, maxIter: DEFAULT_LIMITS.maxIterations, maxCost: DEFAULT_LIMITS.maxCostUsd,
    smarty: false, agentMode: false, yes: false, name: null, rename: null, review: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--model") flags.model = argv[++i] ?? null;
    else if (a === "--max-iter") flags.maxIter = Number(argv[++i]);
    else if (a === "--max-cost") flags.maxCost = Number(argv[++i]);
    else if (a === "--smarty") flags.smarty = true;
    else if (a === "--agent" || a === "--json") flags.agentMode = true;
    else if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--name") flags.name = argv[++i] ?? null;
    else if (a === "--rename") flags.rename = argv[++i] ?? null;
    else if (a === "--review") flags.review = true;
    else if (a === "-h" || a === "--help") rest.unshift("help");
    else if (a.startsWith("--")) {
      console.error(`yeet: unknown flag ${a} (flags are exact on purpose — a typo must not become task text)`);
      process.exit(EXIT.usage);
    } else rest.push(a);
  }
  if (!Number.isFinite(flags.maxIter) || flags.maxIter < 1) flags.maxIter = DEFAULT_LIMITS.maxIterations;
  if (!Number.isFinite(flags.maxCost) || flags.maxCost <= 0) flags.maxCost = DEFAULT_LIMITS.maxCostUsd;
  return { rest, flags };
}

function makeUi(flags: Flags): Ui {
  const cfg = loadConfig();
  const mode: Mode = flags.agentMode ? "json" : flags.smarty || cfg.smarty ? "smarty" : "pleb";
  const autoAnswer = flags.agentMode || flags.yes || !process.stdin.isTTY;
  return new Ui(mode, autoAnswer);
}

function ioFor(ui: Ui): IterationIo {
  return {
    ask: async (q) => (await ui.ask(q)).answer,
    verifyProposal: async (v) => {
      const d = await ui.verifyProposal(v);
      return {
        command: d.command, testFiles: d.testFiles, coverageCommand: d.coverageCommand,
        approvedBy: ui.autoAnswer ? "auto" : "user", changedOnApproval: d.edited,
      };
    },
    escalate: (action, reason) => ui.event({ event: "escalate", action, reason }),
  };
}

/** The plain-English summary the agent was asked to leave behind, if it did. */
function lastSummary(agent: store.Agent): string | null {
  for (let i = agent.iterations.length - 1; i >= 0; i--) {
    const rec = agent.iterations[i]!;
    if (rec.phase !== "agent") continue;
    const p = join(store.agentDir(agent.name), `iter-${String(rec.n).padStart(3, "0")}`, "summary.md");
    if (existsSync(p)) {
      const text = readFileSync(p, "utf8").trim();
      if (text) return text.length > 600 ? text.slice(0, 600) + "…" : text;
    }
  }
  return null;
}

// ── the loop ──────────────────────────────────────────────────────────────────────────────

async function runAgentLoop(agent: store.Agent, flags: Flags, ui: Ui, followUp?: string): Promise<number> {
  const dir = store.agentDir(agent.name);
  const lock = tryLock(`${dir}/.lock`);
  if (!lock) {
    ui.event({ event: "error", message: `agent "${agent.name}" is already running` });
    return EXIT.usage;
  }

  try {
    ui.event({
      event: "start",
      agent: agent.name, task: followUp ?? agent.task, resuming: !!followUp, isNew: agent.iterations.length === 0 && !followUp,
      model: agent.model, origin: agent.origin, verify: agent.verify?.command ?? null,
      maxIter: flags.maxIter, maxCostUsd: flags.maxCost,
    });
    if (ui.autoAnswer && ui.mode !== "json" && !process.stdin.isTTY) {
      ui.event({ event: "info", message: "no terminal to ask questions on — taking the agent's recommendations" });
    }
    // The first instruction is on the `created` event as userPrompt; every later one needs its
    // own. Recorded here rather than at the two call sites so it cannot be missed on one path.
    if (followUp) record(agent.name, { kind: "prompt", from: "user", text: followUp });

    const io = ioFor(ui);
    const history: IterationResult[] = [];
    const started = Date.now();
    // Cost is the DELTA per iteration. pi -c appends to one session file, so raw session
    // totals are cumulative — adding them per iteration double-counted every earlier one.
    let prevReading = readSession(findSessionFile(join(dir, "session")));
    let strikes = 0;
    let agentErrors = 0;
    let outcome: store.AgentState = "capped";
    let stopNote = "";

    // ── baseline: verify only, no agent, zero tokens — but only when a verify command
    // already exists (configured or from an earlier run). A fresh agent has nothing to run.
    // Runs whenever a verify command exists. It used to also require `!followUp`, which made it
    // dead code: a fresh agent has verify:null (create() sets it), and every continuation passes
    // a follow-up — so the baseline never once ran. On a continuation it is still worth the boot,
    // because "was it already broken before I asked for more?" is exactly what you need to know
    // to read the result.
    if (agent.verify) {
      const base = await runIteration(agent, { n: 0, phase: "baseline", runAgent: false, runTest: true });
      history.push(base);
      ui.event({ event: "baseline", verdict: base.verdict, testExit: base.testExit });
      if (base.valid) {
        record(agent.name, {
          kind: "verify_run", reason: "baseline", command: agent.verify.command,
          exitCode: base.testExit ?? -1, passed: base.verdict === "green",
        });
      }
      if (!base.valid) {
        ui.event({ event: "error", message: base.invalidReason ?? "infrastructure failure" });
        return EXIT.failed;
      }
      if (base.testExit === 126 || base.testExit === 127) {
        ui.event({ event: "error", message: `verify command \`${agent.verify.command}\` exits ${base.testExit} — fix it before spending tokens (yeet ${agent.name} config test "...")` });
        agent.state = "failed"; store.save(agent);
        record(agent.name, { kind: "status", status: "failed", reason: `verify command exits ${base.testExit}` });
        return EXIT.failed;
      }
      // Only a shortcut for a FIRST run. On a follow-up a green baseline just means the previous
      // work still holds — which is the starting line for the new request, not a reason to stop.
      if (base.verdict === "green" && !followUp) {
        agent.state = "passed"; store.save(agent);
        record(agent.name, { kind: "status", status: "passed", reason: "already green — nothing to do" });
        ui.event({ event: "done", state: "passed", seconds: Math.round((Date.now() - started) / 1000), costUsd: agent.costUsd, note: "already green — nothing to do", branch: agent.branch, workspace: store.workspaceDir(agent.name), origin: agent.origin, summary: null, model: agent.model, coveragePct: agent.coverage?.pct ?? null });
        return EXIT.passed;
      }
    }

    const baseIter = agent.iterations.length;
    for (let n = 1; n <= flags.maxIter; n++) {
      const iterN = baseIter + n;
      const dirName = `iter-${String(iterN).padStart(3, "0")}`;
      const prev = history.filter((h) => h.phase === "agent").at(-1);

      let prompt: string;
      if (prev && prev.verdict === "green") {
        prompt = [
          "Your change passed once but did NOT reproduce in a fresh VM — the suite is flaky.",
          "Find the nondeterminism (ordering, time, randomness, leftover state) and fix it.",
          `Before you finish, update /yeet/${dirName}/summary.md.`,
        ].join("\n");
      } else if (prev) {
        prompt = retryPrompt(prev, agent, dirName);
      } else if (followUp) {
        prompt = [
          followUp,
          "",
          agent.verify
            ? `Verification still applies: \`${agent.verify.command}\` must exit 0 when you are done.`
            : "You never registered verification — use the set_verify tool early this time.",
          `Before you finish, update /yeet/${dirName}/summary.md (2-4 plain sentences, no jargon).`,
        ].join("\n");
      } else {
        prompt = firstPrompt(agent, dirName);
      }

      const r = await runIteration(agent, {
        n: iterN, phase: "agent", runAgent: true, runTest: true, prompt, io,
        budget: { capUsd: flags.maxCost, spentBeforeUsd: agent.costUsd },
      });
      history.push(r);

      // Charge BEFORE the validity check. A killed or infra-failed iteration still burned
      // tokens — the model ran, we just could not read the result — and skipping this used to
      // lose that spend permanently: the next run re-reads prevReading from the now-larger
      // cumulative session file, so the gap is never recoverable and the cap under-counts.
      const delta = costDelta({ file: prevReading.file, costUsd: prevReading.costUsd }, r.session);
      prevReading = r.session;
      agent.costUsd += delta;

      if (!r.valid) {
        const killed = (r.invalidReason ?? "").startsWith("controller killed");
        if (killed) {
          outcome = "stalled";
          stopNote = r.invalidReason!;
          ui.event({ event: "escalate", action: "kill", reason: r.stopReason ?? "stall", detail: r.invalidReason });
        } else {
          outcome = "failed";
          stopNote = r.invalidReason ?? "infrastructure failure";
          ui.event({ event: "error", message: stopNote });
        }
        store.save(agent);
        // A partial iteration: no commit, no verify, but real spend that must appear in the
        // total. Recorded so `costUsd` folded from the log matches what was actually paid.
        record(agent.name, {
          kind: "iteration", n: iterN,
          agent: { seconds: r.agentSeconds, costUsd: delta, outcome: "stopped", stoppedBy: r.stopReason, sessionEnd: r.session.turns },
          git: { commit: null, treeChanged: r.treeChanged, filesChanged: r.filesChanged, linesAdded: r.insertions, linesRemoved: r.deletions, protectedTestsChanged: r.touchedFrozen },
          verify: null,
        });
        break;
      }

      agent.iterations.push({
        n: iterN, phase: "agent", agentSeconds: r.agentSeconds, costUsd: delta,
        insertions: r.insertions, deletions: r.deletions, filesChanged: r.filesChanged,
        treeChanged: r.treeChanged, testExit: r.testExit, verdict: r.verdict,
        touchedFrozenTests: r.touchedFrozen.length > 0 || undefined,
        stopReason: r.stopReason ?? undefined,
      });
      store.save(agent);
      record(agent.name, {
        kind: "iteration", n: iterN,
        agent: {
          seconds: r.agentSeconds, costUsd: delta,
          outcome: r.agentVerdict ?? "no_edit", stoppedBy: r.stopReason, sessionEnd: r.session.turns,
        },
        git: {
          commit: r.committed ? r.afterHead : null,
          treeChanged: r.treeChanged,
          filesChanged: r.filesChanged, linesAdded: r.insertions, linesRemoved: r.deletions,
          protectedTestsChanged: r.touchedFrozen,
        },
        verify: r.testExit === null ? null
          : { command: agent.verify?.command ?? "", exitCode: r.testExit, passed: r.verdict === "green" },
      });

      ui.event({
        event: "iteration", n: iterN, seconds: r.agentSeconds, costUsd: delta,
        insertions: r.insertions, deletions: r.deletions, filesChanged: r.filesChanged,
        treeChanged: r.treeChanged, verdict: r.verdict, testExit: r.testExit,
        agentVerdict: r.agentVerdict, interrupted: r.interrupted, touchedFrozenTests: r.touchedFrozen.length > 0,
      });

      // Green is not evidence that anything ran: bun, go and cargo all exit 0 on an empty
      // suite. And a diff that disables type checking turns red green without touching code.
      // The diff is read host-side from the commit the runner just made — the guest reports
      // file names and a shortstat, not the patch text the cheat scan needs.
      const patch = r.committed
        ? Bun.spawnSync(["git", "-C", store.workspaceDir(agent.name), "show", "--unified=0", "--format=", r.afterHead]).stdout.toString()
        : "";
      for (const f of [...checkCounts(r.testLog), ...checkCheats(patch)]) {
        ui.event({ event: "warning", message: `${f.detail} (${f.gate})` });
      }

      // An agent that cannot emit a valid tool call will never make progress, so retrying it
      // is spend with no expected value. Two in a row means the model, not the task, is the
      // problem — say so, rather than reporting a stall the user would misread as difficulty.
      if (r.agentVerdict === "error") {
        agentErrors++;
        if (agentErrors >= 2) {
          outcome = "failed";
          stopNote = `the agent errored twice — "${agent.model}" may be unable to use tools. Try a stronger model.`;
          break;
        }
      } else {
        agentErrors = 0;
      }

      if (r.verdict === "green") {
        // Confirmation run: one more boot, verify only, zero tokens. The verifier deserves its
        // own verification — a green that does not reproduce is a flake, not a result.
        const confirm = await runIteration(agent, {
          n: iterN, phase: "confirm", runAgent: false, runTest: true,
          dirName: `confirm-${String(iterN).padStart(3, "0")}`,
        });
        ui.event({ event: "confirmed", ok: confirm.verdict === "green" });
        if (confirm.valid) {
          record(agent.name, {
            kind: "verify_run", reason: "confirm", command: agent.verify?.command ?? "",
            exitCode: confirm.testExit ?? -1, passed: confirm.verdict === "green",
          });
        }
        if (confirm.verdict === "green") {
          outcome = "passed";
          if (r.touchedFrozen.length > 0) {
            ui.event({ event: "warning", message: `the passing change also edited pre-existing tests (${r.touchedFrozen.join(", ")}) — look before trusting it` });
          }
          break;
        }
        strikes = 0;
        continue;
      }

      // Stop reasons in precedence order; green already returned above and beats everything.
      // Report what ACTUALLY happened, not whichever condition is checked last.
      if (r.stopReason === "budget") {
        outcome = "capped";
        stopNote = `hit the ${usd(flags.maxCost)} cap mid-iteration — agent stopped, partial work kept`;
        break;
      }
      if (r.stopReason === "stall") {
        outcome = "stalled";
        stopNote = "went quiet mid-iteration — agent stopped, partial work kept";
        break;
      }

      // Two detectors, one strike counter. The tree SHA is git's own content hash — exact and
      // free — and it only works because artifacts live outside the workspace.
      const prevAgent = history.filter((h) => h.phase === "agent" && h.n !== r.n).at(-1);
      if (!r.treeChanged) strikes++;
      else if (prevAgent && prevAgent.afterTree === r.afterTree) strikes++;
      else strikes = 0;

      if (strikes >= 2) { outcome = "stalled"; stopNote = "no progress for 2 iterations"; break; }
      if (agent.costUsd >= flags.maxCost) { outcome = "capped"; stopNote = `cost cap ${usd(flags.maxCost)}`; break; }
      if (n === flags.maxIter) { outcome = "capped"; stopNote = `iteration cap (${flags.maxIter})`; }
    }

    // A run that never got a verifier is its own kind of result: maybe work happened, but
    // nobody can prove it. Do not dress that up as merely "capped".
    if (outcome !== "passed" && outcome !== "failed" && !agent.verify) {
      outcome = "unverified";
      stopNote = stopNote || "no verification was ever registered";
    }

    agent.state = outcome;
    store.save(agent);
    record(agent.name, { kind: "status", status: outcome, reason: stopNote || null });

    // Ablation: blank the implementation and re-run the suite. If it STILL passes, the tests
    // were never testing the code — mutation testing with a single maximally destructive
    // mutant, and the cheapest high-signal check available. Run by hand once on a real agent
    // it took one command to prove 8 of 14 tests were genuinely load-bearing.
    if (outcome === "passed" && agent.verify) {
      const ws = store.workspaceDir(agent.name);
      const changed = Bun.spawnSync(["git", "-C", ws, "diff", "--name-only", agent.baseHead ?? "HEAD", "HEAD"])
        .stdout.toString().split("\n").filter(Boolean);
      const impl = implementationFiles(changed, agent.verify.testFiles);
      if (impl.length > 0) {
        const saved = impl.map((f) => [f, readFileSync(join(ws, f), "utf8")] as const);
        try {
          for (const [f] of saved) writeFileSync(join(ws, f), "");
          const abl = await runIteration(agent, {
            n: 0, phase: "ablation", runAgent: false, runTest: true, dirName: "ablation",
          });
          // A blanked implementation that still passes means the suite proves nothing. Said,
          // not enforced — a gate that halts on its own misread is worse than the problem.
          if (abl.valid && abl.verdict === "green") {
            ui.event({ event: "warning", message: `the tests still pass with ${impl.join(", ")} emptied out — they are not actually testing the code` });
          }
        } finally {
          // Restore from memory rather than `git checkout`, so an uncommitted change made
          // between the commit and here is not silently discarded.
          for (const [f, body] of saved) writeFileSync(join(ws, f), body);
        }
      }
    }

    // Coverage: measured once, after a confirmed pass — a number for "how much of the app do
    // the tests actually exercise", which is what makes a green light worth believing.
    if (outcome === "passed" && agent.verify?.coverageCommand) {
      const cov = await runCoverage(agent, agent.iterations.length);
      if (cov) {
        agent.coverage = { pct: cov.pct, coveredLines: cov.coveredLines, totalLines: cov.totalLines, at: new Date().toISOString() };
        store.save(agent);
        record(agent.name, { kind: "coverage", pct: cov.pct, coveredLines: cov.coveredLines, totalLines: cov.totalLines });
        ui.event({ event: "coverage", pct: cov.pct, coveredLines: cov.coveredLines, totalLines: cov.totalLines });
      } else {
        ui.event({ event: "coverage", pct: null, coveredLines: 0, totalLines: 0, note: "no lcov file appeared" });
      }
    }

    ui.event({
      event: "done", state: outcome, seconds: Math.round((Date.now() - started) / 1000),
      costUsd: agent.costUsd, note: stopNote, branch: agent.branch,
      workspace: store.workspaceDir(agent.name), origin: agent.origin,
      summary: lastSummary(agent), model: agent.model, coveragePct: agent.coverage?.pct ?? null,
    });

    if (flags.review) await reviewWorkspace(agent);
    return EXIT[outcome as keyof typeof EXIT] ?? EXIT.failed;
  } finally {
    lock.release();
  }
}

// ── commands ──────────────────────────────────────────────────────────────────────────────

function cmdLs(ui: Ui): number {
  const agents = store.list();
  if (ui.mode === "json") {
    console.log(JSON.stringify({
      event: "agents",
      items: agents.map((a) => ({
        name: a.name, state: a.state, iterations: a.iterations.length, costUsd: a.costUsd,
        origin: a.origin, verify: a.verify?.command ?? null, coveragePct: a.coverage?.pct ?? null, task: a.task,
      })),
    }));
    return 0;
  }
  if (agents.length === 0) {
    console.log("no agents yet — start one:  yeet \"build me something\"");
    return 0;
  }
  console.log(C.dim("NAME".padEnd(24) + "STATE".padEnd(12) + "ITER".padEnd(6) + "COST".padEnd(10) + "WHERE".padEnd(16) + "LAST"));
  for (const a of agents) {
    const last = a.iterations.at(-1);
    const summary = last
      ? `${last.verdict === "green" ? "green" : last.verdict === "red" ? `red (exit ${last.testExit})` : "ran"}, +${last.insertions} −${last.deletions}`
      : a.task.slice(0, 40);
    // Pad the PLAIN text, then colour it. padEnd() counts ANSI escape bytes as width, so
    // colouring first silently breaks every column to its right.
    const paint = a.state === "passed" ? C.green : a.state === "running" ? C.cyan : C.yellow;
    console.log(
      a.name.padEnd(24) + paint(a.state.padEnd(12)) + String(a.iterations.length).padEnd(6) +
      usd(a.costUsd).padEnd(10) + store.label(a).slice(0, 15).padEnd(16) + summary,
    );
  }
  return 0;
}

/** yeet ask <name> — the full story, free. With a question — a paid conversation. */
async function cmdAsk(name: string, question: string | undefined, ui: Ui): Promise<number> {
  if (!store.exists(name)) {
    ui.event({ event: "error", message: `no agent named "${name}" — see yeet ls` });
    return EXIT.usage;
  }
  const agent = store.load(name);

  if (!question) {
    if (ui.mode === "json") {
      console.log(JSON.stringify({ event: "report", agent: { ...agent, summary: lastSummary(agent) } }));
      return 0;
    }
    const v = agent.verify;
    console.log("");
    console.log(`${C.bold(agent.name)}  ${C.dim(`(${agent.state})`)}`);
    console.log(`${C.dim("task")}     ${agent.task}`);
    console.log(`${C.dim("model")}    ${agent.model}`);
    console.log(`${C.dim("origin")}   ${agent.origin ?? "none — isolated"}`);
    console.log(`${C.dim("verify")}   ${v ? `${v.command} ${C.dim(`(${v.source})`)}` : "never registered"}`);
    if (v?.coverageCommand) console.log(`${C.dim("coverage")} ${v.coverageCommand}${agent.coverage ? ` → ${agent.coverage.pct}% (${agent.coverage.coveredLines}/${agent.coverage.totalLines} lines)` : ""}`);
    if (v && Object.keys(v.frozen).length) console.log(`${C.dim("frozen")}   ${Object.keys(v.frozen).length} pre-existing test file(s) fingerprinted`);
    console.log(`${C.dim("branch")}   ${agent.branch}`);
    console.log(`${C.dim("cost")}     ${usd(agent.costUsd)} over ${agent.iterations.length} iteration(s)`);
    if (agent.iterations.length) {
      console.log("");
      for (const it of agent.iterations) {
        const verdict = it.verdict === "green" ? C.green("green") : it.verdict === "red" ? C.red(`red · exit ${it.testExit}`) : C.dim("no verifier");
        const flags = `${it.touchedFrozenTests ? C.yellow(" ⚠tests") : ""}${it.stopReason ? C.yellow(` ⏹${it.stopReason}`) : ""}`;
        console.log(` ${String(it.n).padStart(2)}  ${dur(it.agentSeconds).padEnd(8)}${usd(it.costUsd).padEnd(9)}${(it.treeChanged ? `+${it.insertions} −${it.deletions} ${it.filesChanged}f` : "no edit").padEnd(18)}${verdict}${flags}`);
      }
    }
    const summary = lastSummary(agent);
    if (summary) {
      console.log("");
      console.log(`${C.dim("in its own words:")} ${summary}`);
    }
    console.log("");
    console.log(C.dim(`artifacts: ${store.agentDir(agent.name)} · talk to it: yeet ask ${agent.name} "<question>"`));
    return 0;
  }

  const lock = tryLock(`${store.agentDir(name)}/.lock`);
  if (!lock) {
    ui.event({ event: "error", message: `agent "${name}" is busy right now` });
    return EXIT.usage;
  }
  try {
    if (agent.iterations.length === 0) {
      ui.event({ event: "error", message: `${name} hasn't done anything yet — there's nothing to ask about` });
      return EXIT.usage;
    }
    if (ui.mode !== "json") console.log(C.dim("asking… (one VM boot, a few cents)"));
    const res = await runChat(agent, question, ioFor(ui));
    if (!res.valid || !res.answer) {
      ui.event({ event: "error", message: `no answer came back${res.reason ? ` (${res.reason})` : ""}` });
      return EXIT.failed;
    }
    agent.costUsd += res.costUsd;
    store.save(agent);
    // Chat spends money without producing an iteration; without this the total under-reports.
    record(agent.name, { kind: "chat", question, costUsd: res.costUsd });
    if (ui.mode === "json") {
      console.log(JSON.stringify({ event: "chat_answer", agent: name, answer: res.answer, costUsd: res.costUsd }));
    } else {
      console.log("");
      for (const line of res.answer.split("\n")) console.log(`  ${line}`);
      console.log("");
      console.log(C.dim(`(${usd(res.costUsd)})`));
    }
    return 0;
  } finally {
    lock.release();
  }
}

async function cmdRm(name: string, ui: Ui): Promise<number> {
  if (!store.exists(name)) {
    ui.event({ event: "error", message: `no agent named "${name}"` });
    return EXIT.usage;
  }
  const lock = tryLock(`${store.agentDir(name)}/.lock`);
  if (!lock) {
    ui.event({ event: "error", message: `agent "${name}" is running — not deleting a moving target` });
    return EXIT.usage;
  }
  try {
    const agent = store.load(name);
    const pushedNote = agent.origin ? "" : " Nothing was ever pushed, so this is the only copy.";
    const ok = await ui.confirm(`Delete ${name} — workspace, branch, history, the lot?${pushedNote}`);
    if (!ok) {
      ui.event({ event: "info", message: "kept it." });
      return 0;
    }
    lock.release();
    store.remove(name);
    ui.event({ event: "info", message: `${name} is gone.` });
    return 0;
  } finally {
    try { lock.release(); } catch { /* released above on the delete path */ }
  }
}

async function cmdPush(agent: store.Agent, ui: Ui): Promise<number> {
  if (!agent.origin) {
    ui.event({ event: "error", message: `no origin configured — yeet ${agent.name} config origin <url>` });
    return EXIT.usage;
  }
  const ok = await ui.confirm(`Push ${agent.branch} to ${agent.origin}?`);
  if (!ok) {
    ui.event({ event: "info", message: "not pushed." });
    return 0;
  }
  const r = store.push(agent);
  if (ui.mode === "json") {
    console.log(JSON.stringify({ event: "push", agent: agent.name, ok: r.ok, detail: r.detail }));
  } else {
    ui.event(r.ok ? { event: "info", message: r.detail } : { event: "error", message: r.detail });
  }
  return r.ok ? 0 : EXIT.failed;
}

function cmdAgentConfig(agent: store.Agent, args: string[], ui: Ui): number {
  if (args.length === 0) {
    if (ui.mode === "json") {
      console.log(JSON.stringify({ event: "config", agent: agent.name, origin: agent.origin, verify: agent.verify, model: agent.model }));
      return 0;
    }
    console.log(`${C.dim("origin")}    ${agent.origin ?? "none — set one to enable push: yeet " + agent.name + " config origin <url>"}`);
    console.log(`${C.dim("verify")}    ${agent.verify ? `${agent.verify.command} (${agent.verify.source})` : "unset — the agent registers one, or: config test \"<cmd>\""}`);
    console.log(`${C.dim("coverage")}  ${agent.verify?.coverageCommand ?? "unset"}`);
    console.log(`${C.dim("model")}     ${agent.model}`);
    return 0;
  }

  const [key, ...valueParts] = args;
  const value = valueParts.join(" ");
  switch (key) {
    case "origin": {
      if (!value) { ui.event({ event: "error", message: "usage: config origin <git-url-or-path>" }); return EXIT.usage; }
      const r = store.setOrigin(agent, value);
      ui.event({ event: r.detail.startsWith("could not") ? "error" : "info", message: r.detail });
      return r.detail.startsWith("could not") ? EXIT.failed : 0;
    }
    case "test": {
      if (!value) { ui.event({ event: "error", message: "usage: config test \"<command>\"" }); return EXIT.usage; }
      agent.verify = {
        command: value,
        testFiles: agent.verify?.testFiles ?? [],
        coverageCommand: agent.verify?.coverageCommand ?? null,
        source: "user",
        frozen: agent.verify?.frozen ?? {},
      };
      store.save(agent);
      record(agent.name, {
        kind: "verify_set", command: value, testFiles: agent.verify.testFiles,
        coverageCommand: agent.verify.coverageCommand, proposedBy: "user", approvedBy: "user",
        changedOnApproval: false, protectedTests: agent.verify.frozen,
      });
      ui.event({ event: "info", message: `verify is now: ${value}` });
      return 0;
    }
    case "coverage": {
      if (!agent.verify) { ui.event({ event: "error", message: "set a test command first (config test)" }); return EXIT.usage; }
      agent.verify.coverageCommand = value || null;
      store.save(agent);
      record(agent.name, {
        kind: "verify_set", command: agent.verify.command, testFiles: agent.verify.testFiles,
        // Editing the coverage command does not change WHO chose the verify contract. Claiming
        // "user" here would rewrite authorship in the log, since fold() replaces verify wholesale.
        coverageCommand: agent.verify.coverageCommand, proposedBy: agent.verify.source, approvedBy: "user",
        changedOnApproval: false, protectedTests: agent.verify.frozen,
      });
      ui.event({ event: "info", message: value ? `coverage command is now: ${value}` : "coverage command cleared" });
      return 0;
    }
    case "model": {
      if (!value) { ui.event({ event: "error", message: "usage: config model <provider/model>" }); return EXIT.usage; }
      agent.model = value;
      store.save(agent);
      record(agent.name, { kind: "config", key: "model", value, setBy: "user" });
      ui.event({ event: "info", message: `model is now: ${value}` });
      return 0;
    }
    default:
      ui.event({ event: "error", message: `unknown config key "${key}" (origin · test · coverage · model)` });
      return EXIT.usage;
  }
}

function cmdGlobalConfig(args: string[], ui: Ui): number {
  const cfg = loadConfig();
  if (args.length === 0) {
    if (ui.mode === "json") { console.log(JSON.stringify({ event: "config", global: cfg })); return 0; }
    console.log(`${C.dim("smarty")}  ${cfg.smarty ? "on" : "off"}   ${C.dim("(dev detail by default)")}`);
    console.log(`${C.dim("model")}   ${cfg.model ?? DEFAULT_MODEL}`);
    return 0;
  }
  const [key, value] = args;
  if (key === "smarty") {
    if (value !== "on" && value !== "off") { ui.event({ event: "error", message: "usage: yeet config smarty on|off" }); return EXIT.usage; }
    cfg.smarty = value === "on";
    saveConfig(cfg);
    ui.event({ event: "info", message: cfg.smarty ? "smarty on — you get the nerd view from now on." : "smarty off — plain English it is." });
    return 0;
  }
  if (key === "model") {
    if (!value) { ui.event({ event: "error", message: "usage: yeet config model <provider/model>" }); return EXIT.usage; }
    cfg.model = value;
    saveConfig(cfg);
    ui.event({ event: "info", message: `default model is now ${value}` });
    return 0;
  }
  ui.event({ event: "error", message: `unknown config key "${key}" (smarty · model)` });
  return EXIT.usage;
}

function help(): void {
  const cfg = loadConfig();
  console.log(`yeet — sandboxed coding agents that loop until the work actually checks out

  yeet "build me a thing"        start a new agent. It asks questions first, proves its
                                 work with tests, and never touches your files.
  yeet <name> "now do this"      give an existing agent a follow-up
  yeet ls                        every agent and how it's doing
  yeet ask <name>                the full story of its last run (free)
  yeet ask <name> "why X?"       ask the agent about its work (a few cents)
  yeet <name> config             show settings · set: origin <url> · test "<cmd>" ·
                                 coverage "<cmd>" · model <p/m>
  yeet <name> push               push its branch to the configured origin (asks first)
  yeet rm <name>                 delete an agent, workspace and all
  yeet config smarty on|off      dev detail always · model <p/m> sets the default

  --name <n>      pick the agent's name yourself (else it's made from the task)
  --rename <new>  rename: yeet <old> --rename <new>
  --smarty        dev detail for this run
  --agent         machine mode: JSON lines on stdout, recommendations auto-accepted
  --yes           don't wait for answers — take the agent's recommendations
  --model <p/m>   default ${cfg.model ?? DEFAULT_MODEL}
  --max-iter N    default ${DEFAULT_LIMITS.maxIterations} · --max-cost USD  default ${DEFAULT_LIMITS.maxCostUsd}

exit codes: 0 passed · 1 usage/infra · 2 stalled · 3 hit a cap · 4 failed · 5 unverified`);
}

// ── main ──────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { rest, flags } = parse(process.argv.slice(2));
  const ui = makeUi(flags);

  if (rest.length === 0 || rest[0] === "help") {
    help();
    return 0;
  }

  if (!existsSync(LAUNCHER) || !existsSync(CURRENT_IMAGE)) {
    console.error("yeet: no image — run guest/setup.sh first");
    return EXIT.usage;
  }
  mkdirSync(AGENTS_DIR, { recursive: true });

  const cfg = loadConfig();
  const model = flags.model ?? cfg.model ?? DEFAULT_MODEL;

  if (rest[0] === "ls") return cmdLs(ui);
  if (rest[0] === "config") return cmdGlobalConfig(rest.slice(1), ui);
  if (rest[0] === "ask") {
    if (!rest[1]) { ui.event({ event: "error", message: "usage: yeet ask <name> [\"question\"]" }); return EXIT.usage; }
    return cmdAsk(rest[1], rest.slice(2).join(" ") || undefined, ui);
  }
  if (rest[0] === "rm") {
    if (!rest[1]) { ui.event({ event: "error", message: "usage: yeet rm <name>" }); return EXIT.usage; }
    return cmdRm(rest[1], ui);
  }

  // yeet <existing> …
  if (rest[0] && store.exists(rest[0])) {
    const agent = store.load(rest[0]);
    if (flags.model) {
      agent.model = flags.model;
      store.save(agent);
      record(agent.name, { kind: "config", key: "model", value: flags.model, setBy: "user" });
    }

    if (flags.rename) {
      const lock = tryLock(`${store.agentDir(agent.name)}/.lock`);
      if (!lock) { ui.event({ event: "error", message: `"${agent.name}" is running — rename it when it's done` }); return EXIT.usage; }
      try {
        const renamed = store.rename(agent, flags.rename);
        ui.event({ event: "info", message: `${rest[0]} is now ${renamed.name} (branch ${renamed.branch})` });
        return 0;
      } catch (e) {
        ui.event({ event: "error", message: (e as Error).message });
        return EXIT.usage;
      } finally {
        lock.release();
      }
    }
    if (rest[1] === "config") return cmdAgentConfig(agent, rest.slice(2), ui);
    if (rest[1] === "push") return cmdPush(agent, ui);
    if (rest.length >= 2) return runAgentLoop(agent, flags, ui, rest.slice(1).join(" "));

    ui.event({
      event: "error",
      message: `"${agent.name}" exists. Give it work (yeet ${agent.name} "<task>"), ask about it (yeet ask ${agent.name}), or configure it (yeet ${agent.name} config).`,
    });
    return EXIT.usage;
  }

  if (flags.rename) {
    ui.event({ event: "error", message: "--rename works on an existing agent: yeet <name> --rename <new>" });
    return EXIT.usage;
  }

  // New agent.
  const task = rest.join(" ");
  let agent: store.Agent;
  try {
    agent = store.create({ task, model, name: flags.name ?? undefined });
  } catch (e) {
    ui.event({ event: "error", message: (e as Error).message });
    return EXIT.usage;
  }
  return runAgentLoop(agent, flags, ui);
}

process.exitCode = await main();
