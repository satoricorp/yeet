/**
 * session.ts — read pi's session JSONL.
 *
 * This is what makes a real budget cap possible. pi writes a typed JSONL entry per turn, and
 * because the session dir lives on the shared virtiofs mount the host reads it directly — no
 * event stream, no parsing of unstructured agent output.
 *
 * It is also what lets a fresh VM per iteration keep context: the session file survives the VM,
 * so `pi -c` resumes the whole conversation across a boot boundary.
 *
 * Shape (from the image's own docs/session-format.md):
 *   {"type":"message","message":{"role":"assistant","usage":{...},"stopReason":"stop", ...}}
 *   interface Usage { input, output, cacheRead, cacheWrite, totalTokens, cost:{...,total} }
 * Compaction entries also carry usage, and pi counts them in session totals, so we do too.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type SessionStats = {
  file: string | null;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  totalTokens: number;
  costUsd: number;
  stopReason: string | null;
  finalMessage: string | null;
};

export const EMPTY_SESSION: SessionStats = {
  file: null,
  turns: 0,
  toolCalls: 0,
  toolErrors: 0,
  totalTokens: 0,
  costUsd: 0,
  stopReason: null,
  finalMessage: null,
};

/** Newest .jsonl anywhere under dir. pi nests by munged cwd, so this walks. */
export function findSessionFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let newest: { path: string; mtime: number } | null = null;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".jsonl")) {
        const m = statSync(p).mtimeMs;
        if (!newest || m > newest.mtime) newest = { path: p, mtime: m };
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  return newest ? (newest as { path: string }).path : null;
}

export function readSession(file: string | null): SessionStats {
  if (!file || !existsSync(file)) return EMPTY_SESSION;

  const stats: SessionStats = { ...EMPTY_SESSION, file };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn final line while pi is still writing is expected, not an error
    }

    const usage = entry?.message?.usage ?? entry?.usage;
    if (usage) {
      stats.totalTokens += usage.totalTokens ?? 0;
      stats.costUsd += usage.cost?.total ?? 0;
    }

    if (entry?.type === "message" && entry.message?.role === "assistant") {
      stats.turns++;
      if (entry.message.stopReason) stats.stopReason = entry.message.stopReason;
      const text = (entry.message.content ?? [])
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n")
        .trim();
      if (text) stats.finalMessage = text;
      for (const c of entry.message.content ?? []) if (c?.type === "toolCall") stats.toolCalls++;
    }

    if (entry?.type === "toolResult" || entry?.message?.role === "toolResult") {
      const isError = entry.isError ?? entry.message?.isError;
      if (isError) stats.toolErrors++;
    }
  }
  return stats;
}

/** Did the agent actually do anything? Derived from three independent signals rather than
 *  from reading prose: the tree changed, tools were called, and the process exited cleanly.
 *  "stopped" means the controller asked it to stop (budget or stall) — the exit code is the
 *  SIGTERM the watchdog sent, not an agent failure. */
export function agentVerdict(
  stats: SessionStats,
  treeChanged: boolean,
  agentExit: number,
  stopped: boolean,
): "edited" | "no_edit" | "error" | "stopped" {
  if (stopped) return "stopped";
  if (agentExit !== 0) return "error";
  return treeChanged ? "edited" : "no_edit";
}

/**
 * Incremental cost of one iteration. `pi -c` APPENDS to the same session file (sessions.md:
 * continue -> "Same session file"), so readSession() returns cumulative-for-the-file totals —
 * adding those per iteration double-counts every earlier iteration. Diff against the previous
 * reading of the same file; a new file starts its own base.
 */
export function costDelta(
  prev: { file: string | null; costUsd: number } | null,
  cur: SessionStats,
): number {
  if (!cur.file) return 0;
  if (prev && prev.file === cur.file) return Math.max(0, cur.costUsd - prev.costUsd);
  return cur.costUsd;
}
