#!/usr/bin/env bun
/**
 * cli.ts — yeet.
 *
 * Five commands, and every one of them has its own --help:
 *
 *   yeet          start an agent, or give an existing one more work
 *   yeet ls       what you have and how it went
 *   yeet ask      what an agent did, and questions about it
 *   yeet config   settings, global or for one agent
 *   yeet rm       delete an agent
 *
 * WHICH agent is always --name. It used to be positional, which meant the parser had to guess
 * whether "test" was a subcommand or the first word of a task. A flag cannot be ambiguous, so
 * the guessing is gone: bare words are the task, and the only thing left that reads them as a
 * verb is a lone "test" or "push" next to a --name.
 *
 * Unknown --flags are hard errors: in machine mode a typo'd flag silently becoming task text
 * would be a debugging session nobody deserves.
 *
 * Exit codes are part of the interface: 0 passed · 1 usage/infra · 2 stalled · 3 capped ·
 * 4 failed · 5 unverified.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR, CURRENT_IMAGE, LAUNCHER, YEET_HOME, tryLock } from "./host";
import * as store from "./agent";
import {
  runIteration, runChat, runCoverage, firstPrompt, retryPrompt, DEFAULT_LIMITS,
  type IterationIo, type IterationResult,
} from "./loop";
import { Ui, C, usd, dur, type Mode } from "./ui";
import { plainText, plebMoney, lines } from "./voice";
import { loadConfig, saveConfig, DEFAULT_MODEL, VOICES, type Voice } from "./config";
import { hiddenPrompt, setKey, deleteKey, listKeys, fingerprint, KEYS_PATH, KNOWN_PROVIDERS, PROVIDER_ENV } from "./secrets";
import { costDelta, findSessionFile, readSession } from "./session";
import { record } from "./events";
import { checkCounts, checkCheats, implementationFiles, failureSignature } from "./gates";
import { reviewWorkspace } from "./review";
import { analyze, apply, publish } from "./merge";
import { search } from "./search";

const EXIT = { passed: 0, usage: 1, stalled: 2, capped: 3, failed: 4, unverified: 5 } as const;

type Flags = {
  model: string | null;
  /** null means "not given on the command line" — resolved against config, then defaults.
   *  Defaulting here instead would make a config value unreachable, since there would be no
   *  way to tell an explicit --max-cost 2 from the built-in 2. */
  maxIter: number | null;
  maxCost: number | null;
  smarty: boolean;
  agentMode: boolean;
  yes: boolean;
  name: string | null;
  rename: string | null;
  review: boolean;
};

