/**
 * The connection pool a Repo owns, following DBConnection's
 * `ConnectionPool`: it holds at most `size` connections, callers queue for
 * one under CoDel, which drops requests that wait too long instead of
 * letting them wait forever, idle connections are pinged, and connections
 * can be given a maximum lifetime.
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
  /**
   * How often idle connections are checked, in ms (`:idle_interval`,
   * 1000): each one idle since the last check is pinged, so a connection is
   * pinged after `idleInterval` to `2 * idleInterval` of idleness.
   */
  readonly idleInterval?: number;
  /** The number of connections pinged per check (`:idle_limit`, all of them). */
  readonly idleLimit?: number;
  /**
   * How long a connection lives, in ms, as `[min, max]` (`:max_lifetime`,
   * none): each connection is closed after a time between the two, spread
   * so they do not all reconnect at once. A connection is closed when it is
   * checked in or found idle past its lifetime, so one in use lives on until
   * it is checked in.
   */
  readonly maxLifetime?: readonly [number, number];
}

/** How the pool opens, closes and pings its connections. */
export interface PoolConnector<T> {
  open(): Promise<T>;
  close(connection: T): Promise<void>;
  /** Checks an idle connection; when it fails, the connection is closed. */
  ping(connection: T): Promise<void>;
}

interface Waiter<T> {
  /** When it queued (ms, monotonic). */
  readonly sent: number;
  /** Gets a connection, or `undefined` for a free place to open one in. */
  readonly resolve: (connection: T | undefined) => void;
  readonly reject: (error: unknown) => void;
}

function nonNegative(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0)
    throw new TypeError(
      `expected ${name} to be a non-negative integer, got: ${value}`,
    );
  return value;
}

/**
 * DBConnection.ConnectionPool. Its queue aims to wait at most `queueTarget`
 * for a connection: if every checkout in a `queueInterval` waited longer
 * than the target, the target is doubled, and requests that wait longer
 * than that are dropped with a `ConnectionError`.
 *
 * Unlike DBConnection, which connects every connection when the pool
 * starts, connections open when a checkout finds none free and the pool is
 * not full.
 */
export class ConnectionPool<T> {
  readonly size: number;
  readonly #connector: PoolConnector<T>;
  readonly #target: number;
  readonly #interval: number;
  readonly #idleInterval: number;
  readonly #idleLimit: number;
  readonly #lifetime: readonly [number, number] | undefined;
  /** Connections open or opening, at most `size`. */
  #opened = 0;
  /** Checked-in connections, longest idle first. */
  readonly #idle: { readonly connection: T; readonly at: number }[] = [];
  /** When each connection's lifetime ends, with `maxLifetime`. */
  readonly #deadlines = new Map<T, number>();
  /** Callers waiting for a connection, oldest first. */
  readonly #queue: Waiter<T>[] = [];
  // The CoDel state: the minimum delay of the interval, whether it was slow
  // and when the next interval starts.
  #delay = 0;
  #slow = false;
  #next: number;
  #poll: NodeJS.Timeout | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #stopped: Promise<void> | undefined;

  constructor(options: PoolOptions, connector: PoolConnector<T>) {
    const {
      size,
      queueTarget = 50,
      queueInterval = 2000,
      idleInterval = 1000,
      idleLimit = size,
      maxLifetime,
    } = options;
    if (!Number.isInteger(size) || size < 1)
      throw new TypeError(
        `expected poolSize to be a positive integer, got: ${size}`,
      );
    if (
      maxLifetime !== undefined &&
      !(
        Array.isArray(maxLifetime) &&
        maxLifetime.length === 2 &&
        maxLifetime.every((ms) => Number.isInteger(ms)) &&
        maxLifetime[0] >= 0 &&
        maxLifetime[1] >= maxLifetime[0]
      )
    )
      throw new TypeError(
        `invalid value for maxLifetime, expected [min, max] with 0 <= min <= max, got: ${JSON.stringify(maxLifetime)}`,
      );
    this.size = size;
    this.#connector = connector;
    this.#target = queueTarget;
    this.#interval = queueInterval;
    this.#idleInterval = nonNegative("idleInterval", idleInterval);
    this.#idleLimit = nonNegative("idleLimit", idleLimit);
    this.#lifetime = maxLifetime;
    const now = performance.now();
    this.#next = now;
    this.#startPoll(now);
    this.#startIdle();
  }

