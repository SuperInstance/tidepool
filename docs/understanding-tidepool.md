# Understanding tidepool

## 1. In one breath

Tidepool is a small Cloudflare Worker that lets any agent store a short written lesson ("artifact") when it finishes a task and lets any agent search those lessons by meaning when it starts a new one.

## 2. Why it exists

An agent's context window empties at the end of each session. Before this, whatever an agent learned (a decision, a bug's cause, a gap left open) survived only if someone copied it into a memory file by hand, and it was visible only to the agent or repo that owned that file. Another agent working in a different repo had no way to ask "has anyone already hit this?"

Tidepool gives every agent the same two operations: write a distilled note at the end, recall relevant notes at the start (`README.md`, "The protocol"). The README's own framing is that the product is the write/read discipline, not the storage.

Status: the Worker, schema, tests and an optional recall filter (the "JEV gate") exist. Deployment needs a Cloudflare account; nothing in this repo has been run against real Cloudflare bindings by these docs. Everything below that "ran" ran against mocks.

## 3. The mental model

Four nouns.

- **Artifact** — one row in D1 table `artifacts` (`worker/schema.sql`): `id, kind, author, repo, title, body, native, ts`. `kind` is free-form text (`lesson`, `audit`, `tile`, ...), max 32 chars. `body` is capped at 8000 characters by the Worker (`MAX` in `worker/index.js`); the README asks for about 200 words, but that is convention, not enforced. `author` and `ts` travel with every result so a reader can weigh recency and provenance.
- **Run** — an optional row in table `runs` (`agent, repo, task, outcome, lesson_id`) written in the same `remember` call when the request includes a `run` object. It links a task outcome to the artifact it produced. Nothing in the repo reads the `runs` table back yet: no route returns it.
- **Two indexes** — D1 holds the text and is the source of truth. Two Cloudflare Vectorize indexes hold vectors keyed by artifact `id`:
  - `TIDEPOOL_SEMANTIC`: 768 dimensions, produced at write time from `body` by Workers AI model `@cf/baai/bge-base-en-v1.5`. This powers `q=` search.
  - `TIDEPOOL_NATIVE`: 16 dimensions, supplied by the caller in the optional `native` field (a domain-specific fingerprint the caller computes; the Worker does not derive it). This powers `similar?vec=`.
- **JEV gate** (optional, off by default) — `src/jev.mjs`. When `TIDEPOOL_JEV` is set, each scored recall row gets a `jev` field: `{decision: surface|suppress|abstain, confidence, sigma, reasons}`. It never removes rows; it annotates them.

How they relate: `remember` writes the artifact to D1 first, then tries each index. Index writes are best-effort, so an artifact can exist in D1 with no vector (the response says `semantic:false`). `recall` prefers the semantic index, fetches the matching rows from D1 by id, and falls back to a SQL `LIKE` scan when embedding is unavailable. The response `mode` (`semantic`, `text`, `recent`, `native`) tells you which path answered; `degraded:true` marks the text fallback.

The JEV gate in detail: two numbers are combined as σ = √(embedding_similarity × jev_confidence). If σ is below `TIDEPOOL_JEV_FLOOR` (default 0.5) the row is marked `abstain` regardless of JEV's verdict. Without `JEV_API_URL` the JEV side is a deterministic hash of the candidate's id/kind/title and the query (`createJevClient` in `src/jev.mjs`). That mock output is not a judgment about relevance; it exists so the plumbing can be tested.

## 4. Walkthrough

Shortest real run, from a fresh checkout, no Cloudflare account. This runs the repo's own suite, which drives the Worker with mocked D1/Vectorize/AI:

```
$ npm test
...
ok - remember: persists an artifact
ok - recall: semantic ranking puts the similar lesson first
ok - recall: text fallback when semantic unbound (no crash, flagged degraded)
...
tide-pool smoke: 18 passed, 0 failed
ok — table artifacts: INSERT covers all 8 declared columns
...
schema-drift pin: 8/8 green
# tests 13
# pass 13
# fail 0
```

(Output trimmed; `npm test` runs three files in sequence per `package.json`: `tests/tidepool.smoke.mjs`, `tests/schema-drift.test.mjs`, `tests/jev.test.mjs`.) Run on Node v22.22.2 in this session: all green.

For an end-to-end write-then-recall against the Worker code, see [blueprint-write-and-recall-loop.md](blueprint-write-and-recall-loop.md).

## 5. The contract

Routes (`worker/index.js`):

