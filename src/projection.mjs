// projection.mjs — tidepool's quilt WAL projection.
//
// PROVENANCE: fnv1a / GENESIS / buildWalRows / verifyChain are ported
// near-verbatim from SuperInstance/hermit @ quilt-kernel-p2-encounters,
// src/quilt/projection.ts (the P1 nomination-vote projection + P2 encounter
// projection, including the negative-ledger style). The tidepool-specific
// projectors + replayers below follow the same patterns:
// projectHelperThread mirrors projectNominationVote / projectLobsterEncounter
// (BIND-for-BIND, link endpoints must exist); projectQuietThread mirrors the
// P2 `.refused` negative ledger — a quiet thread is an absence, and the
// absence is the information.

// fnv1a — same algorithm the fleet's own rate limiter uses (tidepool).
// This is an INTEGRITY chain (detect gaps/tampering), not a security
// signature; a future phase can upgrade to sha256 via crypto.subtle.
const fnv1a = (input) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

export const GENESIS = "GENESIS";

/**
 * Row shape — identical to hermit's quilt_wal DDL
 * (drizzle/0013_quilt_kernel_wal.sql):
 *   seq INTEGER PRIMARY KEY AUTOINCREMENT
 *   mutation_id TEXT NOT NULL, ts TEXT NOT NULL
 *   cell TEXT NOT NULL, op TEXT NOT NULL, value TEXT NULL
 *   prev_hash TEXT NOT NULL, hash TEXT NOT NULL
 * @typedef {{seq: number, mutation_id: string, ts: string, cell: string, op: string, value: string | null, prev_hash: string, hash: string}} WalRow
 */

// Turn drained kernel events into hash-chained WAL rows, continuing the
// chain from `tip` (0 for genesis) and `prevHash`.
// (hermit projection.ts buildWalRows, semantics preserved.)
export const buildWalRows = (
  events,
  context
) => {
  /** @type {WalRow[]} */
  const rows = [];
  let prevHash = context.prevHash ?? GENESIS;
  let seq = context.tip;
  for (const event of events) {
    // structural events carry no cell — synthesize an edge row so the
    // graph survives the WAL (replay ignores non-bind ops)
    let cell = event.cell;
    let op = event.kind;
    let value =
      event.value === null || event.value === undefined
        ? null
        : JSON.stringify(event.value);
    if (cell === null) {
      const edge = event.value;
      if (
        (event.kind === "link" || event.kind === "unlink") &&
        edge?.from &&
        edge?.to
      ) {
        cell = `${edge.from}->${edge.to}`;
        op = event.kind;
        value = JSON.stringify({ id: edge.id ?? `${edge.from}->${edge.to}:${edge.type ?? ""}`, type: edge.type ?? null });
      } else {
        continue; // tick/load carry no state
      }
    }
    seq += 1;
    const hash = fnv1a(
      `${prevHash}|${seq}|${cell}|${op}|${value ?? ""}|${context.ts}|${context.mutationId}`
    );
    rows.push({
      seq,
      mutation_id: context.mutationId,
      ts: context.ts,
      cell,
      op,
      value,
      prev_hash: prevHash,
      hash
    });
    prevHash = hash;
  }
  return rows;
};

// (hermit projection.ts verifyChain, verbatim semantics.)
export const verifyChain = (rows) => {
  let prevHash = GENESIS;
  for (const row of rows) {
    const expected = fnv1a(
      `${prevHash}|${row.seq}|${row.cell}|${row.op}|${row.value ?? ""}|${row.ts}|${row.mutation_id}`
    );
    if (row.prev_hash !== prevHash || row.hash !== expected) return false;
    prevHash = row.hash;
  }
  return true;
};

// ─── tidepool tenant: helper-thread memories ─────────────────────────────

