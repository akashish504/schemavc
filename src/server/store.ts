/**
 * Data access for the app state store. Thin, typed row mappers and queries;
 * business rules live in the services, engine logic in src/core.
 */

import type { PoolClient } from "pg";
import type { Schema } from "@/core/model";
import type { AttributedOp, Op } from "@/core/ops";
import { pool } from "./db";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
}

export interface BranchRow {
  id: string;
  name: string;
  head: string;
  forked_from: string | null;
  status: "active" | "archived";
  created_by: string | null;
  created_at: string;
}

export interface CommitRow {
  id: string;
  parent: string | null;
  branch_id: string;
  author: string | null;
  author_name: string;
  message: string;
  ops: Op[];
  snapshot: Schema;
  merged_from: string | null;
  resolutions: unknown[] | null;
  created_at: string;
}

export interface TargetRow {
  id: string;
  name: string;
  connection_string: string | null;
  deployed_commit: string;
}

export interface DeploymentRow {
  id: string;
  target_id: string;
  from_commit: string | null;
  to_commit: string;
  sql: string;
  status: "pending" | "succeeded" | "failed" | "manual";
  error_statement: string | null;
  error_message: string | null;
  triggered_by: string | null;
  triggered_by_name: string | null;
  started_at: string;
  finished_at: string | null;
}

type Queryable = Pick<PoolClient, "query">;

const db = (client?: Queryable): Queryable => client ?? pool();

// ---- users ----

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const r = await db().query("SELECT id, email, password_hash, display_name FROM users WHERE email = $1", [email]);
  return (r.rows[0] as UserRow) ?? null;
}

export async function createUser(user: { id: string; email: string; passwordHash: string; displayName: string }): Promise<void> {
  await db().query("INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)", [
    user.id,
    user.email,
    user.passwordHash,
    user.displayName,
  ]);
}

// ---- branches ----

const BRANCH_COLS = "id, name, head, forked_from, status, created_by, created_at";

export async function listBranches(): Promise<BranchRow[]> {
  const r = await db().query(`SELECT ${BRANCH_COLS} FROM branches ORDER BY (forked_from IS NULL) DESC, created_at DESC`);
  return r.rows as BranchRow[];
}

export async function getBranch(id: string, client?: Queryable): Promise<BranchRow | null> {
  const r = await db(client).query(`SELECT ${BRANCH_COLS} FROM branches WHERE id = $1`, [id]);
  return (r.rows[0] as BranchRow) ?? null;
}

export async function insertBranch(
  branch: { id: string; name: string; head: string; forkedFrom: string; createdBy: string },
  client?: Queryable
): Promise<void> {
  await db(client).query("INSERT INTO branches (id, name, head, forked_from, status, created_by) VALUES ($1, $2, $3, $4, 'active', $5)", [
    branch.id,
    branch.name,
    branch.head,
    branch.forkedFrom,
    branch.createdBy,
  ]);
}

/** Optimistic head advance; false means someone moved the head first. */
export async function advanceHead(branchId: string, expectedHead: string, newHead: string, client: Queryable): Promise<boolean> {
  const r = await client.query("UPDATE branches SET head = $1 WHERE id = $2 AND head = $3", [newHead, branchId, expectedHead]);
  return r.rowCount === 1;
}

export async function archiveBranch(branchId: string, client: Queryable): Promise<void> {
  await client.query("UPDATE branches SET status = 'archived' WHERE id = $1", [branchId]);
}

// ---- commits ----

const COMMIT_SELECT = `
  SELECT c.id, c.parent, c.branch_id, c.author, COALESCE(u.display_name, 'system') AS author_name,
         c.message, c.ops, c.snapshot, c.merged_from, c.resolutions, c.created_at
  FROM commits c LEFT JOIN users u ON u.id = c.author`;

export async function getCommit(id: string, client?: Queryable): Promise<CommitRow | null> {
  const r = await db(client).query(`${COMMIT_SELECT} WHERE c.id = $1`, [id]);
  return (r.rows[0] as CommitRow) ?? null;
}

