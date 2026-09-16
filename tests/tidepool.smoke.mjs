// tide-pool smoke tests — mocked D1/Vectorize/AI, no network.
// Deterministic trigram embeddings make semantic ranking testable.
import worker from '../worker/index.js';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('ok -', name); }
  catch (e) { fail++; console.log('FAIL -', name, '\n   ', e.message); }
}
function eq(a, b, m = '') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }
function ok(a, m = '') { if (!a) throw new Error(m || 'not ok'); }

// ---------- fakes ----------
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
          if (s.startsWith('INSERT INTO runs')) { const [id, agent, repo, task, outcome, lesson_id, ts] = args; store.runs.push({ id, agent, repo, task, outcome, lesson_id, ts }); return { success: true }; }
          if (/COUNT\(\*\).*FROM artifacts/.test(s)) return { success: true, results: { c: store.artifacts.length } };
          return { success: true };
        },
        async first() {
          if (s.startsWith('SELECT * FROM artifacts WHERE id = ?')) return store.artifacts.find(a => a.id === args[0]) || null;
          if (/COUNT\(\*\).*FROM artifacts/.test(s)) return { c: store.artifacts.length };
          return null;
        },
        async all() {
          if (s.includes('WHERE id IN')) { const ids = new Set(args); return { results: store.artifacts.filter(a => ids.has(a.id)) }; }
          if (s.includes('LIKE')) { const n = String(args[0]).replaceAll('%', '').toLowerCase(); return { results: store.artifacts.filter(a => a.title.toLowerCase().includes(n) || a.body.toLowerCase().includes(n)).sort((x, y) => y.ts - x.ts).slice(0, 100) }; }
          if (/GROUP BY kind/.test(s)) { const by = {}; for (const a of store.artifacts) by[a.kind] = (by[a.kind] || 0) + 1; return { results: Object.entries(by).map(([kind, c]) => ({ kind, c })) }; }
          if (/ORDER BY ts DESC LIMIT/.test(s)) { const lm = s.match(/LIMIT (\d+)/); const lim = lm ? parseInt(lm[1], 10) : (args[0] ?? 100); return { results: [...store.artifacts].sort((x, y) => y.ts - x.ts).slice(0, lim) }; }
          return { results: [] };
        },
      });
      return make([]);
    },
  };
}

function makeEnv(opts = {}) {
  const store = { artifacts: [], runs: [] };
  const env = { _store: store };
  if (opts.db !== false) env.DB = makeD1(store);
  if (opts.ai !== false) env.AI = { run: async (m, { text }) => ({ data: [fakeEmbed(text)] }) };
  if (opts.semantic !== false) env.TIDEPOOL_SEMANTIC = makeIndex();
  if (opts.native !== false) env.TIDEPOOL_NATIVE = makeIndex();
  return env;
}

let ipSeq = 1;
const call = (env, method, path, body, ip) =>
  worker.fetch(new Request('https://pool.test' + path, {
    method,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip || `10.9.${(ipSeq++ % 250) + 1}.${(ipSeq * 7) % 250}` },
    body: body ? JSON.stringify(body) : undefined,
  }), env).then(async r => ({ status: r.status, json: await r.json() }));

