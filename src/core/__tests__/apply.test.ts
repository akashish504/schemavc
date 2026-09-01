import { describe, expect, it } from "vitest";
import { apply, type ApplyError } from "../apply";
import type { Op } from "../ops";
import { baseSchema, col, id, ids } from "./fixtures";

const newCol = (label: string, name: string, type = "text") => col(label, name, type, { nullable: true });

describe("apply: happy paths", () => {
  it("applies a batch and leaves the input untouched", () => {
    const schema = baseSchema();
    const ops: Op[] = [
      { kind: "add_column", tableId: ids.orders, column: newCol("c:orders.note", "note") },
      { kind: "rename_column", columnId: ids.ordersUserId, name: "account_id" },
      { kind: "set_nullable", columnId: ids.ordersAmount, nullable: true },
    ];
    const result = apply(schema, ops);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const orders = result.schema.tables[ids.orders];
    expect(orders.columns.map((c) => c.name)).toEqual(["id", "account_id", "amount", "note"]);
    expect(orders.columns.find((c) => c.id === ids.ordersAmount)?.nullable).toBe(true);
    // input schema untouched
    expect(schema.tables[ids.orders].columns).toHaveLength(3);
    expect(schema.tables[ids.orders].columns[1].name).toBe("user_id");
  });

  it("later ops in a batch can reference ids created earlier in the batch", () => {
    const noteId = id("c:orders.note");
    const ops: Op[] = [
      { kind: "add_column", tableId: ids.orders, column: { id: noteId, name: "note", type: "text", nullable: true, default: null } },
      { kind: "add_index", tableId: ids.orders, index: { id: id("i:orders.note"), name: "orders_note_idx", columns: [noteId], unique: false } },
    ];
    expect(apply(baseSchema(), ops).ok).toBe(true);
  });

  it("drop_table removes the table", () => {
    const result = apply(baseSchema(), [{ kind: "drop_table", tableId: ids.orders }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.schema.tables[ids.orders]).toBeUndefined();
  });
});

interface RejectionCase {
  name: string;
  ops: Op[];
  code: ApplyError["code"];
  opIndex?: number;
}

const cases: RejectionCase[] = [
  {
    name: "rename of a non-existent column",
    ops: [{ kind: "rename_column", columnId: id("nope"), name: "x" }],
    code: "unknown_column",
  },
  {
    name: "retype of a non-existent column",
    ops: [{ kind: "retype_column", columnId: id("nope"), type: "text" }],
    code: "unknown_column",
  },
  {
    name: "drop of a non-existent table",
    ops: [{ kind: "drop_table", tableId: id("nope") }],
    code: "unknown_table",
  },
  {
    name: "drop of a non-existent constraint",
    ops: [{ kind: "drop_constraint", constraintId: id("nope") }],
    code: "unknown_constraint",
  },
  {
    name: "drop of a non-existent index",
    ops: [{ kind: "drop_index", indexId: id("nope") }],
    code: "unknown_index",
  },
  {
    name: "add column with a name the table already has",
    ops: [{ kind: "add_column", tableId: ids.orders, column: newCol("c:x", "amount") }],
    code: "duplicate_column_name",
  },
  {
    name: "rename column onto an existing name",
    ops: [{ kind: "rename_column", columnId: ids.ordersUserId, name: "amount" }],
    code: "duplicate_column_name",
  },
  {
    name: "rename table onto an existing name",
    ops: [{ kind: "rename_table", tableId: ids.orders, name: "users" }],
    code: "duplicate_table_name",
  },
  {
    name: "add column reusing an existing id",
    ops: [{ kind: "add_column", tableId: ids.orders, column: { ...newCol("c:x", "note"), id: ids.usersEmail } }],
    code: "duplicate_id",
  },
  {
    name: "add column with a malformed id",
    ops: [{ kind: "add_column", tableId: ids.orders, column: { ...newCol("c:x", "note"), id: "BAD" } }],
    code: "invalid_id",
  },
  {
    name: "add column with an unsupported type",
    ops: [{ kind: "add_column", tableId: ids.orders, column: newCol("c:x", "note", "money") }],
    code: "invalid_type",
  },
  {
    name: "retype to an unsupported type",
    ops: [{ kind: "retype_column", columnId: ids.ordersAmount, type: "float8" }],
    code: "invalid_type",
  },
  {
    name: "add column with an invalid identifier",
    ops: [{ kind: "add_column", tableId: ids.orders, column: newCol("c:x", "Bad Name!") }],
    code: "invalid_name",
  },
  {
    name: "add index whose name collides with a constraint",
    ops: [
      { kind: "add_index", tableId: ids.orders, index: { id: id("i:x"), name: "users_pkey", columns: [ids.ordersId], unique: false } },
    ],
    code: "duplicate_object_name",
  },
  {
    name: "rename to the same name is a noop",
    ops: [{ kind: "rename_column", columnId: ids.ordersUserId, name: "user_id" }],
    code: "noop_change",
  },
  {
    name: "second op in the batch is the one that fails",
    ops: [
      { kind: "set_nullable", columnId: ids.ordersAmount, nullable: true },
      { kind: "rename_column", columnId: id("nope"), name: "x" },
    ],
    code: "unknown_column",
    opIndex: 1,
  },
  {
    name: "ops after a drop cannot reference the dropped column",
    ops: [
      { kind: "drop_column", columnId: ids.ordersAmount },
      { kind: "rename_column", columnId: ids.ordersAmount, name: "total" },
    ],
    code: "unknown_column",
    opIndex: 1,
  },
];

describe("apply: rejection table", () => {
  it.each(cases)("rejects $name", ({ ops, code, opIndex }) => {
    const result = apply(baseSchema(), ops);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(code);
    expect(result.error.opIndex).toBe(opIndex ?? 0);
    expect(result.error.message).toBeTruthy();
  });
});