function parse(argv: string[]): { rest: string[]; flags: Flags } {
  const flags: Flags = {
    model: null, maxIter: null, maxCost: null,
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
  if (flags.maxIter !== null && (!Number.isFinite(flags.maxIter) || flags.maxIter < 1)) flags.maxIter = null;
  if (flags.maxCost !== null && (!Number.isFinite(flags.maxCost) || flags.maxCost <= 0)) flags.maxCost = null;
  return { rest, flags };
}

/** flag > config > built-in default. Applied in one place so the three sources cannot
 *  disagree between the run loop and what gets reported to the user. */
function resolveLimits(flags: Flags): void {
  const cfg = loadConfig();
  flags.maxIter ??= cfg.maxIterations ?? DEFAULT_LIMITS.maxIterations;
  flags.maxCost ??= cfg.maxCostUsd ?? DEFAULT_LIMITS.maxCostUsd;
}

function makeUi(flags: Flags): Ui {
  const cfg = loadConfig();
  const mode: Mode = flags.agentMode ? "json" : flags.smarty || cfg.smarty ? "smarty" : "pleb";
  const autoAnswer = flags.agentMode || flags.yes || !process.stdin.isTTY;
  return new Ui(mode, autoAnswer, cfg.voice);
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
      maxIter: flags.maxIter!, maxCostUsd: flags.maxCost!,
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
    /** Fingerprint of the last iteration's failures, for the busy-but-going-nowhere case. */
    let prevSig: string | null = null;
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
        ui.event({ event: "error", message: `verify command \`${agent.verify.command}\` exits ${base.testExit} — fix it before spending tokens (yeet config --name ${agent.name} test "...")` });
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
    for (let n = 1; n <= flags.maxIter!; n++) {
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
        budget: { capUsd: flags.maxCost!, spentBeforeUsd: agent.costUsd },
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
        stopNote = `hit the ${usd(flags.maxCost!)} cap mid-iteration — agent stopped, partial work kept`;
        break;
      }
      if (r.stopReason === "stall") {
        outcome = "stalled";
        stopNote = "went quiet mid-iteration — agent stopped, partial work kept";
        break;
      }

      // Two detectors, one strike counter. The tree SHA is git's own content hash — exact and
      // free — and it only works because artifacts live outside the workspace.
      // Three ways to be stuck, one counter. The round cap is a backstop, not the plan —
      // these are what actually stop a run, which is why the cap can be generous.
      const prevAgent = history.filter((h) => h.phase === "agent" && h.n !== r.n).at(-1);
      const sig = failureSignature(r.testLog);
      let stuckAs: string | null = null;
      if (!r.treeChanged) stuckAs = "it stopped changing anything";
      else if (prevAgent && prevAgent.afterTree === r.afterTree) stuckAs = "it edited its way back to the same code";
      else if (sig && sig === prevSig) stuckAs = "it keeps changing things and failing the same way";
      if (stuckAs) strikes++; else strikes = 0;
      prevSig = sig;

      if (strikes >= 2) {
        outcome = "stalled";
        // Name the shape of the stall. "no progress" is true of all three and useless for
        // deciding what to do about it.
        stopNote = `${stuckAs} — twice running`;
        break;
      }
      if (agent.costUsd >= flags.maxCost!) { outcome = "capped"; stopNote = `cost cap ${usd(flags.maxCost!)}`; break; }
      if (n === flags.maxIter!) { outcome = "capped"; stopNote = `iteration cap (${flags.maxIter!})`; }
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
  // The name is the handle you type back into every other command, so it never gets truncated —
  // the column grows to fit the longest one instead.
  const w = Math.max(24, ...agents.map((a) => a.name.length + 2));
  console.log(C.dim("NAME".padEnd(w) + "STATUS".padEnd(10) + "COST".padEnd(10) + "CHANGES"));
  for (const a of agents) {
    // Six internal states, two words a person cares about: did it work or not. "running" stays
    // its own word — calling a live agent "failed" would just be untrue.
    const status = a.state === "passed" ? "good" : a.state === "running" ? "running" : "failed";
    const paint = status === "good" ? C.green : status === "running" ? C.cyan : C.red;
    const last = a.iterations.at(-1);
    const changes = last ? `${C.green(`+${last.insertions}`)} ${C.red(`−${last.deletions}`)}` : C.dim("—");
    // Pad the PLAIN text, then colour it. padEnd() counts ANSI escape bytes as width, so
    // colouring first silently breaks every column to its right.
    console.log(
      a.name.padEnd(w) + paint(status.padEnd(10)) + `$${a.costUsd.toFixed(2)}`.padEnd(10) + changes,
    );
  }
  return 0;
}

/**
 * yeet --name <n> merge — combine an agent's work with the branch it was built against.
 *
 * Detects before touching anything: merge-tree does a full three-way merge against the object
 * store, so a conflicted merge costs nothing and leaves no half-merged worktree behind. A clean
 * merge is then VERIFIED in a sandbox before publishing, because two changes can merge without
 * one conflicting line and still break each other — the failure a textual merge cannot see, and
 * the only reason a VM belongs in this path at all.
 */
async function cmdMerge(agent: store.Agent, flags: Flags, ui: Ui): Promise<number> {
  const target = loadConfig().target ?? "main";
  const lock = tryLock(`${store.agentDir(agent.name)}/.lock`);
  if (!lock) { ui.event({ event: "error", message: `${agent.name} is busy right now` }); return EXIT.usage; }

  try {
    const r = analyze(agent, target);
    const evt = (result: "clean" | "conflicted" | "resolved" | "aborted", conflicts: number, mergeCommit: string | null) =>
      record(agent.name, {
        kind: "merge", targetBranch: target, mergeBase: r.mergeBase ?? "", targetCommit: r.targetCommit ?? "",
        agentCommit: r.agentCommit ?? "", result, conflicts, mergeCommit,
      });

    if (r.result === "no_origin") {
      ui.event({ event: "error", message: `${agent.name} has nowhere to merge to — yeet config --name ${agent.name} origin <url>` });
      return EXIT.usage;
    }
    if (r.result === "unreachable") {
      ui.event({ event: "error", message: `could not reach ${agent.origin} — does ${target} exist there?` });
      return EXIT.failed;
    }
    if (r.result === "up_to_date") {
      ui.event({ event: "info", message: `already in ${target}. Nothing to do.` });
      return EXIT.passed;
    }

    if (r.result === "conflicted") {
      evt("conflicted", r.conflicts.length, null);
      if (ui.mode === "json") { console.log(JSON.stringify({ event: "merge", ...r })); return EXIT.failed; }
      console.log("");
      console.log(C.yellow(`it and ${target} both changed the same things, so I stopped before touching anything.`));
      console.log("");
      for (const f of r.conflicts) console.log(`  ${f}`);
      console.log("");
      console.log(C.dim("  nothing is half-merged — the branch is exactly as it was."));
      console.log(C.dim(`  hand it back: yeet --name ${agent.name} "merge ${target} in and resolve the conflicts"`));
      return EXIT.failed;
    }

    const applied = apply(agent, target);
    if (!applied.ok) { ui.event({ event: "error", message: applied.detail }); return EXIT.failed; }

    let verified: boolean | null = null;
    if (agent.verify) {
      if (ui.mode !== "json") console.log(C.dim("merged cleanly — checking the combination actually works…"));
      const check = await runIteration(agent, { n: 0, phase: "confirm", runAgent: false, runTest: true, dirName: "merge-verify" });
      verified = check.valid && check.verdict === "green";
      record(agent.name, {
        kind: "verify_run", reason: "manual", command: agent.verify.command,
        exitCode: check.testExit ?? -1, passed: verified,
      });
      if (!verified) {
        // Textually clean, semantically broken. Keep it local so it can be handed back.
        evt("conflicted", 0, applied.commit);
        if (ui.mode === "json") { console.log(JSON.stringify({ event: "merge", ...r, verified: false, mergeCommit: applied.commit })); return EXIT.failed; }
        console.log("");
        console.log(C.red("they merged without conflicts, but the result fails its own checks."));
        console.log(C.dim("  two changes that are each fine and wrong together — exactly what a clean merge"));
        console.log(C.dim(`  cannot tell you. Not published. Hand it back: yeet --name ${agent.name} "fix the merge"`));
        return EXIT.failed;
      }
    }

    const ok = flags.yes || ui.autoAnswer || (await ui.confirm(`  publish to ${target}?`));
    const pushed = ok ? publish(agent, target) : { ok: false, detail: "not published" };
    evt(pushed.ok ? "resolved" : "clean", 0, applied.commit);

    if (ui.mode === "json") {
      console.log(JSON.stringify({ event: "merge", ...r, mergeCommit: applied.commit, verified, published: pushed.ok }));
      return EXIT.passed;
    }
    console.log("");
    console.log(C.green(`${agent.name} is in ${target}.`));
    if (verified === true) console.log(C.dim("  checks pass on the combined result"));
    else if (verified === null) console.log(C.yellow("  nothing verified this — there was no check to run"));
    console.log(pushed.ok ? C.dim(`  ${pushed.detail}`) : C.yellow(`  ${pushed.detail}`));
    return EXIT.passed;
  } finally {
    lock.release();
  }
}

/**
 * yeet --name <n> test — run the agent's own checks and show you the output.
 *
 * Exists because the alternative was telling people to cd into a path. Someone using yeet has
 * an agent, not a filesystem: they should never need to know there is a git repo, where it is,
 * or which package manager it chose. yeet knows the verify command; yeet runs it.
 */
async function cmdTest(name: string, ui: Ui): Promise<number> {
  if (!store.exists(name)) {
    ui.event({ event: "error", message: `no agent named "${name}" — see yeet ls` });
    return EXIT.usage;
  }
  const agent = store.load(name);
  if (!agent.verify) {
    ui.event({ event: "error", message: `${name} never registered a way to check its work, so there is nothing to run` });
    return EXIT.unverified;
  }

  const lock = tryLock(`${store.agentDir(name)}/.lock`);
  if (!lock) {
    ui.event({ event: "error", message: `${name} is busy right now` });
    return EXIT.usage;
  }
  try {
    if (ui.mode !== "json") console.log(C.dim(`running its checks in a fresh sandbox…`));
    const r = await runIteration(agent, {
      n: 0, phase: "confirm", runAgent: false, runTest: true, dirName: "manual-test",
    });
    if (!r.valid) {
      ui.event({ event: "error", message: r.invalidReason ?? "the sandbox did not come back" });
      return EXIT.failed;
    }
    record(name, {
      kind: "verify_run", reason: "manual", command: agent.verify.command,
      exitCode: r.testExit ?? -1, passed: r.verdict === "green",
    });

    if (ui.mode === "json") {
      console.log(JSON.stringify({ event: "test", agent: name, exitCode: r.testExit, passed: r.verdict === "green", output: r.testLog }));
    } else {
      console.log("");
      for (const line of r.testLog.trimEnd().split("\n")) console.log(`  ${line}`);
      console.log("");
      console.log(r.verdict === "green" ? C.green("  all good.") : C.red(`  that is a fail (exit ${r.testExit}).`));
      if (r.verdict !== "green") console.log(C.dim(`  tell it to fix them: yeet --name ${name} "the checks are failing"`));
    }
    return r.verdict === "green" ? EXIT.passed : EXIT.failed;
  } finally {
    lock.release();
  }
}

/**
 * yeet ask "<question>" — with no --name, search every agent. Free, local, no VM.
 *
 * This is the answer to "which one of these built the thing that…", and it deliberately stops
 * one step short of answering the question itself: it finds the agent and hands you the command
 * to put the question to it. Spending money because a --name was forgotten is the one behaviour
 * this command exists to prevent.
 */
function cmdFind(question: string | undefined, ui: Ui): number {
  const agents = store.list();

  if (!question) {
    if (ui.mode === "json") { console.log(JSON.stringify({ event: "error", message: "ask what?" })); return EXIT.usage; }
    console.log("");
    console.log("ask what? For example:");
    console.log(`  yeet ask "which one reads from stdin?"   ${C.dim("search every agent. Free.")}`);
    console.log(`  yeet ask --name <n> "why …?"             ${C.dim("ask one agent directly (a few cents)")}`);
    return EXIT.usage;
  }

  const hits = search(question, agents);

  if (ui.mode === "json") {
    console.log(JSON.stringify({
      event: "search",
      query: question,
      items: hits.map((h) => ({
        name: h.name, state: h.state, score: Number(h.score.toFixed(4)),
        matched: h.matched, task: h.task, snippet: h.snippet,
      })),
    }));
    return 0;
  }

  if (!agents.length) {
    console.log(`no agents yet — start one:  yeet "build me something"`);
    return 0;
  }
  if (!hits.length) {
    console.log("");
    console.log(`nothing matches ${C.bold(question)}.`);
    console.log(C.dim(`  ${agents.length} agent${agents.length === 1 ? "" : "s"} searched — yeet ls to see them all`));
    return 0;
  }

  // Rank is the message, so the best match gets the first row and nothing is truncated out of
  // it. Pad the PLAIN text before colouring — padEnd counts ANSI bytes as width.
  const shown = hits.slice(0, 5);
  const w = Math.max(16, ...shown.map((h) => h.name.length + 2));
  console.log("");
  console.log(C.dim(`agents that look like "${question}"`));
  console.log("");
  for (const h of shown) {
    const status = h.state === "passed" ? "good" : h.state === "running" ? "running" : "failed";
    const paint = status === "good" ? C.green : status === "running" ? C.cyan : C.red;
    console.log(`  ${h.name.padEnd(w)}${paint(status.padEnd(9))}${C.dim(h.snippet ?? h.task)}`);
  }
  if (hits.length > shown.length) {
    console.log(C.dim(`  … and ${hits.length - shown.length} more`));
  }

  const top = shown[0]!;
  const steps: Array<[string, string]> = [
    [`yeet ask --name ${top.name}`, "the full story of that one. Free."],
    [`yeet ask --name ${top.name} "why …?"`, "put the question to the agent itself (a few cents)"],
  ];
  const cw = Math.max(...steps.map(([c]) => c.length)) + 3;
  console.log("");
  console.log(C.dim("next"));
  for (const [cmd, why] of steps) console.log(`  ${cmd.padEnd(cw)}${C.dim(why)}`);
  return 0;
}

/** yeet ask --name <n> — the full story, free. With a question — a paid conversation. */
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
    const summary = lastSummary(agent);
    const ws = store.workspaceDir(agent.name);
    const last = agent.iterations.at(-1);

    // Default view answers the two questions someone actually has: what is it, and how do I
    // run it. The dossier — model, verify command, frozen fingerprints, per-iteration table —
    // is for someone debugging yeet, so it lives behind --smarty.
    console.log("");
    if (ui.mode === "smarty") {
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
          const flags = `${it.touchedFrozenTests ? C.yellow(" tests-touched") : ""}${it.stopReason ? C.yellow(` stopped:${it.stopReason}`) : ""}`;
          console.log(` ${String(it.n).padStart(2)}  ${dur(it.agentSeconds).padEnd(8)}${usd(it.costUsd).padEnd(9)}${(it.treeChanged ? `+${it.insertions} −${it.deletions} ${it.filesChanged}f` : "no edit").padEnd(18)}${verdict}${flags}`);
        }
      }
      if (summary) {
        console.log("");
        console.log(`${C.dim("in its own words:")} ${summary}`);
      }
      console.log("");
      console.log(C.dim(`artifacts: ${store.agentDir(agent.name)}`));
      return 0;
    }

    console.log(`${C.bold(agent.name)} — ${lines(loadConfig().voice).state(agent.state, agent.model)}`);
    console.log("");
    // The summary is where the agent says what the thing does and how to run it; the build
    // prompt asks for exactly that. Leading with it is the whole point of this command.
    console.log(`  ${summary ? plainText(summary, 500) : C.dim("it never left a summary — try yeet ask " + agent.name + ' "what did you build?"')}`);
    console.log("");
    console.log(`  built    ${agent.iterations.length} round${agent.iterations.length === 1 ? "" : "s"}, ${plebMoney(agent.costUsd)}`);
    console.log(`  checked  ${v ? (last?.verdict === "green" ? "tests pass" : "tests are failing") : C.yellow("nothing verifies this")}${agent.coverage ? C.dim(` · ${agent.coverage.pct}% of the code covered`) : ""}`);

    const steps: Array<[string, string]> = [
      [`yeet --name ${agent.name} test`, "run its checks and show the output"],
      [`yeet --name ${agent.name} "…"`, "keep building"],
      [`yeet ask --name ${agent.name} "why …?"`, "ask it about its own work (a few cents)"],
    ];
    const w = Math.max(...steps.map(([c]) => c.length)) + 3;
    console.log("");
    console.log(C.dim("next"));
    for (const [cmd, why] of steps) console.log(`  ${cmd.padEnd(w)}${C.dim(why)}`);
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
    ui.event({ event: "error", message: `no origin configured — yeet config --name ${agent.name} origin <url>` });
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
    console.log(`${C.dim("origin")}    ${agent.origin ?? `none — set one to enable push: yeet config --name ${agent.name} origin <url>`}`);
    console.log(`${C.dim("test")}      ${agent.verify ? `${agent.verify.command} (${agent.verify.source})` : "unset — the agent registers one, or set it yourself"}`);
    console.log(`${C.dim("coverage")}  ${agent.verify?.coverageCommand ?? "unset"}`);
    console.log(`${C.dim("model")}     ${agent.model}`);
    return 0;
  }

  const [key, ...valueParts] = args;
  const value = valueParts.join(" ");
  switch (key) {
    case "origin": {
      if (!value) { ui.event({ event: "error", message: `usage: yeet config --name ${agent.name} origin <git-url-or-path>` }); return EXIT.usage; }
      const r = store.setOrigin(agent, value);
      ui.event({ event: r.detail.startsWith("could not") ? "error" : "info", message: r.detail });
      return r.detail.startsWith("could not") ? EXIT.failed : 0;
    }
    case "test": {
      if (!value) { ui.event({ event: "error", message: `usage: yeet config --name ${agent.name} test "<command>"` }); return EXIT.usage; }
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
      if (!agent.verify) { ui.event({ event: "error", message: `set a test command first: yeet config --name ${agent.name} test "<cmd>"` }); return EXIT.usage; }
      // Clearing has to be asked for. A bare `config --name x coverage` reads as "show me the
      // coverage command", and answering that by deleting it is not a reasonable trade.
      if (!value) {
        ui.event({ event: "error", message: `usage: yeet config --name ${agent.name} coverage "<command>" — or "none" to clear it` });
        return EXIT.usage;
      }
      agent.verify.coverageCommand = value === "none" ? null : value;
      store.save(agent);
      record(agent.name, {
        kind: "verify_set", command: agent.verify.command, testFiles: agent.verify.testFiles,
        // Editing the coverage command does not change WHO chose the verify contract. Claiming
        // "user" here would rewrite authorship in the log, since fold() replaces verify wholesale.
        coverageCommand: agent.verify.coverageCommand, proposedBy: agent.verify.source, approvedBy: "user",
        changedOnApproval: false, protectedTests: agent.verify.frozen,
      });
      ui.event({ event: "info", message: agent.verify.coverageCommand ? `coverage command is now: ${value}` : "coverage command cleared" });
      return 0;
    }
    case "model": {
      if (!value) { ui.event({ event: "error", message: `usage: yeet config --name ${agent.name} model <provider/model>` }); return EXIT.usage; }
      agent.model = value;
      store.save(agent);
      record(agent.name, { kind: "config", key: "model", value, setBy: "user" });
      ui.event({ event: "info", message: `model is now: ${value}` });
      return 0;
    }
    default:
      ui.event({ event: "error", message: `"${key}" is not something an agent has (origin · test · coverage · model). Global settings drop the --name: see yeet config --help` });
      return EXIT.usage;
  }
}

