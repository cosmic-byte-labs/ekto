import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "kysely";
import { ConnectionError } from "./errors.ts";
import { ConnectionPool, type PoolOptions } from "./pool.ts";
import { createRepo } from "./repo.ts";
import { sqlite } from "./sqlite/index.ts";

interface Fake {
  readonly id: number;
  closed: boolean;
  pings: number;
}

/** A pool of fake connections, with the ones it opened. */
function fakePool(
  options: Omit<PoolOptions, "size"> & { size?: number },
  ping: (connection: Fake) => Promise<void> = async () => {},
) {
  const opened: Fake[] = [];
  const pool = new ConnectionPool<Fake>(
    { size: 1, ...options },
    {
      async open() {
        const connection = { id: opened.length + 1, closed: false, pings: 0 };
        opened.push(connection);
        return connection;
      },
      async close(connection) {
        connection.closed = true;
      },
      async ping(connection) {
        connection.pings++;
        await ping(connection);
      },
    },
  );
  return { pool, opened };
}

describe("ConnectionPool", () => {
  test("opens at most size connections, then queues in order", async () => {
    const { pool, opened } = fakePool({ size: 2 });
    const a = await pool.checkout();
    const b = await pool.checkout();
    const order: number[] = [];
    const first = pool.checkout().then((c) => order.push(c.id));
    const second = pool.checkout().then((c) => order.push(c.id));
    await sleep(5);
    assert.deepEqual(order, []);
    pool.checkin(a);
    await first;
    pool.checkin(b);
    await second;
    assert.deepEqual(order, [1, 2]);
    assert.equal(opened.length, 2);
    await pool.stop();
  });

  test("reuses the connection idle the longest", async () => {
    const { pool } = fakePool({ size: 2 });
    const a = await pool.checkout();
    const b = await pool.checkout();
    pool.checkin(b);
    pool.checkin(a);
    assert.equal((await pool.checkout()).id, b.id);
    await pool.stop();
  });

  test("drops requests that wait too long when the queue is slow", async () => {
    const { pool } = fakePool({ queueTarget: 5, queueInterval: 20 });
    await pool.checkout();
    await assert.rejects(pool.checkout(), (error: unknown) => {
      assert.ok(error instanceof ConnectionError);
      assert.equal(error.reason, "queue_timeout");
      assert.match(error.message, /dropped from queue after \d+ms/);
      return true;
    });
    await pool.stop();
  });

  test("a queued request can be aborted", async () => {
    const { pool } = fakePool({});
    const a = await pool.checkout();
    const controller = new AbortController();
    const waiting = pool.checkout(controller.signal);
    controller.abort(new Error("gave up"));
    await assert.rejects(waiting, /gave up/);
    // The aborted request no longer holds a place in the queue.
    pool.checkin(a);
    assert.equal(await pool.checkout(), a);
    await pool.stop();
  });

  test("a closed connection's place goes to the next caller", async () => {
    const { pool, opened } = fakePool({});
    const a = await pool.checkout();
    const waiting = pool.checkout();
    pool.disconnect(a);
    const b = await waiting;
    assert.equal(b.id, 2);
    assert.equal(opened.length, 2);
    await pool.stop();
  });

  test("idle connections are pinged, and closed when the ping fails", async () => {
    let fail = false;
    const { pool, opened } = fakePool(
      { size: 2, idleInterval: 10 },
      async () => {
        if (fail) throw new Error("gone");
      },
    );
    const a = await pool.checkout();
    const b = await pool.checkout();
    pool.checkin(a);
    pool.checkin(b);
    await sleep(40);
    assert.ok(a.pings > 0 && b.pings > 0, "both pinged");
    assert.equal(a.closed, false);
    fail = true;
    await sleep(40);
    assert.ok(a.closed && b.closed);
    // The pool opens new connections in their place.
    assert.equal((await pool.checkout()).id, 3);
    assert.equal(opened.length, 3);
    await pool.stop();
  });

  test("idleLimit bounds the pings per interval", async () => {
    const { pool } = fakePool({ size: 2, idleInterval: 10, idleLimit: 1 });
    const a = await pool.checkout();
    const b = await pool.checkout();
    pool.checkin(a);
    pool.checkin(b);
    await sleep(25);
    assert.ok(a.pings + b.pings <= 2);
    await pool.stop();
  });

  test("connections past their lifetime close on checkin or when idle", async () => {
    const { pool } = fakePool({ maxLifetime: [10, 10], idleInterval: 10 });
    const a = await pool.checkout();
    await sleep(15);
    pool.checkin(a);
    assert.equal(a.closed, true, "closed on checkin");
    const b = await pool.checkout();
    assert.equal(b.id, 2);
    pool.checkin(b);
    await sleep(40);
    assert.equal(b.closed, true, "closed while idle");
    await pool.stop();
  });

  test("stopping fails the queued requests and later checkouts", async () => {
    const { pool } = fakePool({});
    const a = await pool.checkout();
    const waiting = pool.checkout();
    await pool.stop();
    await assert.rejects(waiting, ConnectionError);
    await assert.rejects(pool.checkout(), /the pool is stopped/);
    pool.checkin(a);
    assert.equal(a.closed, true, "closed when checked in after stop");
  });

  test("stopping closes the idle connections", async () => {
    const { pool } = fakePool({});
    const a = await pool.checkout();
    pool.checkin(a);
    await pool.stop();
    assert.equal(a.closed, true);
  });

  test("validates its options", () => {
    assert.throws(() => fakePool({ size: 0 }), /poolSize/);
    assert.throws(() => fakePool({ size: 1.5 }), /poolSize/);
    assert.throws(() => fakePool({ idleInterval: -1 }), /idleInterval/);
    assert.throws(
      () => fakePool({ maxLifetime: [10, 5] }),
      /invalid value for maxLifetime/,
    );
  });
});

