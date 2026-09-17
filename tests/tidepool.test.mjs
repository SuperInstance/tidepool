// tidepool.test.mjs — the tidepool v1 bench proofs (bun:test).
//
// Proves, against a REAL sqlite (hermit's own SqliteD1 harness shape):
//   1. remember → WAL rows exist with a valid fnv1a hash chain
//   2. recallHelperContext returns the relevant chunks (top 3-5)
//   3. detectQuietThreads flags a stalled thread, ignores a growing one
//   4. replay from WAL ALONE reconstructs the ocean index (recall parity)
//   5. oath audit: append-only, timestamps everywhere, tamper-evident chain

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TidepoolOcean } from "../src/ocean.mjs";
import { SqliteD1Database } from "../src/d1sqlite.mjs";
import { verifyChain, replayThreadIndexFromWal } from "../src/projection.mjs";
import { detectQuietThreads } from "../src/stall.mjs";
import {
  rememberHelperThread,
  rememberChannelThreads,
  recallHelperContext,
  rememberBotAction,
  drainQuietThreads
} from "../src/tidepool.mjs";

const SCHEMA = readFileSync(join(import.meta.dir, "../src/schema.sql"), "utf8");

let seq = 0;
const ts = (iso) => iso;
const nextMutation = (name) => `${name}:${++seq}`;

const thread = (over = {}) => ({
  id: `t${++seq}`,
  guildId: "g1",
  channelId: "c1",
  userId: "u1",
  helperKey: "lobster-taxon",
  helperName: "Lobster Taxonomist",
  questionText: "what species is the midnight lobster",
  responseText: "the midnight lobster is a abyssal-zone crustacean with bioluminescent antennae",
  thinkingLevel: "high",
  responseLength: 84,
  createdAt: "2026-09-17T10:00:00.000Z",
  authorTag: "casey#0001",
  authorUsername: "casey",
  lastMessageId: "m1",
  ...over
});

