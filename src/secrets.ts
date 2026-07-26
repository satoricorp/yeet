/**
 * secrets.ts — provider API keys.
 *
 * ONE mechanism on every platform: a 0600 file inside the 0700 $YEET_HOME. The macOS Keychain
 * is genuinely better at rest, but yeet has to run the same way on Linux and Windows, and a
 * store whose location and guarantees change per platform means "where is my key" has three
 * answers and a support burden to match. Linux keyrings in particular are fragmented
 * (libsecret, gnome-keyring, KWallet) and simply absent on most servers, which is exactly
 * where an agent runner ends up.
 *
 * Be honest about what 0600 buys: it stops other users on a shared machine, and nothing else.
 * It is not encrypted at rest, so anything that can read your home directory as you can read
 * it too. That is the same bargain as ~/.aws/credentials, ~/.npmrc, gh and docker — familiar,
 * and not pretending. Encrypting with a key stored beside the ciphertext would look better
 * and protect nothing.
 *
 * What the file DOES buy is the three properties below, each of which fails silently if
 * skipped:
 *
 *   1. The value never reaches argv. `ps` is world-readable, so a key passed as a command-line
 *      argument is visible to every process on the machine — and lands in shell history, where
 *      deleting it later does not help.
 *   2. The value never reaches the terminal. The prompt runs the tty in raw mode and echoes
 *      nothing; readline was not an option because it keeps a history buffer.
 *   3. The value never reaches the event log or the session transcript. `list` returns names
 *      only, and nothing here is ever passed to record().
 *
 * If real at-rest encryption is wanted later, it goes behind setKey/getKey without touching
 * anything above — but it needs a passphrase or an OS keyring, not a derived-from-nothing key.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YEET_HOME } from "./host";

const KEYS = join(YEET_HOME, "keys.json");

/** Providers yeet knows how to bridge, and the env var each one's SDK expects. */
export const PROVIDER_ENV: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

export const KNOWN_PROVIDERS = Object.keys(PROVIDER_ENV);

// ── the file ─────────────────────────────────────────────────────────────────────────

function readAll(): Record<string, string> {
  if (!existsSync(KEYS)) return {};
  try {
    return JSON.parse(readFileSync(KEYS, "utf8")) as Record<string, string>;
  } catch {
    return {}; // a corrupt keys file degrades to "no keys", never to a crash mid-run
  }
}

function writeAll(all: Record<string, string>): void {
  mkdirSync(YEET_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(KEYS, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  // mode: on writeFileSync only applies when CREATING. An existing file keeps whatever bits it
  // had, so a file that was ever world-readable would stay that way silently.
  chmodSync(KEYS, 0o600);
}

// ── the store ─────────────────────────────────────────────────────────────────────────────

export const KEYS_PATH = KEYS;

export function setKey(provider: string, value: string): void {
  const all = readAll();
  all[provider] = value;
  writeAll(all);
}

export function getKey(provider: string): string | null {
  return readAll()[provider] ?? null;
}

export function deleteKey(provider: string): boolean {
  const all = readAll();
  if (!(provider in all)) return false;
  delete all[provider];
  writeAll(all);
  return true;
}

/** Names only. Returning values here is how a `list` ends up in someone's scrollback. */
export function listKeys(): string[] {
  const all = readAll();
  return KNOWN_PROVIDERS.filter((p) => all[p]);
}

// ── input ─────────────────────────────────────────────────────────────────────────────────

/**
 * Read a secret with no echo. Raw mode rather than readline, because readline keeps a history
 * buffer and echoes by default — either one puts the key somewhere it outlives the prompt.
 */
export async function hiddenPrompt(label: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error("no terminal to read a secret from — run this interactively");

  process.stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();

  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      fn();
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return done(() => reject(new Error("cancelled")));  // ctrl-c
        if (byte === 13 || byte === 10) return done(() => resolve(buf));    // enter
        if (byte === 127 || byte === 8) { buf = buf.slice(0, -1); continue; } // backspace
        if (byte >= 32) buf += String.fromCharCode(byte);
      }
    };
    stdin.on("data", onData);
  });
}

/** Never print a key. When one has to be acknowledged, acknowledge its shape. */
export function fingerprint(value: string): string {
  if (value.length <= 8) return `${value.length} chars`;
  return `${value.slice(0, 3)}…${value.slice(-4)} (${value.length} chars)`;
}
