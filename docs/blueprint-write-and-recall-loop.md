# Blueprint: the write-then-recall loop

## 1. In one breath

Store one distilled lesson through `POST /api/remember`, then retrieve it by meaning through `GET /api/recall?q=`, which is the loop every tidepool caller is meant to run at the end and start of a task.

## 2. Why it exists

Before this, a lesson learned in one agent session was gone when the window closed, unless someone hand-copied it into a file that only one repo saw. The loop makes the lesson a row in a shared store that a different agent can find by describing its problem in its own words, not by knowing the original title or keywords.

## 3. The mental model

- **Write side (task end):** one HTTP POST with `author`, `title`, `body`, and optionally `kind`, `repo`, `native`, `run`. The Worker saves the row in D1, then embeds `body` into the 768-dim semantic index.
- **Read side (task start):** one HTTP GET with a free-text `q`. The Worker embeds `q`, asks the index for nearest neighbors, loads those rows from D1, and returns them sorted by cosine `score`.
- **Mode is the honesty field.** `semantic` means vectors answered. `text` (with `degraded:true`) means embedding was unavailable and a substring `LIKE` search answered. `recent` means you sent no `q`.
- **Empty is an answer.** `count:0` means nothing in the pool matched under your filters; the README's rule is that this is the cue to write the first note.
- **JEV gate (optional):** annotates rows with a typed verdict; explained in `docs/understanding-tidepool.md` section 3.

The distillation itself (what to put in `body`) is the caller's job. The Worker checks length (1 to 8000 characters, non-blank) and nothing else about quality.

## 4. Walkthrough

This uses the real Worker module (`worker/index.js`) with in-memory stand-ins for D1, Vectorize and Workers AI, so it needs only Node (tested on v22.22.2) and no Cloudflare account. The stand-in "embedding" is a deterministic character-trigram hash, so the scores below say the two texts share wording; they do not show what real BGE embeddings would score.

Save the script below as `loop.mjs` in a scratch directory outside the repo, `cd` to the repo root, and pipe it in (relative imports resolve against the working directory when piped):

```
node --input-type=module < /path/to/loop.mjs
```

Script contents:

```js
import worker from './worker/index.js';

// --- minimal in-memory stand-ins for D1, Vectorize and Workers AI ---
const rows = [];
const embed = (t) => { const v = new Array(768).fill(0); const s = ' ' + t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ') + ' ';
  for (let i = 0; i < s.length - 2; i++) { let h = 0; for (const c of s.slice(i, i + 3)) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % 768]++; }
  const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
const cos = (a, b) => a.reduce((d, x, i) => d + x * b[i], 0);
const vecs = new Map();
const env = {
  AI: { run: async (_m, { text }) => ({ data: [embed(text)] }) },
  TIDEPOOL_SEMANTIC: {
    upsert: async (vs) => vs.forEach(v => vecs.set(v.id, v.values)),
    query: async ({ vector, topK }) => ({ matches: [...vecs].map(([id, v]) => ({ id, score: cos(vector, v) })).sort((a, b) => b.score - a.score).slice(0, topK) }),
  },
  DB: { prepare: (sql) => { let a = []; const o = {
    bind: (...x) => { a = x; return o; },
    run: async () => { if (sql.startsWith('INSERT INTO artifacts')) { const [id, kind, author, repo, title, body, native, ts] = a; rows.push({ id, kind, author, repo, title, body, native, ts }); } return {}; },
    all: async () => ({ results: sql.includes('WHERE id IN') ? rows.filter(r => a.includes(r.id)) : [...rows].reverse() }),
    first: async () => ({ c: rows.length }) }; return o; } },
};
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request('https://pool.test' + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }), env);
  return r.json();
};

// WRITE at task end
const w = await call('POST', '/api/remember', { kind: 'lesson', author: 'agent-a', repo: 'demo',
  title: 'Retry with jitter', body: 'Retrying failed uploads without jitter caused a thundering herd; add random jitter to the backoff.' });
console.log(JSON.stringify({ ...w, id: w.id.replace(/:.*:/, ':<ts>:') }));

// READ at task start
const r = await call('GET', '/api/recall?q=backoff retry jitter herd&limit=3');
console.log(JSON.stringify({ ...r, results: r.results.map(x => ({ title: x.title, author: x.author, score: +x.score.toFixed(4) })) }));

// Empty pool question: a filter that matches nothing
console.log(JSON.stringify(await call('GET', '/api/recall?q=backoff&author=nobody')));

// Same query with the JEV gate on (mock mode)
env.TIDEPOOL_JEV = 'mock';
const g = await call('GET', '/api/recall?q=backoff retry jitter herd&limit=3');
console.log(JSON.stringify({ jev: g.jev, row: g.results[0].jev }, null, 1));
```

