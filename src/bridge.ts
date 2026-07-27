/**
 * bridge.ts — the controller side of the guest<->human conversation, and the liveness cop.
 *
 * The guest half is guest/yeet-tools.ts: a pi extension whose tools (ask_user, set_verify)
 * write request files into <iter>/qa/ on the shared mount and poll for answer files. This
 * class is the host half: it watches qa/, gets answers (from a person or a policy), and
 * writes them back. File-based on purpose — it is the same "free text crosses the boundary
 * as files" rule the rest of the contract already lives by, and it works because /yeet is
 * the same directory on both sides of virtio-fs.
 *
 * It is also where "is the guest alive?" gets decided, replacing the old fixed in-guest
 * timeouts. One rule: no file growth anywhere we can see (session JSONL, agent/test/runner
 * logs) for stallMs, with no question waiting on a human, means the guest is presumed dead.
 * Escalation is two-step and deliberately reuses the budget machinery:
 *
 *   1. If the agent phase is running and STOP has not been dropped: drop STOP. The in-guest
 *      watchdog SIGTERMs pi, and the runner still commits partial work, verifies, and writes
 *      DONE — nothing already done is lost.
 *   2. If there is STILL no activity for another stallMs (STOP ignored, or a wedged verify
 *      command in a no-agent phase): kill the VM. By then the commit either happened and is
 *      durable on the shared mount, or the guest was never going to produce one.
 *
 * The budget check lives here too (same ticker, same session file): cap crossed mid-iteration
 * -> drop STOP with reason "budget". The host records WHY it dropped STOP; the guest only
 * ever presence-checks the file.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findSessionFile, readSession, costDelta } from "./session";
import { EventTail } from "./trace";
import type { VmWatcher } from "./vm";

export type AskRequest = {
  id: string;
  question: string;
  options: string[];
  recommended: string;
  why?: string;
};

export type VerifyRequest = {
  id: string;
  command: string;
  testFiles: string[];
  coverageCommand: string | null;
  why?: string;
};

export type VerifyDecision = { command: string; testFiles: string[]; coverageCommand: string | null };

export type BridgeOpts = {
  /** Host path of the iteration dir; qa/, STOP, DONE and the logs live here. */
  iterDir: string;
  /** Host path of the agent's session dir — the primary sign of life. */
  sessionDir: string;
  /** No observable activity for this long ⇒ escalate. */
  stallMs: number;
  /** True when pi is running in there — makes escalation STOP-first so partial work is
   *  committed. Distinct from `budget`: a chat run has an agent but may have no cap. */
  agentPhase?: boolean;
  /** Present only for budgeted agent phases. */
  budget?: { capUsd: number; spentBeforeUsd: number };
  onAsk: (q: AskRequest) => Promise<string>;
  onVerify: (v: VerifyRequest) => Promise<VerifyDecision>;
  /** Informational: the bridge dropped STOP or killed the VM. */
  onEscalate?: (action: "stop" | "kill", reason: "budget" | "stall") => void;
  /** pi's event stream as it arrives, for the live trace. It rides this ticker rather than
   *  starting its own: the loop already polls this same shared directory every 750ms, and a
   *  second timer over the same virtiofs mount would only double the I/O. */
  onAgentEvent?: (events: any[]) => void;
  /** The VM has exited and no further events are coming. The renderer needs this to close a
   *  half-written streaming line — the guest compacts and deletes the raw log before the VM
   *  shuts down, so "the file went away" cannot be used as the signal. */
  onAgentEnd?: () => void;
  tickMs?: number;
};

export class Bridge implements VmWatcher {
  /** Why STOP was dropped, if it was. The guest never knows; the host must. */
  stopReason: "budget" | "stall" | null = null;
  killedWhy: string | null = null;
  readonly qa: Array<{ kind: "ask" | "verify"; request: AskRequest | VerifyRequest; answer: unknown }> = [];

  private timer: ReturnType<typeof setInterval> | null = null;
  private kill: ((why: string) => void) | null = null;
  private busy = false;
  private lastActivity = Date.now();
  private lastSizes = new Map<string, number>();
  private answered = new Set<string>();
  private sessionBase: { file: string | null; costUsd: number } | null = null;
  private tail: EventTail | null = null;

  constructor(private opts: BridgeOpts) {}

