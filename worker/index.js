// tide-pool — the fleet's vector context ocean.
// Routes: /health, /api/remember, /api/recall, /api/recall/similar, /api/ledger
// Discipline carried over from duke-lab: degrade honest (never 502),
// 45/min/IP sliding window, fnv1a(ip) fingerprints, no secrets in the pool.

const WINDOW_MS = 60_000;
const LIMIT = 45;

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

const hits = new Map();
function rateOk(fp) {
  const now = Date.now();
  const arr = (hits.get(fp) || []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(fp, arr);
  if (hits.size > 10_000) hits.clear(); // cheap hygiene
  return arr.length <= LIMIT;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });
}

const MAX = { kind: 32, author: 64, repo: 128, title: 200, body: 8000 };
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

async function embed(env, text) {
  if (!env.AI || !env.TIDEPOOL_SEMANTIC) return null;
  try {
    const res = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text });
    const v = res?.data?.[0] || res?.vector || (Array.isArray(res) ? res[0] : null);
    return Array.isArray(v) && v.length === 768 ? v : null;
  } catch { return null; }
}

function applyFilters(rows, sp) {
  let out = rows;
  if (sp.get('kind')) out = out.filter(r => r.kind === sp.get('kind'));
  if (sp.get('author')) out = out.filter(r => r.author === sp.get('author'));
  if (sp.get('repo')) out = out.filter(r => r.repo === sp.get('repo'));
  return out;
}

