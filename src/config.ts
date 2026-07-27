/**
 * config.ts — global settings at $YEET_HOME/config.json.
 *
 * Two audiences, two levels: global config is about the HUMAN (do they want dev detail, which
 * tone, which model, how much they are willing to spend); per-agent settings (origin, verify
 * command, model override) live in the agent's own agent.json, because they describe the work,
 * not the person. Where both exist, the agent's answer wins — you set a global default once
 * and correct it on the one agent that needs correcting.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YEET_HOME } from "./host";

/** Tone of the plain-English rendering. Only has an effect while smarty is off: smarty picks
 *  WHICH facts you see, voice picks how they are said. Machine mode ignores both. */
export type Voice = "default" | "professional" | "dad-jokes";

export const VOICES: Voice[] = ["default", "professional", "dad-jokes"];

export type GlobalConfig = {
  /** Developer detail by default. Flag --smarty overrides per run. */
  smarty?: boolean;
  /** Default model for new agents. */
  model?: string;
  /** Tone. Defaults to "default". */
  voice?: Voice;
  /** Spend ceiling for ONE invocation, enforced live during an iteration rather than only
   *  between them. Per-run, not lifetime: each `yeet --name <n> "…"` gets this much. */
  maxCostUsd?: number;
  /** Branch a merge aims at. */
  target?: string;
  /** How many times the agent may try before yeet calls it. */
  maxIterations?: number;
  /** Git URL or path new agents start with, so the common case (one repo you always push to)
   *  does not need setting per agent. Per-agent `config --name <n> origin` still wins. */
  origin?: string;
};

const PATH = join(YEET_HOME, "config.json");

export function loadConfig(): GlobalConfig {
  if (!existsSync(PATH)) return {};
  try {
    return JSON.parse(readFileSync(PATH, "utf8")) as GlobalConfig;
  } catch {
    return {}; // a corrupt config file should degrade to defaults, not brick the CLI
  }
}

export function saveConfig(cfg: GlobalConfig): void {
  writeFileSync(PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

export const DEFAULT_MODEL = "openrouter/z-ai/glm-5.2";
