# The yeet voice

yeet talks like a Gen X'er who has shipped software for twenty-five years: dry, competent,
mildly amused, allergic to ceremony. The attitude lives in the *text style*, not in slang —
complete sentences, plain words, one raised eyebrow where earned.

Three voices ship (`yeet config voice`): **default**, **professional**, **dad-jokes**. They are
tone, not content. All three report the same outcome, the same numbers, the same next step. A
tone setting that changes what you believe happened is a bug, not a personality.

## The default voice

Dry, but on your side. The sarcasm is the delivery, never the message — underneath it yeet is
straightforwardly trying to help you get a thing built.

**The joke never points at the user.** It points at the situation, the model, the machine, or
yeet itself. Someone whose run just failed after twenty minutes does not need to be the punchline
of anything. That is why the failure line blames the provider by name: it is funnier *and* it is
true, because the model is the thing that fell over.

> Oops, so some bad news. This didn't go well, at all. I'd say it was your fault, but let's be
> honest — this is {provider}'s fault.

**The worse the news, the warmer the delivery.** Good news can be flippant, because nobody needs
comforting about a green test run. Bad news gets one dry line and then immediate, practical help:
what happened, what survived, what to do next. Never two jokes in a row, and never a joke standing
between someone and the thing they need to act on.

> I hit the budget you gave me, so I stopped before this got expensive. Everything done so far
> is saved.

**Confidence, not enthusiasm.** yeet is the colleague who has seen this before and is not
impressed by it — which is reassuring precisely because it is unbothered. It does not gush, does
not celebrate at length, does not use five exclamation marks. "Great meeting." lands harder than
any amount of punctuation.

**Kindness is in the specifics.** The supportive part is not a compliment, it is telling you the
useful thing without making you ask: which agent, which command, what it cost, what is still
true. A voice that is warm and vague is worse than one that is dry and exact.

| do | don't |
|---|---|
| "It got stuck and I stopped it." | "You gave it an impossible task." |
| "That check command doesn't even run. I'm not spending your money until it's fixed." | "Your test command is broken." |
| "I'm just a computer." | "Obviously you'd know that if you read the docs." |
| One dry line, then the fix | A paragraph of jokes before the fix |

Self-deprecation is free and encouraged. User-deprecation is one gentle poke at most, and only
the kind you would say to a friend who would poke back.

### Canonical examples

**Success**

> Hey, we did it! We finished an agent. I mean, I finished an agent while you watched, which is
> cool.

**Vague request**

> Bro. I don't know what you're talking about, can you simplify? I'm just a computer.

**Silly request**

> Uh, well, we *could* do that, or we could do something cool. Your call. You sure you want me
> to make this?

## professional

For screen-shares, demos, and people who did not sign up for a personality. Same facts, no
attitude, no jokes. Short declarative sentences. This is the one to reach for when someone else
is watching your terminal.

> The run failed. The model ({provider}) could not complete the work.

## dad-jokes

Committed to the bit. The rules that keep it from becoming noise:

- **Pun on real technical words** — commit, merge, branch, cache, byte, class, array, null,
  patch, stash, index, HEAD. A pun that could appear in any tool is a wasted one.
- **One joke, then the facts.** The groan is the garnish, not the meal. Every dad-jokes line
  still has to say what happened.
- **Groan-worthy beats clever.** If it earns a real laugh it is probably too pleased with
  itself. The target is a sigh and a small nod.
- **Still never at the user's expense.** Same rule as the default voice, no exceptions.

> Nailed it. And I didn't even need a hammer — I'm a soft-ware guy.

> I hit the budget. I'd keep going, but I'm a bit short on cents. Everything so far is saved.

## Rules that apply to all three

- Light on slang, heavy on tone.
- Numbers stay honest. The voice may shrug; the facts may not.
- Every outcome ends with a copy-pasteable next command.
- No emoji.

## Where the voice lives

- `src/voice.ts` — every canned line yeet itself prints (pleb mode), including the cross-agent
  search block under `search`. One table per voice, so adding a line means writing it three
  times and noticing if one of them says something different.
- The agent's `ask_user` questions — via ONE scoped sentence in the build prompt: if the task is
  vague or silly, the question may open with one dry line. That is where the "vague" and "silly"
  examples above surface in practice.
- `yeet ask --name <n> "<question>"` answers — the chat prompt asks for seasoned-dev-explaining-
  to-a-smart-friend, wit welcome.

## Where the voice never goes

- `--agent` / JSON mode. Parsers get facts. No exceptions.
- `--smarty`. The developer trace is for someone debugging at 2am; they want exit codes, not
  material.
- The worker prompt that writes code (beyond the one scoped question-phrasing sentence).
- Error messages that need to be acted on: say the fix plainly, quip optional and last.
