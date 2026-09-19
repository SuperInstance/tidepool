// breed.test.mjs — proofs for the ℚ¹⁶ breed-trajectory extension.
//
// The duke-lab handoff contract (cross/breed/trajectories.jsonl) is the row
// shape under test: thread_id, kind, artist, persona, seed, verdict, rounds,
// trace (rounds × 16), final_params. Numbers are computed, not trusted —
// every expected value below is derived from the fixtures in-file.

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TidepoolOcean } from "../src/ocean.mjs";
import { SqliteD1Database } from "../src/d1sqlite.mjs";
import { verifyChain } from "../src/projection.mjs";
import {
  ingestBreedTrajectories,
  traceDistance,
  breedFromOcean,
  replayBreedIndexFromWal,
  breedFromReplayedWal,
} from "../src/breed.mjs";

const SCHEMA = readFileSync(join(import.meta.dir, "../src/schema.sql"), "utf8");

let seq = 0;
const nextMutation = (name) => `${name}:${++seq}`;

// ─── fixture factory (the duke-lab row shape, synthetic values) ──────────

const PARAM_KEYS = [
  "registerSpread", "trebleActivity", "dynRange", "dynContour",
  "swingFeel", "syncopation", "downbeatWeight", "harmonicComplex",
  "chromaticism", "repetition", "callReply", "density",
  "phraseVariance", "restRatio", "bassMovement", "cadenceRegular",
];

/** one 16-feature round vector */
const vec = (...over) => {
  const v = Array.from({ length: 16 }, (_, i) => (i + 1) / 100);
  for (const [i, x] of Object.entries(over)) v[Number(i)] = x;
  return v;
};

const row = (over = {}) => {
  const id = `duke-lab/breed/test/${++seq}`;
  return {
    thread_id: id,
    kind: "breed-trajectory",
    artist: "duke",
    persona: "purist",
    seed: `breed/test/${seq}`,
    verdict: { status: "CONVERGED", round: 1, sigma: 0.13 },
    rounds: 2,
    trace: [vec(), vec(0.5)],
    final_params: Object.fromEntries(PARAM_KEYS.map((k, i) => [k, (i + 1) / 10])),
    ...over,
  };
};

let db, ocean, walClient;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "tidepool-breed-"));
  db = new SqliteD1Database(join(dir, "test.db"));
  db.exec(SCHEMA);
  walClient = db;
  ocean = new TidepoolOcean({ now: () => "2026-09-20T05:30:00.000Z" });
});

describe("breed trajectory ingest", () => {
  test("ingest writes ocean sections + a valid WAL chain, ONE mutation", async () => {
    const rows = [row(), row()];
    const ctx = { mutationId: nextMutation("ingest"), ts: "2026-09-20T05:30:00.000Z" };
    const { remembered, walRows } = await ingestBreedTrajectories(ocean, walClient, rows, ctx);

    expect(remembered.length).toBe(2);
    expect(ocean.breedIndex.size).toBe(2);
    expect(ocean.markdown).toContain("## breed:duke-lab/breed/test/");
    // 2 trajectories × 5 binds each + 4 link endpoints... bind rows only in WAL
    expect(walRows.length).toBeGreaterThan(0);
    expect(walRows.every((r) => r.mutation_id === ctx.mutationId)).toBe(true);
    expect(verifyChain(walRows)).toBe(true);
  });

  test("every trace round carries 16 features and final_params carries the 16 hands", async () => {
    const r = row();
    expect(r.trace.every((t) => t.length === 16)).toBe(true);
    expect(Object.keys(r.final_params).length).toBe(16);
  });
});

describe("traceDistance (aligned-round euclidean)", () => {
  test("identical traces are d=0", () => {
    const t = [vec(), vec(0.5)];
    expect(traceDistance(t, t)).toBe(0);
  });

  test("a 3-round query judges a 7-round thread on 3 shared rounds only", () => {
    const short = [vec(), vec(0.5), vec(0.9)];
    const long = [vec(), vec(0.5), vec(0.9), vec(9), vec(9), vec(9), vec(9)];
    // rounds 4-7 of `long` are wildly different from anything — must NOT count
    expect(traceDistance(short, long)).toBe(0);
  });

  test("divergence grows with feature gap", () => {
    const a = [vec()];
    const b = [vec(1.0)];
    const c = [vec(0.0)];
    expect(traceDistance(a, b)).toBeGreaterThan(0);
    expect(traceDistance(a, b)).toBeCloseTo(0.99, 5);
    expect(traceDistance(a, c)).toBeCloseTo(0.01, 5);
  });
});

