// tools/skill-stall.mjs — skill-stall telemetry emitter + local WAL receipt chain.
// Fleet dogfood tile (receipt-manifest + drift-pin pattern), re-homing the
// v1 WAL row law into the tidepool repo after the external bench was lost.
//
// What it does:
//   buildRun({agent, repo, task, outcome}) -> the exact `run` payload the
//     worker persists inside /api/remember (worker/index.js). The emitter
//     MIRRORS the worker's truncation contract (task<=200, outcome<=32) so a
//     stall record built here never exceeds what D1 will actually store.
//   sealChain(entries) -> five-opcode WAL (BIND/LINK/VIEW, fnv1a-64,
//     genesis prev_hash 0x16) over the emitted records. Local receipt only;
//     it never talks to the network and never fakes a server ack.
//
// Honesty: a sealed chain proves WHAT was emitted, not that the pool
// accepted it. Acceptance remains the worker's /api/ledger readback.

export const FNV_OFFSET = 0x811c9dc5n;
export const FNV_PRIME = 0x01000193n;
const MASK32 = 0xffffffffn;

// fnv1a-64 as a 16-char lowercase hex string (fleet receipt convention).
export function fnv1a64hex(s) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i) & 0xff);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

// Canonical JSON: object keys sorted recursively, UTF-16 code units (the
// fleet's established JS/Python parity choice — pinned in tests).
export function canonJson(v) {
  if (v === null) return "null";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "[" + v.map(canonJson).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonJson(v[k])).join(",") + "}";
}

const HEX16 = /^[0-9a-f]{16}$/;

function walRow({ op, cell, args, seq, prevHash }) {
  const row = { args: canonJson(args ?? {}), cell, hash: "", op, prev_hash: prevHash, seq };
  row.hash = fnv1a64hex(canonJson(row));
  if (!HEX16.test(row.hash)) throw new Error(`fnv1a-64 produced non-hex16 hash: ${row.hash}`);
  return row;
}

export const GENESIS_PREV = "0".repeat(16);

export function walChain(cell, entries) {
  const rows = [];
  let prev = GENESIS_PREV;
  rows.push(walRow({ op: "BIND", cell, args: { cell, version: 1 }, seq: 0, prevHash: prev }));
  prev = rows[0].hash;
  entries.forEach((e, i) => {
    const row = walRow({ op: "LINK", cell, args: e, seq: i + 1, prevHash: prev });
    rows.push(row);
    prev = row.hash;
  });
  rows.push(walRow({ op: "VIEW", cell, args: { tip: prev, links: entries.length }, seq: entries.length + 1, prevHash: prev }));
  return rows;
}

export function verifyWal(rows) {
  let prev = GENESIS_PREV;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.seq !== i) return { ok: false, why: `seq gap at ${i}: got ${r.seq}` };
    if (r.prev_hash !== prev) return { ok: false, why: `prev_hash mismatch at seq ${r.seq}` };
    if (fnv1a64hex(canonJson({ ...r, hash: "" })) !== r.hash) return { ok: false, why: `hash mismatch at seq ${r.seq}` };
    if (!HEX16.test(r.hash)) return { ok: false, why: `non-hex16 hash at seq ${r.seq}` };
    if (!["BIND", "LINK", "VIEW"].includes(r.op)) return { ok: false, why: `unknown op ${r.op} at seq ${r.seq}` };
    prev = r.hash;
  }
  if (rows[0]?.op !== "BIND") return { ok: false, why: "genesis row must be BIND" };
  if (rows[rows.length - 1]?.op !== "VIEW") return { ok: false, why: "tip row must be VIEW" };
  return { ok: true, links: Math.max(0, rows.length - 2), tip: prev };
}

// Mirror of the worker's run-row contract (worker/index.js): task<=200,
// outcome<=32. RUN_BOUNDS is exported for the drift pin against the worker.
export const RUN_BOUNDS = { task: 200, outcome: 32 };

export function buildRun({ agent, repo = null, task, outcome }) {
  if (typeof agent !== "string" || !agent.trim()) throw new Error("agent required");
  if (typeof task !== "string" || !task.trim()) throw new Error("task required");
  if (typeof outcome !== "string" || !outcome.trim()) throw new Error("outcome required");
  return {
    agent,
    repo: repo ? String(repo) : null,
    task: task.slice(0, RUN_BOUNDS.task),
    outcome: outcome.slice(0, RUN_BOUNDS.outcome),
  };
}

// Skill-stall vocabulary: an outcome the recorder cannot fake past the
// bounds. Stall taxonomy stays the caller's; the emitter refuses to invent
// a verdict.
export function stallRecord({ agent, repo = null, task, stalledMs, detail = "" }) {
  if (!Number.isFinite(stalledMs) || stalledMs < 0) throw new Error("stalledMs must be a finite non-negative number");
  const outcome = `STALL:${Math.round(stalledMs)}ms`.slice(0, RUN_BOUNDS.outcome);
  const run = buildRun({ agent, repo, task, outcome });
  return { ...run, stalledMs: Math.round(stalledMs), detail: String(detail).slice(0, 200) };
}

export function sealEntries(cell, entries) {
  const links = entries.map(e => ({ ...e }));
  return { chain: walChain(cell, links), verify: () => verifyWal(walChain(cell, links)) };
}