function cmdGlobalConfig(args: string[], ui: Ui): number {
  const cfg = loadConfig();
  if (args.length === 0) {
    if (ui.mode === "json") { console.log(JSON.stringify({ event: "config", global: cfg })); return 0; }
    console.log(`${C.dim("smarty")}  ${cfg.smarty ? "on" : "off"}   ${C.dim("(dev detail by default)")}`);
    console.log(`${C.dim("voice")}   ${cfg.voice ?? "default"}`);
    console.log(`${C.dim("model")}   ${cfg.model ?? DEFAULT_MODEL}`);
    console.log(`${C.dim("budget")}  ${usd(cfg.maxCostUsd ?? DEFAULT_LIMITS.maxCostUsd)} ${C.dim("per run")}`);
    console.log(`${C.dim("rounds")}  ${cfg.maxIterations ?? DEFAULT_LIMITS.maxIterations} ${C.dim("before it gives up")}`);
    console.log(`${C.dim("origin")}  ${cfg.origin ?? C.dim("none — new agents start isolated")}`);
    const keys = listKeys();
    console.log(`${C.dim("keys")}    ${keys.length ? keys.join(", ") : C.dim("none set — yeet config key <provider>")}`);
    return 0;
  }
  const [key, value] = args;
  if (key === "voice") {
    if (!VOICES.includes(value as Voice)) {
      ui.event({ event: "error", message: `usage: yeet config voice ${VOICES.join("|")}` });
      return EXIT.usage;
    }
    cfg.voice = value as Voice;
    saveConfig(cfg);
    // Said IN the new voice, so you hear what you just bought before you commit to it.
    ui.event({ event: "info", message: `voice is now ${value}. ${lines(cfg.voice).passed}` });
    return 0;
  }
  if (key === "origin") {
    if (!value) { ui.event({ event: "error", message: "usage: yeet config origin <git-url-or-path>" }); return EXIT.usage; }
    cfg.origin = value;
    saveConfig(cfg);
    ui.event({ event: "info", message: `new agents will start from ${value}. Existing ones keep whatever they have.` });
    return 0;
  }
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
  if (key === "budget") {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) { ui.event({ event: "error", message: "usage: yeet config budget <dollars>  e.g. yeet config budget 5" }); return EXIT.usage; }
    cfg.maxCostUsd = n;
    saveConfig(cfg);
    ui.event({ event: "info", message: `budget is now ${usd(n)} per run. --max-cost still wins for a single run.` });
    return 0;
  }
  if (key === "rounds") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) { ui.event({ event: "error", message: "usage: yeet config rounds <n>  e.g. yeet config rounds 8" }); return EXIT.usage; }
    cfg.maxIterations = n;
    saveConfig(cfg);
    ui.event({ event: "info", message: `agents now get ${n} round${n === 1 ? "" : "s"} before I call it.` });
    return 0;
  }
  ui.event({ event: "error", message: `unknown setting "${key}" — see yeet config --help` });
  return EXIT.usage;
}

