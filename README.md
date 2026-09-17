# tidepool v1 — helper-thread memory ocean for hermit

A standalone bench (NOT a PR) for the design recalled from an earlier session:
hermit's helper threads get a **memory ocean** — a markdown file any agent can
read — backed by the **quilt WAL** hermit gained on `quilt-kernel-p2-encounters`
(PRs #1/#2). Every remembered thread summary is projected BIND-for-BIND into
the 5-opcode kernel and drained to hash-chained WAL rows via the hermit
commit pattern. The WAL is the source of truth; the ocean markdown is the
human-readable projection; the recall index is rebuildable from the WAL
alone.

> Note: this directory previously held a recon copy of the deployed
> fleet-wide `tidepool` worker (a different service). That content is
> preserved in git history (`a68b3b8`). A concurrent sibling subagent also
> left `bench/` and `src/wal-store.mjs` here mid-flight; neither is part of
> this deliverable.

## Run the bench

```bash
bun test tests/tidepool.test.mjs
# 6 pass, 0 fail — remember→WAL hash chain, recall relevance, stall
# detection, quiet-thread WAL drain, WAL-only replay parity, oath audit
```

Zero dependencies. `bun:sqlite` only, via hermit's own D1 harness shape.

## Package layout (all files)

| File | Role | Hermit PR #3 landing zone |
|---|---|---|
| `src/kernel.mjs` | QuiltKernel, byte-copy of hermit's `src/quilt/reference-kernel.mjs` | already vendored in hermit — do NOT duplicate |
| `src/projection.mjs` | `buildWalRows` / `verifyChain` (ported) + tidepool projectors/replayers | `src/tidepool/projection.ts` |
| `src/commit.mjs` | `commitProjection` (ported `src/quilt/commit.ts` pattern) | reuse hermit's `src/quilt/commit.ts` directly |
| `src/ocean.mjs` | `TidepoolOcean` — markdown ocean + recall index + oaths | `src/tidepool/ocean.ts` |
| `src/stall.mjs` | `detectQuietThreads` — pure stall detector | `src/tidepool/stall.ts` |
| `src/tidepool.mjs` | the six public entry points (below) | `src/tidepool/index.ts` |
| `src/d1sqlite.mjs` | hermit's `tests/helpers/sqliteD1.ts`, ported to JS | already in hermit — do NOT duplicate |
| `src/schema.sql` | DDL for `helper_threads` + `helper_logs` (`quilt_wal` already exists) | `drizzle/0014_tidepool.sql` |
| `tests/tidepool.test.mjs` | the proofs | `tests/tidepool.test.ts` |

## Interface contract (PR #3)

### Public API

```ts
// src/tidepool/index.ts

// Remember one helper-thread summary: append to the ocean markdown AND
// project into the quilt WAL (one mutation). Dual-write, like P1/P2.
rememberHelperThread(
  ocean: TidepoolOcean,
  walClient: WalClient,                    // D1 in prod; SqliteD1Database in tests
  thread: HelperThreadSummary,             // row shape below
  ctx: { mutationId: string, ts: string }  // ts = ISO-8601, oath-mandated
): Promise<{ section: string, entry: object, walRows: WalRow[] }>

// Channel sweep: remember N threads in ONE projection → ONE mutation_id,
// ONE WAL batch (the hermit commit-batch shape).
rememberChannelThreads(
  ocean, walClient, threads: HelperThreadSummary[], ctx
): Promise<{ remembered: Array<{section, entry}>, walRows: WalRow[] }>

// Top 3–5 relevant thread memories. Deterministic token-overlap scoring
// (helperName/question weigh 2, response/meta weigh 1; ties → most recent).
// No embeddings: hermit has no vector dependency, and the WAL replay must
// reproduce it bit-for-bit.
recallHelperContext(ocean, query: string, { limit?: number } = {}):
  Promise<Array<OceanIndexEntry>>

// The oath log: append-only, timestamped, immutable.
rememberBotAction(ocean, action: string): Promise<{ ts: string, action: string }>

// threadLengthMonitor's negative ledger: drain detected quiet threads into
// the WAL. Absence is the information (hermit P2 `.refused` pattern).
drainQuietThreads(walClient, quietList: QuietThread[], ctx):
  Promise<{ walRows: WalRow[] }>

// Pure decision core of the monitor. History in, quiet list out; no I/O,
// no clock (timestamps come from the samples).
detectQuietThreads(
  polls: Array<{ threadId: string, ts: string, messageCount: number }>,
  { window?: number } = {}            // default 3 consecutive flat polls
): Array<QuietThread>
// QuietThread = { threadId, silentPolls, lastCount, since, ts }
```

### HelperThreads row shape (recalled design v1, unchanged)

```ts
type HelperThreadSummary = {
  id: string;             // discord thread id          → helper_threads.id
  guildId: string;        //                            → guild_id
  channelId: string;      //                            → channel_id
  userId: string;         //                            → user_id
  helperKey: string;      //                            → helper_key
  helperName: string;     //                            → helper_name
  questionText: string;   //                            → question_text
  responseText: string;   //                            → response_text
  thinkingLevel: string;  //                            → thinking_level
  responseLength: number; //                            → response_length
  createdAt: string;      // ISO                        → created_at
  authorTag: string;      //                            → author_tag
  authorUsername: string; //                            → author_username
  lastMessageId: string;  //                            → last_message_id
}
```

`helper_logs` (raw message JSON, recalled design): `(guild_id, channel_id,
thread_id, messages JSON, created_at, updated_at)`, PK on `thread_id`,
append-only. DDL in `src/schema.sql`.

### WAL row shapes

Table `quilt_wal` (exists since PR #1): `(seq, mutation_id, ts, cell, op,
value, prev_hash, hash)`, fnv1a chain over
`prev|seq|cell|op|value|ts|mutation_id`, genesis prev_hash = `GENESIS`.

**Thread memory** — `mutation_id = "remember:<n>"` (one per
`rememberHelperThread`; one per channel sweep for `rememberChannelThreads`),
`op` ∈ `{bind, link}`:

```
bind  channel.<channelId>                        {"kind":"channel","guildId":...}
bind  helper.<helperKey>                         {"kind":"helper","helperName":...}
bind  thread.<id>                                {"kind":"helper-thread", id, guildId, channelId, userId, helperKey, helperName, createdAt}
bind  thread.<id>.question                       "<questionText>"
bind  thread.<id>.response                       "<responseText>"
bind  thread.<id>.meta                           {"thinkingLevel","responseLength","authorTag","authorUsername"}
bind  thread.<id>.lastMessage                    "<lastMessageId>"
bind  thread.<id>.rememberedAt                   "<ts>"          (meta {ts} provenance)
link  thread.<id> -> channel.<channelId>         {"id":"...","type":"lives-in"}
link  thread.<id> -> helper.<helperKey>          {"id":"...","type":"served-by"}
```

Link endpoints (channel, helper) are bound first — L1 law, same as hermit's
nomination projection.

**Stall event** — `mutation_id = "stall-monitor:<n>"`, one bind per quiet
thread, negative-ledger style (no helper_threads row is touched):

```
bind  thread.<id>.quiet                          {"silentPolls":4,"lastCount":7,"since":"<last-growth-ts>","ts":"<detection-ts>"}
```

Replay (`replayThreadIndexFromWal`) reads only `op=bind` rows under
`thread.*`; the latest bind of each cell wins, so re-remembered threads
refresh and `.quiet` state survives alongside.

### rememberBotAction oaths (enforced by API shape, audited by `ocean.stats()`)

1. **Never modify messages** — the ocean exposes no edit/delete API.
2. **Always append-only** — re-remembering appends a new section; the old
   one stays (a memory of a memory is itself a memory).
3. **Always include timestamps** — every section carries `rememberedAt`,
   every bot-action line carries an ISO ts, every WAL row carries `ts`.

## Deviations from the recalled design (with reasons)

1. **WAL is the source of truth, not helper_threads.** The recalled design
   wrote the ocean + D1 tables directly. v1 keeps the tables (DDL shipped)
   but treats them as a materialized view; replay from WAL rebuilds the
   recall index bit-for-bit (the bench proves parity). This is the P1/P2
   risk posture: WAL failure is logged, never thrown into the helper path.
2. **Recall is token-overlap, not embeddings.** The fleet-wide tidepool
   service uses BGE/Vectorize; hermit-side v1 deliberately doesn't — the
   replay referee must be deterministic and dependency-free.
3. **threadLengthMonitor is split**: pure `detectQuietThreads` (decision
   core) + thin `drainQuietThreads` (WAL write). The 30-min edge wrapper is
   a 10-line scheduled handler in the PR; business logic stays testable.
4. **Quiet threads get WAL-only `.quiet` cells** — no update to
   helper_threads. Absence is the information; the negative ledger sees
   what the live table cannot (hermit P2's refusal pattern).
5. **Channel sweep = one mutation.** `rememberChannelThreads` drains one
   kernel → one batch → one `mutation_id`, matching hermit's
   commitProjection batching (vs per-thread mutations in the recall).

## Provenance

- `src/kernel.mjs` — body byte-identical to hermit
  `src/quilt/reference-kernel.mjs` @ `quilt-kernel-p2-encounters`
  (CONTRACT v5, differential-fuzz sealed).
- `src/projection.mjs` (`fnv1a`, `buildWalRows`, `verifyChain`) ported from
  hermit `src/quilt/projection.ts`; projectors mirror
  `projectNominationVote` / `projectLobsterEncounter` / the P2 `.refused`
  negative ledger.
- `src/commit.mjs` — the generic `commitProjection` from hermit
  `src/quilt/commit.ts`.
- `src/d1sqlite.mjs` — hermit `tests/helpers/sqliteD1.ts`, JS port.
- `src/schema.sql` — `quilt_wal` DDL from hermit
  `drizzle/0013_quilt_kernel_wal.sql`.
