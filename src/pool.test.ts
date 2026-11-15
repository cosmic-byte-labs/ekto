import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "kysely";
import { ConnectionError } from "./errors.ts";
import { ConnectionPool } from "./pool.ts";
import { createRepo } from "./repo.ts";
import { sqlite } from "./sqlite/index.ts";

describe("ConnectionPool", () => {
  test("hands out at most size connections, then queues in order", async () => {
    const pool = new ConnectionPool({ size: 2 });
    await pool.checkout();
    await pool.checkout();
    const order: number[] = [];
    const first = pool.checkout().then(() => order.push(1));
    const second = pool.checkout().then(() => order.push(2));
    await sleep(5);
    assert.deepEqual(order, []);
    pool.checkin();
    await first;
    assert.deepEqual(order, [1]);
    pool.checkin();
    await second;
    assert.deepEqual(order, [1, 2]);
    pool.checkin();
    pool.checkin();
    await pool.checkout();
    await pool.checkout();
    pool.stop();
  });

  test("drops requests that wait too long when the queue is slow", async () => {
    const pool = new ConnectionPool({
      size: 1,
      queueTarget: 5,
      queueInterval: 20,
    });
    await pool.checkout();
    const waiting = pool.checkout();
    await assert.rejects(waiting, (error: unknown) => {
      assert.ok(error instanceof ConnectionError);
      assert.equal(error.reason, "queue_timeout");
      assert.match(error.message, /dropped from queue after \d+ms/);
      return true;
    });
    pool.stop();
  });

  test("a queued request can be aborted", async () => {
    const pool = new ConnectionPool({ size: 1 });
    await pool.checkout();
    const controller = new AbortController();
    const waiting = pool.checkout(controller.signal);
    controller.abort(new Error("gave up"));
    await assert.rejects(waiting, /gave up/);
    // The aborted request no longer holds a place in the queue.
    pool.checkin();
    await pool.checkout();
    pool.stop();
  });

  test("stopping fails the queued requests and later checkouts", async () => {
    const pool = new ConnectionPool({ size: 1 });
    await pool.checkout();
    const waiting = pool.checkout();
    pool.stop();
    await assert.rejects(waiting, ConnectionError);
    await assert.rejects(pool.checkout(), /the pool is stopped/);
  });

  test("the size is a positive integer", () => {
    assert.throws(() => new ConnectionPool({ size: 0 }), TypeError);
    assert.throws(() => new ConnectionPool({ size: 1.5 }), TypeError);
  });
});

describe("a Repo's pool", () => {
  const dir = mkdtempSync(join(tmpdir(), "ekto-pool-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("defaults to the adapter's size, Ecto's queue target and interval", async () => {
    const repo = createRepo({ adapter: sqlite(), database: ":memory:" });
    assert.equal(repo.config.poolSize, 1);
    assert.equal(repo.config.queueTarget, 50);
    assert.equal(repo.config.queueInterval, 2000);
    await repo.stop();
  });

  test("an in-memory SQLite database needs a pool of one", () => {
    assert.throws(
      () =>
        createRepo({ adapter: sqlite(), database: ":memory:", poolSize: 2 }),
      /In memory databases must have a poolSize of 1/,
    );
  });

  test("SQLite needs a database", () => {
    assert.throws(() => createRepo({ adapter: sqlite() }), TypeError);
  });

  test("a pool of one serializes transactions", async () => {
    const repo = createRepo({
      adapter: sqlite(),
      database: join(dir, "serial.db"),
    });
    await sql`CREATE TABLE log (n INTEGER)`.execute(repo.kysely);
    const run = (n: number) =>
      repo.kysely.transaction().execute(async (trx) => {
        await sql`INSERT INTO log (n) VALUES (${n})`.execute(trx);
        await sleep(5);
        await sql`INSERT INTO log (n) VALUES (${n})`.execute(trx);
      });
    await Promise.all([run(1), run(2)]);
    const { rows } = await sql<{
      n: number;
    }>`SELECT n FROM log ORDER BY rowid`.execute(repo.kysely);
    assert.deepEqual(
      rows.map((r) => r.n),
      [1, 1, 2, 2],
    );
    await repo.stop();
  });

  test("a stopped Repo runs no queries", async () => {
    const repo = createRepo({ adapter: sqlite(), database: ":memory:" });
    await repo.stop();
    await assert.rejects(sql`SELECT 1`.execute(repo.kysely));
  });
});
