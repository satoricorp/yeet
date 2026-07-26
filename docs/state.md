# The state contract

What an agent *is*, in a shape that persists to a local file today and to Postgres, S3 or
turbopuffer tomorrow without a rewrite.

## The one structural change that makes the rest easy

Today `agent.json` is a mutable blob: every iteration rewrites the whole file. That is fine for
one process on one laptop and bad everywhere else — it has no history, it is a last-write-wins
conflict the moment two machines touch it, and it maps to an UPDATE-heavy Postgres table.

**Make the log the truth and the blob a cache.** An agent becomes an append-only sequence of
events plus a snapshot derived from replaying them. That single change buys:

- **Sync with no merge logic** — "give me everything after seq N" is the entire protocol.
- **A checkpoint for free** — the checkpoint *is* the last event id.
- **A natural Postgres shape** — one insert-only table, no update contention.
- **A natural object-storage shape** — immutable records, so S3 without read-modify-write.
- **Rebuildable indexes** — turbopuffer can be wiped and reindexed from raw at any time.

`agent.json` stays exactly as it is on disk. It just stops being authoritative.

## Entities

Written as SQL because that is the strictest of the three targets; the same shapes are a JSON
document per row in S3, or attributes in turbopuffer.

```sql
-- Identity. One row per agent, and the only table that is ever UPDATEd.
create table agent (
  id            uuid primary key,          -- stable across machines; not the name
  name          text not null,             -- the human handle; unique per owner
  owner         text not null,
  created_at    timestamptz not null,
  task          text not null,             -- the original prompt, verbatim
  model         text not null,
  origin        text,                      -- git url; null while isolated
  branch        text not null,
  base_head     text,
  state         text not null,             -- running|passed|stalled|capped|failed|unverified
  unique (owner, name)
);

-- Every state change, append-only. THIS is the source of truth.
create table agent_event (
  agent_id      uuid not null references agent(id),
  seq           bigint not null,           -- monotonic per agent
  at            timestamptz not null,
  kind          text not null,             -- iteration|verify_bound|config|state|merge|note
  body          jsonb not null,
  primary key (agent_id, seq)
);

-- Derived from agent_event, materialised because it is queried constantly.
create table iteration (
  agent_id      uuid not null references agent(id),
  n             int  not null,
  phase         text not null,             -- baseline|agent|confirm|chat|coverage
  commit_sha    text,                      -- the checkpoint this iteration produced
  seconds       int  not null,
  cost_usd      numeric(12,6) not null,
  insertions    int, deletions int, files_changed int,
  tree_changed  boolean not null,
  test_exit     int,
  verdict       text not null,             -- green|red|none
  agent_verdict text,                      -- edited|no_edit|error|stopped
  stop_reason   text,                      -- budget|stall|null
  interrupted   boolean not null default false,
  touched_frozen text[],
  primary key (agent_id, n)
);

-- The acceptance contract, versioned because it can be re-bound mid-run.
create table verify (
  agent_id       uuid not null references agent(id),
  version        int  not null,
  command        text not null,
  test_files     text[] not null,
  coverage_command text,
  source         text not null,            -- agent|user
  frozen         jsonb not null,           -- {path: blob_sha} as of base_head
  bound_at       timestamptz not null,
  primary key (agent_id, version)
);

-- The raw transcript, one row per JSONL line. Immutable.
create table session_event (
  agent_id    uuid not null references agent(id),
  seq         bigint not null,
  at          timestamptz not null,
  type        text not null,               -- session|message|model_change|…
  role        text,                        -- user|assistant|toolResult
  model       text,
  provider    text,
  tokens      int,
  cost_usd    numeric(12,6),
  raw         jsonb not null,              -- the pi line, byte-faithful
  primary key (agent_id, seq)
);

-- Derived and disposable: the semantic search unit.
create table session_chunk (
  agent_id    uuid not null references agent(id),
  chunk_id    text not null,
  seq_from    bigint not null,
  seq_to      bigint not null,
  kind        text not null,               -- request|decision|tool_use|summary
  text        text not null,
  primary key (agent_id, chunk_id)
);
```

`session_chunk` is the row that also becomes a turbopuffer document: the vector plus attributes
`{agent_id, name, branch, kind, model, at, seq_from, seq_to}`, with the attributes carrying the
pointer back to `session_event`. Nothing in turbopuffer is authoritative, so a change to the
chunking or embedding strategy is a reindex, never a migration.

## Where each thing lives

| Data | Home | Why |
|---|---|---|
| **Code** (`workspace/`) | **git** | Already content-addressed, already syncs, already merges. Never put it in a database. |
| **Session raw** | Postgres `session_event`, or one object per agent in S3 | Immutable, append-only, occasionally large |
| **Iterations, verify, agent** | Postgres | Small, queried, relational |
| **Semantic index** | turbopuffer | Derived; rebuildable from raw |
| **Secrets** (`run.env`) | **nowhere — never synced** | See below |

