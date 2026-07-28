# Secrets: what yeet needs, and what Juice would provide

Written from yeet's side. The proposal is that Juice becomes the secrets layer yeet uses,
rather than yeet growing its own — but three of the four changes below are things Juice needs
regardless, which is the main argument for doing it there.

## Two kinds of secret

Conflating these is the trap, because they have different owners and different blast radii.

| | scope | example | who reads it | if it leaks |
|---|---|---|---|---|
| **Provider key** | one per user | `OPENROUTER_API_KEY` | yeet itself, to run the agent | costs money |
| **Agent secret** | one per agent | `DATABASE_URL` | the agent's code, inside the VM | drops your table |

Juice's `project / env` model fits the second naturally and the first awkwardly. Both fit if a
scope is just an opaque path, which is cheaper than teaching Juice about agents:

```
yeet/global                 the provider keys
yeet/agents/<name>          that agent's secrets
```

## The interface yeet needs

Four operations. yeet already has this shape in `src/secrets.ts`; the proposal is that Juice
becomes an implementation of it, the same way a Postgres store will become an implementation of
`EventStore`.

```
set(scope, key)          prompt for a value, store it
get(scope, key)          one value
list(scope)              names only, never values
export(scope, → file)    every key in scope, written to a path
```

`export` is the one Juice does not have and the one yeet cannot work without: yeet is not
spawning the consuming process, libkrun is. `juice run -- cmd` cannot help here.

## Proposed CLI

```
juice set DATABASE_URL                    prompt, no echo, current scope
juice set DATABASE_URL --scope yeet/agents/fix-auth
juice list                                names only
juice unset DATABASE_URL
juice export --to .env                    write every key in scope to a file
juice run -- npm start                    inject and run (unchanged)
juice scope                               which scope am I in, and why
juice scope use yeet/agents/fix-auth      pin it
```

Three deliberate choices:

**`export --to <path>`, never `--json` to stdout.** A command that prints secrets to stdout is
the footgun that makes everything else pointless: the moment an agent runs it, the values are
in the session transcript forever, and `$(juice get KEY)` in a shell puts them in history. Write
to a path and the value never transits a stream anything is logging. `get` should stay, because
humans need it, but yeet will never call it.

**A value is never an argument.** `juice set KEY value` should be *refused*, not accepted — by
the time you regret it, it is in `ps` and in shell history, and deleting it later does not help.
Juice already has the hidden prompt for this; it just needs to stop accepting the alternative.

**`scope` is explicit and printable.** Today Juice infers a project by walking up for
`package.json` or `.git`, which silently does the wrong thing anywhere that is not a repo — and
`~/.yeet/agents/<name>/` is exactly that. Being able to ask "which scope am I in" is what makes
an inferred default safe.

## What has to change in Juice

**1 · Scopes, replacing project-root discovery.** The blocker. yeet's store is not in a repo,
and the one directory nearby that *is* a repo is the agent's own workspace — putting secrets
there makes them committable and pushable by the agent itself.

**2 · Local scoping at all.** Today local mode ignores `project` entirely and `--env` is a
silent no-op: `set K --local --env prod` and `--env dev` write the same file and the second
wins. That is a live bug independent of yeet, and it is the same fix as (1).

**3 · `export --to`.** ~20 lines. Without it there is no integration.

**4 · A direct Secrets Manager backend.** Today every client goes through a Juice API server.
A cloud runner already has an AWS task role and can call SM itself — the existing AWS code is
~97 lines, repointed. The server keeps its real purpose: giving *laptops* a path that does not
require AWS credentials.

Only (3) is purely for yeet.

## How yeet consumes it

`src/secrets.ts` stays as the interface, with a backend chosen in config:

```
yeet config secrets file      default — a 0600 file, works standalone
yeet config secrets juice     delegate
```

so yeet is never blocked on Juice, and switching is one config value. Shell out to the `juice`
CLI rather than take an npm dependency, at least initially: coupling two prototypes' release
cycles is the part that is expensive to undo.

The injection point already exists. `loop.ts` writes `run.env` at 0600 inside a 0700 directory
every iteration, and the guest sources it. With Juice that write becomes:

```
juice export --scope yeet/agents/<name> --to <agentdir>/run.env
```

plus the provider key from `yeet/global`. Per-iteration refresh is free because the file is
rewritten every time anyway.

## What none of this fixes

**The guest still holds the secret.** `run.env` is inside the VM and the VM has unrestricted
outbound network, so anything bridged in is exfiltratable by an agent that wants to. Juice does
not change that and neither does the current file store — storage is about protecting the
secret on *your* machine, not from the agent.

The only real answer is a host-side proxy: the guest gets a loopback address and a per-run
nonce, the host substitutes the real credential. That is a separate project, only viable for
protocols worth proxying, and worth deciding on its own merits rather than as a side effect of
choosing a store.

## The open decision

Does Juice stay *a secrets tool yeet happens to use*, or become *yeet's secrets layer*?

It matters because of identity. Juice authenticates with GitHub device flow and scopes secrets
by `githubUserId`; yeet's cloud story is per-user agents on a runner with an AWS role. If Juice
is to serve yeet those have to reconcile, and that is a larger decision than any of the four
changes above.

Suggested order: land scopes, local scoping, and `export --to` first. They make Juice better on
its own terms and unblock yeet's local path completely. Leave identity until yeet actually has
cloud, at which point the requirement will be concrete instead of hypothetical.