describe("breedFromOcean (the genetic step IS the recall)", () => {
  test("nearest parent wins; warm-start carries final_params", async () => {
    const near = row({ persona: "purist", trace: [vec(0.10), vec(0.20)] });
    const far = row({ persona: "maximalist", trace: [vec(0.80), vec(0.90)] });
    await ingestBreedTrajectories(ocean, walClient, [near, far], {
      mutationId: nextMutation("ingest"),
      ts: "2026-09-20T05:30:00.000Z",
    });

    const query = [vec(0.11), vec(0.21)]; // close to `near`
    const parents = breedFromOcean(ocean, query, { k: 2 });
    expect(parents.length).toBe(2);
    expect(parents[0].thread_id).toBe(near.thread_id);
    expect(parents[0].distance).toBeLessThan(parents[1].distance);
    // the warm-start: the child's initial hands ARE the parent's final hands
    expect(Object.keys(parents[0].final_params).sort()).toEqual([...PARAM_KEYS].sort());
  });

  test("self-recall exclusion: a query never parents from itself (the duke-lab bug, made a proof)", async () => {
    const target = row({ trace: [vec(0.30), vec(0.40)] });
    const other = row({ trace: [vec(0.90), vec(0.90)] });
    await ingestBreedTrajectories(ocean, walClient, [target, other], {
      mutationId: nextMutation("ingest"),
      ts: "2026-09-20T05:30:00.000Z",
    });

    // without exclusion the query recalls itself at d=0 — a tautology
    const tautology = breedFromOcean(ocean, target.trace, { k: 1 });
    expect(tautology[0].thread_id).toBe(target.thread_id);
    expect(tautology[0].distance).toBe(0);
    // with exclusion it must reach for the OTHER thread
    const honest = breedFromOcean(ocean, target.trace, { k: 1, excludeId: target.thread_id });
    expect(honest[0].thread_id).toBe(other.thread_id);
  });

  test("same-persona trajectories are closer on average than cross-persona", async () => {
    const personaTrace = (base) => [vec(base), vec(base + 0.05), vec(base + 0.02)];
    const purists = Array.from({ length: 3 }, () => row({ persona: "purist", trace: personaTrace(0.20) }));
    const outsiders = Array.from({ length: 3 }, () => row({ persona: "maximalist", trace: personaTrace(0.85) }));
    await ingestBreedTrajectories(ocean, walClient, [...purists, ...outsiders], {
      mutationId: nextMutation("ingest"),
      ts: "2026-09-20T05:30:00.000Z",
    });

    const query = personaTrace(0.22); // purist-flavored
    const same = breedFromOcean(ocean, query, { k: 3 })
      .filter((p) => purists.some((r) => r.thread_id === p.thread_id));
    const cross = breedFromOcean(ocean, query, { k: 6 })
      .filter((p) => outsiders.some((r) => r.thread_id === p.thread_id));
    const avg = (xs) => xs.reduce((s, x) => s + x.distance, 0) / xs.length;
    expect(same.length).toBeGreaterThan(0);
    expect(cross.length).toBeGreaterThan(0);
    expect(avg(same)).toBeLessThan(avg(cross));
  });
});

describe("replay from WAL alone (the WAL is the source of truth)", () => {
  test("replayed index reproduces ingest bit-for-bit; recall parity holds", async () => {
    const rows = [row({ persona: "purist", trace: [vec(0.10), vec(0.20)] }), row({ persona: "maximalist", trace: [vec(0.80), vec(0.90)] })];
    const ctx = { mutationId: nextMutation("ingest"), ts: "2026-09-20T05:30:00.000Z" };
    await ingestBreedTrajectories(ocean, walClient, rows, ctx);

    const { results } = await walClient
      .prepare("select * from quilt_wal order by seq")
      .all();
    const replayed = replayBreedIndexFromWal(results);
    expect(replayed.size).toBe(2);
    for (const r of rows) {
      const e = replayed.get(r.thread_id);
      expect(e).toBeDefined();
      expect(e.trace).toEqual(r.trace);
      expect(e.final_params).toEqual(r.final_params);
      expect(e.verdict).toEqual(r.verdict);
      expect(e.artist).toBe(r.artist);
      expect(e.persona).toBe(r.persona);
    }

    // recall against the replayed set must equal recall against the live ocean
    const query = [vec(0.11), vec(0.21)];
    const fromOcean = breedFromOcean(ocean, query, { k: 2 });
    const fromWal = breedFromReplayedWal(results, query, { k: 2 });
    expect(fromWal.map((p) => p.thread_id)).toEqual(fromOcean.map((p) => p.thread_id));
    expect(fromWal.map((p) => p.distance)).toEqual(fromOcean.map((p) => p.distance));
  });
});

describe("integration: the real duke-lab seed stock (present in this workspace)", () => {
  const STOCK = "/tmp/duke-lab/cross/breed/trajectories.jsonl";
  test("ingests the 12-thread trajectories.jsonl and recalls across it", async () => {
    if (!existsSync(STOCK)) {
      // not a failure of the bench — the sibling repo simply isn't checked out here
      return;
    }
    const rows = readFileSync(STOCK, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));

    expect(rows.length).toBe(12);
    const ctx = { mutationId: nextMutation("stock"), ts: "2026-09-20T05:30:00.000Z" };
    const { walRows } = await ingestBreedTrajectories(ocean, walClient, rows, ctx);
    expect(verifyChain(walRows)).toBe(true);
    expect(ocean.breedIndex.size).toBe(12);

    // every row: 16-feature rounds, 16 hands
    for (const r of rows) {
      expect(r.trace.every((t) => t.length === 16)).toBe(true);
      expect(Object.keys(r.final_params).length).toBe(16);
    }

    // recall parity ocean vs WAL over the REAL stock
    const query = rows[0].trace;
    const { results } = await walClient
      .prepare("select * from quilt_wal order by seq")
      .all();
    const fromOcean = breedFromOcean(ocean, query, { k: 3, excludeId: rows[0].thread_id });
    const fromWal = breedFromReplayedWal(results, query, { k: 3, excludeId: rows[0].thread_id });
    expect(fromWal.map((p) => p.thread_id)).toEqual(fromOcean.map((p) => p.thread_id));
  });
});