describe("a Repo's pool", () => {
  const dir = mkdtempSync(join(tmpdir(), "ekto-pool-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("defaults to the adapter's size, Ecto's queue target and interval", async () => {
    const repo = createRepo({
      adapter: sqlite(),
      database: join(dir, "defaults.db"),
    });
    assert.equal(repo.config.poolSize, 5, "ecto_sqlite3's");
    assert.equal(repo.config.queueTarget, 50);
    assert.equal(repo.config.queueInterval, 2000);
    assert.equal(repo.config.idleInterval, 1000);
    assert.equal(repo.config.idleLimit, 5);
    assert.equal(repo.config.maxLifetime, undefined);
    await repo.stop();
  });

  test("an in-memory SQLite database needs a pool of one", () => {
    assert.throws(
      () => createRepo({ adapter: sqlite(), database: ":memory:" }),
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
      poolSize: 1,
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

  test("SQLite connections wait for the write lock without blocking the others", async () => {
    const repo = createRepo({
      adapter: sqlite(),
      database: join(dir, "concurrent.db"),
    });
    await sql`CREATE TABLE log (n INTEGER)`.execute(repo.kysely);
    const run = (n: number) =>
      repo.kysely.transaction().execute(async (trx) => {
        await sql`INSERT INTO log (n) VALUES (${n})`.execute(trx);
        await sleep(20);
        await sql`INSERT INTO log (n) VALUES (${n})`.execute(trx);
      });
    // The second waits up to busyTimeout on its first insert while the
    // first, on another connection, finishes.
    await Promise.all([run(1), run(2), run(3)]);
    const { rows } = await sql<{
      n: number;
    }>`SELECT n FROM log ORDER BY rowid`.execute(repo.kysely);
    assert.deepEqual(rows.map((r) => r.n).sort(), [1, 1, 2, 2, 3, 3]);
    await repo.stop();
  });

  test("a stopped Repo runs no queries", async () => {
    const repo = createRepo({
      adapter: sqlite(),
      database: ":memory:",
      poolSize: 1,
    });
    await repo.stop();
    await assert.rejects(sql`SELECT 1`.execute(repo.kysely));
  });
});