The local layout does not change. `~/.yeet/agents/<name>/` remains exactly what a VM mounts;
the cloud simply reconstructs that directory from the tables before booting.

## Secrets: deliberately out of scope

Environment variables and API keys are **not** part of this contract and are not synced. For now
a single project-level env file, not per-sandbox and not per-session. Reconciling secrets across
machines is its own problem with its own failure modes, and conflating it with state sync is how
credentials end up in a blob store. `run.env` must be on an explicit denylist in any sync path —
a denylist, not an allowlist by omission.

## Checkpoints and resume

A checkpoint is `(commit_sha, agent_event.seq, session_event.seq)`. All three are monotonic, so
resume is:

1. pull `agent`, then everything after the local `seq` in both event tables
2. reconstruct `~/.yeet/agents/<name>/` — `agent.json` is replayed, session JSONL is concatenated
3. `git fetch` the branch, check out `commit_sha`
4. boot a VM with that directory mounted

Nothing about the VM or the runner changes. That is the whole payoff of the workspace being a
host directory rather than VM-local state.

## Merge

Code merges; sessions fork. Two divergent transcripts cannot be interleaved into a coherent one,
and trying produces an agent that is worse than either parent. A merged agent inherits the code
and *references* both session lineages — which is exactly what makes the semantic lookup below
possible.

### `yeet merge <name>`

Combines the named agent with `origin`'s target branch (from config).

**1 · Can it merge at all?** `git merge-tree --write-tree <base> <ours> <theirs>` answers this
without a checkout, a worktree, or a sandbox — it writes the merged tree to the object store and
reports conflicts. Cheap, side-effect free, and correct. A sandbox is *not* needed to detect
conflicts; it is needed for step 3.

**2 · If it conflicts, turn conflicts into questions.** This is the part worth building. For each
conflicted hunk:

- **Ours**: search this agent's own session for why it touched that region.
- **Theirs**: semantic search across the sessions of the agents already merged into the target
  branch, filtered by `branch` and file path, for why that code exists.
- Emit a *question about intent*, not a diff. "Both sides changed token refresh. This agent
  added clock-skew tolerance; the target added a retry loop for 401s. Keep both, or is one
  superseded?"

**3 · If it merges clean, prove it.** Run the merged tree's verify command in a sandbox. A clean
textual merge that breaks the build is the entire reason semantic conflicts exist — this is
where the VM earns its place in the merge path.

### The merge JSON contract

Symmetric so a human or an agent can drive it:

```jsonc
// yeet merge fix-auth --agent
{
  "schema": "yeet.merge/1",
  "agent": "fix-auth", "target": "main",
  "base": "9c3228d", "ours": "4f17e5c", "theirs": "a81b0e2",
  "mergeable": false,
  "questions": [{
    "id": "q1",
    "file": "src/auth.ts",
    "ours":   { "summary": "added clock-skew tolerance to token refresh",
                "evidence": [{ "agent": "fix-auth", "seq": 412, "quote": "…" }] },
    "theirs": { "summary": "added a retry loop on 401",
                "evidence": [{ "agent": "retry-401", "seq": 88, "quote": "…" }] },
    "question": "Both changed the refresh path. Keep both behaviours, or does one supersede?",
    "options": [ { "id": "ours" }, { "id": "theirs" }, { "id": "both" } ],
    "recommended": "both", "confidence": 0.62
  }]
}
```

```jsonc
// yeet merge fix-auth --answers answers.json
{ "schema": "yeet.merge.answers/1",
  "answers": [{ "id": "q1", "choose": "both", "note": "skew tolerance is inside the retry" }] }
```

With every question answered the merge is applied as a normal commit — no conflict markers ever
reach the working tree, because the resolution was decided before the merge was written.

## CLI surface

Sync is implicit. There is no `push` and no `clone`, because a non-developer should not have to
know those exist.

```
yeet "<task>"              start a new agent
yeet <name> "<task>"       continue it — pulls it from cloud first if it only exists there
yeet <name>                show it / resume it
yeet merge <name>          combine it with origin's target branch
yeet ls · ask · rm · config
```

`yeet <name> …` is the whole transfer story: if the name resolves locally, use it; if it resolves
in the cloud, materialise it and then use it; if cloud is configured, push the new events at the
end of the run. The user never names the operation, and the append-only log is what makes that
safe to do implicitly.

## Build order

1. `agent_event` locally as a JSONL file beside `agent.json`, with `agent.json` becoming a
   replayed cache. Nothing else changes, and everything below becomes possible.
2. `lastCheckpoint` recorded per iteration.
3. `yeet merge` with `merge-tree` detection + verify-in-sandbox on a clean merge. **No semantic
   step yet** — just clean/conflicted, and the JSON shape above with `questions: []`.
4. Session chunking + embedding, and the semantic half of the conflict questions.
5. Remote backends behind the same interface.

Steps 1–3 are a working merge story with no cloud dependency at all.
