/**
 * The connection pool a Repo owns, following DBConnection's
 * `ConnectionPool`: at most `size` connections are checked out at once, and
 * callers queue for one under CoDel, which drops requests that wait too
 * long instead of letting them wait forever.
 */

import type {
  DatabaseConnection,
  Dialect,
  Driver,
  QueryCompiler,
  TransactionSettings,
} from "kysely";
import { ConnectionError } from "./errors.ts";

export interface PoolOptions {
  /** The number of connections (Ecto's `:pool_size`). */
  readonly size: number;
  /** How long a checkout should wait at most, in ms (`:queue_target`, 50). */
  readonly queueTarget?: number;
  /** The window in which the target is checked, in ms (`:queue_interval`, 2000). */
  readonly queueInterval?: number;
}

interface Waiter {
  /** When it queued (ms, monotonic). */
  readonly sent: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * DBConnection.ConnectionPool's queue. The goal is to wait at most
 * `queueTarget` for a connection. If every checkout in a `queueInterval`
 * waited longer than the target, the target is doubled, and requests that
 * wait longer than that are dropped with a `ConnectionError`.
 */
export class ConnectionPool {
  readonly size: number;
  readonly #target: number;
  readonly #interval: number;
  /** Connections not checked out (DBConnection's `:ready` state when above 0). */
  #available: number;
  /** Callers waiting for a connection, oldest first. */
  readonly #queue: Waiter[] = [];
  // The CoDel state: the minimum delay of the interval, whether it was slow
  // and when the next interval starts.
  #delay = 0;
  #slow = false;
  #next: number;
  #poll: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor({ size, queueTarget = 50, queueInterval = 2000 }: PoolOptions) {
    if (!Number.isInteger(size) || size < 1)
      throw new TypeError(
        `expected poolSize to be a positive integer, got: ${size}`,
      );
    this.size = size;
    this.#target = queueTarget;
    this.#interval = queueInterval;
    this.#available = size;
    const now = performance.now();
    this.#next = now;
    this.#startPoll(now);
  }

  /** Waits for a connection to be free and takes it. */
  checkout(signal?: AbortSignal): Promise<void> {
    if (this.#stopped)
      return Promise.reject(
        new ConnectionError("connection not available: the pool is stopped"),
      );
    signal?.throwIfAborted();
    if (this.#available > 0) {
      this.#available--;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.#queue.indexOf(waiter);
        if (index !== -1) this.#queue.splice(index, 1);
        reject(signal?.reason);
      };
      const waiter: Waiter = {
        sent: performance.now(),
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  /** Gives a connection back, to the next caller in the queue. */
  checkin(): void {
    if (this.#available > 0 || this.#stopped) {
      this.#available++;
      return;
    }
    const now = performance.now();
    if (now >= this.#next) this.#dequeueFirst(now, this.#delay > this.#target);
    else if (!this.#slow) this.#dequeueFast(now);
    else this.#dequeueSlow(now, this.#target * 2);
  }

  /** Stops the pool: queued callers fail, and so do later checkouts. */
  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#poll);
    for (const waiter of this.#queue.splice(0))
      waiter.reject(
        new ConnectionError("connection not available: the pool was stopped"),
      );
  }

  #dequeueFirst(time: number, slow: boolean): void {
    this.#next = time + this.#interval;
    this.#slow = slow;
    const waiter = this.#queue.shift();
    if (waiter === undefined) {
      this.#delay = 0;
      this.#available++;
      return;
    }
    this.#delay = time - waiter.sent;
    waiter.resolve();
  }

  #dequeueFast(time: number): void {
    const waiter = this.#queue.shift();
    if (waiter === undefined) {
      this.#delay = 0;
      this.#available++;
      return;
    }
    this.#go(time - waiter.sent, waiter);
  }

  #dequeueSlow(time: number, timeout: number): void {
    for (;;) {
      const waiter = this.#queue.shift();
      if (waiter === undefined) {
        this.#delay = 0;
        this.#available++;
        return;
      }
      if (time - waiter.sent > timeout) {
        drop(time - waiter.sent, waiter);
        continue;
      }
      this.#go(time - waiter.sent, waiter);
      return;
    }
  }

  #go(delay: number, waiter: Waiter): void {
    if (delay < this.#delay) this.#delay = delay;
    waiter.resolve();
  }

  // Every interval, a queue that made no progress since the last poll is
  // checked: when the interval was slow, the requests waiting longer than
  // twice the target are dropped.
  #startPoll(lastSent: number): void {
    this.#poll = setTimeout(() => {
      const time = performance.now();
      const first = this.#queue[0];
      if (first !== undefined && first.sent <= lastSent) {
        const delay = time - first.sent;
        this.#startPoll(first.sent);
        this.#timeout(delay, time);
      } else this.#startPoll(first?.sent ?? time);
    }, this.#interval);
    this.#poll.unref();
  }

  #timeout(delay: number, time: number): void {
    if (time < this.#next) return;
    if (this.#delay > this.#target) {
      this.#slow = true;
      this.#delay = delay;
      this.#next = time + this.#interval;
      const minSent = time - this.#target * 2;
      for (let i = 0; i < this.#queue.length; ) {
        const waiter = this.#queue[i] as Waiter;
        if (waiter.sent < minSent) {
          this.#queue.splice(i, 1);
          drop(time - waiter.sent, waiter);
        } else i++;
      }
    } else {
      this.#slow = false;
      this.#delay = delay;
      this.#next = time + this.#interval;
    }
  }
}

