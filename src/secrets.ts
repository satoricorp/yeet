/**
 * secrets.ts — provider API keys, stored somewhere better than a JSON file.
 *
 * Three rules, and each exists because breaking it is silent:
 *
 *   1. The value never reaches argv. `ps` is world-readable on macOS, so a key passed as a
 *      command-line argument is visible to every process on the machine for the lifetime of
 *      the call. macOS `security` normally takes the password as an argument; we drive it
 *      through `security -i` instead, which reads its command line from STDIN.
 *   2. The value never reaches the terminal. Typing a key at a normal prompt puts it in the
 *      scrollback and, worse, in shell history if it was ever an argument. The prompt below
 *      runs the tty in raw mode and echoes nothing.
 *   3. The value never reaches the event log or the session transcript. `list` returns names
 *      only, and nothing here is ever passed to record().
 *
 * On macOS the store is the Keychain, which gives at-rest encryption with no key management
 * for us to invent badly. Elsewhere it falls back to a 0600 file, which is honest about being
 * weaker rather than pretending otherwise.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YEET_HOME } from "./host";

const SERVICE = "yeet";
const FALLBACK = join(YEET_HOME, "keys.json");
const darwin = process.platform === "darwin";

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

// ── keychain ──────────────────────────────────────────────────────────────────────────────

/** `security -i` reads its command line from stdin, which is the only way to hand it a
 *  password without that password appearing in argv. */
function keychainSet(provider: string, value: string): boolean {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const r = Bun.spawnSync(["security", "-i"], {
    stdin: new Blob([`add-generic-password -U -s ${SERVICE} -a ${provider} -w "${escaped}"\n`]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return r.exitCode === 0;
}

function keychainGet(provider: string): string | null {
  const r = Bun.spawnSync(["security", "find-generic-password", "-s", SERVICE, "-a", provider, "-w"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) return null;
  const v = r.stdout.toString().trim();
  return v || null;
}

function keychainDelete(provider: string): boolean {
  const r = Bun.spawnSync(["security", "delete-generic-password", "-s", SERVICE, "-a", provider], {
    stdout: "pipe", stderr: "pipe",
  });
  return r.exitCode === 0;
}

// ── file fallback ─────────────────────────────────────────────────────────────────────────

function fileAll(): Record<string, string> {
  if (!existsSync(FALLBACK)) return {};
  try {
    return JSON.parse(readFileSync(FALLBACK, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function fileWrite(all: Record<string, string>): void {
  mkdirSync(YEET_HOME, { recursive: true });
  writeFileSync(FALLBACK, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  chmodSync(FALLBACK, 0o600); // in case the file already existed with looser bits
}

// ── the store ─────────────────────────────────────────────────────────────────────────────

export type Store = "keychain" | "file";
export const storeKind: Store = darwin ? "keychain" : "file";

export function setKey(provider: string, value: string): Store {
  if (darwin && keychainSet(provider, value)) return "keychain";
  const all = fileAll();
  all[provider] = value;
  fileWrite(all);
  return "file";
}

export function getKey(provider: string): string | null {
  if (darwin) {
    const v = keychainGet(provider);
    if (v) return v;
  }
  return fileAll()[provider] ?? null;
}

export function deleteKey(provider: string): boolean {
  const inFile = fileAll();
  let removed = false;
  if (provider in inFile) {
    delete inFile[provider];
    fileWrite(inFile);
    removed = true;
  }
  if (darwin && keychainDelete(provider)) removed = true;
  return removed;
}

/** Names only. Returning values here is how a `list` ends up in someone's scrollback. */
export function listKeys(): Array<{ provider: string; where: Store }> {
  const out: Array<{ provider: string; where: Store }> = [];
  for (const p of KNOWN_PROVIDERS) {
    if (darwin && keychainGet(p)) out.push({ provider: p, where: "keychain" });
    else if (fileAll()[p]) out.push({ provider: p, where: "file" });
  }
  return out;
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