Actual output from running exactly that (the script masks the id's timestamp segment; the random suffix differs per run):

```
{"ok":true,"id":"a:<ts>:om6ydu","persisted":true,"semantic":true,"native":false}
{"ok":true,"mode":"semantic","count":1,"results":[{"title":"Retry with jitter","author":"agent-a","score":0.5127}]}
{"ok":true,"mode":"semantic","count":0,"results":[]}
{
 "jev": {
  "gated": true,
  "mode": "mock",
  "floor": 0.5,
  "surfaced": 1,
  "suppressed": 0,
  "abstained": 0
 },
 "row": {
  "decision": "surface",
  "confidence": 0.6927067645932089,
  "sigma": 0.6927067645932089,
  "reasons": [
   "mock:deterministic_hash",
   "mock:p=0.936",
   "witness:emb=0.513",
   "witness:jev=0.936",
   "sigma=0.693"
  ]
 }
}
```

Reading it: line 1 is the write receipt. Line 2 shows the query "backoff retry jitter herd", which shares no exact title with the stored lesson, still returning it, with a score of 0.5127. Line 3 shows the same query filtered to an author with no artifacts: `count:0`. Lines 4 onward show the JEV gate in mock mode: σ = √(0.513 × 0.936) = 0.693, above the 0.5 floor, so the mock verdict `surface` stands. The 0.936 is a hash of the inputs, not a relevance judgment.

Against a deployed Worker the same two calls are plain curl (intended shape; not run here because it needs a deployed Worker):

```
curl -X POST https://tidepool.<subdomain>.workers.dev/api/remember \
  -H 'content-type: application/json' \
  -d '{"kind":"lesson","author":"agent-a","repo":"demo","title":"Retry with jitter","body":"..."}'
curl 'https://tidepool.<subdomain>.workers.dev/api/recall?q=backoff+retry+jitter&limit=3'
```

Provisioning steps (D1, two Vectorize indexes with 16 and 768 dimensions, `wrangler deploy`, replacing the placeholder `database_id` in `worker/wrangler.toml`) are in `README.md` under "Provision". They were not run for these docs.

## 5. The contract

Inputs (write): `author`, `title`, `body` non-blank strings within 64 / 200 / 8000 characters; `kind` up to 32 (default `lesson`); `repo` up to 128; `native` exactly 16 finite numbers; `run` an object whose `task` (truncated to 200) and `outcome` (truncated to 32) are stored in `runs`.

Inputs (read): `q` (free text), `limit` 1 to 50 (default 8), optional exact-match filters `kind`, `author`, `repo`.

Outputs: write returns `{ok, id, persisted, semantic, native}` where `id` has the form `a:<base36 time>:<6 random chars>`. Read returns `{ok, mode, count, results}`; each result is the full stored row, plus `score` in semantic mode.

Invariants:
1. `persisted:true` means the row is in D1. `semantic:true` means the vector is also indexed. The two can differ.
2. Reads never mutate.
3. Missing D1 gives 503, not a crash; missing AI or semantic index gives the `text` fallback on recall and `semantic:false` on write.

The receipt: the write response `id`, then the same `id` appearing in a recall result. `GET /api/ledger` shows the newest ids and per-kind counts, a second check that the write landed. `npm test` covering these paths is green (18 smoke + 8 drift + 13 unit checks in this session).

## 6. Failure modes / scars

- `semantic:false` on write: no vector was stored (AI or index unbound, or embedding threw and was swallowed). That note is findable only by text fallback or recent mode.
- A recall that returns fewer than `limit` rows with an `author` or `repo` filter: those filters run after the top-K neighbor fetch, so they can drop everything. Widen `q` or drop the filter to check.
- `mode:"text"`: only a literal substring of `q` (first 80 chars) in title or body matches. Multi-word natural language queries will usually return nothing in this mode.
- 400 `native_must_be_16_finite_numbers`: `native` must be exactly 16 numbers or omitted.
- 429 `rate_limited`: 45 requests per minute per IP fingerprint, per isolate.
- Secrets: nothing stops you from writing one into `body`, and the API has no delete. Do not.
- Scores are cosine values from whichever embedder is bound; the trigram stand-in above gives 0.51 for a clearly on-topic pair, so do not hard-code a score threshold from these numbers.

## 7. How it composes

Write and recall are HTTP, so any agent harness can wrap them: a task-end hook that POSTs a distilled summary, a task-start step that GETs the top 3 and pastes them into context (the README's suggested protocol). Filters (`repo`, `author`, `kind`) scope recall to one project, one agent, or one artifact type. `run` attaches a task outcome to the artifact. `similar?id=` starts from an existing artifact instead of a question. No client library or hook is provided in this repo; the wrapper is yours to write.

## 8. Where to look next

- [understanding-tidepool.md](understanding-tidepool.md) — the whole system and its known gaps.
- `worker/index.js` (the `/api/remember` and `/api/recall` branches) — exact validation and fallback order.
- `tests/tidepool.smoke.mjs` — richer mocks and the cases that pin this behavior.
