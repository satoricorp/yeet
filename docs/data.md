# The data contract

What an agent *is*, as data — in a shape that lives in a file today and in Postgres, S3 or
turbopuffer tomorrow without a rewrite.

## Two rules

**1. Events are the truth. State is a fold over them.**

`agent.json` used to be a mutable blob rewritten every iteration. That has no history, it is a
last-write-wins conflict the moment two machines touch it, and it maps to an UPDATE-heavy table.
Making the log authoritative buys: sync as *"everything after id X"*, a checkpoint for free (the
last event id), an insert-only Postgres table, immutable objects for S3, and a semantic index
that can be rebuilt rather than migrated.

**2. The controller writes events; the guest never does.**

The guest reports *facts about what it did* into its own iteration directory. The host decides
what those facts mean and appends an event. So an agent can never rewrite its own audit trail.

| Direction | What moves | Mounted into the VM? |
|---|---|---|
| host → guest | `request.env`, `prompt.txt`, `test-cmd.sh`, `STOP` | yes, guest reads |
| guest → host | `meta.kv`, `agent.log`, `test.log`, `qa/`, session JSONL | yes, guest writes |
| host only | `events.jsonl`, `agent.json` | **no** |

---

## Event kinds

| kind | means |
|---|---|
| `created` | the agent exists, with the user's verbatim prompt |
| `prompt` | a follow-up instruction |
| `config` | origin / target / model was set |
| `verify_set` | the acceptance contract was bound |
| `verify_run` | verify ran on its own — baseline, confirm, or coverage |
| `iteration` | the agent worked |
| `merge` | a merge was attempted or completed |
| `status` | the agent's status changed |

Every event carries `id` (a ULID)  and `at` (ISO-8601 UTC). Events are immutable and
never rewritten.

---

## Every event, with real values

### `created`

The user's words are stored verbatim and never paraphrased — everything downstream, including
merge-conflict reasoning, refers back to this.

```json
{"id":"01JN5JR7QF8888888888888888","at":"2026-07-26T17:27:08.777Z","kind":"created",
 "name":"reverse-cli",
 "userPrompt":"build a small CLI in Node that reads text on stdin and writes it back reversed, with tests",
 "model":"openrouter/z-ai/glm-5.2",
 "session":{"program":"pi","file":"session/2026-07-26T17-27-08-777Z_019f9c1a.jsonl"},
 "git":{"branch":"yeet/reverse-cli","baseCommit":"8ffb35d81ec6a358af85be05292435a06546b71e","origin":null}}
```

`session.file` is relative to the agent directory, so it resolves identically on a laptop and on
a cloud worker. `git.baseCommit` is this agent's *own* starting commit — not to be confused with
`mergeBase`, which only appears in merges.

### `prompt`

```json
{"id":"01JN5JRFEY3333333333333333","at":"2026-07-26T18:03:12.887Z","kind":"prompt",
 "from":"user","text":"now add refresh-token tests"}
```

`from` is always recorded because "who asked for this" is the one thing you cannot reconstruct
later. `"agent"` appears when a parent agent drives a sub-agent.

### `config`

```json
{"id":"01JN5JRQ6DFFFFFFFFFFFFFFFF","at":"2026-07-26T18:02:44.010Z","kind":"config",
 "key":"origin","value":"git@github.com:satoricorp/console.git","setBy":"user"}
```

Keys: `origin` · `target` (the branch merges aim at, default `main`) · `model`.

### `verify_set`

```json
{"id":"01JN5JRYXWFFFFFFFFFFFFFFFF","at":"2026-07-26T18:03:51.400Z","kind":"verify_set",
 "command":"bun test && bun run typecheck",
 "testFiles":["test/**/*.test.ts"],
 "coverageCommand":null,
 "proposedBy":"agent","approvedBy":"user","changedOnApproval":true,
 "protectedTests":{"test/auth.test.ts":"a3f19c8e2b04d7561f8a09c3e5b2d4a71c069f83"}}
```

`approvedBy:"user"` with `changedOnApproval:true` means a person read the agent's proposal and
altered it. `approvedBy:"auto"` means nobody was at the terminal.

`protectedTests` maps path → blob sha **as of `baseCommit`**: the tests that existed before the
agent arrived. Those are the rules of the game, and quietly rewriting them is the classic way to
turn red green without doing the work. Tests the agent writes itself are deliberately not listed
— iterating on your own new tests is normal work, not cheating. An agent starting from a blank
workspace has `protectedTests:{}`, and nothing is off-limits.

### `verify_run`

