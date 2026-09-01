/**
 * Business rules: branching, committing, merging, deploying. Services load
 * state through the store, call the pure core engine, and write results back
 * in single transactions with optimistic-concurrency guards on branch heads.
 */

import { randomUUID } from "node:crypto";
import { apply } from "@/core/apply";
import { describeOp } from "@/core/describe";
import { merge, type Conflict, type MergeResult, type Resolution } from "@/core/merge";
import type { Schema } from "@/core/model";
import type { Op } from "@/core/ops";
import { order } from "@/core/order";
import { migrationScript, migrationStatements, schemaToSql } from "@/core/sql";
import { tag } from "@/core/safety";
import { validate } from "@/core/validate";
import { MAIN_BRANCH_ID, withTransaction } from "./db";
import { conflict, invalid, notFound, ServiceError } from "./errors";
import {
  advanceHead,
  archiveBranch,
  attributedOps,
  commitChain,
  getBranch,
  getCommit,
  getTarget,
  insertBranch,
  insertCommit,
  insertDeployment,
  finishDeployment,
  listBranches,
  listDeployments,
  setDeployedCommit,
  type BranchRow,
  type CommitRow,
} from "./store";
import { applyStatementsToTarget } from "./target";

const newRowId = () => randomUUID();

const BRANCH_NAME_RE = /^[a-z0-9][a-z0-9/_-]{0,62}$/;

// ---------------------------------------------------------------- branches

export async function branchesOverview() {
  const branches = await listBranches();
  const main = branches.find((b) => b.id === MAIN_BRANCH_ID);
  if (!main) throw notFound("main branch");
  const withCounts = await Promise.all(
    branches.map(async (b) => {
      const ahead = b.forked_from ? (await commitChain(b.head, b.forked_from)).length : 0;
      const mainMoved = b.forked_from && b.status === "active" ? (await commitChain(main.head, b.forked_from)).length : 0;
      return { ...row(b), aheadOfMain: ahead, mainMovedBy: mainMoved };
    })
  );
  return { branches: withCounts };
}