/**
 * yeet config key <provider> — read a key with no echo and store it out of reach.
 *
 * Deliberately NOT an argument. A key passed on the command line is in `ps` for every process
 * on the machine and in shell history forever, and neither is undone by deleting it later.
 */
async function cmdKey(args: string[], ui: Ui): Promise<number> {
  const [provider, ...rest] = args;
  if (!provider) {
    ui.event({ event: "error", message: `usage: yeet config key <provider> — one of ${KNOWN_PROVIDERS.join(", ")}` });
    return EXIT.usage;
  }
  if (!KNOWN_PROVIDERS.includes(provider)) {
    ui.event({ event: "error", message: `I do not know "${provider}". Try one of: ${KNOWN_PROVIDERS.join(", ")}` });
    return EXIT.usage;
  }
  if (rest[0] === "remove" || rest[0] === "rm") {
    ui.event({ event: "info", message: deleteKey(provider) ? `${provider} key removed.` : `there was no ${provider} key to remove.` });
    return 0;
  }
  // A key given as an argument is already compromised — refuse rather than quietly accept it.
  if (rest.length > 0) {
    ui.event({ event: "error", message: `don't put the key on the command line — it lands in ps and your shell history. Run: yeet config key ${provider}` });
    return EXIT.usage;
  }
  if (!process.stdin.isTTY) {
    ui.event({ event: "error", message: `I need a terminal to take a key without echoing it. Or export ${PROVIDER_ENV[provider]} instead.` });
    return EXIT.usage;
  }

  let value: string;
  try {
    value = (await hiddenPrompt(`  ${provider} key ${C.dim("(not shown as you type)")}: `)).trim();
  } catch {
    ui.event({ event: "info", message: "cancelled." });
    return EXIT.usage;
  }
  if (!value) { ui.event({ event: "error", message: "nothing entered." }); return EXIT.usage; }

  setKey(provider, value);
  ui.event({
    event: "info",
    message: `${provider} key saved (${fingerprint(value)}) to ${KEYS_PATH.replace(process.env.HOME ?? "", "~")}, mode 0600.`,
  });
  return 0;
}