export async function insertCommit(
  commit: {
    id: string;
    parent: string;
    branchId: string;
    author: string;
    message: string;
    ops: Op[];
    snapshot: Schema;
    mergedFrom?: string;
    resolutions?: unknown[];
  },
  client: Queryable
): Promise<void> {
  await client.query(
    `INSERT INTO commits (id, parent, branch_id, author, message, ops, snapshot, merged_from, resolutions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      commit.id,
      commit.parent,
      commit.branchId,
      commit.author,
      commit.message,
      JSON.stringify(commit.ops),
      JSON.stringify(commit.snapshot),
      commit.mergedFrom ?? null,
      commit.resolutions ? JSON.stringify(commit.resolutions) : null,
    ]
  );
}

/**
 * The commit chain from `headId` back to (exclusive) `stopAtId`, returned
 * oldest → newest. With stopAtId null, walks to the root. Both branch and
 * main histories are linear, so this is a simple parent walk.
 */
export async function commitChain(headId: string, stopAtId: string | null, client?: Queryable): Promise<CommitRow[]> {
  const r = await db(client).query(
    `WITH RECURSIVE chain AS (
       SELECT c.*, 0 AS depth FROM commits c WHERE c.id = $1
       UNION ALL
       SELECT c.*, chain.depth + 1 FROM commits c JOIN chain ON c.id = chain.parent
       WHERE chain.parent IS NOT NULL AND chain.id IS DISTINCT FROM $2 AND chain.parent IS DISTINCT FROM $2 AND chain.depth < 10000
     )
     SELECT ch.id, ch.parent, ch.branch_id, ch.author, COALESCE(u.display_name, 'system') AS author_name,
            ch.message, ch.ops, ch.snapshot, ch.merged_from, ch.resolutions, ch.created_at
     FROM chain ch LEFT JOIN users u ON u.id = ch.author
     WHERE ch.id IS DISTINCT FROM $2
     ORDER BY ch.depth DESC`,
    [headId, stopAtId]
  );
  return r.rows as CommitRow[];
}

/** Flatten a chain of commits into attributed ops, oldest first. */
export function attributedOps(chain: CommitRow[]): AttributedOp[] {
  return chain.flatMap((commit) =>
    commit.ops.map((op) => ({
      op,
      commitId: commit.id,
      author: commit.author_name,
      message: commit.message,
      at: new Date(commit.created_at).toISOString(),
    }))
  );
}

// ---- targets & deployments ----

export async function getTarget(client?: Queryable): Promise<TargetRow | null> {
  const r = await db(client).query("SELECT id, name, connection_string, deployed_commit FROM targets LIMIT 1");
  return (r.rows[0] as TargetRow) ?? null;
}

export async function setDeployedCommit(targetId: string, commitId: string, client: Queryable): Promise<void> {
  await client.query("UPDATE targets SET deployed_commit = $1 WHERE id = $2", [commitId, targetId]);
}

export async function listDeployments(): Promise<DeploymentRow[]> {
  const r = await db().query(
    `SELECT d.id, d.target_id, d.from_commit, d.to_commit, d.sql, d.status, d.error_statement, d.error_message,
            d.triggered_by, u.display_name AS triggered_by_name, d.started_at, d.finished_at
     FROM deployments d LEFT JOIN users u ON u.id = d.triggered_by
     ORDER BY d.started_at DESC LIMIT 50`
  );
  return r.rows as DeploymentRow[];
}

export async function insertDeployment(
  deployment: { id: string; targetId: string; fromCommit: string; toCommit: string; sql: string; status: DeploymentRow["status"]; triggeredBy: string },
  client: Queryable
): Promise<void> {
  await client.query(
    "INSERT INTO deployments (id, target_id, from_commit, to_commit, sql, status, triggered_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [deployment.id, deployment.targetId, deployment.fromCommit, deployment.toCommit, deployment.sql, deployment.status, deployment.triggeredBy]
  );
}

export async function finishDeployment(
  id: string,
  outcome: { status: "succeeded" | "failed" | "manual"; errorStatement?: string; errorMessage?: string },
  client: Queryable
): Promise<void> {
  await client.query(
    "UPDATE deployments SET status = $1, error_statement = $2, error_message = $3, finished_at = now() WHERE id = $4",
    [outcome.status, outcome.errorStatement ?? null, outcome.errorMessage ?? null, id]
  );
}
