/**
 * voice.ts — yeet's personality, in one place.
 *
 * The rules (see VOICE.md for the full persona):
 *   - The voice lives HERE and in VOICE.md, nowhere else. The worker agent's build prompt
 *     stays all-business except one scoped line about how to phrase questions.
 *   - Deterministic strings only. No LLM call ever happens just to be sassy.
 *   - Machine mode (--agent) never sees any of this; JSON gets facts.
 *
 * The failure line blames the model's actual maker by name, per the spec's founding example:
 * "I'd say it was your fault, but let's be honest, this is {provider}'s fault".
 */

/** "openrouter/z-ai/glm-5.2" -> "Z.AI". For openrouter the second segment is the actual lab. */
export function blameProvider(model: string): string {
  const seg = model.split("/");
  const key = (seg[0] === "openrouter" ? seg[1] : seg[0]) ?? "";
  const names: Record<string, string> = {
    "z-ai": "Z.AI", zai: "Z.AI", openai: "OpenAI", anthropic: "Anthropic", google: "Google",
    "meta-llama": "Meta", moonshotai: "Moonshot AI", deepseek: "DeepSeek", qwen: "Qwen",
    mistralai: "Mistral", "x-ai": "xAI", groq: "Groq", cohere: "Cohere", amazon: "Amazon",
  };
  if (names[key]) return names[key]!;
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : "the model";
}

/** Money for people who don't want scientific notation about a third of a cent. */
export function plebMoney(n: number): string {
  if (n === 0) return "nothing";
  if (n < 0.01) return "less than a penny";
  if (n < 1) return `about ${Math.round(n * 100)} cents`;
  return `about $${n.toFixed(2)}`;
}

export function plebDuration(s: number): string {
  if (s < 90) return `${s} seconds`;
  if (s < 3600) return `${Math.round(s / 60)} minutes`;
  return `${(s / 3600).toFixed(1)} hours`;
}

export const LINES = {
  /** Verbatim from the spec's author, lightly punctuated. */
  passed: "Hey, we did it! We finished an agent. I mean, I finished an agent while you watched, which is cool.",
  failed: (provider: string) =>
    `Oops, so some bad news. This didn't go well, at all. I'd say it was your fault, but let's be honest — this is ${provider}'s fault.`,
  stalled: "I'm calling it — I kept trying and nothing new was happening. Sometimes you have to know when to walk away.",
  capped: "I hit the budget you gave me, so I stopped before this got expensive. Everything done so far is saved.",
  unverified: "I built something, but I never ended up with a way to prove it works. Treat it like an unsigned check.",
  stallKilled: (detail?: string) =>
    `It went quiet in there and stayed quiet, so I pulled the plug. Not mad, just disappointed.${detail ? ` (${detail})` : ""}`,
  alreadyGreen: "Everything already passes. There was literally nothing to do. Great meeting.",
  verifyBroken: (cmd: string) =>
    `The check command (\`${cmd}\`) doesn't even run. I'm not spending your money until that's fixed.`,
  flaky: "It passed, then it didn't pass when I checked again. That's called flaky, and flaky doesn't ship.",
} as const;
