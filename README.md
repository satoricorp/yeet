# yeet

Coding agents that loop until the work is **verified** — not until the agent stops talking.

Each iteration runs in its own [libkrun](https://github.com/containers/libkrun) microVM on
Apple Silicon. The agent works in an isolated workspace, asks you questions when the task is
ambiguous, registers how its work gets proven, and the loop continues until the checks are
green (twice), progress stalls, or a budget cap is hit.

```bash
yeet "make me a budget tracking app"      # new agent — it asks questions, then builds
yeet budget-tracking-app "add categories" # continue — same session, workspace, branch
yeet ask budget-tracking-app              # the full story of the last run (free)
yeet ask budget-tracking-app "why sqlite?"# talk to the agent about its work
yeet ls                                   # list agents
```

Output defaults to plain English for people who don't read diffstats; `--smarty` (or
`yeet config smarty on`) restores the dense developer view; `--agent` emits NDJSON with real
exit codes (0 passed · 2 stalled · 3 capped · 4 failed · 5 unverified) and auto-accepts every
recommendation, so other programs can drive yeet. The personality — dry, Gen X, one raised
eyebrow — is defined in VOICE.md and never leaks into machine mode.

## How a run works

1. **Isolation by default.** A new agent gets a blank git workspace. It has never seen your
   repos. `yeet <name> config origin <url>` imports a repo as the base (if nothing was built
   yet) and unlocks `yeet <name> push` — which pushes from the *host*; the guest never has a
   remote.
2. **Questions are a tool call.** The guest pi runs with a yeet extension (guest/yeet-tools.ts)
   whose `ask_user` tool writes a question file onto the shared mount and blocks. The
   controller relays it to your terminal (Enter = accept its recommendation) or auto-answers
   in `--agent`/`--yes` mode. Questions can happen mid-build, not just up front.
3. **Verification is mandatory, and the agent registers it.** The `set_verify` tool binds the
   command that proves the work (plus test-file globs and a coverage command). You confirm or
   edit it interactively; it takes effect in the *same* iteration via the shared mount. There
   is no --test flag: a run that never gets a verifier ends `unverified`, loudly.
4. **The controller owns liveness.** No in-guest timeouts. The CLI watches the shared mount
   for signs of life (session growth, log growth) and escalates on its own judgment: drop a
   STOP file the runner honors gracefully (partial work is committed, verified, reported),
   then kill the VM only if even that is ignored. A question waiting on a human pauses the
   clock. The cost cap is enforced the same way, live, mid-iteration.
5. **Green must be earned twice, then survive scrutiny.** A green verify triggers a fresh-VM
   confirm run (flakes don't ship). Pre-existing test files are fingerprinted at base — a pass
   that edited them gets flagged, not celebrated. After a confirmed pass, a coverage run
   parses the lcov output and reports how much of the app the tests actually exercise.

## Why a VM per iteration

Boot is ~360 ms and the image clones in ~110 ms (APFS copy-on-write, ~4 MB of real disk), so a
fresh VM costs about 1% of an LLM iteration. In exchange every iteration starts from an
identical known machine, and a crash or a runaway process cannot poison the next one.

Nothing worth keeping lives inside the VM. The workspace **is** a host directory shared over
virtio-fs, and the agent's session transcript lives beside it — so `pi -c` resumes the whole
conversation across a boot boundary, and the VM is genuinely disposable.

## Layout

```
guest/launcher/    yeet-vm.c — the libkrun launcher (C, codesigned, ~200 lines)
guest/setup.sh     builds the guest image into $YEET_HOME/images
guest/yeet-run     one iteration, in-guest; staged per run, not baked into the image
guest/yeet-tools.ts pi extension: ask_user + set_verify; staged per run
src/               the host orchestrator (Bun/TypeScript)
  bridge.ts        the controller: relays questions, enforces budget, decides liveness
  ui.ts            one event stream, three renderings (pleb / smarty / json)
  voice.ts         every canned line yeet says; see VOICE.md
test/roundtrip.ts  proves the whole machine except the LLM — no tokens spent
```

Runtime state lives in `$YEET_HOME` (default `~/.yeet`), never in this repo.

## Setup

Requires macOS on Apple Silicon, `brew install libkrun libkrunfw`, and Bun.

```bash
guest/setup.sh          # build the guest image (~5 min, ~563 MB)
bun test/roundtrip.ts   # verify the machinery, no LLM involved
```

The agent inside the VM is [pi](https://github.com/badlogic/pi-mono). Its model key is bridged
from opencode's auth store — api-key providers only, so use e.g. OpenRouter (opencode stores
Anthropic as OAuth, which cannot be handed to a process in a VM).

## Three constraints worth knowing

These are measured, not assumed, and each one broke something before it was understood:

- **`DYLD_LIBRARY_PATH` is required.** libkrun `dlopen`s `libkrunfw` *by leaf name at runtime*,
  so it never appears in `otool -L` and `-rpath` cannot reach it.
- **Never pass free text through guest argv.** libkrun's argv transport corrupts any argument
  containing both `"` and `$`, splitting it at internal spaces. `yeet-vm` refuses rather than
  corrupting. Files and env values are unaffected — which is why prompts, commands, questions
  and answers all cross the boundary as files.
- **The guest must do the git commit.** virtio-fs stores guest file modes in a
  `user.containers.override_stat` xattr, so host-visible modes are wrong — a host-side commit
  would silently drop exec bits. For the same reason the image is duplicated with
  `clonefile(2)` and never `cp -R`/rsync/tar (which destroy xattrs) or `cp -c` (which silently
  falls back to a full copy).

## Status

The loop, the sandbox, session resume, live budget enforcement, interactive questions,
agent-registered verification, frozen-test fingerprinting, and post-pass coverage all work end
to end. Still honest gaps: coverage is reported, not yet gated; a suite the agent wrote for
itself proves what the agent chose to prove — read `yeet ask <name>` before trusting a green
you care about.
