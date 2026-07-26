/**
 * config.ts — global settings at $YEET_HOME/config.json.
 *
 * Two audiences, two levels: global config is about the HUMAN (do they want dev detail, which
 * model by default); per-agent settings (origin, verify command, model override) live in the
 * agent's own agent.json, because they describe the work, not the person.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YEET_HOME } from "./host";

export type GlobalConfig = {
  /** Developer detail by default. Flag --smarty overrides per run. */
  smarty?: boolean;
  /** Default model for new agents. */
  model?: string;
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
