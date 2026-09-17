// tidepool.mjs — the hermit-facing tidepool v1 API.
//
// Drops into SuperInstance/hermit as PR #3 (after PRs #1/#2 land the quilt
// WAL). Every write is a DUAL-WRITE: the ocean markdown is the
// human-readable memory; the quilt WAL is the replayable ledger. See
// README.md for the full interface contract and row shapes.

import { commitProjection } from "./commit.mjs";
import { projectHelperThread, projectQuietThread } from "./projection.mjs";

/**
 * rememberHelperThread — the recalled design's core write, upgraded:
 * the thread summary is stored in the ocean markdown AND projected
 * BIND-for-BIND into the quilt WAL via the hermit commit pattern.
 *
 * @param {import("./ocean.mjs").TidepoolOcean} ocean
 * @param {import("./commit.mjs").WalClient} walClient  D1 or SqliteD1Database
 * @param {import("./projection.mjs").HelperThreadSummary} thread
 * @param {{mutationId: string, ts: string}} ctx
 */
export const rememberHelperThread = async (ocean, walClient, thread, ctx) => {
  const { section, entry } = await ocean.remember(thread);
  const { rows } = await commitProjection(walClient, ctx, (kernel) => {
    projectHelperThread(kernel, thread, ctx.ts);
  });
  return { section, entry, walRows: rows };
};

/**
 * rememberChannelThreads — the channel sweep: remember several thread
 * summaries in ONE projection (ONE mutation_id → ONE WAL batch), the same
 * way hermit batches a state-machine transition.
 */
export const rememberChannelThreads = async (ocean, walClient, threads, ctx) => {
  const remembered = await ocean.rememberAll(threads);
  const { rows } = await commitProjection(walClient, ctx, (kernel) => {
    for (const t of threads) projectHelperThread(kernel, t, ctx.ts);
  });
  return { remembered, walRows: rows };
};

/**
 * recallHelperContext — top 3-5 relevant thread memories for a query.
 */
export const recallHelperContext = (ocean, query, { limit = 5 } = {}) =>
  ocean.recall(query, { limit });

/**
 * rememberBotAction — append-only, timestamped oath log entry.
 */
export const rememberBotAction = (ocean, action) => ocean.botAction(action);

/**
 * drainQuietThreads — the threadLengthMonitor's negative ledger: project
 * each detected quiet thread into the WAL (`.quiet` cell). Absence is the
 * information.
 */
export const drainQuietThreads = async (walClient, quietList, ctx) => {
  if (quietList.length === 0) return { walRows: [] };
  const { rows } = await commitProjection(walClient, ctx, (kernel) => {
    for (const q of quietList) projectQuietThread(kernel, q, ctx.ts);
  });
  return { walRows: rows };
};
