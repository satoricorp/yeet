/**
 * cloud.ts — `yeet sync` and `yeet cloud`: the laptop half of the S3 + Fargate story.
 *
 * Everything here shells out to the `aws` CLI rather than taking an SDK dependency. yeet has
 * zero npm dependencies and that is worth protecting; the aws CLI is the one tool anyone
 * touching AWS already has, and every call this file makes is a single well-formed command.
 *
 * What syncs is the measured must-move set, not the directory: events.jsonl (append-only),
 * agent.json, the newest session file, and the workspace as a git bundle. node_modules and
 * build output never travel — they are rebuilt where they land, because native binaries do
 * not survive the mac-arm to linux-arm trip anyway.
 *
 * The infra contract: a CloudFormation stack named YeetCloud (infra/) whose outputs name the
 * bucket, cluster, task definition, subnets and security group. Discovered once with
 * describe-stacks and cached at $YEET_HOME/cloud.json — delete that file after a redeploy
 * that changes outputs.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { YEET_HOME } from "./host";
import * as store from "./agent";

const CACHE = join(YEET_HOME, "cloud.json");

export type CloudConfig = {
  stateBucket: string;
  clusterArn: string;
  taskDefinitionArn: string;
  subnetIds: string[];
  securityGroupId: string;
};

const run = (args: string[]): { ok: boolean; out: string; err: string } => {
  const r = Bun.spawnSync(["aws", ...args]);
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

/** The aws CLI is the one dependency this file allows itself, so its absence is a setup
 *  error with a fix, not a stack trace. */
export function awsReady(): string | null {
  if (Bun.spawnSync(["which", "aws"]).exitCode !== 0) {
    return "the aws CLI is not installed — brew install awscli, then aws configure";
  }
  const id = run(["sts", "get-caller-identity", "--query", "Account", "--output", "text"]);
  if (!id.ok) return `aws credentials are not working: ${id.err.split("\n")[0]}`;
  return null;
}

/** Stack outputs, cached. One describe-stacks on first use; delete $YEET_HOME/cloud.json to
 *  re-discover after a redeploy. */
export function loadCloudConfig(): CloudConfig | { error: string } {
  if (existsSync(CACHE)) {
    try { return JSON.parse(readFileSync(CACHE, "utf8")) as CloudConfig; } catch { /* re-discover */ }
  }
  const r = run(["cloudformation", "describe-stacks", "--stack-name", "YeetCloud",
    "--query", "Stacks[0].Outputs", "--output", "json"]);
  if (!r.ok) {
    return { error: "no YeetCloud stack found — deploy it once: cd infra && npm install && npx cdk deploy" };
  }
  const outputs = Object.fromEntries(
    (JSON.parse(r.out) as Array<{ OutputKey: string; OutputValue: string }>)
      .map((o) => [o.OutputKey, o.OutputValue]),
  );
  const cfg: CloudConfig = {
    stateBucket: outputs.StateBucket ?? "",
    clusterArn: outputs.ClusterArn ?? "",
    taskDefinitionArn: outputs.TaskDefinitionArn ?? "",
    subnetIds: (outputs.SubnetIds ?? "").split(",").filter(Boolean),
    securityGroupId: outputs.SecurityGroupId ?? "",
  };
  if (!cfg.stateBucket || !cfg.clusterArn) return { error: "YeetCloud stack exists but is missing outputs — redeploy infra/" };
  writeFileSync(CACHE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return cfg;
}

const prefix = (cfg: CloudConfig, name: string) => `s3://${cfg.stateBucket}/agents/${name}`;

/** Newest session file, by the same rule the host and guest use everywhere: mtime. */
function newestSession(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let best: { p: string; m: number } | null = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const m = statSync(join(dir, f)).mtimeMs;
    if (!best || m > best.m) best = { p: join(dir, f), m };
  }
  return best?.p ?? null;
}

/**
 * Push an agent's must-move set to S3. Returns what was shipped, for honest reporting —
 * a sync that cannot say what it synced is a sync nobody trusts.
 */
