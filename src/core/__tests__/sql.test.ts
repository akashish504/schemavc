import { describe, expect, it } from "vitest";
import type { Op } from "../ops";
import { migrationScript, opToSql, schemaToSql } from "../sql";
import { baseSchema, col, id, ids } from "./fixtures";

describe("opToSql", () => {
  const schema = baseSchema();

  const cases: { name: string; op: Op; want: string }[] = [
    {
      name: "add_column",
      op: { kind: "add_column", tableId: ids.orders, column: col("c:x", "note", "text", { nullable: true }) },
      want: 'ALTER TABLE "orders" ADD COLUMN "note" text;',
    },
    {
      name: "add_column not null with default",
      op: { kind: "add_column", tableId: ids.orders, column: col("c:x", "flag", "boolean", { default: "false" }) },
      want: 'ALTER TABLE "orders" ADD COLUMN "flag" boolean NOT NULL DEFAULT false;',
    },
    {
      name: "rename_column uses the pre-op name",
      op: { kind: "rename_column", columnId: ids.ordersUserId, name: "account_id" },
      want: 'ALTER TABLE "orders" RENAME COLUMN "user_id" TO "account_id";',
    },
    {
      name: "retype_column emits a USING cast",
      op: { kind: "retype_column", columnId: ids.ordersAmount, type: "numeric(12,4)" },
      want: 'ALTER TABLE "orders" ALTER COLUMN "amount" TYPE numeric(12,4) USING "amount"::numeric(12,4);',
    },
    {
      name: "set_nullable false",
      op: { kind: "set_nullable", columnId: ids.ordersUserId, nullable: false },
      want: 'ALTER TABLE "orders" ALTER COLUMN "user_id" SET NOT NULL;',
    },
    {
      name: "set_default null drops the default",
      op: { kind: "set_default", columnId: ids.ordersId, default: null },
      want: 'ALTER TABLE "orders" ALTER COLUMN "id" DROP DEFAULT;',
    },
    {
      name: "drop_column",
      op: { kind: "drop_column", columnId: ids.ordersAmount },
      want: 'ALTER TABLE "orders" DROP COLUMN "amount";',
    },
    {
      name: "drop_table",
      op: { kind: "drop_table", tableId: ids.orders },
      want: 'DROP TABLE "orders";',
    },
    {
      name: "rename_table",
      op: { kind: "rename_table", tableId: ids.orders, name: "purchases" },
      want: 'ALTER TABLE "orders" RENAME TO "purchases";',
    },
    {
      name: "add unique constraint",
      op: { kind: "add_constraint", tableId: ids.orders, constraint: { id: id("k:x"), name: "orders_amount_key", kind: "unique", columns: [ids.ordersAmount] } },
      want: 'ALTER TABLE "orders" ADD CONSTRAINT "orders_amount_key" UNIQUE ("amount");',
    },
    {
      name: "add foreign key with actions",
      op: {
        kind: "add_constraint",
        tableId: ids.orders,
        constraint: {
          id: id("k:x"),
          name: "orders_user_fk2",
          kind: "foreign_key",
          columns: [ids.ordersUserId],
          references: { table: ids.users, columns: [ids.usersId] },
          onDelete: "set_null",
          onUpdate: "no_action",
        },
      },
      want: 'ALTER TABLE "orders" ADD CONSTRAINT "orders_user_fk2" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION;',
    },
    {
      name: "drop_constraint",
      op: { kind: "drop_constraint", constraintId: ids.ordersUserFk },
      want: 'ALTER TABLE "orders" DROP CONSTRAINT "orders_user_fk";',
    },
    {
      name: "add unique index",
      op: { kind: "add_index", tableId: ids.orders, index: { id: id("i:x"), name: "orders_amount_uidx", columns: [ids.ordersAmount], unique: true } },
      want: 'CREATE UNIQUE INDEX "orders_amount_uidx" ON "orders" ("amount");',
    },
    {
      name: "drop_index",
      op: { kind: "drop_index", indexId: ids.ordersUserIdx },
      want: 'DROP INDEX "orders_user_id_idx";',
    },
  ];

  it.each(cases)("$name", ({ op, want }) => {
    expect(opToSql(op, schema)).toEqual([want]);
  });

  it("create_table emits the table with inline constraints plus its indexes", () => {
    const statements = opToSql({ kind: "create_table", table: baseSchema().tables[ids.orders] }, { tables: { [ids.users]: baseSchema().tables[ids.users] } });
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('CREATE TABLE "orders"');
    expect(statements[0]).toContain('"amount" numeric(10,2) NOT NULL');
    expect(statements[0]).toContain('CONSTRAINT "orders_pkey" PRIMARY KEY ("id")');
    expect(statements[0]).toContain('FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE');
    expect(statements[1]).toBe('CREATE INDEX "orders_user_id_idx" ON "orders" ("user_id");');
  });
});

describe("migrationScript", () => {
  it("resolves names against the evolving schema (rename then retype)", () => {
    const script = migrationScript({
      startSchema: baseSchema(),
      ops: [
        { kind: "rename_column", columnId: ids.ordersAmount, name: "total" },
        { kind: "retype_column", columnId: ids.ordersAmount, type: "numeric(12,2)" },
      ],
      header: ["migration test"],
    });
    expect(script).toContain('RENAME COLUMN "amount" TO "total";');
    // the retype must use the *new* name
    expect(script).toContain('ALTER COLUMN "total" TYPE numeric(12,2)');
    expect(script.startsWith("-- migration test\nBEGIN;")).toBe(true);
    expect(script.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("annotates risky statements with their safety reason", () => {
    const script = migrationScript({
      startSchema: baseSchema(),
      ops: [{ kind: "drop_column", columnId: ids.ordersAmount }],
    });
    expect(script).toContain("-- destructive: column data is lost");
  });
});

describe("schemaToSql", () => {
  it("emits tables (FKs split out), then FKs, then indexes", () => {
    const sql = schemaToSql(baseSchema());
    const createOrders = sql.indexOf('CREATE TABLE "orders"');
    const createUsers = sql.indexOf('CREATE TABLE "users"');
    const addFk = sql.indexOf('ALTER TABLE "orders" ADD CONSTRAINT "orders_user_fk"');
    const createIdx = sql.indexOf('CREATE INDEX "orders_user_id_idx"');
    expect(createOrders).toBeGreaterThanOrEqual(0);
    expect(createUsers).toBeGreaterThan(createOrders); // alphabetical
    expect(addFk).toBeGreaterThan(createUsers);
    expect(createIdx).toBeGreaterThan(addFk);
    // no FK inline in CREATE TABLE
    expect(sql.slice(createOrders, createUsers)).not.toContain("FOREIGN KEY");
  });
});
