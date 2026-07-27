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
 *
 * Three voices (yeet config voice): the default above, `professional` for screen-shares, and
 * `dad-jokes`. They differ in tone only — every one of them reports the same outcome.
 */
import type { Voice } from "./config";

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

/**
 * The agent writes its summary as markdown and reaches for headings and bullets even when told
 * not to. Strip the scaffolding so the wrap-up reads as prose in yeet's register rather than a
 * document pasted into a terminal.
 */
export function plainText(md: string, max: number): string {
  const flat = md
    // Whole heading LINES, not just the hashes — stripping only the marker left "# Summary"
    // rendering as a stray "Summary" word glued to the first sentence.
    .replace(/^#+\s*.*$/gm, "")
    .replace(/^[-*]\s+/gm, "") // bullets
    .replace(/[*_`]/g, "")     // emphasis and code marks
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  // Cut at a sentence end where possible; a summary that stops mid-clause reads like a bug.
  const cut = flat.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.trimEnd() + "…";
}

export type Lines = {
  passed: string;
  failed: (provider: string) => string;
  stalled: string;
  capped: string;
  unverified: string;
  stallKilled: (detail?: string) => string;
  alreadyGreen: string;
  verifyBroken: (cmd: string) => string;
  flaky: string;
  /** One dry line for how an agent ended, for the top of `yeet ask`. Deliberately not the
   *  run-end lines above — those are written for the moment a run finishes ("we did it!"),
   *  which reads as strange when you are looking something up three days later. */
  state: (state: string, model: string) => string;
};

/**
 * The three voices say the same facts. None of them may add, soften, or invent an outcome —
 * a tone setting that changes what you believe happened is a bug, not a personality.
 */
const VOICE_LINES: Record<Voice, Lines> = {
  /** Verbatim from the spec's author, lightly punctuated. */
  default: {
    passed: "Hey, we did it! We finished an agent. I mean, I finished an agent while you watched, which is cool.",
    failed: (provider) =>
      `Oops, so some bad news. This didn't go well, at all. I'd say it was your fault, but let's be honest — this is ${provider}'s fault.`,
    stalled: "I'm calling it — I kept trying and nothing new was happening. Sometimes you have to know when to walk away.",
    capped: "I hit the budget you gave me, so I stopped before this got expensive. Everything done so far is saved.",
    unverified: "I built something, but I never ended up with a way to prove it works. Treat it like an unsigned check.",
    stallKilled: (detail) =>
      `It went quiet in there and stayed quiet, so I pulled the plug. Not mad, just disappointed.${detail ? ` (${detail})` : ""}`,
    alreadyGreen: "Everything already passes. There was literally nothing to do. Great meeting.",
    verifyBroken: (cmd) => `The check command (\`${cmd}\`) doesn't even run. I'm not spending your money until that's fixed.`,
    flaky: "It passed, then it didn't pass when I checked again. That's called flaky, and flaky doesn't ship.",
    state: (state, model) => {
      switch (state) {
        case "passed": return "it works, and the tests agree.";
        case "running": return "still going.";
        case "stalled": return "it got stuck and I stopped it.";
        case "capped": return "it ran out of budget before finishing.";
        case "unverified": return "it built something, but nothing proves it works.";
        case "failed": return `it fell over. ${blameProvider(model)}'s model, not you.`;
        default: return state;
      }
    },
  },

  /** For screen-shares and people who did not sign up for a personality. */
  professional: {
    passed: "Done. The work is complete and the tests pass.",
    failed: (provider) => `The run failed. The model (${provider}) could not complete the work.`,
    stalled: "Stopped: repeated rounds produced no new progress.",
    capped: "Stopped at the budget limit. All completed work has been saved.",
    unverified: "The work was built, but no check was ever registered to prove it correct.",
    stallKilled: (detail) => `Stopped: the run produced no output for an extended period.${detail ? ` (${detail})` : ""}`,
    alreadyGreen: "All checks already pass. No changes were needed.",
    verifyBroken: (cmd) => `The check command (\`${cmd}\`) does not run. Stopping before spending tokens.`,
    flaky: "The checks passed, then failed on a re-run. The result is not reproducible.",
    state: (state, model) => {
      switch (state) {
        case "passed": return "complete; tests pass.";
        case "running": return "in progress.";
        case "stalled": return "stopped after no further progress.";
        case "capped": return "stopped at the budget limit.";
        case "unverified": return "built, but unproven — no check was registered.";
        case "failed": return `failed (model: ${blameProvider(model)}).`;
        default: return state;
      }
    },
  },

  "dad-jokes": {
    passed: "Nailed it. And I didn't even need a hammer — I'm a soft-ware guy.",
    failed: (provider) => `Well, that went about as well as a screen door on a submarine. Not my fault — that one's on ${provider}.`,
    stalled: "I kept going in circles. At this point I'm just a-round to nothing.",
    capped: "I hit the budget. I'd keep going, but I'm a bit short on cents. Everything so far is saved.",
    unverified: "I built it, but there's no test to prove it. Trust me, I'm an engineer — which is exactly what you shouldn't do.",
    stallKilled: (detail) => `It went dead quiet in there. I pulled the plug — you could say I ended the process.${detail ? ` (${detail})` : ""}`,
    alreadyGreen: "Already passing. I came, I saw, I did absolutely nothing. Veni, vidi, vacancy.",
    verifyBroken: (cmd) => `The check command (\`${cmd}\`) won't even start. That's a hard no — or should I say, a hard NaN.`,
    flaky: "Passed, then failed. That's not a test, that's a coin flip with extra steps.",
    state: (state, model) => {
      switch (state) {
        case "passed": return "it works. Tested and a-proved.";
        case "running": return "still cooking.";
        case "stalled": return "it got stuck. Happens to the best of us, and to this one.";
        case "capped": return "it ran out of budget. Cost it everything.";
        case "unverified": return "it built something. Whether it works is anyone's guess, including mine.";
        case "failed": return `it fell over. ${blameProvider(model)}'s model — I'd point fingers, but I don't have any.`;
        default: return state;
      }
    },
  },
};

export const lines = (voice: Voice = "default"): Lines => VOICE_LINES[voice] ?? VOICE_LINES.default;
