/**
 * keys.ts — bridge a provider API key into the guest.
 *
 * pi reads its key from a provider-specific env var. We reuse opencode's stored auth so you
 * don't authenticate a second tool. Only api-key providers can bridge: opencode stores
 * Anthropic as OAuth, and an OAuth token is not something we can hand to a process in a VM.
 *
 * The key never touches argv (world-readable via ps) and never lands in the image. It is
 * written to the per-agent run.env at 0600 inside a 0700 directory, which the guest sources.
 * The spike wrote it 0644 — see the plan's spike-bug list.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getKey, PROVIDER_ENV } from "./secrets";

// PROVIDER_ENV is imported from secrets.ts: two copies of that map would drift the moment a
// provider is added to one of them.

export type BridgedKey = { name: string; value: string; provider: string };

export function bridgeKey(model: string): BridgedKey | null {
  const provider = model.split("/")[0] ?? "";
  const envName = PROVIDER_ENV[provider];
  if (!envName) return null;

  // Precedence, most explicit first: an exported env var is someone deliberately overriding
  // for this shell; yeet's own store is what they configured; opencode's is a convenience so
  // people already set up there do not have to enter anything twice.
  const fromEnv = process.env[envName];
  if (fromEnv) return { name: envName, value: fromEnv, provider };

  const stored = getKey(provider);
  if (stored) return { name: envName, value: stored, provider };

  const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
  if (!existsSync(authPath)) return null;
  try {
    const entry = JSON.parse(readFileSync(authPath, "utf8"))[provider];
    if (entry?.type === "api" && entry.key) return { name: envName, value: entry.key, provider };
  } catch {
    /* fall through — a malformed auth store is not fatal, it just means no key */
  }
  return null;
}

export function describeMissingKey(model: string): string {
  const provider = model.split("/")[0] ?? "";
  if (!PROVIDER_ENV[provider]) return `unknown provider "${provider}" in model "${model}"`;
  return (
    `no API key for "${provider}". Either export ${PROVIDER_ENV[provider]}, or add the ` +
    `provider to opencode (note: opencode stores Anthropic as OAuth, which cannot be bridged ` +
    `into a VM — use an api-key provider such as openrouter).`
  );
}
