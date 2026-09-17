// d1sqlite.mjs — bun:sqlite-backed D1 stand-in for the bench.
//
// PROVENANCE: ported from SuperInstance/hermit @ quilt-kernel-p2-encounters,
// tests/helpers/sqliteD1.ts (SqliteD1Database). Semantics preserved:
// prepare/bind/all/batch with begin-immediate/commit/rollback around batch,
// withSession() returning this. The bench uses it to prove the WAL chain
// against a REAL sqlite, not a mock — replay is the referee.

import { Database } from "bun:sqlite";

const d1Result = (results) => ({
  success: true,
  results,
  meta: {}
});

class SqliteD1PreparedStatement {
  constructor(owner, query, params = []) {
    this.owner = owner;
    this.query = query;
    this.params = params;
  }

  bind(...values) {
    return new SqliteD1PreparedStatement(this.owner, this.query, values);
  }

  async run() {
    await this.owner.run(this.query, this.params);
    return d1Result([]);
  }

  async all() {
    return d1Result(
      this.owner.database.query(this.query).all(...this.params)
    );
  }

  async raw() {
    return this.owner.database.query(this.query).values(...this.params);
  }

  async first(columnName) {
    const first = this.owner.database.query(this.query).get(...this.params);
    if (!first || !columnName) return first;
    return first[columnName] ?? null;
  }
}

export class SqliteD1Database {
  constructor(path = ":memory:") {
    this.database = new Database(path);
    this.transactionTail = Promise.resolve();
    this.releaseTransaction = null;
  }

  prepare(query) {
    return new SqliteD1PreparedStatement(this, query);
  }

  async batch(statements) {
    const results = [];
    await this.run("begin immediate", []);
    try {
      for (const statement of statements) {
        results.push(await statement.all());
      }
      await this.run("commit", []);
      return results;
    } catch (error) {
      await this.run("rollback", []);
      throw error;
    }
  }

  async exec(query) {
    this.database.exec(query);
    return { count: 0, duration: 0 };
  }

  withSession() {
    return this;
  }

  async run(query, params) {
    const normalized = query.trim().toLowerCase();
    if (normalized.startsWith("begin")) {
      const previous = this.transactionTail;
      let release = () => {};
      this.transactionTail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      this.releaseTransaction = release;
      try {
        this.database.query(query).run(...params);
      } catch (error) {
        this.releaseTransaction = null;
        release();
        throw error;
      }
      return;
    }

    if (normalized === "commit" || normalized === "rollback") {
      try {
        this.database.query(query).run(...params);
      } finally {
        this.releaseTransaction?.();
        this.releaseTransaction = null;
      }
      return;
    }

    this.database.query(query).run(...params);
  }

  close() {
    this.database.close();
  }
}
