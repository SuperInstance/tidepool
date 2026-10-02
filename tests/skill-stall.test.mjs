// tests/skill-stall.test.mjs — v1 WAL row-shape pins + skill-stall telemetry
// emitter contract (fleet dogfood, re-homed after the external bench was lost).
// Run: node tests/skill-stall.test.mjs   (exit 0 = all green)
//
// Pins:
//   1. WAL ROW LAW re-derived with deliberately independent code (own
//      canonicalizer + fnv1a-64, zero tools/ imports) so a shared bug in
//      tools/skill-stall.mjs cannot blind both sides.
//   2. Emitter bounds == worker truncation contract, parsed independently
//      from worker/index.js (drift pin).
//   3. Determinism: same entries -> byte-identical chain.
//   4. Tamper: post-hash edit -> verify names the exact seq.
//   5. stallRecord honesty: refuses non-finite stalledMs, never invents
//      a verdict without a measurement.
//
// FAIL-first evidence (in PR body): pristine origin/main lacks tools/ and
// this file -> import fails, suite exit non-zero.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const t = await import(join(ROOT, "tools", "skill-stall.mjs"));
const { buildRun, stallRecord, walChain, verifyWal, sealEntries, RUN_BOUNDS, canonJson, fnv1a64hex } = t;

// ---- independent re-derivation (must not share implementation) ----
function indepFnv1a64(s) {
  let h = 14695981039346656037n; // 0xcbf29ce484222325
  for (let i = 0; i < s.length; i++) {
    h = h ^ BigInt(s.charCodeAt(i) & 0xff);
    h = (h * 1099511628211n) & 0xffffffffffffffffn; // 0x100000001b3
  }
  return h.toString(16).padStart(16, "0");
}
function indepCanon(v) {
  if (v === null) return "null";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "[" + v.map(indepCanon).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + indepCanon(v[k])).join(",") + "}";
}

let n = 0, bad = 0;
const check = (name, cond, detail = "") => {
  n++;
  if (!cond) { bad++; console.log(`not ok — ${name}${detail ? " — " + detail : ""}`); }
  else console.log(`ok — ${name}`);
};

// 1. WAL ROW LAW (independent re-derivation)
{
  const entries = [
    { agent: "snowball", repo: "tidepool", task: "v1 wal pins", outcome: "PASS", stalledMs: 0 },
    { agent: "snowball", repo: null, task: "stall record", outcome: "STALL:120000ms", stalledMs: 120000, detail: "gateway congestion" },
  ];
  const rows = walChain("skill-stall", entries);
  const KEYSET = ["args", "cell", "hash", "op", "prev_hash", "seq"].sort().join(",");
  for (const r of rows) {
    check(`row seq ${r.seq}: exact key set {args,cell,hash,op,prev_hash,seq}`,
      Object.keys(r).sort().join(",") === KEYSET);
    check(`row seq ${r.seq}: hash re-derives under independent fnv1a-64`,
      indepFnv1a64(indepCanon({ ...r, hash: "" })) === r.hash);
  }
  check("genesis prev_hash is 0x16", rows[0].prev_hash === "0".repeat(16));
  check("genesis op is BIND", rows[0].op === "BIND");
  check("tip op is VIEW", rows[rows.length - 1].op === "VIEW");
  check("seq contiguous from 0", rows.every((r, i) => r.seq === i));
  check("op vocabulary is exactly {BIND,LINK,VIEW}",
    rows.every(r => ["BIND", "LINK", "VIEW"].includes(r.op)));
  check("all hashes lowercase hex16", rows.every(r => /^[0-9a-f]{16}$/.test(r.hash)));
  const v = verifyWal(rows);
  check("verifyWal ok on fresh chain", v.ok === true, v.why || "");
  check("verifyWal reports link count", v.links === entries.length);
}

// 2. Emitter bounds == worker truncation contract (independent parse)
{
  const src = readFileSync(join(ROOT, "worker", "index.js"), "utf8");
  const m = src.match(/r\.task \|\| ''\)\.toString\(\)\.slice\(0, (\d+)\).*?r\.outcome \|\| ''\)\.toString\(\)\.slice\(0, (\d+)\)/s);
  check("worker run-row truncation contract parseable from worker/index.js", !!m);
  if (m) {
    check(`emitter RUN_BOUNDS.task (${RUN_BOUNDS.task}) == worker (${m[1]})`, RUN_BOUNDS.task === Number(m[1]));
    check(`emitter RUN_BOUNDS.outcome (${RUN_BOUNDS.outcome}) == worker (${m[2]})`, RUN_BOUNDS.outcome === Number(m[2]));
  }
  const longTask = "x".repeat(500);
  const r = buildRun({ agent: "a", task: longTask, outcome: "ok" });
  check("buildRun truncates task to worker bound", r.task.length === RUN_BOUNDS.task);
  const longOutcome = "y".repeat(100);
  const r2 = buildRun({ agent: "a", task: "t", outcome: longOutcome });
  check("buildRun truncates outcome to worker bound", r2.outcome.length === RUN_BOUNDS.outcome);
  let threw = false;
  try { buildRun({ agent: "a", task: "", outcome: "ok" }); } catch { threw = true; }
  check("buildRun refuses empty task", threw);
}

// 3. Determinism
{
  const e = { agent: "snowball", repo: "tidepool", task: "d", outcome: "PASS", stalledMs: 5 };
  const c1 = JSON.stringify(walChain("skill-stall", [e]));
  const c2 = JSON.stringify(walChain("skill-stall", [e]));
  check("same entries -> byte-identical chain", c1 === c2);
}

// 4. Tamper localization
{
  const rows = walChain("skill-stall", [{ agent: "a", task: "t", outcome: "PASS", stalledMs: 1 }]);
  const tampered = rows.map(r => ({ ...r }));
  tampered[1].args = tampered[1].args.replace("PASS", "FAILED"); // post-hash edit
  const v = verifyWal(tampered);
  check("post-hash arg edit -> verify refuses", v.ok === false);
  check("tamper named at exact seq", /seq 1/.test(v.why || ""), v.why || "");
  const splice = rows.filter(r => r.seq !== 1); // row removal -> continuity break
  const v2 = verifyWal(splice);
  check("row removal -> prev_hash continuity break", v2.ok === false);
}

// 5. stallRecord honesty
{
  let threw = false;
  try { stallRecord({ agent: "a", task: "t", stalledMs: -1 }); } catch { threw = true; }
  check("stallRecord refuses negative stalledMs", threw);
  threw = false;
  try { stallRecord({ agent: "a", task: "t", stalledMs: NaN }); } catch { threw = true; }
  check("stallRecord refuses NaN stalledMs (never invents a measurement)", threw);
  const s = stallRecord({ agent: "a", repo: "r", task: "t", stalledMs: 120000.4 });
  check("stallRecord rounds stalledMs into outcome", s.outcome === "STALL:120000ms");
  check("stallRecord outcome respects worker bound", s.outcome.length <= RUN_BOUNDS.outcome);
}

// 6. sealEntries round trip
{
  const { chain, verify } = sealEntries("skill-stall", [{ agent: "a", task: "t", outcome: "PASS", stalledMs: 0 }]);
  check("sealEntries chain verifies", verify().ok === true);
  check("sealEntries VIEW tip names link count", chain[chain.length - 1].args.includes('"links":1'));
}

console.log(`\n${n - bad}/${n} pins green`);
process.exit(bad ? 1 : 0);