  start(kill: (why: string) => void): void {
    this.kill = kill;
    this.lastActivity = Date.now();
    // The budget baseline is this session file's totals BEFORE this iteration adds to it —
    // pi -c appends to one file, so live readings are cumulative and must be diffed.
    this.sessionBase = this.opts.budget
      ? readSession(findSessionFile(this.opts.sessionDir))
      : null;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 750);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // One last read. The guest keeps writing between the final tick and the VM exiting, and
    // the tail end is the part worth seeing — agent_end, the closing message, and whatever a
    // stopped agent managed to emit before it was killed. Without this the live trace loses
    // its last up-to-750ms and leaves a half-written line for the next printer to collide with.
    this.drainAgentEvents();
    this.opts.onAgentEnd?.();
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const pending = this.scanQa();
      for (const file of pending) await this.answer(file);
      this.drainAgentEvents();
      this.observeActivity();
      this.checkBudget();
      this.checkStall(pending.length > 0);
    } catch {
      /* a torn qa file mid-rename or a vanished dir is a next-tick problem, not a crash */
    } finally {
      this.busy = false;
    }
  }

  private qaDir(): string {
    return join(this.opts.iterDir, "qa");
  }

  /** Forward whatever pi has written since the last tick. Constructed lazily because the file
   *  does not exist until the guest has started the agent. */
  private drainAgentEvents(): void {
    if (!this.opts.onAgentEvent) return;
    this.tail ??= new EventTail(join(this.opts.iterDir, "agent.raw.jsonl"));
    const events = this.tail.drain();
    if (events.length) this.opts.onAgentEvent(events);
  }

  private scanQa(): string[] {
    const dir = this.qaDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^\d+\.(ask|verify)\.json$/.test(f))
      .filter((f) => !this.answered.has(f) && !existsSync(join(dir, `${f.split(".")[0]}.answer.json`)))
      .sort();
  }

  private async answer(file: string): Promise<void> {
    const dir = this.qaDir();
    let req: Record<string, unknown>;
    try {
      req = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      return; // torn write; the guest renames atomically, so next tick sees it whole
    }
    const id = String(file.split(".")[0]);
    const kind = file.includes(".verify.") ? "verify" : "ask";

    let payload: unknown;
    if (kind === "ask") {
      const q: AskRequest = {
        id,
        question: String(req.question ?? ""),
        options: Array.isArray(req.options) ? req.options.map(String) : [],
        recommended: String(req.recommended ?? ""),
        why: req.why ? String(req.why) : undefined,
      };
      const answer = await this.opts.onAsk(q);
      payload = { answer };
      this.qa.push({ kind, request: q, answer });
    } else {
      const v: VerifyRequest = {
        id,
        command: String(req.command ?? ""),
        testFiles: Array.isArray(req.testFiles) ? req.testFiles.map(String) : [],
        coverageCommand: req.coverageCommand ? String(req.coverageCommand) : null,
        why: req.why ? String(req.why) : undefined,
      };
      const decision = await this.opts.onVerify(v);
      payload = { ok: true, ...decision };
      this.qa.push({ kind, request: v, answer: decision });
    }

    // Atomic: the guest polls existsSync then parses, so it must never see a half-write.
    const ans = join(dir, `${id}.answer.json`);
    writeFileSync(ans + ".tmp", JSON.stringify(payload, null, 2));
    renameSync(ans + ".tmp", ans);
    this.answered.add(file);
    this.lastActivity = Date.now(); // an exchange is activity by definition
  }

  /** Growth in any watched file counts. Size, not mtime — virtiofs mtime propagation has
   *  burned enough people, and size-monotone growth is what "alive" actually looks like. */
  private observeActivity(): void {
    const watch: string[] = [];
    const sess = findSessionFile(this.opts.sessionDir);
    if (sess) watch.push(sess);
    for (const f of ["agent.log", "test.log", "runner.log", "console.log", "meta.kv.tmp"]) {
      watch.push(join(this.opts.iterDir, f));
    }
    for (const p of watch) {
      let size = -1;
      try {
        size = statSync(p).size;
      } catch {
        continue;
      }
      if (this.lastSizes.get(p) !== size) {
        this.lastSizes.set(p, size);
        this.lastActivity = Date.now();
      }
    }
  }

  private checkBudget(): void {
    if (!this.opts.budget || this.stopReason) return;
    const live = readSession(findSessionFile(this.opts.sessionDir));
    const spent = this.opts.budget.spentBeforeUsd + costDelta(this.sessionBase, live);
    if (spent >= this.opts.budget.capUsd) this.dropStop("budget");
  }

  private checkStall(questionPending: boolean): void {
    // A human thinking about an answer is not a dead guest. The clock resumes when they answer.
    if (questionPending) {
      this.lastActivity = Date.now();
      return;
    }
    if (Date.now() - this.lastActivity < this.opts.stallMs) return;
    if (existsSync(join(this.opts.iterDir, "DONE"))) return; // finished; VM is on its way out

    if (this.opts.agentPhase && !this.stopReason) {
      // Agent phase, first strike: ask nicely via STOP so partial work gets committed.
      this.dropStop("stall");
      this.lastActivity = Date.now(); // restart the clock — the runner needs time to wrap up
      return;
    }
    // No-agent phase (a wedged verify), or STOP was ignored for a whole further stallMs.
    this.killedWhy = this.stopReason === "budget" ? "budget stop ignored" : "no signs of life";
    this.opts.onEscalate?.("kill", this.stopReason ?? "stall");
    this.kill?.(this.killedWhy);
  }

  private dropStop(reason: "budget" | "stall"): void {
    this.stopReason = reason;
    try {
      writeFileSync(join(this.opts.iterDir, "STOP"), reason + "\n");
    } catch {
      /* iteration dir vanished ⇒ the run is over anyway */
    }
    this.opts.onEscalate?.("stop", reason);
  }
}

/** Host-side atomic mkdir for the qa dir so the first guest poll never races a mkdir. */
export function prepareQaDir(iterDir: string): void {
  mkdirSync(join(iterDir, "qa"), { recursive: true });
}
