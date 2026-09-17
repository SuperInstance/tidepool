// stall.mjs — threadLengthMonitor, as a PURE function.
//
// The recalled design had an edge function polling thread lengths every
// 30 minutes. The bench extracts the decision core: given a length history,
// a thread whose message count stops growing across N consecutive polls
// becomes a "quiet thread" memory. The absence is the information — this is
// hermit's P2 negative ledger applied to helper threads
// (see src/projection.mjs projectQuietThread).

/**
 * @param {Array<{threadId: string, ts: string, messageCount: number}>} polls
 *   sampled thread lengths, any order (sorted internally by ts).
 * @param {{window?: number}} [options] consecutive flat polls required (default 3).
 * @returns {Array<{threadId: string, silentPolls: number, lastCount: number,
 *                   since: string, ts: string}>}
 *   one record per quiet thread; `since` = ts of the last growth,
 *   `ts` = ts of the newest sample.
 */
export const detectQuietThreads = (polls, { window = 3 } = {}) => {
  const byThread = new Map();
  for (const p of polls) {
    if (!byThread.has(p.threadId)) byThread.set(p.threadId, []);
    byThread.get(p.threadId).push(p);
  }
  const quiet = [];
  for (const [threadId, samples] of byThread) {
    samples.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    let flat = 0;
    let since = samples[0]?.ts;
    for (let i = 1; i < samples.length; i += 1) {
      if (samples[i].messageCount > samples[i - 1].messageCount) {
        flat = 0;
        since = samples[i].ts;
      } else {
        flat += 1;
      }
    }
    if (flat >= window - 1 && samples.length >= window) {
      quiet.push({
        threadId,
        silentPolls: flat + 1,
        lastCount: samples[samples.length - 1].messageCount,
        since,
        ts: samples[samples.length - 1].ts
      });
    }
  }
  return quiet;
};
