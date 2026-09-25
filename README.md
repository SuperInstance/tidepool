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
# tests 13   # pass 13   # fail 0     (jev gate unit tests)
```
plus 18 smoke checks above it (health, remember, recall, ledger, 429 rate
limit). If you see `# fail 0` twice, the ocean is sound. The `Provision`
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

`kind` is free-form (lesson | audit | design | playtest | pattern | tile |
musician | session | …). `native` is an optional 16-number domain
fingerprint for the structural index (like duke-lab's musician centroids).

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
npm test   # 31 checks: 18 smoke (mocked D1/Vectorize/AI) + 13 jev gate unit tests, deterministic embeddings
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
