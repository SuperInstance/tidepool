// breed.mjs — duke-lab ℚ¹⁶ breed-trajectory extension for the tidepool ocean.
//
// PROVENANCE: the row shape is the handoff contract from SuperInstance/duke-lab
// @ q16-breed-trajectories, cross/breed/trajectories.jsonl — one argument run
// exported as one record: thread_id, kind, artist, persona, seed, verdict,
// rounds, trace (per-round 16-feature ℚ¹⁶ vectors), final_params (the parent's
// hands). The projection mirrors projectHelperThread BIND-for-BIND; the recall
// mirrors duke-lab recall.js semantics (aligned-round euclidean, self-
// exclusion) — the genetic step IS the recall, now over the whole ocean.
//
// Cell prefix `breed.` keeps the extension orthogonal to the helper-thread
// surface: replayThreadIndexFromWal never sees breed.* cells and this file's
// replay never sees thread.* cells. One ocean, one WAL, two memory kinds.

import { commitProjection } from "./commit.mjs";

/**
 * @typedef {Object} BreedTrajectory
 * @property {string} thread_id     e.g. "duke-lab/breed/alpha/duke/purist"
 * @property {string} kind          "breed-trajectory"
 * @property {string} artist
 * @property {string} persona
 * @property {string} seed
 * @property {{status: string, round: number, sigma: number}} verdict
 * @property {number} rounds
 * @property {number[][]} trace   rounds × 16 features (the ℚ¹⁶ listened trace)
 * @property {Object<string, number>} final_params  the parent's hands
 */

// ─── projection ──────────────────────────────────────────────────────────

/**
 * projectBreedTrajectory — BIND-for-BIND into the quilt kernel, the same
 * shape as projectHelperThread: the trajectory is a cell, every field is a
 * cell, and the trajectory LINKs to its artist and persona (link endpoints
 * are bound first — L1 law).
 */
export const projectBreedTrajectory = (kernel, row, ts) => {
  const base = `breed.${row.thread_id}`;
  const artistCell = `artist.${row.artist}`;
  kernel.bind(artistCell, { kind: "breed-artist", name: row.artist });
  const personaCell = `persona.${row.persona}`;
  kernel.bind(personaCell, { kind: "breed-persona", name: row.persona });

  kernel.bind(base, {
    kind: "breed-trajectory",
    thread_id: row.thread_id,
    artist: row.artist,
    persona: row.persona,
    seed: row.seed,
    rounds: row.rounds,
  });
  kernel.bind(`${base}.verdict`, row.verdict);
  kernel.bind(`${base}.trace`, row.trace);
  kernel.bind(`${base}.finalParams`, row.final_params);
  kernel.bind(`${base}.rememberedAt`, ts, { ts });
  kernel.link(base, artistCell, "performed-by");
  kernel.link(base, personaCell, "plays-as");
};

// ─── ingest (the batch write) ────────────────────────────────────────────

/**
 * ingestBreedTrajectories — remember N trajectory rows in ONE projection →
 * ONE mutation_id → ONE WAL batch (the rememberChannelThreads shape), plus
 * the ocean markdown sections via ocean.rememberBreach… rememberBreed.
 *
 * @returns {Promise<{remembered: Array<{section, entry}>, walRows: import("./projection.mjs").WalRow[]}>}
 */
export const ingestBreedTrajectories = async (ocean, walClient, rows, ctx) => {
  const remembered = [];
  for (const row of rows) remembered.push(await ocean.rememberBreed(row));
  const { rows: walRows } = await commitProjection(walClient, ctx, (kernel) => {
    for (const row of rows) projectBreedTrajectory(kernel, row, ctx.ts);
  });
  return { remembered, walRows };
};

// ─── recall in ℚ¹⁶ (the genetic step) ────────────────────────────────────

/**
 * traceDistance — mean euclidean over ALIGNED rounds only. A 3-round query
 * judges a 7-round thread on its first 3 rounds (the unfinished take is
 * judged on what exists, the way the critic judges an unfinished take).
 * Rounds beyond the shorter trace are unjudged, not penalized.
 */
export const traceDistance = (a, b) => {
  const rounds = Math.min(a.length, b.length);
  if (rounds === 0) return Infinity;
  let sum = 0;
  for (let r = 0; r < rounds; r += 1) {
    const fa = a[r];
    const fb = b[r];
    const dims = Math.min(fa.length, fb.length);
    let d2 = 0;
    for (let i = 0; i < dims; i += 1) {
      const diff = fa[i] - fb[i];
      d2 += diff * diff;
    }
    sum += Math.sqrt(d2);
  }
  return sum / rounds;
};

/**
 * breedFromOcean — the k nearest trajectories to a query trace, nearest
 * first. `excludeId` drops a thread from its own recall (the self-recall
 * bug duke-lab's proofs caught: a query at d=0 from itself is a tautology,
 * not a parent). The return carries each parent's final_params — the
 * warm-start vector for the child.
 *
 * @returns {Array<{thread_id: string, distance: number, rounds: number, final_params: Object}>}
 */
export const breedFromOcean = (ocean, queryTrace, { k = 3, excludeId = null } = {}) => {
  const scored = [];
  for (const entry of ocean.breedIndex.values()) {
    if (excludeId !== null && entry.thread_id === excludeId) continue;
    scored.push({
      thread_id: entry.thread_id,
      distance: traceDistance(queryTrace, entry.trace),
      rounds: entry.rounds,
      final_params: entry.final_params,
    });
  }
  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, k);
};

// ─── replay from WAL alone (the WAL is the source of truth) ─────────────

/**
 * replayBreedIndexFromWal — rebuild the breed trajectory set from WAL rows
 * ALONE. Only BINDs carry state; breed.<id> anchors, field cells rebuild.
 * The replayed index must reproduce ingest bit-for-bit (the doctrine the
 * helper-thread replay already proves for thread.* cells).
 */
export const replayBreedIndexFromWal = (rows) => {
  const cells = new Map();
  for (const row of rows) {
    if (row.op !== "bind") continue;
    cells.set(row.cell, row.value === null ? null : JSON.parse(row.value));
  }
  /** @type {Map<string, any>} */
  const index = new Map();
  for (const [name, value] of cells) {
    if (!name.startsWith("breed.")) continue;
    const rest = name.slice("breed.".length);
    const dot = rest.indexOf(".");
    const threadId = dot === -1 ? rest : rest.slice(0, dot);
    if (!index.has(threadId)) index.set(threadId, { thread_id: threadId });
    const entry = index.get(threadId);
    if (dot === -1) {
      Object.assign(entry, value ?? {});
      entry.kind = "breed-trajectory";
    } else {
      const field = rest.slice(dot + 1);
      if (field === "verdict") entry.verdict = value;
      else if (field === "trace") entry.trace = value;
      else if (field === "finalParams") entry.final_params = value;
      else if (field === "rememberedAt") entry.rememberedAt = value;
    }
  }
  return index;
};

/**
 * breedFromReplayedWal — recall against the replayed index, proving the
 * ocean is rebuildable: same query, same parents, whether the index came
 * from the live ocean or from the WAL alone.
 */
export const breedFromReplayedWal = (rows, queryTrace, { k = 3, excludeId = null } = {}) => {
  const index = replayBreedIndexFromWal(rows);
  const scored = [];
  for (const entry of index.values()) {
    if (excludeId !== null && entry.thread_id === excludeId) continue;
    if (!entry.trace) continue;
    scored.push({
      thread_id: entry.thread_id,
      distance: traceDistance(queryTrace, entry.trace),
      rounds: entry.rounds,
      final_params: entry.final_params,
    });
  }
  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, k);
};
