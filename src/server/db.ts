/**
 * App state store: connection pool, schema bootstrap, and the root of the
 * one-repository model (a `main` branch whose root commit is the empty schema).
 *
 * The app's own tables are created with idempotent DDL at first touch rather
 * than a migration tool — the store's schema is small and append-only for the
 * life of this project, and one fewer moving part for the evaluator.
 */

import { Pool, type PoolClient } from "pg";
import { emptySchema } from "@/core/model";
import { appDatabaseUrl, targetDatabaseUrl } from "./env";

declare global {
  // Reuse the pool across Next.js hot reloads / serverless invocations.
  var __appPool: Pool | undefined;
  var __bootstrapped: Promise<void> | undefined;
}

export function pool(): Pool {
  if (!global.__appPool) {
    global.__appPool = new Pool({
      connectionString: appDatabaseUrl(),
      max: 5,
      // Neon and most managed Postgres require TLS; local Postgres has none.
      ssl: appDatabaseUrl().includes("localhost") || appDatabaseUrl().includes("127.0.0.1") ? undefined : { rejectUnauthorized: false },
    });
  }
  return global.__appPool;
}

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branches (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  head        text,
  forked_from text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by  text REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- active branch names are unique; archived branches free their name
CREATE UNIQUE INDEX IF NOT EXISTS branches_active_name ON branches (name) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS commits (
  id          text PRIMARY KEY,
  parent      text REFERENCES commits(id),
  branch_id   text NOT NULL REFERENCES branches(id),
  author      text REFERENCES users(id),
  message     text NOT NULL,
  ops         jsonb NOT NULL,
  snapshot    jsonb NOT NULL,
  merged_from text REFERENCES commits(id),
  resolutions jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- two commits can never claim the same parent on the same branch (linearity)
CREATE UNIQUE INDEX IF NOT EXISTS commits_linear ON commits (branch_id, parent);

CREATE TABLE IF NOT EXISTS targets (
  id                text PRIMARY KEY,
  name              text NOT NULL,
  connection_string text,
  deployed_commit   text REFERENCES commits(id)
);

CREATE TABLE IF NOT EXISTS deployments (
  id              text PRIMARY KEY,
  target_id       text NOT NULL REFERENCES targets(id),
  from_commit     text REFERENCES commits(id),
  to_commit       text NOT NULL REFERENCES commits(id),
  sql             text NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending','succeeded','failed','manual')),
  error_statement text,
  error_message   text,
  triggered_by    text REFERENCES users(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
-- single-flight: at most one pending deployment per target
CREATE UNIQUE INDEX IF NOT EXISTS deployments_single_flight ON deployments (target_id) WHERE status = 'pending';
`;

export const MAIN_BRANCH_ID = "main0000";
export const ROOT_COMMIT_ID = "root0000";
export const TARGET_ID = "target00";

async function bootstrapOnce(): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query(DDL);
    await client.query("BEGIN");
    const existing = await client.query("SELECT id FROM branches WHERE id = $1", [MAIN_BRANCH_ID]);
    if (existing.rowCount === 0) {
      await client.query(
        "INSERT INTO branches (id, name, head, forked_from, status) VALUES ($1, 'main', NULL, NULL, 'active') ON CONFLICT (id) DO NOTHING",
        [MAIN_BRANCH_ID]
      );
      await client.query(
        "INSERT INTO commits (id, parent, branch_id, author, message, ops, snapshot) VALUES ($1, NULL, $2, NULL, 'Initial empty schema', '[]', $3) ON CONFLICT (id) DO NOTHING",
        [ROOT_COMMIT_ID, MAIN_BRANCH_ID, JSON.stringify(emptySchema())]
      );
      await client.query("UPDATE branches SET head = $1 WHERE id = $2 AND head IS NULL", [ROOT_COMMIT_ID, MAIN_BRANCH_ID]);
    }
    await client.query(
      "INSERT INTO targets (id, name, connection_string, deployed_commit) VALUES ($1, 'Target database', $2, $3) ON CONFLICT (id) DO NOTHING",
      [TARGET_ID, targetDatabaseUrl(), ROOT_COMMIT_ID]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Idempotent; concurrent callers share one in-flight bootstrap. */
export function ensureBootstrapped(): Promise<void> {
  if (!global.__bootstrapped) {
    global.__bootstrapped = bootstrapOnce().catch((error) => {
      global.__bootstrapped = undefined; // allow retry after a transient failure
      throw error;
    });
  }
  return global.__bootstrapped;
}

/** Run `fn` inside one transaction on a dedicated client. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
