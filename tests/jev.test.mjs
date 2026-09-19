// JEV gate tests — node:test, no deps, no network.
// Unit: mock determinism, schema validity on every response, sigma-floor
// refusal, confidence monotonicity, http-mode mapping with fake fetch.
// Integration: the worker's recall path gated behind TIDEPOOL_JEV.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createJevClient, gateRecall, agreementMass, validateJevDecision } from '../src/jev.mjs';
import worker from '../worker/index.js';

// ---------- shape helpers ----------
function assertDecisionShape(d, where) {
  assert.ok(validateJevDecision(d), `${where}: schema-valid decision, got ${JSON.stringify(d)}`);
  assert.ok(typeof d.sigma === 'number' || d.sigma === undefined, `${where}: sigma field sane`);
}

// ---------- unit: mock determinism ----------
test('mock: identical input -> identical typed decision', async () => {
  const jev = createJevClient({});
  assert.equal(jev.mode, 'mock');
  const c = { id: 'a:xyz:1', kind: 'lesson', title: 'Damping again', body: 'critical damping smooths transitions' };
  const a = await jev.scoreRecall({ candidate: c, query: 'damping' });
  const b = await jev.scoreRecall({ candidate: c, query: 'damping' });
  assert.deepEqual(a, b);
  assertDecisionShape(a, 'mock');
});

test('mock: different input -> decision still schema-valid', async () => {
  const jev = createJevClient({});
  for (let i = 0; i < 25; i++) {
    const d = await jev.scoreRecall({ candidate: { id: `a:t:${i}`, kind: 'lesson', title: `note ${i}` }, query: `q${i}` });
    assertDecisionShape(d, `mock#${i}`);
  }
});

// ---------- unit: http mode against a fake JEV server ----------
function fakeFetchReplier(replies) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetchImpl, calls };
}
const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('http: noul probability maps to surface/suppress/abstain', async () => {
  const mk = (p) => {
    const { fetchImpl, calls } = fakeFetchReplier([jsonRes({ answers: { genuine: { noul: p } } })]);
    return { client: createJevClient({ apiUrl: 'https://jev.test/v1/systemone', fetchImpl }), calls };
  };
  let { client, calls } = mk(0.91);
  let d = await client.scoreRecall({ candidate: { title: 't', body: 'b' }, query: 'q' });
  assert.equal(d.decision, 'surface'); assert.ok(Math.abs(d.confidence - 0.91) < 1e-9);
  assert.equal(calls[0].url, 'https://jev.test/v1/systemone');
  assert.equal(JSON.parse(calls[0].opts.body).questions.genuine.type, 'noul');

  ({ client } = mk(0.04));
  d = await client.scoreRecall({ candidate: { title: 't' }, query: 'q' });
  assert.equal(d.decision, 'suppress'); assert.ok(Math.abs(d.confidence - 0.96) < 1e-9);

  ({ client } = mk(0.5));
  d = await client.scoreRecall({ candidate: { title: 't' }, query: 'q' });
  assert.equal(d.decision, 'abstain'); assert.ok(Math.abs(d.confidence - 1) < 1e-9);
  assertDecisionShape(d, 'http abstain');
});

test('http: malformed body / network error fail closed to typed abstain', async () => {
  for (const replies of [
    [jsonRes({ garbage: true })],
    [jsonRes({ answers: { genuine: { noul: 'nope' } } })],
    [new Error('socket hangup')],
  ]) {
    const { fetchImpl } = fakeFetchReplier(replies);
    const client = createJevClient({ apiUrl: 'https://jev.test/v1/systemone', fetchImpl, timeoutMs: 100 });
    const d = await client.scoreRecall({ candidate: { title: 't' }, query: 'q' });
    assert.equal(d.decision, 'abstain');
    assert.ok(d.reasons.some((r) => r.startsWith('jev_')), 'carries a failure reason');
    assertDecisionShape(d, 'http fail-closed');
  }
});

