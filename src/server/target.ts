/**
 * The deploy target: the user's real Postgres database. Written to only
 * during a deploy, statement by statement inside one transaction — Postgres
 * DDL is transactional, so failure rolls the whole script back and the
 * deployed pointer never moves.
 */

import { Client } from "pg";

export type TargetOutcome = { ok: true } | { ok: false; statement: string; message: string };

export async function applyStatementsToTarget(connectionString: string, statements: string[]): Promise<TargetOutcome> {
  const client = new Client({
    connectionString,
    ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1") ? undefined : { rejectUnauthorized: false },
    statement_timeout: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  let current = "";
  try {
    await client.connect();
    await client.query("BEGIN");
    for (const statement of statements) {
      if (statement.startsWith("--")) continue;
      current = statement;
      await client.query(statement);
    }
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, statement: current, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => {});
  }
}