export async function createBranch(name: string, userId: string) {
  if (!BRANCH_NAME_RE.test(name))
    throw invalid("invalid_branch_name", "branch names use lowercase letters, digits, -, _ and /, max 63 chars");
  const main = await getBranch(MAIN_BRANCH_ID);
  if (!main) throw notFound("main branch");
  const id = newRowId();
  try {
    await withTransaction(async (client) => {
      await insertBranch({ id, name, head: main.head, forkedFrom: main.head, createdBy: userId }, client);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("branch_name_taken", `an active branch named "${name}" already exists`);
    throw error;
  }
  return { id, name };
}

export interface BranchDetail {
  branch: ReturnType<typeof row>;
  schema: Schema;
  aheadOfMain: number;
  mainMovedBy: number;
  commits: { id: string; message: string; author: string; at: string; opCount: number; mergedFrom: string | null }[];
}

export async function branchDetail(branchId: string): Promise<BranchDetail> {
  const branch = await getBranch(branchId);
  if (!branch) throw notFound("branch");
  const head = await getCommit(branch.head);
  if (!head) throw notFound("head commit");
  const main = branch.id === MAIN_BRANCH_ID ? branch : await getBranch(MAIN_BRANCH_ID);
  const chain = await commitChain(branch.head, branch.forked_from);
  const mainMoved = branch.forked_from && main ? (await commitChain(main.head, branch.forked_from)).length : 0;
  const history = branch.id === MAIN_BRANCH_ID ? await commitChain(branch.head, null) : chain;
  return {
    branch: row(branch),
    schema: head.snapshot,
    aheadOfMain: branch.forked_from ? chain.length : 0,
    mainMovedBy: branch.status === "active" ? mainMoved : 0,
    commits: history
      .slice()
      .reverse()
      .map((c) => ({
        id: c.id,
        message: c.message,
        author: c.author_name,
        at: new Date(c.created_at).toISOString(),
        opCount: c.ops.length,
        mergedFrom: c.merged_from,
      })),
  };
}

const row = (b: BranchRow) => ({
  id: b.id,
  name: b.name,
  head: b.head,
  isMain: b.id === MAIN_BRANCH_ID,
  status: b.status,
  createdAt: new Date(b.created_at).toISOString(),
});

// ---------------------------------------------------------------- commits

export async function createCommit(input: { branchId: string; userId: string; message: string; ops: Op[]; expectedHead: string }) {
  const { branchId, userId, ops, expectedHead } = input;
  const message = input.message.trim();
  if (message.length === 0 || message.length > 300) throw invalid("invalid_message", "commit message must be 1–300 characters");

  const branch = await getBranch(branchId);
  if (!branch) throw notFound("branch");
  if (branch.status !== "active") throw invalid("branch_archived", "this branch is archived and read-only");
  if (branch.head !== expectedHead)
    throw conflict("head_moved", "the branch moved while you were editing — review the latest schema and re-apply your changes");

  const head = await getCommit(branch.head);
  if (!head) throw notFound("head commit");

  const applied = apply(head.snapshot, ops);
  if (!applied.ok)
    throw invalid("invalid_ops", applied.error.message, { opIndex: applied.error.opIndex, code: applied.error.code });
  const violations = validate(applied.schema);
  if (violations.length > 0)
    throw invalid("schema_invalid", `this change would leave the schema inconsistent: ${violations[0].message}`, { violations });

  const commitId = newRowId();
  await withTransaction(async (client) => {
    await insertCommit({ id: commitId, parent: branch.head, branchId, author: userId, message, ops, snapshot: applied.schema }, client);
    const advanced = await advanceHead(branchId, expectedHead, commitId, client);
    if (!advanced) throw conflict("head_moved", "the branch moved while you were editing — refresh and try again");
  });
  return { commitId };
}

export async function commitDetail(commitId: string) {
  const commit = await getCommit(commitId);
  if (!commit) throw notFound("commit");
  const parent = commit.parent ? await getCommit(commit.parent) : null;
  const before = parent?.snapshot ?? { tables: {} };
  return {
    id: commit.id,
    branchId: commit.branch_id,
    message: commit.message,
    author: commit.author_name,
    at: new Date(commit.created_at).toISOString(),
    mergedFrom: commit.merged_from,
    resolutions: commit.resolutions,
    changes: describeOps(commit.ops, before),
    schemaSql: schemaToSql(commit.snapshot),
  };
}

function describeOps(ops: Op[], startSchema: Schema) {
  const out: { description: string; safety: ReturnType<typeof tag> }[] = [];
  let current = startSchema;
  for (const op of ops) {
    out.push({ description: describeOp(op, current), safety: tag(op, current) });
    const next = apply(current, [op], { allowNameCollisions: true });
    if (next.ok) current = next.schema;
  }
  return out;
}

// ---------------------------------------------------------------- merge

export interface CompareResponse {
  branch: { id: string; name: string };
  mainHead: string;
  forkedAt: string;
  mainMovedBy: number;
  result: MergeResult;
  /** main commit ids at or before the deployed pointer (for resolver warnings) */
  deployedMainCommits: string[];
}

async function loadMergeContext(branchId: string) {
  const branch = await getBranch(branchId);
  if (!branch) throw notFound("branch");
  if (branch.id === MAIN_BRANCH_ID) throw invalid("cannot_merge_main", "main cannot be compared with itself");
  if (branch.status !== "active") throw invalid("branch_archived", "this branch has already been merged");
  if (!branch.forked_from) throw invalid("no_fork_point", "branch has no fork point");
  const main = await getBranch(MAIN_BRANCH_ID);
  if (!main) throw notFound("main branch");
  const fork = await getCommit(branch.forked_from);
  if (!fork) throw notFound("fork commit");
  const mainChain = await commitChain(main.head, branch.forked_from);
  const featureChain = await commitChain(branch.head, branch.forked_from);
  return { branch, main, fork, mainChain, featureChain };
}

export async function compareWithMain(branchId: string, resolutions: Resolution[]): Promise<CompareResponse> {
  const { branch, main, fork, mainChain, featureChain } = await loadMergeContext(branchId);
  const result = merge(
    { fork: fork.snapshot, mainOps: attributedOps(mainChain), featureOps: attributedOps(featureChain) },
    resolutions
  );
  if (result.status === "error") throw new ServiceError(500, "merge_error", result.error);

  const target = await getTarget();
  const deployedMainCommits: string[] = [];
  if (target) {
    const mainIds = new Set(mainChain.map((c) => c.id));
    const deployedChain = await commitChain(target.deployed_commit, branch.forked_from);
    for (const c of deployedChain) if (mainIds.has(c.id)) deployedMainCommits.push(c.id);
  }

  return {
    branch: { id: branch.id, name: branch.name },
    mainHead: main.head,
    forkedAt: new Date(fork.created_at).toISOString(),
    mainMovedBy: mainChain.length,
    result,
    deployedMainCommits,
  };
}

export async function submitMerge(input: {
  branchId: string;
  userId: string;
  resolutions: Resolution[];
  expectedMainHead: string;
  acknowledgedAdvisories: string[];
}) {
  const { branch, main, fork, mainChain, featureChain } = await loadMergeContext(input.branchId);
  if (main.head !== input.expectedMainHead)
    throw conflict("main_moved", "main changed while you were resolving — review the updated comparison", { mainHead: main.head });

  const result = merge(
    { fork: fork.snapshot, mainOps: attributedOps(mainChain), featureOps: attributedOps(featureChain) },
    input.resolutions
  );
  if (result.status === "error") throw new ServiceError(500, "merge_error", result.error);
  if (result.status === "blocked" || !result.mergedOps || !result.mergedSchema)
    throw invalid("unresolved_conflicts", "resolve every conflict before merging", {
      unresolved: result.conflicts.filter((c) => c.severity !== "advisory" && !c.resolved).map((c) => c.id),
    });

  const acknowledged = new Set(input.acknowledgedAdvisories);
  const unacknowledged = result.conflicts.filter((c) => c.severity === "advisory" && !acknowledged.has(c.id));
  if (unacknowledged.length > 0)
    throw invalid("unacknowledged_advisories", "acknowledge the warnings before merging", { advisories: unacknowledged.map((c) => c.id) });

  const now = new Date().toISOString();
  const resolutionsRecord = result.conflicts
    .filter((c) => c.severity !== "advisory")
    .map((c) => ({
      conflictId: c.id,
      severity: c.severity,
      rule: c.rule,
      explanation: c.explanation,
      mainOps: c.mainRefs.map((r) => r.description),
      featureOps: c.featureRefs.map((r) => r.description),
      choice: c.resolved?.choice,
      resolvedBy: input.userId,
      resolvedAt: now,
    }))
    .concat(
      result.conflicts
        .filter((c) => c.severity === "advisory")
        .map((c) => ({
          conflictId: c.id,
          severity: c.severity,
          rule: c.rule,
          explanation: c.explanation,
          mainOps: c.mainRefs.map((r) => r.description),
          featureOps: [],
          choice: "acknowledged" as never,
          resolvedBy: input.userId,
          resolvedAt: now,
        }))
    );

  const mergeCommitId = newRowId();
  await withTransaction(async (client) => {
    await insertCommit(
      {
        id: mergeCommitId,
        parent: main.head,
        branchId: MAIN_BRANCH_ID,
        author: input.userId,
        message: `Merge branch '${branch.name}'`,
        ops: result.mergedOps!,
        snapshot: result.mergedSchema!,
        mergedFrom: branch.head,
        resolutions: resolutionsRecord,
      },
      client
    );
    const advanced = await advanceHead(MAIN_BRANCH_ID, input.expectedMainHead, mergeCommitId, client);
    if (!advanced) throw conflict("main_moved", "main changed while you were resolving — review the updated comparison");
    await archiveBranch(branch.id, client);
  });
  return { mergeCommitId };
}

// ---------------------------------------------------------------- deploy

export async function deployStatus() {
  const target = await getTarget();
  if (!target) throw notFound("deploy target");
  const main = await getBranch(MAIN_BRANCH_ID);
  if (!main) throw notFound("main branch");
  const deployedCommit = await getCommit(target.deployed_commit);
  if (!deployedCommit) throw notFound("deployed commit");
  const pending = await commitChain(main.head, target.deployed_commit);
  const pendingOps = attributedOps(pending);
  const orderedOps = orderedPendingOps(pendingOps.map((a) => a.op), deployedCommit.snapshot);
  const sql = migrationScript({
    ops: orderedOps,
    startSchema: deployedCommit.snapshot,
    header: [
      `schema-vc migration: ${pending.length} commit(s), ${pendingOps.length} operation(s)`,
      `from ${target.deployed_commit.slice(0, 8)} to ${main.head.slice(0, 8)}`,
    ],
  });

  const authorByOp = new Map(pendingOps.map((a) => [a.op, a]));
  const preflight = describeOps(orderedOps, deployedCommit.snapshot)
    .map((c, i) => ({ ...c, author: authorByOp.get(orderedOps[i])?.author ?? "", commitId: authorByOp.get(orderedOps[i])?.commitId ?? "" }))
    .filter((c) => c.safety.level !== "additive");

  const timeline = (await commitChain(main.head, null))
    .slice()
    .reverse()
    .map((c) => ({
      id: c.id,
      message: c.message,
      author: c.author_name,
      at: new Date(c.created_at).toISOString(),
      opCount: c.ops.length,
      isDeployed: false, // set below
      isHead: c.id === main.head,
      mergedFrom: c.merged_from,
    }));
  const deployedIndex = timeline.findIndex((c) => c.id === target.deployed_commit);
  for (let i = deployedIndex; i < timeline.length && i >= 0; i++) timeline[i].isDeployed = true;

  return {
    target: { id: target.id, name: target.name, hasConnection: target.connection_string !== null, deployedCommit: target.deployed_commit },
    mainHead: main.head,
    pendingCommits: pending.length,
    pendingOps: pendingOps.length,
    sql,
    preflight,
    timeline,
    deployments: (await listDeployments()).map((d) => ({
      id: d.id,
      status: d.status,
      fromCommit: d.from_commit,
      toCommit: d.to_commit,
      errorStatement: d.error_statement,
      errorMessage: d.error_message,
      triggeredBy: d.triggered_by_name,
      startedAt: new Date(d.started_at).toISOString(),
      finishedAt: d.finished_at ? new Date(d.finished_at).toISOString() : null,
    })),
  };
}

/**
 * Dependency-order the pending range's ops before SQL generation. Ops within
 * one commit already replay in order, but across commits (and especially in
 * merge compensations) a drop_column can precede the drop_index of an index
 * on it — valid in the model, broken on a real database where the column
 * drop cascades the index away. Falls back to commit order on a cycle
 * (which the effects model should make impossible).
 */
function orderedPendingOps(ops: Op[], startSchema: Schema): Op[] {
  const ordered = order(ops, startSchema);
  return ordered.ok ? ordered.ops : ops;
}

async function preparePendingDeploy(expectedHead: string) {
  const target = await getTarget();
  if (!target) throw notFound("deploy target");
  const main = await getBranch(MAIN_BRANCH_ID);
  if (!main) throw notFound("main branch");
  if (main.head !== expectedHead) throw conflict("head_moved", "main moved — review the deploy view again");
  if (main.head === target.deployed_commit) throw invalid("nothing_pending", "everything is already deployed");
  const deployedCommit = await getCommit(target.deployed_commit);
  if (!deployedCommit) throw notFound("deployed commit");
  const pending = await commitChain(main.head, target.deployed_commit);
  const ops = orderedPendingOps(pending.flatMap((c) => c.ops), deployedCommit.snapshot);
  return { target, main, deployedCommit, ops };
}

export async function markDeployed(userId: string, expectedHead: string) {
  const { target, main, deployedCommit, ops } = await preparePendingDeploy(expectedHead);
  const sql = migrationScript({ ops, startSchema: deployedCommit.snapshot });
  const id = newRowId();
  await withTransaction(async (client) => {
    await insertDeployment(
      { id, targetId: target.id, fromCommit: target.deployed_commit, toCommit: main.head, sql, status: "manual", triggeredBy: userId },
      client
    );
    await finishDeployment(id, { status: "manual" }, client);
    await setDeployedCommit(target.id, main.head, client);
  });
  return { deploymentId: id, status: "manual" as const };
}

export async function deployToTarget(userId: string, expectedHead: string) {
  const { target, main, deployedCommit, ops } = await preparePendingDeploy(expectedHead);
  if (!target.connection_string)
    throw invalid("no_target_connection", "no target database is configured — run the SQL yourself and use “Mark as deployed”");

  const statements = migrationStatements(ops, deployedCommit.snapshot);
  const sql = migrationScript({ ops, startSchema: deployedCommit.snapshot });
  const id = newRowId();

  // Claim the single-flight slot first, in its own transaction.
  try {
    await withTransaction(async (client) => {
      await insertDeployment(
        { id, targetId: target.id, fromCommit: target.deployed_commit, toCommit: main.head, sql, status: "pending", triggeredBy: userId },
        client
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("deploy_in_progress", "another deployment is already running");
    throw error;
  }

  const outcome = await applyStatementsToTarget(target.connection_string, statements.map((s) => s.sql));

  if (outcome.ok) {
    await withTransaction(async (client) => {
      await finishDeployment(id, { status: "succeeded" }, client);
      await setDeployedCommit(target.id, main.head, client);
    });
    return { deploymentId: id, status: "succeeded" as const };
  }
  await withTransaction(async (client) => {
    await finishDeployment(id, { status: "failed", errorStatement: outcome.statement, errorMessage: outcome.message }, client);
  });
  throw new ServiceError(502, "deploy_failed", `deployment failed and was rolled back: ${outcome.message}`, {
    deploymentId: id,
    statement: outcome.statement,
  });
}

// ---------------------------------------------------------------- shared

export type { Conflict, CommitRow };

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}