async function rowsByIds(env, ids) {
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  const r = await env.DB.prepare(`SELECT * FROM artifacts WHERE id IN (${marks})`).bind(...ids).all();
  return r.results || [];
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const ip = req.headers.get('cf-connecting-ip') || 'local';
    if (!rateOk(fnv1a(String(ip)))) {
      return json({ ok: false, error: 'rate_limited', limit: `${LIMIT}/min`, hint: 'the pool is liberal; please stay in it' }, 429);
    }
    const u = new URL(req.url);
    const p = u.pathname;

    if (p === '/health') {
      let artifacts = null, error = null;
      if (env.DB) { try { artifacts = (await env.DB.prepare('SELECT COUNT(*) AS c FROM artifacts').first())?.c ?? null; } catch (e) { error = String(e); } }
      return json({ ok: true, service: 'tide-pool', db: !!env.DB, semantic: !!(env.AI && env.TIDEPOOL_SEMANTIC), native: !!env.TIDEPOOL_NATIVE, artifacts, error });
    }

    if (p === '/api/remember' && req.method === 'POST') {
      let body; try { body = await req.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
      const kind = (body.kind || 'lesson').toString();
      const author = (body.author || '').toString();
      const title = (body.title || '').toString();
      const text = (body.body || '').toString();
      const repo = body.repo ? body.repo.toString() : null;
      if (!str(author, MAX.author)) return json({ ok: false, error: 'author_required' }, 400);
      if (!str(title, MAX.title)) return json({ ok: false, error: 'title_required' }, 400);
      if (!str(text, MAX.body)) return json({ ok: false, error: 'body_required' }, 400);
      if (!str(kind, MAX.kind)) return json({ ok: false, error: 'kind_too_long' }, 400);
      if (repo && !str(repo, MAX.repo)) return json({ ok: false, error: 'repo_too_long' }, 400);
      let native = null;
      if (body.native != null) {
        if (!Array.isArray(body.native) || body.native.length !== 16 || !body.native.every(Number.isFinite)) {
          return json({ ok: false, error: 'native_must_be_16_finite_numbers' }, 400);
        }
        native = body.native.map(Number);
      }
      if (!env.DB) return json({ ok: false, error: 'db_unbound', persisted: false }, 503);
      const id = 'a:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 8);
      const ts = Date.now();
      await env.DB.prepare('INSERT INTO artifacts (id,kind,author,repo,title,body,native,ts) VALUES (?,?,?,?,?,?,?,?)')
        .bind(id, kind, author, repo, title, text, native ? JSON.stringify(native) : null, ts).run();
      let semantic = false;
      const vec = await embed(env, text);
      if (vec) {
        await env.TIDEPOOL_SEMANTIC.upsert([{ id, values: vec, metadata: { kind, author } }]);
        semantic = true;
      }
      let nativeStored = false;
      if (native && env.TIDEPOOL_NATIVE) {
        try { await env.TIDEPOOL_NATIVE.upsert([{ id, values: native, metadata: { kind, author } }]); nativeStored = true; } catch { /* degraded */ }
      }
      if (body.run && typeof body.run === 'object') {
        const r = body.run;
        await env.DB.prepare('INSERT INTO runs (id,agent,repo,task,outcome,lesson_id,ts) VALUES (?,?,?,?,?,?,?)')
          .bind('r:' + id.slice(2), author, repo || null, (r.task || '').toString().slice(0, 200), (r.outcome || '').toString().slice(0, 32), id, ts).run();
      }
      return json({ ok: true, id, persisted: true, semantic, native: nativeStored });
    }

    if (p === '/api/recall') {
      const q = (u.searchParams.get('q') || '').trim();
      const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '8', 10) || 8, 1), 50);
      if (!env.DB) return json({ ok: false, error: 'db_unbound', results: [], degraded: true }, 503);
      if (q) {
        const vec = await embed(env, q);
        if (vec) {
          const filter = u.searchParams.get('kind') ? { kind: u.searchParams.get('kind') } : undefined;
          const qr = await env.TIDEPOOL_SEMANTIC.query({ topK: Math.min(Math.max(limit * 4, 20), 100), vector: vec, filter });
          const ids = (qr.matches || []).map(m => m.id);
          const scoreById = new Map((qr.matches || []).map(m => [m.id, m.score]));
          let rows = await rowsByIds(env, ids);
          rows = applyFilters(rows, u.searchParams).slice(0, limit);
          rows = rows.map(r => ({ ...r, score: scoreById.get(r.id) ?? null }));
          rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
          return json({ ok: true, mode: 'semantic', count: rows.length, results: rows });
        }
        // honest degrade: keyword search over title/body
        const needle = `%${q.slice(0, 80)}%`;
        const r = await env.DB.prepare('SELECT * FROM artifacts WHERE title LIKE ? OR body LIKE ? ORDER BY ts DESC LIMIT 100').bind(needle, needle).all();
        const rows = applyFilters(r.results || [], u.searchParams).sort((a, b) => b.ts - a.ts).slice(0, limit);
        return json({ ok: true, mode: 'text', degraded: true, count: rows.length, results: rows });
      }
      const r = await env.DB.prepare('SELECT * FROM artifacts ORDER BY ts DESC LIMIT 100').all();
      const rows = applyFilters(r.results || [], u.searchParams).slice(0, limit);
      return json({ ok: true, mode: 'recent', count: rows.length, results: rows });
    }

    if (p === '/api/recall/similar') {
      if (!env.DB) return json({ ok: false, error: 'db_unbound', results: [], degraded: true }, 503);
      const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '8', 10) || 8, 1), 50);
      const id = u.searchParams.get('id');
      const vecParam = u.searchParams.get('vec');
      if (vecParam) {
        const vec = vecParam.split(',').map(Number);
        if (vec.length !== 16 || !vec.every(Number.isFinite) || !env.TIDEPOOL_NATIVE) {
          return json({ ok: false, error: 'native_index_unbound_or_bad_vec' }, 400);
        }
        const qr = await env.TIDEPOOL_NATIVE.query({ topK: limit * 4, vector: vec });
        const ids = (qr.matches || []).map(m => m.id);
        const scoreById = new Map((qr.matches || []).map(m => [m.id, m.score]));
        let rows = (await rowsByIds(env, ids)).slice(0, limit);
        rows = rows.map(r => ({ ...r, score: scoreById.get(r.id) ?? null }));
        rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        return json({ ok: true, mode: 'native', count: rows.length, results: rows });
      }
      if (!id) return json({ ok: false, error: 'id_or_vec_required' }, 400);
      const row = await env.DB.prepare('SELECT * FROM artifacts WHERE id = ?').bind(id).first();
      if (!row) return json({ ok: false, error: 'not_found' }, 404);
      let vec = await embed(env, row.body);
      if (!vec && row.native && env.TIDEPOOL_NATIVE) {
        try { vec = JSON.parse(row.native); } catch { vec = null; }
        if (vec) {
          const qr = await env.TIDEPOOL_NATIVE.query({ topK: limit * 4, vector: vec });
          let rows = (await rowsByIds(env, (qr.matches || []).map(m => m.id))).filter(r => r.id !== id);
          return json({ ok: true, mode: 'native', count: rows.length, results: rows.slice(0, limit) });
        }
      }
      if (!vec) return json({ ok: false, error: 'semantic_unbound', degraded: true }, 503);
      const qr = await env.TIDEPOOL_SEMANTIC.query({ topK: limit * 4 + 1, vector: vec });
      const scoreById = new Map((qr.matches || []).map(m => [m.id, m.score]));
      let rows = (await rowsByIds(env, (qr.matches || []).map(m => m.id))).filter(r => r.id !== id);
      rows = rows.slice(0, limit).map(r => ({ ...r, score: scoreById.get(r.id) ?? null }));
      rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return json({ ok: true, mode: 'semantic', count: rows.length, results: rows });
    }

    if (p === '/api/ledger') {
      if (!env.DB) return json({ ok: false, error: 'db_unbound', line: [], degraded: true }, 503);
      const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '25', 10) || 25, 1), 100);
      const r = await env.DB.prepare('SELECT id,kind,author,repo,title,ts FROM artifacts ORDER BY ts DESC LIMIT ?').bind(limit).all();
      const c = await env.DB.prepare('SELECT kind, COUNT(*) AS c FROM artifacts GROUP BY kind').all();
      const counts = {};
      for (const row of c.results || []) counts[row.kind] = row.c;
      return json({ ok: true, count: (r.results || []).length, line: r.results || [], counts });
    }

    return json({ ok: false, error: 'not_found', routes: ['/health', '/api/remember', '/api/recall?q=', '/api/recall/similar?id=|vec=', '/api/ledger'] }, 404);
  },
};
