/**
 * agent.ts — the durable unit.
 *
 * An agent is not a run. It owns a workspace, a git branch, and a pi session, so `yeet <name>
 * "<follow-up>"` is a real continuation of a conversation rather than a fresh attempt.
 *
 * Layout (0700 throughout — run.env holds a bridged API key):
 *   ~/.yeet/agents/<name>/
 *     agent.json      state, cost, iteration history
 *     .lock           flock held for the duration of a run
 *     workspace/      a `git clone --local` of the target repo, on branch yeet/<name>
 *     session/        pi's session JSONL — survives every VM, which is what lets -c resume
 *     bin/yeet-run    staged per run, so iterating on the runner never rebuilds the image
 *     iter-000/…      per-iteration request + logs + meta.kv + DONE
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AGENTS_DIR } from "./host";

export type IterationRecord = {
  n: number;
  phase: string;
  agentSeconds: number;
  costUsd: number;
  insertions: number;
  deletions: number;
  filesChanged: number;
  treeChanged: boolean;
  testExit: number | null;
  verdict: "green" | "red" | "none";
};

export type AgentState = "running" | "passed" | "stalled" | "capped" | "failed";

export type Agent = {
  name: string;
  createdAt: string;
  /** Host path of the target repo, or null for a greenfield agent. */
  repo: string | null;
  baseHead: string | null;
  branch: string;
  model: string;
  testCommand: string | null;
  task: string;
  state: AgentState;
  costUsd: number;
  iterations: IterationRecord[];
};

const RESERVED = new Set(["ls", "help", "-h", "--help"]);

/** Name from the first task, so `yeet ls` reads like a to-do list and you never type an id. */
export function slugify(task: string, taken: (n: string) => boolean): string {
  const stop = new Set(["a", "an", "the", "to", "for", "of", "in", "on", "and", "make", "me", "my", "please", "add"]);
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !stop.has(w))
    .slice(0, 3);
  let base = words.join("-").slice(0, 32) || "agent";
  if (RESERVED.has(base)) base = `${base}-1`;
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}

export const agentDir = (name: string) => join(AGENTS_DIR, name);
const metaPath = (name: string) => join(agentDir(name), "agent.json");

export function exists(name: string): boolean {
  return existsSync(metaPath(name));
}

export function load(name: string): Agent {
  return JSON.parse(readFileSync(metaPath(name), "utf8")) as Agent;
}

export function save(agent: Agent): void {
  writeFileSync(metaPath(agent.name), JSON.stringify(agent, null, 2) + "\n", { mode: 0o600 });
}

export function list(): Agent[] {
  if (!existsSync(AGENTS_DIR)) return [];
  const out: Agent[] = [];
  for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(load(entry.name));
    } catch {
      /* a half-created agent dir is not worth failing the whole listing over */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args]);
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

export function repoRootOf(cwd: string): string | null {
  const r = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

export type CreateOptions = {
  task: string;
  cwd: string;
  model: string;
  testCommand: string | null;
  repoOverride?: string;
};

export function create(opts: CreateOptions): Agent {
  const name = slugify(opts.task, exists);
  const dir = agentDir(name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const sub of ["session", "bin"]) mkdirSync(join(dir, sub), { recursive: true });

  const repo = opts.repoOverride ?? repoRootOf(opts.cwd);
  const workspace = join(dir, "workspace");
  const branch = `yeet/${name}`;
  let baseHead: string | null = null;

  if (repo) {
    // --local hardlinks .git/objects: metadata-only and safe, since git never rewrites an
    // existing object file. The user's checkout, index, and stash are never touched.
    const head = git(repo, "rev-parse", "HEAD");
    if (!head.ok) throw new Error(`cannot read HEAD of ${repo} — is it an empty repository?`);
    baseHead = head.out;
    const clone = Bun.spawnSync(["git", "clone", "--quiet", "--local", repo, workspace]);
    if (clone.exitCode !== 0) throw new Error(`git clone failed: ${clone.stderr.toString()}`);
    git(workspace, "checkout", "--quiet", "-b", branch, baseHead);
    // The guest has unrestricted TSI egress; it must not be able to push anywhere.
    git(workspace, "remote", "remove", "origin");
  } else {
    mkdirSync(workspace, { recursive: true });
    git(workspace, "init", "-q");
    git(workspace, "commit", "-q", "--allow-empty", "-m", "yeet: empty base");
    baseHead = git(workspace, "rev-parse", "HEAD").out || null;
    git(workspace, "checkout", "--quiet", "-b", branch);
  }

  const agent: Agent = {
    name,
    createdAt: new Date().toISOString(),
    repo,
    baseHead,
    branch,
    model: opts.model,
    testCommand: opts.testCommand,
    task: opts.task,
    state: "running",
    costUsd: 0,
    iterations: [],
  };
  save(agent);
  return agent;
}

/** Import the agent's commits into the user's repo as a real branch. Objects only — no
 *  working-tree write, no index lock, safe to run while the user is editing. */
export function exportResult(agent: Agent): { ok: boolean; detail: string } {
  if (!agent.repo) return { ok: true, detail: join(agentDir(agent.name), "workspace") };
  const ws = join(agentDir(agent.name), "workspace");
  const r = Bun.spawnSync([
    "git", "-C", agent.repo, "fetch", "--quiet", "--no-tags", ws,
    `+${agent.branch}:${agent.branch}`,
  ]);
  return r.exitCode === 0
    ? { ok: true, detail: agent.branch }
    : { ok: false, detail: r.stderr.toString().trim() };
}

export const label = (agent: Agent) =>
  agent.repo ? basename(agent.repo) : join(agentDir(agent.name), "workspace").replace(process.env.HOME ?? "", "~");