describe("tidepool v1 bench", () => {
  let db, ocean, oceanPath;
  const now = () => "2026-09-17T17:52:00.000Z";

  beforeEach(async () => {
    db = new SqliteD1Database(":memory:");
    await db.exec(SCHEMA);
    oceanPath = join(mkdtempSync(join(tmpdir(), "tidepool-")), "ocean.md");
    ocean = new TidepoolOcean({ path: oceanPath, now });
  });

  test("remember → WAL rows with a valid hash chain", async () => {
    const t = thread({ id: "t-remember" });
    const ctx = { mutationId: nextMutation("remember"), ts: ts("2026-09-17T17:52:00.000Z") };
    const { walRows, section } = await rememberHelperThread(ocean, db, t, ctx);

    expect(walRows.length).toBeGreaterThan(0);
    // every event in the projection is a row: 8 binds (channel + helper
    // endpoints, thread base, question, response, meta, lastMessage,
    // rememberedAt) + 2 links (lives-in, served-by)
    expect(walRows.length).toBe(10);
    expect(section).toContain("## thread:t-remember");

    const { results: stored } = await db
      .prepare("select * from quilt_wal order by seq")
      .all();
    expect(stored.length).toBe(walRows.length);
    expect(verifyChain(stored)).toBe(true);

    // the thread's cells are in the chain, including the link rows
    const cells = stored.map((r) => r.cell);
    expect(cells).toContain("thread.t-remember");
    expect(cells).toContain("thread.t-remember.question");
    expect(cells).toContain("thread.t-remember.response");
    expect(cells.some((c) => c.endsWith("->channel.c1"))).toBe(true);
    expect(stored.every((r) => r.mutation_id === ctx.mutationId)).toBe(true);
    expect(stored.every((r) => r.ts === ctx.ts)).toBe(true);
  });

  test("recallHelperContext returns the relevant chunks", async () => {
    await rememberChannelThreads(ocean, db, [
      thread({ id: "t-lobster", questionText: "midnight lobster species", responseText: "abyssal crustacean, bioluminescent antennae" }),
      thread({ id: "t-quilt", helperKey: "quilt-kernel", helperName: "Quilt Keeper", questionText: "what is the WAL hash chain", responseText: "fnv1a over prev|seq|cell|op|value|ts|mutation" }),
      thread({ id: "t-music", helperKey: "music-theory", helperName: "Music Theorist", questionText: "what is a dominant seventh", responseText: "a major triad with a minor seventh above the root" })
    ], { mutationId: nextMutation("sweep"), ts: ts("2026-09-17T17:53:00.000Z") });

    const hits = await recallHelperContext(ocean, "lobster species abyssal");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe("t-lobster");

    const hits2 = await recallHelperContext(ocean, "WAL hash chain fnv1a");
    expect(hits2[0].id).toBe("t-quilt");

    // limit clamps to 3..5 per the recalled design
    const hits3 = await recallHelperContext(ocean, "lobster", { limit: 50 });
    expect(hits3.length).toBeLessThanOrEqual(5);
  });

  test("detectQuietThreads flags a stalled thread; growing thread stays loud", () => {
    const polls = [
      { threadId: "t-quiet", ts: "2026-09-17T10:00:00Z", messageCount: 12 },
      { threadId: "t-quiet", ts: "2026-09-17T10:30:00Z", messageCount: 12 },
      { threadId: "t-quiet", ts: "2026-09-17T11:00:00Z", messageCount: 12 },
      { threadId: "t-quiet", ts: "2026-09-17T11:30:00Z", messageCount: 12 },
      { threadId: "t-loud", ts: "2026-09-17T10:00:00Z", messageCount: 3 },
      { threadId: "t-loud", ts: "2026-09-17T10:30:00Z", messageCount: 5 },
      { threadId: "t-loud", ts: "2026-09-17T11:00:00Z", messageCount: 9 }
    ];
    const quiet = detectQuietThreads(polls, { window: 3 });
    expect(quiet.length).toBe(1);
    expect(quiet[0].threadId).toBe("t-quiet");
    expect(quiet[0].lastCount).toBe(12);
    expect(quiet[0].silentPolls).toBe(4);
    expect(quiet[0].since).toBe("2026-09-17T10:00:00Z");
  });

  test("quiet threads drain into the WAL negative ledger (.quiet cells)", async () => {
    const t = thread({ id: "t-stall" });
    await rememberHelperThread(ocean, db, t, { mutationId: nextMutation("remember"), ts: ts("2026-09-17T17:52:00.000Z") });

    const polls = [0, 1, 2, 3].map((i) => ({
      threadId: "t-stall",
      ts: `2026-09-17T1${i}:00:00Z`,
      messageCount: 7
    }));
    const quiet = detectQuietThreads(polls, { window: 3 });
    expect(quiet.length).toBe(1);

    const { walRows } = await drainQuietThreads(db, quiet, {
      mutationId: nextMutation("stall-monitor"),
      ts: ts("2026-09-17T18:00:00.000Z")
    });
    expect(walRows.length).toBe(1);
    expect(walRows[0].cell).toBe("thread.t-stall.quiet");
    const payload = JSON.parse(walRows[0].value);
    expect(payload.lastCount).toBe(7);
    expect(payload.silentPolls).toBe(4);

    const { results: stored } = await db.prepare("select * from quilt_wal order by seq").all();
    expect(verifyChain(stored)).toBe(true);
  });

  test("replay from WAL ALONE reconstructs the ocean index (recall parity)", async () => {
    const threads = [
      thread({ id: "t-rl", questionText: "penrose tiles quasicrystal", responseText: "non-periodic tilings with fivefold symmetry" }),
      thread({ id: "t-mb", helperKey: "mandelbrot", helperName: "Mandelbrot Guide", questionText: "mandelbrot meets fibonacci", responseText: "the boundary's spirals echo the golden ratio" })
    ];
    await rememberChannelThreads(ocean, db, threads, {
      mutationId: nextMutation("sweep"),
      ts: ts("2026-09-17T17:53:00.000Z")
    });
    const liveHits = await recallHelperContext(ocean, "penrose quasicrystal");

    // fresh ocean, NO markdown — replay the WAL into the index
    const { results: rows } = await db.prepare("select * from quilt_wal order by seq").all();
    expect(verifyChain(rows)).toBe(true);
    const replayed = replayThreadIndexFromWal(rows);
    const fresh = new TidepoolOcean({ now });
    fresh.index = replayed;

    const replayedHits = await recallHelperContext(fresh, "penrose quasicrystal");
    expect(replayedHits.length).toBe(liveHits.length);
    expect(replayedHits[0]?.id).toBe(liveHits[0]?.id);
    expect(replayedHits[0]?.questionText).toBe(liveHits[0]?.questionText);
    expect(replayed.get("t-rl")?.questionText).toBe("penrose tiles quasicrystal");
    expect(replayed.get("t-mb")?.helperName).toBe("Mandelbrot Guide");
  });

  test("oaths: append-only, timestamps everywhere, tamper-evident", async () => {
    const t = thread({ id: "t-oath" });
    await rememberHelperThread(ocean, db, t, { mutationId: nextMutation("remember"), ts: ts("2026-09-17T17:52:00.000Z") });
    // re-remembering appends a NEW section; the old one survives
    await rememberHelperThread(ocean, db, { ...t, responseText: "a refined answer" }, { mutationId: nextMutation("remember"), ts: ts("2026-09-17T17:54:00.000Z") });

    const md = readFileSync(oceanPath, "utf8");
    expect(md.match(/## thread:t-oath/g).length).toBe(2);
    expect(md).toContain("a refined answer");
    expect(md.indexOf("a refined answer")).toBeGreaterThan(md.indexOf("bioluminescent antennae"));

    const stats = ocean.stats();
    expect(stats.threadSections).toBe(2);
    expect(stats.oathViolations).toBe(0);

    const { results: rows } = await db.prepare("select * from quilt_wal order by seq").all();
    expect(verifyChain(rows)).toBe(true);
    // tamper with one value → chain fails
    const tampered = rows.map((r, i) => (i === 3 ? { ...r, value: '{"kind":"forged"}' } : r));
    expect(verifyChain(tampered)).toBe(false);

    // bot actions: append-only + timestamped
    await rememberBotAction(ocean, "recalled helper context for #c1");
    await rememberBotAction(ocean, "drained stall monitor");
    expect(ocean.stats().botActionLines).toBe(2);
    const md2 = readFileSync(oceanPath, "utf8");
    expect(md2.match(/^- 2026-09-17T17:52:00\.000Z /gm).length).toBe(2);
  });
});