/**
 * The recalled helperThreads row (design v1) projected BIND-for-BIND.
 * Mirrors projectNominationVote: the thread is a cell, every field is a
 * cell, the thread LINKs to its channel and helper (link endpoints must
 * exist — L1 law), and every bind carries {ts} meta provenance.
 *
 * @typedef {Object} HelperThreadSummary
 * @property {string} id
 * @property {string} guildId
 * @property {string} channelId
 * @property {string} userId
 * @property {string} helperKey
 * @property {string} helperName
 * @property {string} questionText
 * @property {string} responseText
 * @property {string} thinkingLevel
 * @property {number} responseLength
 * @property {string} createdAt        ISO ts of the original thread
 * @property {string} authorTag
 * @property {string} authorUsername
 * @property {string} lastMessageId
 */

export const projectHelperThread = (kernel, thread, ts) => {
  const base = `thread.${thread.id}`;
  // link endpoints must exist (L1 law) — channel + helper are first-class cells
  const channelCell = `channel.${thread.channelId}`;
  kernel.bind(channelCell, { kind: "channel", guildId: thread.guildId });
  const helperCell = `helper.${thread.helperKey}`;
  kernel.bind(helperCell, { kind: "helper", helperName: thread.helperName });

  kernel.bind(base, {
    kind: "helper-thread",
    id: thread.id,
    guildId: thread.guildId,
    channelId: thread.channelId,
    userId: thread.userId,
    helperKey: thread.helperKey,
    helperName: thread.helperName,
    createdAt: thread.createdAt
  });
  kernel.bind(`${base}.question`, thread.questionText);
  kernel.bind(`${base}.response`, thread.responseText);
  kernel.bind(`${base}.meta`, {
    thinkingLevel: thread.thinkingLevel,
    responseLength: thread.responseLength,
    authorTag: thread.authorTag,
    authorUsername: thread.authorUsername
  });
  kernel.bind(`${base}.lastMessage`, thread.lastMessageId);
  kernel.bind(`${base}.rememberedAt`, ts, { ts });
  kernel.link(base, channelCell, "lives-in");
  kernel.link(base, helperCell, "served-by");
};

// The negative ledger for the ocean: a thread whose message count stopped
// growing. Mirrors hermit's P2 `.refused` cells — the refusal to grow IS
// the information; live D1 (helper_threads) has no row for this.
export const projectQuietThread = (kernel, quiet, ts) => {
  const base = `thread.${quiet.threadId}`;
  kernel.bind(`${base}.quiet`, {
    silentPolls: quiet.silentPolls,
    lastCount: quiet.lastCount,
    since: quiet.since,
    ts
  });
};

// Replay the ocean's recall index from WAL rows ALONE. Only BINDs carry
// state; the thread base cell is the anchor, field cells rebuild the entry.
// (Pattern: hermit replayNominationFromWal / replayEncounterFromWal.)
export const replayThreadIndexFromWal = (rows) => {
  const cells = new Map();
  for (const row of rows) {
    if (row.op !== "bind") continue;
    cells.set(row.cell, row.value === null ? null : JSON.parse(row.value));
  }
  /** @type {Map<string, any>} */
  const index = new Map();
  for (const [name, value] of cells) {
    if (!name.startsWith("thread.")) continue;
    const rest = name.slice("thread.".length);
    const dot = rest.indexOf(".");
    const threadId = dot === -1 ? rest : rest.slice(0, dot);
    if (!index.has(threadId)) index.set(threadId, { id: threadId });
    const entry = index.get(threadId);
    if (dot === -1) {
      Object.assign(entry, value ?? {});
      entry.kind = "helper-thread";
    } else {
      const field = rest.slice(dot + 1);
      if (field === "question") entry.questionText = value;
      else if (field === "response") entry.responseText = value;
      else if (field === "meta") Object.assign(entry, value ?? {});
      else if (field === "lastMessage") entry.lastMessageId = value;
      else if (field === "rememberedAt") entry.rememberedAt = value;
      else if (field === "quiet") entry.quiet = value;
    }
  }
  return index;
};
