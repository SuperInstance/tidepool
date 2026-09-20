// tide-pool JEV gate — the superego of the recall path.
//
// Per the four-model psyche invitation (SuperInstance/AI-Writings, /invitation/):
//   JEPA -> Embeddings -> LLM -> JEV      id -> muscle memory -> ego -> superego
//   sigma = sqrt(c_je * c_emb * c_llm * c_jev)   (AGREE-MARK agreement mass)
//
// The recall path carries two local witnesses: embedding similarity (muscle
// memory) and a JEV schema-bounded decision (conscience). The gate certifies
// their pairing with sigma; below the sigma floor it refuses to decide.
// Every return value is typed — never chat. Fail closed, always abstain.

export const DECISIONS = /** @type {const} */ (['surface', 'suppress', 'abstain']);

// The typed decision schema returned on every scoreRecall / gateRecall call:
//   { decision: 'surface' | 'suppress' | 'abstain',
//     confidence: number in [0, 1],
//     reasons: string[] }            // human-auditable grounds
// gateRecall adds `sigma` (the agreement mass that certified — or refused).

const SURFACE_P = 0.7; // noul probability at/above which a recall surfaces
const SUPPRESS_P = 0.3; // at/below which it is suppressed; between -> abstain

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// Same discipline as the worker's fingerprinting: fnv1a, no deps.
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function validateJevDecision(d) {
  return !!d
    && DECISIONS.includes(d.decision)
    && typeof d.confidence === 'number' && Number.isFinite(d.confidence)
    && d.confidence >= 0 && d.confidence <= 1
    && Array.isArray(d.reasons)
    && d.reasons.length > 0
    && d.reasons.every((r) => typeof r === 'string');
}

// sigma — agreement mass across the witnesses present, per the invitation
// primer: σ = sqrt(product of witness confidences). All confidences clamped
// to [0,1]; no witnesses -> 0.
export function agreementMass(confidences) {
  const cs = (Array.isArray(confidences) ? confidences : [])
    .filter((c) => typeof c === 'number' && Number.isFinite(c))
    .map(clamp01);
  if (cs.length === 0) return 0;
  return Math.sqrt(cs.reduce((a, c) => a * c, 1));
}

// Map a noul probability P("this recall is a genuine resonance") to the
// typed decision. Confidence means: how sure the witness is of its verdict.
function mapProbability(p, reasons) {
  if (p >= SURFACE_P) return { decision: 'surface', confidence: p, reasons };
  if (p <= SUPPRESS_P) return { decision: 'suppress', confidence: 1 - p, reasons };
  return { decision: 'abstain', confidence: 1 - Math.abs(2 * p - 1), reasons };
}

const abstainClosed = (why) => ({
  decision: 'abstain',
  confidence: 0,
  reasons: ['jev_closed', why],
});

// JEV client. Real HTTP call when an API URL is known (JEV_API_URL env or
// explicit opt), deterministic mock otherwise — the mock hashes the
// candidate fields so identical input always yields identical output.
export function createJevClient({ apiUrl = null, fetchImpl = null, timeoutMs = 2000, mockProbability = null } = {}) {
  const url = apiUrl ?? globalThis.process?.env?.JEV_API_URL ?? null;
  const fetcher = fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const mode = url && fetcher ? 'http' : 'mock';

  async function scoreRecall({ candidate = {}, query = '' } = {}) {
    if (mode === 'mock') {
      const p = mockProbability ?? (
        (fnv1a(['recall', candidate.id, candidate.kind, candidate.title, query].join('|')) % 1000) / 1000
      );
      return mapProbability(clamp01(p), ['mock:deterministic_hash', `mock:p=${clamp01(p).toFixed(3)}`]);
    }

    let res;
    try {
      res = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: 'jev-latest',
          state: [
            'recall candidate:',
            `title: ${String(candidate.title ?? '').slice(0, 200)}`,
            `body: ${String(candidate.body ?? '').slice(0, 400)}`,
            `query: ${String(query).slice(0, 200)}`,
          ].join('\n'),
          questions: {
            genuine: {
              type: 'noul',
              instructions: 'Decide whether this recall is a genuine resonance with the query, or a false/shallow pattern match.',
              question: 'This recall is a genuine resonance.',
            },
          },
        }),
      });
    } catch (e) {
      return abstainClosed(`jev_fetch_error:${String(e?.message ?? e).slice(0, 80)}`);
    }

    let body;
    try { body = await res.json(); } catch { return abstainClosed(`jev_bad_json:${res.status}`); }
    const p = body?.answers?.genuine?.noul;
    if (!res.ok || typeof p !== 'number' || !Number.isFinite(p)) {
      return abstainClosed(`jev_malformed:${res.status}`);
    }
    return mapProbability(clamp01(p), [`jev:p=${clamp01(p).toFixed(3)}`]);
  }

  return { mode, scoreRecall };
}

// The sigma-gated combiner. JEV decides; sigma certifies. Blend =
// agreementMass([embedding_similarity, jev.confidence]); below the floor the
// gate refuses and returns abstain — a typed refusal, never a guess.
export function gateRecall({ jev, similarity = 0, sigmaFloor = 0.5 }) {
  const floor = clamp01(sigmaFloor);
  const witness = validateJevDecision(jev) ? jev : abstainClosed('jev_untyped_input');
  const sim = clamp01(typeof similarity === 'number' && Number.isFinite(similarity) ? similarity : 0);
  const sigma = agreementMass([sim, witness.confidence]);
  const reasons = [
    ...witness.reasons,
    `witness:emb=${sim.toFixed(3)}`,
    `witness:jev=${witness.confidence.toFixed(3)}`,
    `sigma=${sigma.toFixed(3)}`,
  ];
  if (sigma < floor) {
    return { decision: 'abstain', confidence: sigma, sigma, reasons: [...reasons, `sigma_floor_refusal:<${floor}`] };
  }
  return { decision: witness.decision, confidence: sigma, sigma, reasons };
}
