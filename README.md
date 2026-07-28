# yeet

**Coding agents that loop until the work is verified — not until the agent stops talking.**

Most agents stop when they run out of things to say. yeet stops when the tests pass, twice, in a
clean machine. Every iteration runs in its own disposable microVM, so an agent can install
anything, break anything, and delete anything without touching your laptop. It writes its own
tests, registers how its work gets proven, and keeps going until the checks are green, progress
stalls, or it hits the budget you set.

You get a branch you can merge, a number for what it cost, and an honest answer about whether it
actually works.

## Install

macOS on Apple Silicon, with [Homebrew](https://brew.sh) and [Bun](https://bun.sh).

```bash
brew tap slp/krun                         # libkrun is not in homebrew-core
brew install libkrun libkrunfw
git clone git@github.com:satoricorp/yeet.git && cd yeet
ln -s "$PWD/bin/yeet" "$(brew --prefix)/bin/yeet"
guest/setup.sh                            # builds the guest image — ~5 min, 563 MB
bun test/roundtrip.ts                     # proves the machine works, no API key needed
```

`bun` is not optional — `bin/yeet` execs it. Any directory on your `PATH` works for the symlink;
Homebrew's is used above only because you have just proven it exists.

Then give it a key. The agent inside the VM is [pi](https://github.com/badlogic/pi-mono), and it
needs an API-key provider — OpenRouter, OpenAI, Groq, and so on. Anthropic via OAuth cannot be
bridged into a VM.

```bash
yeet config key openrouter   # prompts; never echoed, never an argument, stored 0600
```

## Your first agent

```bash
yeet "build me a CLI that counts words from stdin"
```

It asks a couple of questions, builds in an isolated workspace, writes tests, runs them, and
re-runs them in a fresh VM to be sure. About a minute and a few cents later:

```
Hey, we did it! We finished an agent. I mean, I finished an agent while you watched,
which is cool.

  wc-implicit is a small CLI that reads stdin and prints a word count. Pass --words,
  --lines, --chars, or --bytes to choose which units to report, in any combination.
  Run it with echo 'some words here' | bun run src/index.ts

  took     1 round, about 7 cents
  branch   yeet/wc-implicit
  covered  66.7% of the code

next
  yeet --name wc-implicit test   run its checks and show the output
  yeet --name wc-implicit "…"    keep building
```

That summary is the agent's own, written for a human — and the coverage number is real, which is
why it says 66.7% rather than something flattering.

Nothing was written to your repos — the agent starts in a blank workspace and has never seen
them. Point it at one when you're ready:

```bash
yeet config --name wc-app origin git@github.com:you/yours.git
yeet --name wc-app merge
```

## The CLI

Every command takes `--name <n>` to say which agent. Omit it only where noted.

### Running work

| | |
|---|---|
| `yeet "<task>"` | start a new agent; the name is derived from the task |
| `yeet --name <n> "<task>"` | give an existing agent more work — same session, workspace and branch |
| `yeet --name <n> test` | run its checks and show the raw output |
| `yeet --name <n> merge` | merge its branch into your main branch, verified in a sandbox first |
| `yeet --name <n> push` | push its branch to origin |
| `yeet --name <n> --rename <new>` | rename it |
| `yeet rm --name <n>` | delete it (`remove` also works) |

### Finding things out

| | |
|---|---|
| `yeet ls` | every agent and how it went |
| `yeet ask "<question>"` | search every agent on this machine. Free, offline, no VM |
| `yeet ask --name <n>` | what that one did. Free |
| `yeet ask --name <n> "<question>"` | ask the agent itself, in a sandbox. A few cents |
| `yeet help [ls\|ask\|config\|rm]` | per-command help |

Only the last of those spends money. A forgotten `--name` can never turn into a paid fan-out.

### Settings

`yeet config` alone shows yours. With `--name <n>` it shows one agent's. Where a setting exists
in both, the agent's answer wins.

| yours | |
|---|---|
| `voice default\|professional\|dad-jokes` | how yeet talks. All three report the same facts |
| `smarty on\|off` | the developer trace everywhere, not just with `--smarty` |
| `model <provider/model>` | which model new agents use |
| `budget <dollars>` | spend ceiling for one run |
| `rounds <n>` | how many tries before yeet calls it |
| `origin <url>` | repo new agents start from |
| `key <provider>` | store an API key — prompts, never echoes |
| `keys` | which keys are set, and where |

| one agent's | |
|---|---|
| `origin <url>` | connect a repo. Imports it as the base if nothing is built yet, and unlocks push |
| `test "<cmd>"` | how the work gets proven. Overrides what the agent registered |
| `coverage "<cmd>"` | must leave an lcov file behind · `none` to clear |
| `model <provider/model>` | just this agent |

### Flags

| | |
|---|---|
| `--name <n>` | which agent. On a new one, this names it |
| `--model <provider/model>` | override the model for this run |
| `--max-cost <usd>` | spend ceiling for this run |
| `--max-iter <n>` | rounds for this run |
| `--smarty` | the trace: tool calls, exit codes, tokens, latency |
| `--yes` | don't wait for answers — take the agent's recommendations |
| `--agent` | machine mode: NDJSON on stdout, nothing else (`--json` is the same) |
| `--review` | run `gx review` over the workspace afterwards |

### Exit codes

`0` passed · `1` usage or infrastructure · `2` stalled · `3` hit a cap · `4` failed ·
`5` unverified

`--agent` gives you those plus NDJSON and auto-accepts every recommendation, so other programs
can drive yeet.

## How it works

**A microVM per iteration.** Each round runs in its own [libkrun](https://github.com/containers/libkrun)
guest. Boot is ~360 ms and the image clones in ~110 ms via APFS copy-on-write (~4 MB of real
disk), so isolation costs about 1% of an LLM iteration. Every round starts from an identical
known machine, and a runaway process cannot poison the next one. The VM is genuinely disposable:
the workspace *is* a host directory shared over virtio-fs, and the agent's transcript sits beside
it, so the conversation resumes across a boot boundary.

**Isolation is the default and the only starting state.** A new agent gets a blank git workspace
that has never seen your repos. The outside world arrives only through config, and `push` runs
from the *host* — the guest never has a remote, so nothing inside a VM can reach anything you own.

**The agent registers how it will be judged.** A `set_verify` tool call binds the command that
proves the work, plus test-file globs and a coverage command. You confirm or edit it, and it
takes effect in the same iteration. There is no `--test` flag: a run that never gets a verifier
ends `unverified`, loudly.

**Green has to be earned twice.** A passing verify triggers a confirm run in a fresh VM, because
flakes don't ship. Pre-existing test files are fingerprinted at base, so a pass that edited them
gets flagged rather than celebrated. After a confirmed pass, a coverage run reports how much of
the code the tests actually exercise.

**Questions are a tool call, not a prompt.** The agent can stop and ask you something mid-build.
Enter accepts its recommendation; `--yes` and `--agent` accept automatically.

**The controller owns liveness.** There are no timeouts inside the guest. The host watches the
shared mount for signs of life and escalates on its own judgment — first a STOP file the runner
honours gracefully (partial work is committed, verified and reported), then killing the VM only
if that is ignored. A question waiting on a human pauses the clock. The cost cap works the same
way: enforced live, mid-iteration, not just between rounds.

**Merging detects before it touches anything.** `git merge-tree` performs a full three-way merge
against the object store, so a conflicted merge costs nothing and leaves no half-merged worktree.
A clean merge is then verified in a sandbox before publishing, because two changes can merge
without one conflicting line and still break each other.

**Three renderings, one set of facts.** Plain English by default, `--smarty` for the developer
trace, `--agent` for NDJSON. The personality is defined in [VOICE.md](VOICE.md) and never appears
in machine mode.

## Layout

```
guest/launcher/      yeet-vm.c — the libkrun launcher (C, codesigned)
guest/setup.sh       builds the guest image
guest/yeet-run       one iteration, in-guest; staged per run, not baked into the image
guest/yeet-tools.ts  pi extension: ask_user + set_verify
src/                 the host orchestrator (Bun/TypeScript)
  bridge.ts          relays questions, enforces budget, decides liveness
  trace.ts           reconstructs what the agent did, from the event stream
  merge.ts           detect-before-touch merging
  search.ts          lexical search across agents
test/roundtrip.ts    proves the whole machine except the LLM — no tokens spent
```

Runtime state lives in `$YEET_HOME` (default `~/.yeet`), never in this repo.

## Three constraints worth knowing

Each was measured, and each broke something before it was understood.

- **`DYLD_LIBRARY_PATH` is required.** libkrun `dlopen`s `libkrunfw` *by leaf name at runtime*,
  so it never appears in `otool -L` and `-rpath` cannot reach it.
- **Never pass free text through guest argv.** libkrun's argv transport corrupts any argument
  containing both `"` and `$`, splitting it at internal spaces. Files and env values are
  unaffected — which is why prompts, commands, questions and answers all cross as files.
- **The guest must do the git commit.** virtio-fs stores guest file modes in a
  `user.containers.override_stat` xattr, so host-visible modes are wrong and a host-side commit
  would silently drop exec bits. For the same reason the image is duplicated with `clonefile(2)`,
  never `cp -R`/rsync/tar (which destroy xattrs) or `cp -c` (which silently falls back to a full
  copy).

## Status

The loop, the sandbox, session resume, live budget enforcement, interactive questions,
agent-registered verification, frozen-test fingerprinting, coverage, merging and cross-agent
search all work end to end.

Honest gaps: coverage is reported but not yet gated, and a suite the agent wrote for itself only
proves what the agent chose to prove. Read `yeet ask --name <n>` before trusting a green you care
about.
