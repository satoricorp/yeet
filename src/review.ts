/**
 * review.ts — run `gx review` over an agent's result.
 *
 * REPORTED, NOT GATING — and the reason is a real defect worth stating plainly.
 *
 * `gx review` reads the WORKING TREE (`git status --short`, internal/codereview/review.go:588).
 * It has no commit-range option, and it always exits 0 (internal/cli/root.go:2440 — findings
 * never influence the return). A yeet workspace is a clean clone whose work is already
 * committed, so pointing gx review at it directly yields zero changed files and the cheerful
 * "No material issues found in this change." — a silent false pass, which is strictly worse
 * than no gate at all.
 *
 * So we do what gx review's own constraints force: materialize the committed range as
 * uncommitted working-tree state in a throwaway clone, review that, and report the findings
 * without pretending they gate anything. Wiring this as a real gate needs the gx changes in
 * the plan: --range, --json, --fail-on, --no-publish, and treating an empty change set as a
 * distinct status rather than a pass.
 *
 * We also run it on a THROWAWAY clone rather than the agent's workspace because gx review is
 * not read-only: shouldSkipAutoInit (autoinit.go:49) does not exempt `review`, so it installs
 * git hooks into whatever repo it runs in.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "./agent";

const has = (bin: string) => Bun.spawnSync(["which", bin]).exitCode === 0;

export async function reviewWorkspace(agent: store.Agent): Promise<void> {
  console.log(`\n\x1b[36m▪\x1b[0m gx review \x1b[2m(reported, not gating — see review.ts)\x1b[0m`);

  if (!has("gx")) {
    console.log("  \x1b[33mskipped\x1b[0m — gx not on PATH");
    return;
  }
  const ws = join(store.agentDir(agent.name), "workspace");
  const base = agent.baseHead;
  if (!base || !existsSync(ws)) {
    console.log("  \x1b[33mskipped\x1b[0m — no base commit to diff against");
    return;
  }

  const head = Bun.spawnSync(["git", "-C", ws, "rev-parse", "HEAD"]).stdout.toString().trim();
  if (head === base) {
    console.log("  \x1b[2mnothing to review — the agent produced no commits\x1b[0m");
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), "yeet-review-"));
  try {
    const clone = Bun.spawnSync(["git", "clone", "--quiet", "--local", "--no-hardlinks", ws, scratch]);
    if (clone.exitCode !== 0) {
      console.log(`  \x1b[33mskipped\x1b[0m — clone failed: ${clone.stderr.toString().trim()}`);
      return;
    }
    Bun.spawnSync(["git", "-C", scratch, "checkout", "--quiet", base]);
    // Range -> dirty working tree, which is the only shape gx review can currently see.
    const diff = Bun.spawnSync(["git", "-C", scratch, "diff", `${base}..${head}`]);
    const apply = Bun.spawnSync(["git", "-C", scratch, "apply", "--whitespace=nowarn"], {
      stdin: new Blob([diff.stdout]),
    });
    if (apply.exitCode !== 0) {
      console.log(`  \x1b[33mskipped\x1b[0m — could not materialize the range: ${apply.stderr.toString().trim()}`);
      return;
    }

    const r = Bun.spawnSync(["gx", "review"], {
      cwd: scratch,
      env: { ...process.env, GX_PLAIN_PROMPTS: "1", NO_COLOR: "1" },
    });
    const out = r.stdout.toString().trim();
    if (!out) {
      console.log(`  \x1b[33mno output\x1b[0m (exit ${r.exitCode}) — ${r.stderr.toString().trim().slice(0, 200)}`);
      return;
    }
    const findings = (out.match(/^### \d+\./gm) ?? []).length;
    console.log(`  ${findings} finding${findings === 1 ? "" : "s"} \x1b[2m(gx review always exits 0; count is parsed from headings)\x1b[0m`);
    for (const line of out.split("\n").slice(0, 40)) console.log(`  \x1b[2m│\x1b[0m ${line}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