test('http: JEV_API_URL env picked up when apiUrl omitted', async () => {
  const { fetchImpl, calls } = fakeFetchReplier([jsonRes({ answers: { genuine: { noul: 0.85 } } })]);
  const client = createJevClient({ apiUrl: 'https://env-var.example/v1/systemone', fetchImpl });
  assert.equal(client.mode, 'http');
  await client.scoreRecall({ candidate: { title: 't' }, query: 'q' });
  assert.equal(calls[0].url, 'https://env-var.example/v1/systemone');
});

// ---------- unit: sigma ----------
test('sigma: agreementMass follows the primer formula', () => {
  assert.equal(agreementMass([]), 0);
  assert.ok(Math.abs(agreementMass([1, 1]) - 1) < 1e-12);
  assert.ok(Math.abs(agreementMass([0.5, 0.5]) - 0.5) < 1e-12);
  assert.ok(Math.abs(agreementMass([0.25]) - 0.5) < 1e-12); // sqrt(0.25)
  assert.ok(agreementMass([0.9, 0.4]) > agreementMass([0.4, 0.4]));
});

test('floor: below-floor pairing refuses with a typed abstain', () => {
  const g = gateRecall({
    jev: { decision: 'surface', confidence: 0.9, reasons: ['jev:p=0.900'] },
    similarity: 0.1, // sigma = sqrt(0.09) = 0.3 < 0.5
    sigmaFloor: 0.5,
  });
  assert.equal(g.decision, 'abstain');
  assert.ok(Math.abs(g.sigma - 0.3) < 1e-12);
  assert.ok(g.reasons.some((r) => r.startsWith('sigma_floor_refusal')));
  assert.ok(validateJevDecision(g));
});

test('floor: passing pairing keeps JEV verdict with blended confidence', () => {
  const g = gateRecall({
    jev: { decision: 'suppress', confidence: 0.9, reasons: ['jev:p=0.050'] },
    similarity: 0.9, // sigma = sqrt(0.81) = 0.9
    sigmaFloor: 0.5,
  });
  assert.equal(g.decision, 'suppress');
  assert.ok(Math.abs(g.confidence - 0.9) < 1e-12);
  assert.ok(validateJevDecision(g));
});

test('floor: untyped JEV input fails closed', () => {
  const g = gateRecall({ jev: { nope: true }, similarity: 1, sigmaFloor: 0.1 });
  assert.equal(g.decision, 'abstain');
  assert.ok(g.reasons.includes('jev_untyped_input'));
});

test('monotonicity: closer memory never lowers confidence', () => {
  for (const jevConf of [0.4, 0.7, 0.95]) {
    const jev = { decision: 'surface', confidence: jevConf, reasons: ['fixed'] };
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const sim = i / 20;
      const g = gateRecall({ jev, similarity: sim, sigmaFloor: 0 });
      assert.ok(g.confidence >= prev - 1e-12, `monotone at sim=${sim} jev=${jevConf}`);
      prev = g.confidence;
    }
  }
});

