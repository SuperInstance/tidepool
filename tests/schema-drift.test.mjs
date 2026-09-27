// tests/schema-drift.test.mjs — schema↔write-path drift pin (fleet dogfood).
// Run: node tests/schema-drift.test.mjs   (exit 0 = all green)
//
// Tidepool's schema (worker/schema.sql) and its write path
// (INSERT statements in worker/index.js) can drift in lockstep or apart:
// a column added to one and not the other fails only at deploy time, on
// real D1, in production. This pin parses BOTH sides independently and
// asserts the column sets agree exactly — a missing or extra column trips
// RED at test time, naming the table and the asymmetry.
//
// FAIL-first evidence (in PR body): pristine tree green; drift injected
// into a temp copy (add column to schema, leave INSERT) → RED naming the
// table; restore → green.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseSchema(sql) {
  const tables = {};
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([^;]+?)\);/gs;
  for (const m of sql.matchAll(re)) {
    const cols = m[2]
      .split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.toUpperCase().startsWith("CREATE INDEX"))
      .map(l => l.split(/\s+/)[0].replace(/,$/, ""));
    tables[m[1]] = new Set(cols);
  }
  return tables;
}

function parseInserts(js) {
  const stmts = {};
  const re = /INSERT INTO (\w+) \(([^)]+)\)/g;
  for (const m of js.matchAll(re)) {
    stmts[m[1]] = new Set(m[2].split(",").map(c => c.trim()));
  }
  return stmts;
}

let n = 0, bad = 0;
const check = (name, cond, detail = "") => {
  n++;
  if (!cond) { bad++; console.log(`not ok — ${name}${detail ? " — " + detail : ""}`); }
  else console.log(`ok — ${name}`);
};

export function runSchemaDriftPin(root = ROOT) {
  const schema = parseSchema(readFileSync(join(root, "worker/schema.sql"), "utf8"));
  const inserts = parseInserts(readFileSync(join(root, "worker/index.js"), "utf8"));
  const results = [];
  for (const [table, cols] of Object.entries(schema)) {
    const write = inserts[table];
    results.push([`table ${table}: write path exists`, !!write]);
    if (!write) continue;
    const missing = [...cols].filter(c => !write.has(c));   // schema says it, INSERT doesn't write it
    const extra = [...write].filter(c => !cols.has(c));     // INSERT writes it, schema doesn't declare it
    results.push([`table ${table}: INSERT covers all ${cols.size} declared columns`,
      missing.length === 0, missing.length ? "missing: " + missing.join(",") : ""]);
    results.push([`table ${table}: no undeclared columns in INSERT`,
      extra.length === 0, extra.length ? "undeclared: " + extra.join(",") : ""]);
  }
  for (const [table] of Object.entries(inserts)) {
    results.push([`table ${table}: INSERT target declared in schema`, !!schema[table]]);
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, cond, detail] of runSchemaDriftPin()) check(name, cond, detail);
  console.log(`\nschema-drift pin: ${n - bad}/${n} green`);
  process.exit(bad ? 1 : 0);
}
