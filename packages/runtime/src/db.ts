/**
 * Nexus Database Connection
 *
 * Drizzle ORM over PostgreSQL. Gracefully degrades to no-op
 * when DATABASE_URL is not set or drizzle-orm/pg are not installed,
 * so the CLI and server still work without a running database.
 */

// Re-export schema so consumers can import from here
export * from "@nexus/db";

// NexusDb typed loosely to avoid hard compile-time dependency on drizzle-orm
export type NexusDb = any;

let _db: NexusDb | null = null;
let _pool: any | null = null;

function tryInitDb(): void {
  const url = process.env.DATABASE_URL;
  if (!url) return;

  try {
    // These require statements will throw if packages are not installed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pg = require("pg");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { drizzle } = require("drizzle-orm/node-postgres");
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (!Pool || !drizzle) return;

    _pool = new Pool({ connectionString: url, max: 10 });
    _db = drizzle(_pool);
  } catch {
    // drizzle-orm / pg not installed — silently degrade to in-memory
  }
}

// Attempt eager init; fails silently if packages absent
tryInitDb();

/**
 * Get the database instance (synchronous).
 * Returns null if DATABASE_URL is not set or db packages are unavailable.
 */
export function getDb(): NexusDb | null {
  return _db;
}

/**
 * Check if the database is reachable.
 */
export async function checkDbConnection(): Promise<boolean> {
  if (!_pool) return false;

  try {
    const client = await _pool.connect();
    await client.query("SELECT 1");
    client.release();
    return true;
  } catch {
    return false;
  }
}

/**
 * Close the database pool (for graceful shutdown).
 */
export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}