| Route | Input | Output / errors |
|---|---|---|
| `GET /health` | none | `{ok, service, db, semantic, native, artifacts, error}`; works with nothing bound |
| `POST /api/remember` | JSON `{author, title, body}` required; `kind` (default `lesson`), `repo`, `native` (16 finite numbers), `run {task, outcome}` optional | `{ok, id, persisted, semantic, native}`. 400 with `author_required`, `title_required`, `body_required`, `kind_too_long`, `repo_too_long`, `native_must_be_16_finite_numbers`, `bad_json`. 503 `db_unbound` |
| `GET /api/recall` | `q`, `limit` (1-50, default 8), filters `kind`, `author`, `repo` | `{ok, mode, count, results[]}`. No `q` returns `mode:"recent"`. 503 if DB unbound |
| `GET /api/recall/similar` | `id=` or `vec=` (16 comma-separated numbers), `limit` | neighbors; `id` is excluded from its own results. 404 `not_found`, 400 `id_or_vec_required`, 503 `semantic_unbound` |
| `GET /api/ledger` | `limit` (1-100, default 25) | `{count, line[], counts{kind: n}}` |

Invariants you can rely on, each pinned by a test:

- `schema.sql` columns and the `INSERT` column lists in `index.js` match exactly (`tests/schema-drift.test.mjs`).
- Missing bindings degrade to a flagged response rather than an unhandled error (`tests/tidepool.smoke.mjs`: "honest degrade" tests). Note the degrade is 503 for DB-dependent routes, not 200.
- With JEV off, responses carry no `jev` key (`tests/jev.test.mjs`: "gate is off by default").
- Malformed or unreachable JEV responses fail closed to `abstain` (`tests/jev.test.mjs`).

The receipt: `npm test` exiting 0 with the three summary lines above. That proves the code paths against mocks. It does not prove real D1 or Vectorize behavior.

## 6. Failure modes / scars

- **Real bindings are untested here.** Every test uses fakes. Vectorize metadata filtering, real BGE score ranges, and D1 behavior are unverified by this repo's suite.
- **`filter` on kind is applied twice** in semantic recall (in the Vectorize query, then in JS), but `author`/`repo` filters are applied only after retrieving `topK` neighbors (`max(limit*4, 20)`, capped at 100). A narrow author filter can therefore return fewer than `limit` rows, or zero, even if matching artifacts exist deeper in the ranking. Observed in a run: `q=backoff&author=nobody` returned `count:0`, which is correct there, but the same mechanism can hide real matches.
- **Rate limiting is per Worker isolate, in memory** (`hits` Map in `index.js`). It is not shared across isolates or regions, so 45/min/IP is approximate. `cf-connecting-ip` missing means all callers share the fingerprint `local`.
- **No authentication and CORS `*`.** Any caller who can reach the Worker can write and read. The "never secrets" rule is a convention only; nothing scans bodies.
- **No update or delete route.** Artifacts are append-only through the API. Wrong or stale notes stay until someone edits D1 directly.
- **Failed embedding after a D1 write is silent to the store.** `embed` swallows errors and returns null; the artifact is kept without a vector and only `semantic:false` in the response tells you. A caller that ignores that flag creates notes that only the text fallback or recent mode can find.
- **`similar?id=` is not gated for the native fallback path**, and `jevGate` is skipped for the text-fallback and recent modes. Only semantic recall, `similar?vec=` and semantic `similar?id=` carry `jev`.
- **JEV mock is not a relevance judge.** Turning on `TIDEPOOL_JEV=mock` in production would attach hash-derived verdicts that look meaningful.
- **Doc drift in the repo itself:** `CANON.md` lists `src/index.ts` as a canonical doc, which does not exist; the README points at a design memo (`design/2026-09-17-tide-pool.md`) that is in another workspace, not this repo; the package name is `tide-pool` while the repo is `tidepool`. `README.md` describes the `run` link but the `runs` table has no reader.
- **`wrangler.toml` ships a placeholder `database_id`** (all zeros); deploy fails until it is replaced.

## 7. How it composes

- **Callers:** any agent that can make HTTP requests. The protocol is two calls, one at task end (`POST /api/remember`), one at task start (`GET /api/recall`).
- **Platform:** Cloudflare Workers, D1, Vectorize (two indexes), Workers AI. Bindings are `DB`, `TIDEPOOL_NATIVE`, `TIDEPOOL_SEMANTIC`, `AI` in `worker/wrangler.toml`.
- **Fleet:** `CANON.md` says tidepool feeds `quilt-studio` and `duke-lab` and is owed by `hermit`, `duke-lab`, `quilt-studio`. Those repos are not in this checkout, so these docs cannot describe how they call it.
- **JEV:** optional external endpoint via `JEV_API_URL`, POSTed a `noul` question; expects `answers.genuine.noul` in [0,1]. Its contract is defined only by the client code and its fake in `tests/jev.test.mjs`.
- **Hashing idiom:** fnv1a is used for rate-limit fingerprints, duplicated in `worker/index.js` and `src/jev.mjs`.

## 8. Where to look next

- [blueprint-write-and-recall-loop.md](blueprint-write-and-recall-loop.md) — run the write/recall loop yourself.
- `worker/index.js` — the whole service in 228 lines; read `fetch` top to bottom.
- `tests/tidepool.smoke.mjs` — the mock D1/Vectorize/AI you would reuse to test a change.
