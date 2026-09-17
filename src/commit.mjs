// commit.mjs — dual-write tidepool state transitions into the quilt WAL.
//
// PROVENANCE: ported from SuperInstance/hermit @ quilt-kernel-p2-encounters,
// src/quilt/commit.ts (commitProjection, the generic projector). The
// pattern is unchanged: run `project` against a FRESH in-memory kernel,
// drain the subscribed events, read the current chain tip, append
// hash-chained WAL rows in ONE batch. A tidepool-specific note: the batch
// must be best-effort in production (hermit P1 risk posture: a WAL failure
// is caught and logged, never thrown into the user path) — this bench
// surfaces errors so tests referee them.

import { QuiltKernel } from "./kernel.mjs";
import { buildWalRows } from "./projection.mjs";

// D1-shaped client (hermit commit.ts WalClient): prepare/bind/batch.
// The sqliteD1 harness in this package satisfies this shape.
export const commitProjection = async (
  client,
  context,
  project
) => {
  const kernel = new QuiltKernel();
  /** @type {Array<{kind: string, cell: string | null, value: unknown}>} */
  const events = [];
  const unsubscribe = kernel.subscribe((event) => {
    events.push(event);
  });
  project(kernel);
  unsubscribe();

  const [tipResult] = await client.batch([
    client.prepare(
      `select coalesce(max(seq), 0) as tip,
        (select hash from quilt_wal order by seq desc limit 1) as prev
       from quilt_wal`
    )
  ]);
  const tipRow = tipResult?.results?.[0] ?? { tip: 0, prev: null };
  const rows = buildWalRows(events, {
    mutationId: context.mutationId,
    ts: context.ts,
    tip: Number(tipRow.tip ?? 0),
    prevHash: tipRow.prev ?? null
  });
  if (rows.length === 0) return { rows: [], kernel };

  await client.batch(
    rows.map((row) =>
      client
        .prepare(
          `insert into quilt_wal
            (mutation_id, ts, cell, op, value, prev_hash, hash)
           values (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          row.mutation_id,
          row.ts,
          row.cell,
          row.op,
          row.value,
          row.prev_hash,
          row.hash
        )
    )
  );
  return { rows, kernel };
};