export function push(cfg: CloudConfig, agent: store.Agent): { ok: boolean; detail: string } {
  const dir = store.agentDir(agent.name);
  const ws = store.workspaceDir(agent.name);
  const p = prefix(cfg, agent.name);

  const bundle = join(dir, ".sync-workspace.bundle");
  const b = Bun.spawnSync(["git", "-C", ws, "bundle", "create", bundle, "--all"]);
  if (b.exitCode !== 0) return { ok: false, detail: `bundle failed: ${b.stderr.toString().trim().slice(0, 200)}` };

  const steps: Array<[string, string[]]> = [
    ["agent.json", ["s3", "cp", join(dir, "agent.json"), `${p}/agent.json`]],
    ["events.jsonl", ["s3", "cp", join(dir, "events.jsonl"), `${p}/events.jsonl`]],
    ["workspace.bundle", ["s3", "cp", bundle, `${p}/workspace.bundle`]],
  ];
  const sess = newestSession(join(dir, "session"));
  if (sess) steps.push(["session", ["s3", "cp", sess, `${p}/session/${sess.split("/").pop()}`]]);

  const shipped: string[] = [];
  for (const [label, args] of steps) {
    const r = run([...args, "--only-show-errors"]);
    if (!r.ok) return { ok: false, detail: `${label}: ${r.err.split("\n")[0]}` };
    shipped.push(label);
  }
  const size = statSync(bundle).size;
  return { ok: true, detail: `${shipped.join(", ")} (bundle ${size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`})` };
}

/** Pull the cloud's version of an agent's state down. The workspace updates via git fetch
 *  from the bundle — history is merged, never overwritten, so a stale pull cannot destroy
 *  local commits. */
export function pull(cfg: CloudConfig, agent: store.Agent): { ok: boolean; detail: string } {
  const dir = store.agentDir(agent.name);
  const ws = store.workspaceDir(agent.name);
  const p = prefix(cfg, agent.name);

  const bundle = join(dir, ".sync-workspace.bundle");
  const steps: Array<[string, string[]]> = [
    ["workspace.bundle", ["s3", "cp", `${p}/workspace.bundle`, bundle]],
    ["session", ["s3", "sync", `${p}/session/`, join(dir, "session/")]],
  ];
  const got: string[] = [];
  for (const [label, args] of steps) {
    const r = run([...args, "--only-show-errors"]);
    if (r.ok) got.push(label);
    else if (label === "workspace.bundle") return { ok: false, detail: `nothing in the cloud for ${agent.name} (${r.err.split("\n")[0]})` };
  }
  // Fetch, don't clobber: bundle refs land under refs/yeet-cloud/* and fast-forward the
  // agent branch only when that is what it is.
  const f = Bun.spawnSync(["git", "-C", ws, "fetch", bundle, `refs/heads/*:refs/yeet-cloud/*`]);
  if (f.exitCode !== 0) return { ok: false, detail: `fetch from bundle failed: ${f.stderr.toString().trim().slice(0, 200)}` };
  const ff = Bun.spawnSync(["git", "-C", ws, "merge", "--ff-only", `refs/yeet-cloud/${agent.branch}`]);
  const applied = ff.exitCode === 0 ? "fast-forwarded" : "fetched (diverged — resolve with merge)";
  return { ok: true, detail: `${got.join(", ")} · ${applied}` };
}

/** Launch one cloud run. The task syncs back and exits on its own — completion IS shutdown. */
export function launch(cfg: CloudConfig, agent: store.Agent, task: string, model?: string): { ok: boolean; taskArn?: string; detail: string } {
  const overrides = JSON.stringify({
    containerOverrides: [{
      name: "runner",
      environment: [
        { name: "YEET_AGENT", value: agent.name },
        { name: "YEET_TASK", value: task },
        { name: "YEET_MODEL", value: model ?? agent.model },
      ],
    }],
  });
  const net = JSON.stringify({
    awsvpcConfiguration: {
      subnets: cfg.subnetIds,
      securityGroups: [cfg.securityGroupId],
      assignPublicIp: "ENABLED",
    },
  });
  const r = run(["ecs", "run-task",
    "--cluster", cfg.clusterArn,
    "--task-definition", cfg.taskDefinitionArn,
    "--launch-type", "FARGATE",
    "--network-configuration", net,
    "--overrides", overrides,
    "--query", "tasks[0].taskArn", "--output", "text"]);
  if (!r.ok || !r.out || r.out === "None") return { ok: false, detail: r.err.split("\n")[0] || "run-task returned no task" };
  writeFileSync(join(store.agentDir(agent.name), "cloud.json"),
    JSON.stringify({ taskArn: r.out, at: new Date().toISOString() }) + "\n");
  return { ok: true, taskArn: r.out, detail: r.out };
}

function lastTaskArn(name: string): string | null {
  const p = join(store.agentDir(name), "cloud.json");
  if (!existsSync(p)) return null;
  try { return (JSON.parse(readFileSync(p, "utf8")) as { taskArn?: string }).taskArn ?? null; } catch { return null; }
}

export function stop(cfg: CloudConfig, name: string): { ok: boolean; detail: string } {
  const arn = lastTaskArn(name);
  if (!arn) return { ok: false, detail: `no recorded cloud task for ${name}` };
  const r = run(["ecs", "stop-task", "--cluster", cfg.clusterArn, "--task", arn,
    "--reason", "yeet cloud stop", "--query", "task.lastStatus", "--output", "text"]);
  return r.ok ? { ok: true, detail: `stopping ${arn.split("/").pop()}` } : { ok: false, detail: r.err.split("\n")[0] };
}

export function status(cfg: CloudConfig, name: string): { ok: boolean; detail: string } {
  const arn = lastTaskArn(name);
  if (!arn) return { ok: false, detail: `no recorded cloud task for ${name}` };
  const r = run(["ecs", "describe-tasks", "--cluster", cfg.clusterArn, "--tasks", arn,
    "--query", "tasks[0].{s:lastStatus,r:stoppedReason,c:containers[0].exitCode}", "--output", "json"]);
  if (!r.ok) return { ok: false, detail: r.err.split("\n")[0] };
  const t = JSON.parse(r.out || "{}") as { s?: string; r?: string; c?: number };
  const bits = [t.s ?? "UNKNOWN"];
  if (t.c != null) bits.push(`exit ${t.c}`);
  if (t.r) bits.push(t.r);
  return { ok: true, detail: bits.join(" · ") };
}
