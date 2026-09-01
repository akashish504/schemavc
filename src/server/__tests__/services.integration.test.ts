/**
 * Integration tests against a real local Postgres. Skipped gracefully when
 * TEST_APP_DATABASE_URL is unset (e.g. a machine without Postgres); the
 * `npm run test:integration` script supplies localhost defaults.
 *
 * Covers what unit tests cannot: the optimistic-concurrency guards, the
 * commit → compare → resolve → merge → deploy journey against real storage,
 * and the all-or-nothing deploy transaction on a real target database.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Op } from "@/core/ops";
import { col, id } from "@/core/__tests__/fixtures";

const APP_URL = process.env.TEST_APP_DATABASE_URL;
const TARGET_URL = process.env.TEST_TARGET_DATABASE_URL;

// Dynamic imports so APP_DATABASE_URL is set before the pool is created.
type Services = typeof import("../services");
type Store = typeof import("../store");
type Db = typeof import("../db");

let services: Services;
let store: Store;
let db: Db;
let userId: string;

const usersTableId = id("t:it.users");
const usersIdCol = id("c:it.users.id");

const seedOps: Op[] = [
  {
    kind: "create_table",
    table: {
      id: usersTableId,
      name: "app_users",
      columns: [
        col("c:it.users.id", "id", "uuid", { default: "gen_random_uuid()" }),
        col("c:it.users.email", "email", "text"),
      ],
      constraints: [{ id: id("k:it.users.pk"), name: "app_users_pkey", kind: "primary_key", columns: [usersIdCol] }],
      indexes: [],
    },
  },
];

describe.skipIf(!APP_URL)("services against real Postgres", () => {
  afterAll(async () => {
    await db.pool().end();
  });

  beforeAll(async () => {
    process.env.APP_DATABASE_URL = APP_URL!;
    process.env.TARGET_DATABASE_URL = "";
    db = await import("../db");
    store = await import("../store");
    services = await import("../services");

    // Full reset: drop app tables, re-bootstrap, register a user.
    await db.pool().query("DROP TABLE IF EXISTS deployments, targets, commits, branches, users CASCADE");
    await db.ensureBootstrapped();
    userId = randomUUID();
    await store.createUser({ id: userId, email: "it@example.com", passwordHash: "x", displayName: "Ida" });
  });

  async function seedMain(): Promise<string> {
    const main = await store.getBranch(db.MAIN_BRANCH_ID);
    const r = await services.createCommit({
      branchId: db.MAIN_BRANCH_ID,
      userId,
      message: "seed schema",
      ops: seedOps,
      expectedHead: main!.head,
    });
    return r.commitId;
  }

  it("commits to main, and the branch detail reflects the new schema", async () => {
    await seedMain();
    const detail = await services.branchDetail(db.MAIN_BRANCH_ID);
    expect(Object.values(detail.schema.tables).map((t) => t.name)).toContain("app_users");
    expect(detail.commits[0].message).toBe("seed schema");
  });

  it("rejects a commit whose expectedHead is stale (concurrent editor)", async () => {
    const main = await store.getBranch(db.MAIN_BRANCH_ID);
    const op: Op = { kind: "add_column", tableId: usersTableId, column: col("c:it.users.name", "name", "text", { nullable: true }) };
    await services.createCommit({ branchId: db.MAIN_BRANCH_ID, userId, message: "add name", ops: [op], expectedHead: main!.head });
    await expect(
      services.createCommit({
        branchId: db.MAIN_BRANCH_ID,
        userId,
        message: "stale",
        ops: [{ kind: "rename_column", columnId: id("c:it.users.name"), name: "full_name" }],
        expectedHead: main!.head, // stale — head just moved
      })
    ).rejects.toMatchObject({ status: 409, code: "head_moved" });
  });

  it("rejects ops that do not apply, with the offending index", async () => {
    const main = await store.getBranch(db.MAIN_BRANCH_ID);
    await expect(
      services.createCommit({
        branchId: db.MAIN_BRANCH_ID,
        userId,
        message: "bad",
        ops: [{ kind: "rename_column", columnId: id("nope"), name: "x" }],
        expectedHead: main!.head,
      })
    ).rejects.toMatchObject({ status: 422, code: "invalid_ops", details: { opIndex: 0 } });
  });

  it("walks the full journey: branch → conflicting edits → resolve → merge → archived", async () => {
    const { id: branchId } = await services.createBranch("feature/status", userId);

    // Feature adds `status varchar(20)`; meanwhile main adds `status text`.
    const branch = await store.getBranch(branchId);
    await services.createCommit({
      branchId,
      userId,
      message: "add status to app_users",
      ops: [{ kind: "add_column", tableId: usersTableId, column: col("c:it.f.status", "status", "varchar(20)", { nullable: true }) }],
      expectedHead: branch!.head,
    });
    const main = await store.getBranch(db.MAIN_BRANCH_ID);
    await services.createCommit({
      branchId: db.MAIN_BRANCH_ID,
      userId,
      message: "add status column",
      ops: [{ kind: "add_column", tableId: usersTableId, column: col("c:it.m.status", "status", "text", { nullable: true }) }],
      expectedHead: main!.head,
    });

    // Compare: one semantic duplicate-name conflict, merge blocked.
    const compare = await services.compareWithMain(branchId, []);
    expect(compare.result.status).toBe("blocked");
    if (compare.result.status !== "blocked") return;
    const conflict = compare.result.conflicts.find((c) => c.severity === "semantic");
    expect(conflict?.rule).toBe("duplicate_name");
    expect(conflict?.explanation).toContain("Ida");

    // Stale main head is refused.
    await expect(
      services.submitMerge({
        branchId,
        userId,
        resolutions: [{ conflictId: conflict!.id, choice: "main" }],
        expectedMainHead: "not-the-head",
        acknowledgedAdvisories: [],
      })
    ).rejects.toMatchObject({ status: 409, code: "main_moved" });

    // Unresolved conflicts are refused.
    await expect(
      services.submitMerge({ branchId, userId, resolutions: [], expectedMainHead: compare.mainHead, acknowledgedAdvisories: [] })
    ).rejects.toMatchObject({ status: 422, code: "unresolved_conflicts" });

    // Resolve keep-main and merge.
    const { mergeCommitId } = await services.submitMerge({
      branchId,
      userId,
      resolutions: [{ conflictId: conflict!.id, choice: "main" }],
      expectedMainHead: compare.mainHead,
      acknowledgedAdvisories: [],
    });

    const mergedMain = await services.branchDetail(db.MAIN_BRANCH_ID);
    expect(mergedMain.branch.head).toBe(mergeCommitId);
    const appUsers = Object.values(mergedMain.schema.tables).find((t) => t.name === "app_users");
    expect(appUsers?.columns.filter((c) => c.name === "status")).toHaveLength(1);
    expect(appUsers?.columns.find((c) => c.name === "status")?.type).toBe("text"); // main's copy won

    // The branch is archived, read-only, and cannot merge again.
    const archived = await store.getBranch(branchId);
    expect(archived?.status).toBe("archived");
    await expect(services.compareWithMain(branchId, [])).rejects.toMatchObject({ code: "branch_archived" });

    // The merge commit records the resolution.
    const commit = await services.commitDetail(mergeCommitId);
    expect(commit.resolutions).toMatchObject([{ choice: "main", severity: "semantic" }]);
  });

  it("keeps history healthy: every commit replays to its stored snapshot", async () => {
    const r = await db.pool().query("SELECT id, parent, ops, snapshot FROM commits");
    const { apply } = await import("@/core/apply");
    const byId = new Map(r.rows.map((row) => [row.id, row]));
    for (const row of r.rows) {
      const base = row.parent ? byId.get(row.parent)?.snapshot : { tables: {} };
      expect(base, `parent of ${row.id}`).toBeDefined();
      const replayed = apply(base, row.ops, { allowNameCollisions: true });
      expect(replayed.ok, `replay of ${row.id}`).toBe(true);
      if (replayed.ok) {
        expect(JSON.parse(JSON.stringify(replayed.schema)), `snapshot of ${row.id}`).toEqual(row.snapshot);
      }
    }
  });

  it("mark-as-deployed advances the pointer over all pending commits", async () => {
    const main = await store.getBranch(db.MAIN_BRANCH_ID);
    const before = await services.deployStatus();
    expect(before.pendingCommits).toBeGreaterThan(0);
    await services.markDeployed(userId, main!.head);
    const after = await services.deployStatus();
    expect(after.pendingCommits).toBe(0);
    expect(after.target.deployedCommit).toBe(main!.head);
    expect(after.deployments[0].status).toBe("manual");
    await expect(services.markDeployed(userId, main!.head)).rejects.toMatchObject({ code: "nothing_pending" });
  });
  it.skipIf(!TARGET_URL)("deploys pending SQL to a real target in one transaction, rolling back fully on failure", async () => {
    const { Client } = await import("pg");
    const target = new Client({ connectionString: TARGET_URL });
    await target.connect();
    await target.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");

    // Point the app's single target row at the real test target.
    await db.pool().query("UPDATE targets SET connection_string = $1", [TARGET_URL]);

    // Successful deploy: pending ops (a new table) land on the target.
    const main1 = await store.getBranch(db.MAIN_BRANCH_ID);
    const notesTable = id("t:it.notes");
    await services.createCommit({
      branchId: db.MAIN_BRANCH_ID,
      userId,
      message: "add notes table",
      ops: [
        {
          kind: "create_table",
          table: {
            id: notesTable,
            name: "notes",
            columns: [col("c:it.notes.id", "id", "uuid"), col("c:it.notes.body", "body", "text", { nullable: true })],
            constraints: [{ id: id("k:it.notes.pk"), name: "notes_pkey", kind: "primary_key", columns: [id("c:it.notes.id")] }],
            indexes: [],
          },
        },
      ],
      expectedHead: main1!.head,
    });
    const main2 = await store.getBranch(db.MAIN_BRANCH_ID);
    const deployed = await services.deployToTarget(userId, main2!.head);
    expect(deployed.status).toBe("succeeded");
    const tables = await target.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    expect(tables.rows.map((r) => r.table_name)).toContain("notes");

    // Failing deploy: retype text → integer over non-numeric data. The cast
    // fails mid-script; everything rolls back and the pointer stays put.
    await target.query("INSERT INTO notes (id, body) VALUES (gen_random_uuid(), 'not a number')");
    const main3 = await store.getBranch(db.MAIN_BRANCH_ID);
    await services.createCommit({
      branchId: db.MAIN_BRANCH_ID,
      userId,
      message: "retype body to integer",
      ops: [
        { kind: "add_column", tableId: notesTable, column: col("c:it.notes.extra", "extra", "text", { nullable: true }) },
        { kind: "retype_column", columnId: id("c:it.notes.body"), type: "integer" },
      ],
      expectedHead: main3!.head,
    });
    const main4 = await store.getBranch(db.MAIN_BRANCH_ID);
    const pointerBefore = (await services.deployStatus()).target.deployedCommit;
    await expect(services.deployToTarget(userId, main4!.head)).rejects.toMatchObject({ code: "deploy_failed" });

    const after = await services.deployStatus();
    expect(after.target.deployedCommit).toBe(pointerBefore); // pointer unmoved
    expect(after.deployments[0].status).toBe("failed");
    expect(after.deployments[0].errorStatement).toContain("ALTER TABLE");
    // the add_column earlier in the script rolled back too — all or nothing
    const columns = await target.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'notes'");
    expect(columns.rows.map((r) => r.column_name)).not.toContain("extra");

    await target.end();
  });
});