function drop(delay: number, waiter: Waiter): void {
  waiter.reject(
    new ConnectionError(
      `connection not available and request was dropped from queue after ${Math.round(delay)}ms. This means requests are coming in and your connection pool cannot serve them fast enough. You can address this by:

  1. Ensuring your database is available and that you can connect to it
  2. Tracking down slow queries and making sure they are running fast enough
  3. Increasing the poolSize (although this increases resource consumption)
  4. Allowing requests to wait longer by increasing queueTarget and queueInterval
`,
      "queue_timeout",
    ),
  );
}

/**
 * The dialect with its connections checked out through `pool`, so Kysely
 * holds at most `pool.size` connections at once.
 */
export function pooledDialect(dialect: Dialect, pool: ConnectionPool): Dialect {
  return {
    createDriver: () => pooledDriver(dialect.createDriver(), pool),
    createQueryCompiler: () => dialect.createQueryCompiler(),
    createAdapter: () => dialect.createAdapter(),
    createIntrospector: (db) => dialect.createIntrospector(db),
  };
}

function pooledDriver(driver: Driver, pool: ConnectionPool): Driver {
  return {
    init: (options) => driver.init(options),
    async acquireConnection(options) {
      await pool.checkout(options?.signal);
      try {
        return await driver.acquireConnection(options);
      } catch (error) {
        pool.checkin();
        throw error;
      }
    },
    beginTransaction: (connection, settings) =>
      driver.beginTransaction(connection, settings),
    commitTransaction: (connection) => driver.commitTransaction(connection),
    rollbackTransaction: (connection) => driver.rollbackTransaction(connection),
    ...savepoints(driver),
    async releaseConnection(connection, options) {
      try {
        await driver.releaseConnection(connection, options);
      } finally {
        pool.checkin();
      }
    },
    async destroy(options) {
      pool.stop();
      await driver.destroy(options);
    },
  };
}

function savepoints(driver: Driver): Partial<Driver> {
  const { savepoint, rollbackToSavepoint, releaseSavepoint } = driver;
  return {
    ...(savepoint && { savepoint: savepoint.bind(driver) }),
    ...(rollbackToSavepoint && {
      rollbackToSavepoint: rollbackToSavepoint.bind(driver),
    }),
    ...(releaseSavepoint && {
      releaseSavepoint: releaseSavepoint.bind(driver),
    }),
  };
}

/**
 * A driver over drivers of one connection each (such as Kysely's
 * `SqliteDriver`), opened as they are needed: each checkout takes a driver
 * no one holds. The pool around it keeps their number at the pool size.
 */
export function connectionsDriver(create: () => Driver): Driver {
  const idle: Driver[] = [];
  const all: Driver[] = [];
  const owners = new Map<DatabaseConnection, Driver>();
  const ownerOf = (connection: DatabaseConnection): Driver => {
    const owner = owners.get(connection);
    if (owner === undefined) throw new Error("unknown connection");
    return owner;
  };
  return {
    async init() {},
    async acquireConnection(options) {
      let driver = idle.pop();
      if (driver === undefined) {
        driver = create();
        await driver.init(options);
        all.push(driver);
      }
      const connection = await driver.acquireConnection(options);
      owners.set(connection, driver);
      return connection;
    },
    beginTransaction: (connection, settings: TransactionSettings) =>
      ownerOf(connection).beginTransaction(connection, settings),
    commitTransaction: (connection) =>
      ownerOf(connection).commitTransaction(connection),
    rollbackTransaction: (connection) =>
      ownerOf(connection).rollbackTransaction(connection),
    savepoint: (connection, name, compile: QueryCompiler["compileQuery"]) =>
      callSavepoint(
        ownerOf(connection),
        "savepoint",
        connection,
        name,
        compile,
      ),
    rollbackToSavepoint: (connection, name, compile) =>
      callSavepoint(
        ownerOf(connection),
        "rollbackToSavepoint",
        connection,
        name,
        compile,
      ),
    releaseSavepoint: (connection, name, compile) =>
      callSavepoint(
        ownerOf(connection),
        "releaseSavepoint",
        connection,
        name,
        compile,
      ),
    async releaseConnection(connection, options) {
      const driver = ownerOf(connection);
      owners.delete(connection);
      await driver.releaseConnection(connection, options);
      idle.push(driver);
    },
    async destroy(options) {
      await Promise.all(all.splice(0).map((driver) => driver.destroy(options)));
      idle.length = 0;
    },
  };
}

async function callSavepoint(
  driver: Driver,
  method: "savepoint" | "rollbackToSavepoint" | "releaseSavepoint",
  connection: DatabaseConnection,
  name: string,
  compile: QueryCompiler["compileQuery"],
): Promise<void> {
  const fn = driver[method];
  if (fn === undefined)
    throw new Error(`the driver does not support ${method}`);
  await fn.call(driver, connection, name, compile);
}