// ---------- integration: the worker recall path ----------
function fakeEmbed(text, dims = 768) {
  const v = new Array(dims).fill(0);
  const s = ' ' + String(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ') + ' ';
  for (let i = 0; i < s.length - 2; i++) {
    let h = 0; const tri = s.slice(i, i + 3);
    for (const c of tri) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % dims] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}
function cosine(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }
function makeIndex() {
  const m = new Map();
  return {
    async upsert(vectors) { for (const v of vectors) m.set(v.id, { id: v.id, values: v.values, metadata: v.metadata || {} }); },
    async query(opts) {
      let items = [...m.values()];
      if (opts.filter) for (const k of Object.keys(opts.filter)) items = items.filter(v => v.metadata[k] === opts.filter[k]);
      return { matches: items.map(v => ({ id: v.id, score: cosine(opts.vector, v.values), metadata: v.metadata })).sort((a, b) => b.score - a.score).slice(0, opts.topK) };
    },
  };
}
function makeD1(store) {
  return {
    prepare(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      const make = (args) => ({
        bind(...more) { return make([...args, ...more]); },
        async run() {
          if (s.startsWith('INSERT INTO artifacts')) { const [id, kind, author, repo, title, body, native, ts] = args; store.artifacts.push({ id, kind, author, repo, title, body, native, ts }); return { success: true }; }
          return { success: true };
        },
        async first() {
          if (s.startsWith('SELECT * FROM artifacts WHERE id = ?')) return store.artifacts.find(a => a.id === args[0]) || null;
          return null;
        },
        async all() {
          if (s.includes('WHERE id IN')) { const ids = new Set(args); return { results: store.artifacts.filter(a => ids.has(a.id)) }; }
          if (/ORDER BY ts DESC LIMIT/.test(s)) { const lm = s.match(/LIMIT (\d+)/); const lim = lm ? parseInt(lm[1], 10) : (args[0] ?? 100); return { results: [...store.artifacts].sort((x, y) => y.ts - x.ts).slice(0, lim) }; }
          return { results: [] };
        },
      });
      return make([]);
    },
  };
}
function makeEnv() {
  const store = { artifacts: [], runs: [] };
  return {
    _store: store,
    DB: makeD1(store),
    AI: { run: async (m, { text }) => ({ data: [fakeEmbed(text)] }) },
    TIDEPOOL_SEMANTIC: makeIndex(),
    TIDEPOOL_NATIVE: makeIndex(),
  };
}
let ipSeq = 1;
const call = (env, method, path, body) =>
  worker.fetch(new Request('https://pool.test' + path, {
    method,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `10.9.${(ipSeq++ % 250) + 1}.${(ipSeq * 7) % 250}` },
    body: body ? JSON.stringify(body) : undefined,
  }), env).then(async r => ({ status: r.status, json: await r.json() }));

async function seed(env) {
  await call(env, 'POST', '/api/remember', { kind: 'lesson', author: 'kimi1', title: 'Theia DI calibration', body: 'the spring damper smooths agent transitions with critical damping and overdamped response', repo: 'quilt-studio' });
  await call(env, 'POST', '/api/remember', { kind: 'lesson', author: 'mavis', title: 'Viewport kennel', body: 'parliament ring seeding on small viewports needs the kennel fence and spring containment', repo: 'rune-quilt' });
  await call(env, 'POST', '/api/remember', { kind: 'tile', author: 'zc', title: 'Trend: five opcodes', body: 'tiles about bind link effect view tick are compounding across the fleet', native: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
}

test('integration: gated recall annotates every row with a typed decision', async () => {
  const env = makeEnv();
  env.TIDEPOOL_JEV = 'mock';
  await seed(env);
  const r = await call(env, 'GET', '/api/recall?q=damping transitions agent smoothing');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.jev.gated, true);
  assert.equal(r.json.jev.mode, 'mock');
  const { surfaced, suppressed, abstained } = r.json.jev;
  assert.equal(surfaced + suppressed + abstained, r.json.results.length);
  for (const row of r.json.results) {
    assert.ok(validateJevDecision(row.jev), `row ${row.id} carries typed decision`);
    assert.equal(typeof row.jev.sigma, 'number');
    assert.ok(row.jev.sigma >= 0 && row.jev.sigma <= 1);
  }
});

test('integration: gate is off by default — responses unchanged', async () => {
  const env = makeEnv();
  await seed(env);
  const r = await call(env, 'GET', '/api/recall?q=damping transitions');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.jev, undefined);
  assert.ok(r.json.results.every(row => row.jev === undefined));
});

test('integration: native similar-vec path gates with typed decisions', async () => {
  const env = makeEnv();
  env.TIDEPOOL_JEV = 'on';
  await seed(env);
  const r = await call(env, 'GET', '/api/recall/similar?vec=1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0&limit=5');
  assert.equal(r.json.jev.gated, true);
  for (const row of r.json.results) assert.ok(validateJevDecision(row.jev), 'native rows typed');
});