/**
 * One screen per command, because a single wall listing every flag of every command is a
 * reference nobody reads. `yeet --help` answers "what can this do"; `yeet <cmd> --help`
 * answers "how do I use this one".
 */
function help(topic?: string): void {
  const cfg = loadConfig();
  const model = cfg.model ?? DEFAULT_MODEL;
  const cost = cfg.maxCostUsd ?? DEFAULT_LIMITS.maxCostUsd;
  const iter = cfg.maxIterations ?? DEFAULT_LIMITS.maxIterations;

  if (topic === "ls") {
    console.log(`yeet ls — every agent you have, newest first.

  NAME      what you call it in every other command
  STATUS    good · failed · running
  COST      everything it has spent: rounds and questions together
  CHANGES   lines added and removed in its last round

  --agent   JSON lines instead of the table`);
    return;
  }

  if (topic === "ask") {
    console.log(`yeet ask — which agent did what, and questions about it.

  yeet ask "which one reads stdin?"   search every agent. Free.
  yeet ask --name <n>                 the story of its last run. Free.
  yeet ask --name <n> "why X?"        put the question to the agent itself. A few cents.

Without --name it searches: it matches your words against every agent's task and its own
summary, on this machine, and hands you the agent's name. Nothing boots and nothing is spent.

Naming an agent AND asking it something is the only form that costs money — it wakes that
agent in a sandbox with its own history, where it can read its code but not change it. So a
forgotten --name can never turn into a question asked of every agent you own.

  --name <n>   which agent. Omit it to search across all of them.
  --agent      JSON instead of prose`);
    return;
  }

  if (topic === "config") {
    console.log(`yeet config — settings. Without --name they are yours; with it, one agent's.

  yeet config                       show yours
  yeet config <setting> <value>     set one
  yeet config --name <n>            show that agent's
  yeet config --name <n> <s> <v>    set one on that agent

yours
  smarty on|off       developer detail everywhere, not only when you pass --smarty
  voice ${VOICES.join("|")}
  model <p/m>         which model new agents use              now: ${model}
  budget <dollars>    spend ceiling for one run               now: ${usd(cost)}
  rounds <n>          tries before yeet calls it              now: ${iter}
  origin <url>        repo new agents start from              now: ${cfg.origin ?? "none"}
  key <provider>      store an API key — prompts, never echoes, never an argument
  keys                which keys are set, and where

one agent's (--name)
  origin <url>        connect a repo. Imports it as the base if nothing is built yet,
                      and unlocks push.
  test "<cmd>"        how the work gets proven. Overrides what the agent registered.
  coverage "<cmd>"    must leave an lcov file behind · "none" to clear it
  model <p/m>         just this agent

Where a setting exists in both places, the agent's answer wins.`);
    return;
  }

  if (topic === "rm") {
    console.log(`yeet rm --name <n> — delete an agent: workspace, branch, history, all of it.

Nothing is pushed first, and there is no undo. If the work matters, push it before you
run this.

  --name <n>   required: which agent
  --yes        don't ask for confirmation`);
    return;
  }

  console.log(`yeet — sandboxed coding agents that loop until the work actually checks out

  yeet "build me a thing"        start a new agent. It asks questions first, proves its
                                 work with tests, and never touches your files.
  yeet --name <n> "now do this"  give that agent more work
  yeet --name <n> test           run its checks and show you the output
  yeet --name <n> push           push its branch to origin (asks first)
  yeet --name <n> merge          combine its work with your main branch

  yeet ls                        every agent and how it went
  yeet ask "which one did X?"    find the agent you mean. Free.
  yeet ask --name <n>            what one did, and questions about it
  yeet config                    settings, yours or one agent's
  yeet rm --name <n>             delete an agent

  --name <n>       which agent. Starting a new one, this names it.
  --rename <new>   yeet --name <old> --rename <new>
  --model <p/m>    ${model}
  --max-cost USD   ${cost}          --max-iter N   ${iter}
  --smarty         developer detail for this run
  --yes            don't wait for answers — take the agent's recommendations
  --agent          machine mode: JSON lines on stdout, nothing else

ls · ask · config · rm each have their own --help.
exit codes: 0 passed · 1 usage/infra · 2 stalled · 3 hit a cap · 4 failed · 5 unverified`);
}