  /** Waits for a connection to be free and takes it. */
  async checkout(signal?: AbortSignal): Promise<T> {
    if (this.#stopped) throw stoppedError();
    signal?.throwIfAborted();
    const idle = this.#idle.shift();
    if (idle !== undefined) return idle.connection;
    if (this.#opened < this.size) {
      this.#opened++;
      return this.#connect();
    }
    const connection = await new Promise<T | undefined>((resolve, reject) => {
      const onAbort = () => {
        const index = this.#queue.indexOf(waiter);
        if (index !== -1) this.#queue.splice(index, 1);
        this.#holdLoop();
        reject(signal?.reason);
      };
      const waiter: Waiter<T> = {
        sent: performance.now(),
        resolve: (connection) => {
          signal?.removeEventListener("abort", onAbort);
          this.#holdLoop();
          resolve(connection);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          this.#holdLoop();
          reject(error);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(waiter);
      this.#holdLoop();
    });
    return connection ?? this.#connect();
  }

  /**
   * Gives a connection back, to the next caller in the queue. A connection
   * past its lifetime is closed instead, and its place given on.
   */
  checkin(connection: T): void {
    if (this.#stopped || this.#expired(connection)) this.disconnect(connection);
    else if (this.#idle.length > 0 || !this.#hand(connection))
      this.#idle.push({ connection, at: performance.now() });
  }

  /** Closes a connection, e.g. a broken one, and gives its place on. */
  disconnect(connection: T): void {
    this.#deadlines.delete(connection);
    this.#connector.close(connection).catch(() => {});
    this.#vacate();
  }

  /**
   * Stops the pool: queued callers fail, and so do later checkouts. Idle
   * connections close now, the others when they are checked in.
   */
  stop(): Promise<void> {
    this.#stopped ??= (async () => {
      clearTimeout(this.#poll);
      clearTimeout(this.#idleTimer);
      for (const waiter of this.#queue.splice(0))
        waiter.reject(
          new ConnectionError("connection not available: the pool was stopped"),
        );
      const idle = this.#idle.splice(0);
      this.#opened -= idle.length;
      await Promise.all(
        idle.map(({ connection }) =>
          this.#connector.close(connection).catch(() => {}),
        ),
      );
    })();
    return this.#stopped;
  }

  async #connect(): Promise<T> {
    let connection: T;
    try {
      connection = await this.#connector.open();
    } catch (error) {
      this.#vacate();
      throw error;
    }
    if (this.#stopped) {
      this.disconnect(connection);
      throw stoppedError();
    }
    if (this.#lifetime !== undefined) {
      const [min, max] = this.#lifetime;
      const spread = Math.floor(Math.random() * (max - min));
      this.#deadlines.set(connection, performance.now() + min + spread);
    }
    return connection;
  }

  #expired(connection: T): boolean {
    const deadline = this.#deadlines.get(connection);
    return deadline !== undefined && performance.now() > deadline;
  }

  /** A connection closed: its place goes to the next caller in the queue. */
  #vacate(): void {
    if (this.#stopped || this.#idle.length > 0 || !this.#hand(undefined))
      this.#opened--;
  }

  /**
   * Hands `connection` (or a free place) to the next caller under CoDel;
   * false when no one waits.
   */
  #hand(connection: T | undefined): boolean {
    const now = performance.now();
    if (now >= this.#next)
      return this.#dequeueFirst(now, this.#delay > this.#target, connection);
    if (!this.#slow) return this.#dequeueFast(now, connection);
    return this.#dequeueSlow(now, this.#target * 2, connection);
  }

  #dequeueFirst(time: number, slow: boolean, connection: T | undefined) {
    this.#next = time + this.#interval;
    this.#slow = slow;
    const waiter = this.#queue.shift();
    if (waiter === undefined) {
      this.#delay = 0;
      return false;
    }
    this.#delay = time - waiter.sent;
    waiter.resolve(connection);
    return true;
  }

  #dequeueFast(time: number, connection: T | undefined): boolean {
    const waiter = this.#queue.shift();
    if (waiter === undefined) {
      this.#delay = 0;
      return false;
    }
    this.#go(time - waiter.sent, waiter, connection);
    return true;
  }

  #dequeueSlow(
    time: number,
    timeout: number,
    connection: T | undefined,
  ): boolean {
    for (;;) {
      const waiter = this.#queue.shift();
      if (waiter === undefined) {
        this.#delay = 0;
        return false;
      }
      if (time - waiter.sent > timeout) {
        drop(time - waiter.sent, waiter);
        continue;
      }
      this.#go(time - waiter.sent, waiter, connection);
      return true;
    }
  }

  #go(delay: number, waiter: Waiter<T>, connection: T | undefined): void {
    if (delay < this.#delay) this.#delay = delay;
    waiter.resolve(connection);
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
    this.#holdLoop();
  }

  // The poll timer keeps the process alive only while callers wait, as
  // nothing else may: it drops them when the queue is slow.
  #holdLoop(): void {
    if (this.#queue.length > 0) this.#poll?.ref();
    else this.#poll?.unref();
  }

  #timeout(delay: number, time: number): void {
    if (time < this.#next) return;
    if (this.#delay > this.#target) {
      this.#slow = true;
      this.#delay = delay;
      this.#next = time + this.#interval;
      const minSent = time - this.#target * 2;
      for (let i = 0; i < this.#queue.length; ) {
        const waiter = this.#queue[i] as Waiter<T>;
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

  // DBConnection's drop_idle: every idle interval, up to `idleLimit`
  // connections checked in before the interval started are taken out of
  // the pool and closed when past their lifetime, or pinged and checked in.
  #startIdle(): void {
    const past = performance.now();
    this.#idleTimer = setTimeout(() => {
      for (let limit = this.#idleLimit; limit > 0; limit--) {
        const first = this.#idle[0];
        if (first === undefined || first.at > past) break;
        this.#idle.shift();
        const { connection } = first;
        if (this.#expired(connection)) this.disconnect(connection);
        else
          this.#connector.ping(connection).then(
            () => this.checkin(connection),
            () => this.disconnect(connection),
          );
      }
      this.#startIdle();
    }, this.#idleInterval);
    this.#idleTimer.unref();
  }
}

const stoppedError = () =>
  new ConnectionError("connection not available: the pool is stopped");

function drop<T>(delay: number, waiter: Waiter<T>): void {
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
 * The dialect on a pool of its connections. Each driver `dialect` creates
 * holds one connection; the pool creates up to `options.size` of them and
 * pings idle ones with `ping` (a no-op without it, as Exqlite's ping).
 */
export function pooledDialect(
  dialect: Dialect,
  options: PoolOptions,
  ping?: (connection: DatabaseConnection) => Promise<void>,
): { readonly dialect: Dialect; readonly pool: ConnectionPool<Driver> } {
  const pool = new ConnectionPool<Driver>(options, {
    async open() {
      const driver = dialect.createDriver();
      try {
        await driver.init();
      } catch (error) {
        await driver.destroy().catch(() => {});
        throw error;
      }
      return driver;
    },
    close: (driver) => driver.destroy(),
    async ping(driver) {
      if (ping === undefined) return;
      const connection = await driver.acquireConnection();
      try {
        await ping(connection);
      } finally {
        await driver.releaseConnection(connection);
      }
    },
  });
  return {
    pool,
    dialect: {
      createDriver: () => pooledDriver(pool),
      createQueryCompiler: () => dialect.createQueryCompiler(),
      createAdapter: () => dialect.createAdapter(),
      createIntrospector: (db) => dialect.createIntrospector(db),
    },
  };
}

/** A driver handing out the connections of the pool's drivers. */
function pooledDriver(pool: ConnectionPool<Driver>): Driver {
  const owners = new Map<DatabaseConnection, Driver>();
  const ownerOf = (connection: DatabaseConnection): Driver => {
    const owner = owners.get(connection);
    if (owner === undefined) throw new Error("unknown connection");
    return owner;
  };
  return {
    async init() {},
    async acquireConnection(options) {
      const driver = await pool.checkout(options?.signal);
      let connection: DatabaseConnection;
      try {
        connection = await driver.acquireConnection(options);
      } catch (error) {
        pool.disconnect(driver);
        throw error;
      }
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
      try {
        await driver.releaseConnection(connection, options);
      } finally {
        pool.checkin(driver);
      }
    },
    destroy: () => pool.stop(),
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
