// ocean.mjs — the tidepool ocean: a markdown memory file with a recall index.
//
// Implements the recalled tidepool v1 design for hermit's helper threads:
//   rememberHelperThread / rememberChannelThreads store thread SUMMARIES
//   into an ocean markdown file; recallHelperContext fetches the top 3-5
//   relevant chunks.
//
// rememberBotAction oaths (the contract this file enforces by API shape):
//   1. NEVER modify messages — the ocean exposes no edit/delete API at all.
//   2. ALWAYS append-only — re-remembering a thread appends a NEW section;
//      the old section stays (memory of a memory is itself a memory).
//   3. ALWAYS include timestamps — every section carries `rememberedAt`,
//      every bot-action log line carries an ISO ts. `stats()` verifies.

import { appendFile, readFile } from "node:fs/promises";

const SECTION_RE = /^## thread:([^\n]+)$/gm;

const tokenize = (text) =>
  String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2);

export class TidepoolOcean {
  /**
   * @param {{path?: string, now?: () => string}} [options]
   *   path — ocean markdown file. Omit for a pure in-memory ocean (tests).
   *   now  — clock injection; MUST return an ISO-8601 ts (oath 3).
   */
  constructor({ path = null, now = () => new Date().toISOString() } = {}) {
    this.path = path;
    this.now = now;
    this.markdown = "# Tidepool Ocean\n\n<!-- append-only: never modify, never delete. every section carries rememberedAt. -->\n";
    /** @type {Map<string, Object>} threadId -> recall entry (latest memory wins) */
    this.index = new Map();
    this._actionCount = 0;
  }

  // ---- oath-checked append (the ONLY write path) ----
  async _append(text) {
    this.markdown += text;
    if (this.path) await appendFile(this.path, text, "utf8");
  }

  /**
   * Remember one helper-thread summary. Appends a `## thread:<id>` section
   * and upserts the recall index. Returns {section, entry}.
   */
  async remember(thread) {
    const ts = this.now();
    const entry = {
      id: thread.id,
      guildId: thread.guildId,
      channelId: thread.channelId,
      userId: thread.userId,
      helperKey: thread.helperKey,
      helperName: thread.helperName,
      questionText: thread.questionText,
      responseText: thread.responseText,
      thinkingLevel: thread.thinkingLevel,
      responseLength: thread.responseLength,
      createdAt: thread.createdAt,
      authorTag: thread.authorTag,
      authorUsername: thread.authorUsername,
      lastMessageId: thread.lastMessageId,
      rememberedAt: ts
    };
    const section =
      `## thread:${thread.id}\n` +
      `rememberedAt: ${ts}\n` +
      `helper: ${thread.helperName} (${thread.helperKey})\n` +
      `channel: ${thread.channelId} guild: ${thread.guildId}\n` +
      `author: ${thread.authorUsername} (${thread.authorTag})\n` +
      `thinking: ${thread.thinkingLevel} responseChars: ${thread.responseLength}\n` +
      `question: ${thread.questionText}\n` +
      `response: ${thread.responseText}\n` +
      `lastMessage: ${thread.lastMessageId}\n\n`;
    await this._append(section);
    this.index.set(thread.id, entry);
    return { section, entry };
  }

  /**
   * Channel sweep: remember several thread summaries (the
   * rememberChannelThreads shape — one mutation per channel sweep).
   */
  async rememberAll(threads) {
    const out = [];
    for (const t of threads) out.push(await this.remember(t));
    return out;
  }

  /**
   * recallHelperContext: top `limit` (default 5, clamp 3..5 per the
   * recalled design) relevant chunks. Deterministic token-overlap scoring:
   * helperName/question matches weigh 2, response/meta matches weigh 1.
   * Ties break to the most recently remembered.
   */
  async recall(query, { limit = 5 } = {}) {
    const clamped = Math.max(3, Math.min(5, limit));
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const scored = [];
    for (const entry of this.index.values()) {
      const haystack = {
        q: tokenize(`${entry.helperName} ${entry.questionText}`),
        r: tokenize(`${entry.responseText} ${entry.helperKey} ${entry.authorUsername} ${entry.thinkingLevel}`)
      };
      let score = 0;
      for (const t of tokens) {
        if (haystack.q.includes(t)) score += 2;
        if (haystack.r.includes(t)) score += 1;
      }
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) =>
      b.score - a.score ||
      String(b.entry.rememberedAt).localeCompare(String(a.entry.rememberedAt))
    );
    return scored.slice(0, clamped).map((s) => s.entry);
  }

  /**
   * rememberBotAction oath log — append-only, timestamped, immutable.
   * Action strings must be plain text; the oath is enforced structurally:
   * there is no API to change a line once written.
   */
  async botAction(action) {
    const ts = this.now();
    const line = `- ${ts} ${String(action).replace(/[\n\r]+/g, " ")}\n`;
    if (this._actionCount === 0) await this._append("\n## bot-actions\n");
    await this._append(line);
    this._actionCount += 1;
    return { ts, action: line.trim() };
  }

  /** Oath audit: every thread section carries rememberedAt; returns counts. */
  stats() {
    const sections = [...this.markdown.matchAll(SECTION_RE)];
    let oathViolations = 0;
    for (const m of sections) {
      const rest = this.markdown.slice(m.index);
      const end = rest.indexOf("\n## ", 4);
      const body = end === -1 ? rest : rest.slice(0, end);
      if (!/^rememberedAt: \S+/m.test(body)) oathViolations += 1;
    }
    return {
      threadSections: sections.length,
      indexEntries: this.index.size,
      botActionLines: this._actionCount,
      oathViolations,
      bytes: Buffer.byteLength(this.markdown)
    };
  }

  /** Load an existing ocean file back into memory (rebuilds the index from
   *  the LATEST section per thread — replay is the referee). */
  async load() {
    if (!this.path) throw new Error("ocean has no path");
    this.markdown = await readFile(this.path, "utf8");
    this.index.clear();
    this._actionCount = 0;
    const sections = [...this.markdown.matchAll(SECTION_RE)];
    for (const m of sections) {
      const rest = this.markdown.slice(m.index);
      const end = rest.indexOf("\n## ", 4);
      const body = (end === -1 ? rest : rest.slice(0, end)).split("\n");
      const id = m[1].trim();
      const get = (prefix) => {
        const line = body.find((l) => l.startsWith(prefix));
        return line ? line.slice(prefix.length).trim() : "";
      };
      const helper = get("helper: ").match(/^(.*) \((.*)\)$/);
      const channel = get("channel: ").match(/^(.*) guild: (.*)$/);
      const author = get("author: ").match(/^(.*) \((.*)\)$/);
      const thinking = get("thinking: ").match(/^(.*) responseChars: (.*)$/);
      this.index.set(id, {
        id,
        rememberedAt: get("rememberedAt: "),
        helperName: helper?.[1] ?? "",
        helperKey: helper?.[2] ?? "",
        channelId: channel?.[1] ?? "",
        guildId: channel?.[2] ?? "",
        authorUsername: author?.[1] ?? "",
        authorTag: author?.[2] ?? "",
        thinkingLevel: thinking?.[1] ?? "",
        responseLength: Number(thinking?.[2] ?? 0),
        questionText: get("question: "),
        responseText: get("response: "),
        lastMessageId: get("lastMessage: "),
        userId: "",
        createdAt: ""
      });
    }
    return this;
  }
}
