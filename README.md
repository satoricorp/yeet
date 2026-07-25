# yeet

Coding agents that loop until the work is **verified** — not until the agent stops talking.

Each iteration runs in its own [libkrun](https://github.com/containers/libkrun) microVM on
Apple Silicon. The agent edits a git workspace, the verify command runs in the same VM, and the
loop continues until the suite is green, progress stalls, or a budget cap is hit.

```bash
yeet "make the auth tests pass" --test "bun test"   # new agent
yeet fix-auth "now add refresh tests"               # continue — same session, workspace, branch
yeet ls                                             # list agents
```

```
agent   fix-auth
repo    ~/git/console @ 9c3228d
verify  bun test
limits  5 iterations · $2.00

 0  baseline                                  red · exit 1
 1  agent    9s      $0.0026  +4 −1  1 file   green
    confirm                                   green ✓

passed · 12s · $0.0026
branch  yeet/fix-auth
```

## Why a VM per iteration

Boot is ~360 ms and the image clones in ~110 ms (APFS copy-on-write, ~4 MB of real disk), so a
fresh VM costs about 1% of an LLM iteration. In exchange every iteration starts from an
identical known machine, and a crash or a runaway process cannot poison the next one.

Nothing worth keeping lives inside the VM. The workspace **is** a host directory shared over
virtio-fs, and the agent's session transcript lives beside it — so `pi -c` resumes the whole
conversation across a boot boundary, and the VM is genuinely disposable.

## Layout

```
guest/launcher/   yeet-vm.c — the libkrun launcher (C, codesigned, ~200 lines)
guest/setup.sh    builds the guest image into $YEET_HOME/images
guest/yeet-run    one iteration, in-guest; staged per run, not baked into the image
src/              the host orchestrator (Bun/TypeScript)
test/roundtrip.ts proves the whole machine except the LLM — no tokens spent
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
  corrupting. Files and env values are unaffected.
- **The guest must do the git commit.** virtio-fs stores guest file modes in a
  `user.containers.override_stat` xattr, so host-visible modes are wrong — a host-side commit
  would silently drop exec bits. For the same reason the image is duplicated with
  `clonefile(2)` and never `cp -R`/rsync/tar (which destroy xattrs) or `cp -c` (which silently
  falls back to a full copy).

## Status

The loop, the sandbox, session resume, and cost tracking work end to end. The acceptance gates
that make "green" mean something — frozen tests, a composition requirement, and an
implementation-ablation check — are not built yet. Until they are, treat a green result as
evidence that a suite passed, not that the work is right.