// ── main ──────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { rest, flags } = parse(process.argv.slice(2));
  resolveLimits(flags);
  const ui = makeUi(flags);

  // `yeet ls --help`, `yeet help ls` and `yeet --help` all land here the same way: parse()
  // turns -h/--help into a leading "help", so rest[1] is the topic when there is one.
  if (rest[0] === "help") {
    help(rest[1]);
    return 0;
  }
  // Bare `yeet` is the help screen. `yeet --name x` is NOT — it named an agent and then asked
  // for nothing, which is a mistake worth reporting rather than a table of contents.
  if (rest.length === 0 && !flags.name && !flags.rename) {
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

  /** Every command but `ls` and global `config` needs to know which agent. */
  const named = (cmd: string): store.Agent | null => {
    if (!flags.name) {
      ui.event({ event: "error", message: `which agent? yeet ${cmd} --name <n> — see yeet ls` });
      return null;
    }
    if (!store.exists(flags.name)) {
      ui.event({ event: "error", message: `no agent named "${flags.name}" — see yeet ls` });
      return null;
    }
    return store.load(flags.name);
  };

  if (rest[0] === "ls") return cmdLs(ui);

  if (rest[0] === "config") {
    // Keys are the machine's, not an agent's, so they resolve before --name is consulted.
    if (rest[1] === "key") return cmdKey(rest.slice(2), ui);
    if (rest[1] === "keys") {
      const keys = listKeys();
      if (ui.mode === "json") { console.log(JSON.stringify({ event: "keys", keys })); return 0; }
      // Names and locations only. Printing a value here is how a key ends up in scrollback.
      if (!keys.length) console.log(C.dim("no keys set — yeet config key <provider>"));
      for (const k of keys) console.log(`  ${k}`);
      if (keys.length) console.log(C.dim(`  stored in ${KEYS_PATH.replace(process.env.HOME ?? "", "~")} (0600)`));
      return 0;
    }
    if (flags.name) {
      const agent = named("config");
      return agent ? cmdAgentConfig(agent, rest.slice(1), ui) : EXIT.usage;
    }
    return cmdGlobalConfig(rest.slice(1), ui);
  }

  if (rest[0] === "ask") {
    const q = rest.slice(1).join(" ") || undefined;
    // A missing --name is not an error here: it means "look across all of them", which reads
    // from disk and costs nothing. Only naming an agent AND asking it something spends money.
    if (!flags.name) return cmdFind(q, ui);
    const agent = named("ask");
    return agent ? cmdAsk(agent.name, q, ui) : EXIT.usage;
  }

  if (rest[0] === "rm") {
    const agent = named("rm");
    return agent ? cmdRm(agent.name, ui) : EXIT.usage;
  }

  // Everything below is the bare `yeet` command: work, test, push, rename.
  if (flags.name && store.exists(flags.name)) {
    const agent = store.load(flags.name);
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
        ui.event({ event: "info", message: `${agent.name} is now ${renamed.name} (branch ${renamed.branch})` });
        return 0;
      } catch (e) {
        ui.event({ event: "error", message: (e as Error).message });
        return EXIT.usage;
      } finally {
        lock.release();
      }
    }
    // Bare, on their own, these are the two verbs. With anything around them they are just
    // words in a task, which is exactly the ambiguity that killed the positional name.
    if (rest.length === 1 && rest[0] === "test") return cmdTest(agent.name, ui);
    if (rest.length === 1 && rest[0] === "push") return cmdPush(agent, ui);
    if (rest.length === 1 && rest[0] === "merge") return cmdMerge(agent, flags, ui);
    if (rest.length) return runAgentLoop(agent, flags, ui, rest.join(" "));

    ui.event({
      event: "error",
      message: `"${agent.name}" exists. Give it work (yeet --name ${agent.name} "<task>"), ask about it (yeet ask --name ${agent.name}), or configure it (yeet config --name ${agent.name}).`,
    });
    return EXIT.usage;
  }

  if (rest.length === 1 && (rest[0] === "test" || rest[0] === "push" || rest[0] === "merge")) {
    ui.event({ event: "error", message: `which agent? yeet --name <n> ${rest[0]} — see yeet ls` });
    return EXIT.usage;
  }
  if (flags.rename) {
    ui.event({ event: "error", message: "--rename needs an existing agent: yeet --name <old> --rename <new>" });
    return EXIT.usage;
  }

  // New agent.
  const task = rest.join(" ").trim();
  if (!task) {
    ui.event({
      event: "error",
      message: flags.name
        ? `there is no agent called "${flags.name}". To start one, tell it what to build: yeet --name ${flags.name} "<task>"`
        : `tell it what to build: yeet "build me a thing"`,
    });
    return EXIT.usage;
  }
  let agent: store.Agent;
  try {
    agent = store.create({ task, model, name: flags.name ?? undefined });
  } catch (e) {
    ui.event({ event: "error", message: (e as Error).message });
    return EXIT.usage;
  }
  // A configured default origin is a starting point, not a requirement: if it is unreachable
  // the agent still gets to work, isolated, rather than the run dying on a settings problem.
  if (cfg.origin) {
    const r = store.setOrigin(agent, cfg.origin);
    ui.event(
      r.detail.startsWith("could not")
        ? { event: "warning", message: `${r.detail} — starting isolated instead` }
        : { event: "info", message: r.detail },
    );
  }
  return runAgentLoop(agent, flags, ui);
}

process.exitCode = await main();
