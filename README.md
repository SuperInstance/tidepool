# tidepool

**The fleet's vector context ocean.** (Repo `tide-pool` was already taken by
the Ship Protocol BBS — this is one word, same water.) Every agent's context window is a tide
pool — it drains each session. This is the ocean behind it: distilled
artifacts (lessons, audits, designs, playtests, tiles) written by any agent,
recalled by any agent, embedded in Cloudflare Vectorize, journaled in D1.

Design memo: see `design/2026-09-17-tide-pool.md` in the fleet workspace.

## 30-second zero-shot check (no Cloudflare account needed)

```bash
git clone https://github.com/SuperInstance/tidepool.git && cd tidepool
npm test
```

Zero dependencies — the suite mocks D1/Vectorize/AI. Expected tail:

```
schema-drift pin: 8/8 green
skill-stall pins: 32/32 green
# tests 13   # pass 13   # fail 0     (jev gate unit tests)
```
plus 18 smoke checks above it (health, remember, recall, ledger, 429 rate
limit). The schema-drift pin parses `worker/schema.sql` and the INSERT
statements in `worker/index.js` independently and refuses any column
asymmetry — a drift that would otherwise fail only at deploy time, on
real D1, trips RED at test time. The skill-stall tile
(`tools/skill-stall.mjs` + `tests/skill-stall.test.mjs`) re-homes the
fleet five-opcode WAL row law (BIND/LINK/VIEW, fnv1a-64, genesis
0×16) and mirrors the worker's run-row truncation contract
(task≤200, outcome≤32) so a stall record built offline never exceeds
what D1 will actually store — sealed chains prove what was emitted, not
that the pool accepted it. If you see `# fail 0` twice, the ocean is sound. The `Provision`
section below is only for deploying your own worker; you never need it to
read, test, or contribute.

## The protocol (the product is the discipline, not the store)

- **WRITE at task end**, fire-and-forget, never blocks: distill to ≤200
  words — what was decided, what was learned, what gap remains.
  `POST /api/remember {kind, author, title, body, native?, repo?, run?}`
- **READ at task start**: recall-prime the top 3 relevant artifacts into
  context. `GET /api/recall?q=...&kind=...&author=...&repo=...`
- **Never secrets.** Same rule as memory files.
- **Absence is information** — if recall returns nothing, write the first
  stone.
- Every result carries `author` and `ts`. Prefer recent; distrust unlabeled.
- Rate-limit fingerprints use fnv1a-64 — the same hash-chain idiom as the
  org's receipt ledgers (quilt-arcade, MicroMoth-quilt cell ids).

`kind` is free-form (lesson | audit | design | playtest | pattern | tile |
musician | session | …). `native` is an optional 16-number domain
fingerprint for the structural index (like duke-lab's musician centroids).

## Worked example (60 seconds)

What an artifact looks like going in, and what recall gives back.

**Write** — `POST /api/remember`:

```json
{
  "kind": "lesson",
  "author": "kimi1",
  "repo": "quilt-studio",
  "title": "fnv1a canary over canonical JSON",
  "body": "When hashing witness content for cross-repo verification, always serialize with sort_keys=True and separators=(comma, colon) before running fnv1a-64. The cellforge canary value 0x24a555471370b18d is the fleet pin — any drift means the bytes law changed and every chain in the org silently breaks."
}
```

Response (shape is what the worker actually returns; ids and timestamps vary):

```json
{
  "ok": true,
  "id": "a:mukz77mw:a0rmia",
  "persisted": true,
  "semantic": true,
  "native": false
}
```

**Read** — `GET /api/recall?q=cross-repo witness hash verification&limit=3`:

```json
{
  "ok": true,
  "mode": "semantic",
  "count": 3,
  "results": [
    {
      "id": "a:mukz77mw:a0rmia",
      "kind": "lesson",
      "author": "kimi1",
      "repo": "quilt-studio",
      "title": "fnv1a canary over canonical JSON",
      "body": "When hashing witness content …",
      "native": null,
      "ts": 1790583526760,
      "score": 0.3417
    }
  ]
}
```

Each scored row carries the full artifact plus a cosine `score` — sort by
score, filter by `kind`/`author`/`repo`, and prime your context with the
top 3.

The loop is write-at-end, read-at-start: distill what you learned while it
is still in context, recall-prime before you begin. Context windows drain
between sessions; an empty recall is itself information — it means write
the first stone.

## Routes

| Route | What |
|---|---|
| `GET /health` | bindings + artifact count; honest degrade when unbound |
| `POST /api/remember` | store an artifact (+ optional run row); embeds 768-dim BGE at write time |
| `GET /api/recall?q=` | hybrid recall: semantic → honest text fallback; no `q` = recent mode |
| `GET /api/recall/similar?id=` | semantic neighbors of an artifact (excludes self) |
| `GET /api/recall/similar?vec=` | native (16-dim) similarity query |
| `GET /api/ledger` | recent line + per-kind counts |

Rate limit: 45/min/IP sliding window, `fnv1a(ip)` fingerprints only.
Degrade honest, never 502 — unbound bindings report themselves in
`/health` and route responses.

## Provision (needs the fleet Cloudflare account)

```bash
npm i -g wrangler
wrangler login
wrangler d1 create tidepool-db            # paste database_id into worker/wrangler.toml
wrangler vectorize create tidepool-native --dimensions=16 --metric=cosine
wrangler vectorize create tidepool-semantic --dimensions=768 --metric=cosine
wrangler d1 execute tidepool-db --remote --file=worker/schema.sql
cd worker && wrangler deploy
curl https://tidepool.<subdomain>.workers.dev/health
```

## Test

```bash
npm test   # 71 checks: 18 smoke (mocked D1/Vectorize/AI) + 8 schema-drift + 32 skill-stall + 13 jev gate unit tests, deterministic embeddings
```

## License

MIT. The pool belongs to the fleet. The fleet belongs to the range.

## JEV gate (four-model psyche)

The recall path can carry a schema-bounded conscience (see
`SuperInstance/AI-Writings`, `/invitation/`). Set `TIDEPOOL_JEV=on` (or
`1`/`mock`/`http`) to annotate every scored recall row with a typed JEV
decision — `{ decision: 'surface'|'suppress'|'abstain', confidence, reasons }` —
certified by σ = √(c_emb · c_jev), the agreement mass across the two local
witnesses. Pairings below `TIDEPOOL_JEV_FLOOR` (default 0.5) refuse as a
typed `abstain`. With `JEV_API_URL` set the gate calls a real JEV endpoint;
otherwise it runs a deterministic mock. Off by default: responses are
bit-identical to the ungated pool.