// ---------- tests ----------
async function seed(env) {
  await call(env, 'POST', '/api/remember', { kind: 'lesson', author: 'kimi1', title: 'Theia DI calibration', body: 'the spring damper smooths agent transitions with critical damping and overdamped response', repo: 'quilt-studio' });
  await call(env, 'POST', '/api/remember', { kind: 'lesson', author: 'mavis', title: 'Viewport kennel', body: 'parliament ring seeding on small viewports needs the kennel fence and spring containment', repo: 'rune-quilt' });
  await call(env, 'POST', '/api/remember', { kind: 'tile', author: 'zc', title: 'Trend: five opcodes', body: 'tiles about bind link effect view tick are compounding across the fleet', native: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
}

await t('health: honest degrade when fully unbound', async () => {
  const r = await call({}, 'GET', '/health');
  eq(r.status, 200); eq(r.json.ok, true); eq(r.json.db, false); eq(r.json.semantic, false); eq(r.json.native, false); eq(r.json.artifacts, null);
});

await t('health: reports bindings and counts when bound', async () => {
  const env = makeEnv(); await seed(env);
  const r = await call(env, 'GET', '/health');
  eq(r.json.db, true); eq(r.json.semantic, true); eq(r.json.native, true); eq(r.json.artifacts, 3);
});

await t('remember: persists an artifact', async () => {
  const env = makeEnv();
  const r = await call(env, 'POST', '/api/remember', { kind: 'design', author: 'kimi1', title: 'Studio thesis', body: 'the polyformalism is the studio architecture' });
  eq(r.status, 200); ok(r.json.id.startsWith('a:'), 'id prefix'); eq(r.json.persisted, true); eq(env._store.artifacts.length, 1);
});

await t('remember: stores a run row when run attached', async () => {
  const env = makeEnv();
  const r = await call(env, 'POST', '/api/remember', { author: 'kimi1', title: 'Shift closeout', body: 'duke-lab v2 shipped', run: { task: 'foundry v2', outcome: 'ok' } });
  eq(r.status, 200); eq(env._store.runs.length, 1); eq(env._store.runs[0].lesson_id, r.json.id); eq(env._store.runs[0].outcome, 'ok');
});

await t('remember: semantic embedding computed when AI bound', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/api/remember', { author: 'kimi1', title: 'Damping note', body: 'critical damping smooths the transition curve' });
  const r = await call(env, 'GET', '/api/recall?q=damping transition smoothing');
  eq(r.json.mode, 'semantic'); eq(r.json.results[0].title, 'Damping note');
});

await t('remember: degrades honestly without AI (persisted, semantic:false)', async () => {
  const env = makeEnv({ ai: false });
  const r = await call(env, 'POST', '/api/remember', { author: 'kimi1', title: 'No AI note', body: 'stored without embedding' });
  eq(r.status, 200); eq(r.json.persisted, true); eq(r.json.semantic, false);
});

await t('remember: 400 on missing author', async () => {
  const r = await call(makeEnv(), 'POST', '/api/remember', { title: 'x', body: 'y' });
  eq(r.status, 400); eq(r.json.error, 'author_required');
});

await t('remember: 400 on bad native vector', async () => {
  const r = await call(makeEnv(), 'POST', '/api/remember', { author: 'kimi1', title: 'x', body: 'y', native: [1, 2, 3] });
  eq(r.status, 400); eq(r.json.error, 'native_must_be_16_finite_numbers');
});

await t('recall: semantic ranking puts the similar lesson first', async () => {
  const env = makeEnv(); await seed(env);
  const r = await call(env, 'GET', '/api/recall?q=damping transitions agent smoothing');
  eq(r.json.mode, 'semantic'); eq(r.json.results[0].author, 'kimi1'); eq(r.json.results[0].title, 'Theia DI calibration');
});

await t('recall: kind filter scopes results', async () => {
  const env = makeEnv(); await seed(env);
  const r = await call(env, 'GET', '/api/recall?q=fleet opcodes&kind=tile');
  eq(r.json.results.every(x => x.kind === 'tile'), true);
});

await t('recall: author filter scopes results', async () => {
  const env = makeEnv(); await seed(env);
  const r = await call(env, 'GET', '/api/recall?q=viewport ring fence&author=mavis');
  eq(r.json.results.length, 1); eq(r.json.results[0].author, 'mavis');
});

await t('recall: no q returns recent mode in ts order', async () => {
  const env = makeEnv(); await seed(env);
  const r = await call(env, 'GET', '/api/recall?limit=3');
  eq(r.json.mode, 'recent'); eq(r.json.results.length, 3);
  const ts = r.json.results.map(x => x.ts); eq([...ts].sort((a, b) => b - a), ts, 'descending ts');
});

await t('recall: text fallback when semantic unbound (no crash, flagged degraded)', async () => {
  const env = makeEnv({ ai: false }); await seed(env);
  const r = await call(env, 'GET', '/api/recall?q=kennel');
  eq(r.json.ok, true); eq(r.json.mode, 'text'); eq(r.json.degraded, true);
  ok(r.json.results.some(x => x.title === 'Viewport kennel'), 'found by keyword');
});

await t('recall/similar?id= finds neighbors, excludes self', async () => {
  const env = makeEnv(); await seed(env);
  const first = env._store.artifacts.find(a => a.title === 'Theia DI calibration');
  await call(env, 'POST', '/api/remember', { kind: 'lesson', author: 'kimi1', title: 'Damping again', body: 'the damping curve smooths transitions again with critical response' });
  const r = await call(env, 'GET', `/api/recall/similar?id=${first.id}&limit=3`);
  eq(r.json.ok, true);
  ok(r.json.results.length > 0, 'has neighbors');
  eq(r.json.results.some(x => x.id === first.id), false, 'self excluded');
  eq(r.json.results[0].kind, 'lesson');
});

await t('recall/similar?vec= queries the native index', async () => {
  const env = makeEnv(); await seed(env);
  const r = await call(env, 'GET', '/api/recall/similar?vec=1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0&limit=5');
  eq(r.json.ok, true); eq(r.json.mode, 'native'); eq(r.json.results[0].kind, 'tile');
});

await t('recall/similar: 404 on unknown id', async () => {
  const r = await call(makeEnv(), 'GET', '/api/recall/similar?id=a:nope:1');
  eq(r.status, 404);
});

await t('ledger: returns line and kind counts', async () => {
  const env = makeEnv(); await seed(env);
  const r = await call(env, 'GET', '/api/ledger');
  eq(r.json.ok, true); eq(r.json.count, 3); eq(r.json.counts.lesson, 2); eq(r.json.counts.tile, 1);
  ok(r.json.line.every(x => 'kind' in x && 'author' in x && 'title' in x), 'line shape');
});

await t('429s engage inside the window', async () => {
  const env = makeEnv();
  let limited = 0;
  for (let i = 0; i < 50; i++) {
    const r = await call(env, 'GET', '/health', null, '10.9.250.250');
    if (r.status === 429) limited++;
  }
  ok(limited > 0 && limited < 60, `limited=${limited} on a dedicated ip`);
});

console.log(`\ntide-pool smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