Verify running on its own — no agent, no tokens.

```json
{"id":"01JN5JS6NBGGGGGGGGGGGGGGGG","at":"2026-07-26T17:27:20.100Z","kind":"verify_run",
 "reason":"baseline","command":"bun test","exitCode":1,"passed":false}
```

```json
{"id":"01JN5JSECT5555555555555555","at":"2026-07-26T17:28:19.550Z","kind":"verify_run",
 "reason":"confirm","command":"node --test","exitCode":0,"passed":true}
```

`reason` is `baseline` (before any work — distinguishes "the agent fixed it" from "nothing was
broken"), `confirm` (proving a green reproduces, so a flake is not mistaken for success), or
`coverage`.

### `iteration`

An `iteration` always means the agent worked, so the `agent` block is always present. Three
questions: what did the model do, what happened to the code, did it check out.

```json
{"id":"01JN5JSP49MMMMMMMMMMMMMMMM","at":"2026-07-26T17:28:03.918Z","kind":"iteration","n":1,
 "agent":{"seconds":55,"costUsd":0.01554123474,"outcome":"edited","stoppedBy":null,"sessionEnd":47},
 "git":{"commit":"c4f9a02e1b77d3a6f0e18b5c9d2a4e7f3b6c8d1a",
        "filesChanged":9,"linesAdded":214,"linesRemoved":0,"protectedTestsChanged":[]},
 "verify":{"command":"node --test && node scripts/coverage.js","exitCode":0,"passed":true}}
```

A failure — the real $1.15 overrun that motivated the budget watchdog:

```json
{"id":"01JN5JSXVREEEEEEEEEEEEEEEE","at":"2026-07-26T00:52:11.004Z","kind":"iteration","n":1,
 "agent":{"seconds":900,"costUsd":1.1510,"outcome":"stopped","stoppedBy":"stall","sessionEnd":1034},
 "git":{"commit":"9d2b06f4c1e88a7b3f05d2e6c9a1b4f7e8d3c025",
        "filesChanged":2,"linesAdded":89,"linesRemoved":1,"protectedTestsChanged":[]},
 "verify":{"command":"bun test","exitCode":1,"passed":false}}
```

`outcome:"stopped"` with `stoppedBy:"stall"` and a commit that exists says *we interrupted it
mid-edit* — the committed tree may not even parse. That is a different fact from "the agent
finished and the tests failed", and it has to read differently.

- `outcome`: `edited` · `no_edit` · `error` · `stopped`
- `stoppedBy`: `budget` · `stall` · `null`
- `sessionEnd`: transcript position after this iteration. 1034 against 47 is thrashing, as a number.
- `git.commit` is `null` when nothing changed — there are no empty commits, so absence is signal.
- `protectedTestsChanged` non-empty beside `passed:true` is the reward-hacking alarm.

### `merge`

```
        A───B───C          main            targetCommit = C
       /
  ───O                     ← diverged      mergeBase    = O
       \
        D───E              yeet/fix-auth   agentCommit  = E
```

`mergeBase` is the **common ancestor**, not the head of origin — that is `targetCommit`. A
three-way merge diffs both sides against the base, which is why it needs a name of its own.

```json
{"id":"01JN5JT5K7XXXXXXXXXXXXXXXX","at":"2026-07-26T18:20:03.441Z","kind":"merge",
 "targetBranch":"main","mergeBase":"9c3228d","targetCommit":"a81b0e2","agentCommit":"4f17e5c",
 "result":"conflicted","conflicts":2,"mergeCommit":null}
```

```json
{"id":"01JN5JTDAP2222222222222222","at":"2026-07-26T18:24:51.902Z","kind":"merge",
 "targetBranch":"main","mergeBase":"9c3228d","targetCommit":"a81b0e2","agentCommit":"4f17e5c",
 "result":"resolved","conflicts":0,"mergeCommit":"b70e4d1"}
```

Two events rather than one mutated: you can see it was attempted, conflicted, and later resolved
— and how long the human took in between. `result` is `clean` · `conflicted` · `resolved` ·
`aborted`.

### `status`

```json
{"id":"01JN5JTN25WWWWWWWWWWWWWWWW","at":"2026-07-26T17:28:19.612Z","kind":"status","status":"passed","reason":null}
```

```json
{"id":"01JN5JTWSMYYYYYYYYYYYYYYYY","at":"2026-07-26T00:52:11.180Z","kind":"status","status":"capped",
 "reason":"agent stopped mid-work after 15m without output"}
```

`running` · `passed` · `stalled` · `capped` · `failed` · `unverified`.

---

## The derived state

A total fold, small enough to recompute on every load:

```
verify      = last verify_set
status      = last status
costUsd     = sum of iteration.agent.costUsd
checkpoint  = last iteration with git.commit != null  →  {id, commit, sessionEnd}
```

```json
{"name":"reverse-cli",
 "userPrompt":"build a small CLI in Node that reads text on stdin and writes it back reversed, with tests",
 "status":"passed","costUsd":0.01554123474,
 "verify":{"command":"node --test && node scripts/coverage.js","proposedBy":"agent","protectedTests":{}},
 "git":{"branch":"yeet/reverse-cli","origin":null},
 "checkpoint":{"id":"01JN5JV4H3GGGGGGGGGGGGGGGG","commit":"c4f9a02e1b77d3a6f0e18b5c9d2a4e7f3b6c8d1a","sessionEnd":47}}
```

---

## How `verify_set` actually works

The interesting part is that the contract binds **while the VM is already running**.

1. The guest image carries a pi extension exposing a `set_verify` tool.
2. Mid-task the agent calls it: *"I'll prove this with `node --test`; tests live in
   `test/**/*.test.js`."*
3. The tool writes the proposal into `qa/` in the shared iteration directory.
4. The **Bridge** on the host is watching that directory and picks it up.
5. It surfaces the proposal — to a human at the terminal (accept, or type a replacement), or to
   the recommendation policy when nobody is there.
6. The decision is written back into `qa/`; the tool call returns and the agent carries on.
7. The host persists it, computing `protectedTests` from `baseCommit`, and appends `verify_set`.
8. The host also writes `test-cmd.sh` into the **live** iteration directory — so *this very run*
   verifies with it.

Step 8 is what virtio-fs buys: late binding is an ordinary file write into a directory the
running guest already has open. The agent never restarts, and the contract it proposed governs
the run it proposed it in.

An identical re-proposal is a no-op. Models re-call `set_verify` with the same content more often
than you would expect, and re-prompting a human each time would be maddening.

---

## Where each thing lives

| Data | Home | Why |
|---|---|---|
| **Code** (`workspace/`) | **git** | already content-addressed, already syncs, already merges |
| **Events** | file → Postgres | small, append-only, insert-only table |
| **Session raw** | file → Postgres `jsonb`, or S3 when large | immutable, append-only |
| **Semantic index** | turbopuffer | derived and rebuildable |
| **Secrets** | **nowhere — never synced** | its own problem with its own failure modes |

turbopuffer stores **vectors plus structured attributes**, not raw blobs — it is a search engine
built *on* object storage, not an object store. So a session chunk becomes a vector plus
attributes `{agent, branch, kind, model, at, seqFrom, seqTo}` that point back to the raw. Nothing
there is authoritative, so changing the chunking or embedding strategy is a reindex, not a
migration.

Postgres is enough for a long time. S3 only earns its place when session blobs get large, and
adding it later is not a migration, because immutable append-only records move without
reconciliation.

---

## Checkpoints, resume, and cloud

A checkpoint is `(commit, id, sessionEnd)` — all three monotonic. Resume is the same four steps
whether it happens on a laptop or in a data centre:

1. pull events after the local `id`, replay to state
2. `git fetch` the branch, check out `commit`
3. reconstruct `~/.yeet/agents/<name>/`
4. boot a VM over that directory

**The runner does not know where it is.** libkrun uses KVM on Linux and Hypervisor.framework on
macOS, and the guest image is arm64 Ubuntu — so a Graviton instance runs the identical image a
Mac does. Local and cloud are one architecture; only the materializer differs.

Sync is implicit; there is no `push` and no `clone`. `yeet <name> …` resolves locally first, then
in the cloud, materializing if needed. The append-only log is what makes doing that automatically
*safe* — with a mutable blob, an implicit pull would be a silent clobber.

Defaults: the **CLI runs local**, the **SDK runs cloud**, and `yeet config cloud always` forces
everything remote. The state decides where an agent lives; the interface only decides the default.

## Build order

1. `events.jsonl` locally, with `agent.json` becoming a replayed cache. Everything below depends
   on this one inversion.
2. Checkpoint recorded per iteration.
3. `yeet merge` — `git merge-tree` for conflict detection, verify-in-sandbox on a clean merge,
   emitting the merge JSON with `conflicts: 0`.
4. Session chunking + embeddings; the semantic half of conflict questions.
5. Remote backends behind the same interface.

Steps 1–3 are a working merge story with no cloud dependency at all.
