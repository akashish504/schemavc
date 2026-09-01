import { describe, expect, it } from "vitest";
import type { Op } from "../ops";
import { tag, type SafetyLevel } from "../safety";
import { baseSchema, col, id, ids } from "./fixtures";

interface Case {
  name: string;
  op: Op;
  level: SafetyLevel;
}

const cases: Case[] = [
  // additive
  { name: "add nullable column", op: { kind: "add_column", tableId: ids.orders, column: col("c:x", "note", "text", { nullable: true }) }, level: "additive" },
  { name: "add NOT NULL column with default", op: { kind: "add_column", tableId: ids.orders, column: col("c:x", "flag", "boolean", { default: "false" }) }, level: "additive" },
  { name: "rename column", op: { kind: "rename_column", columnId: ids.ordersUserId, name: "account_id" }, level: "additive" },
  { name: "rename table", op: { kind: "rename_table", tableId: ids.orders, name: "purchases" }, level: "additive" },
  { name: "add non-unique index", op: { kind: "add_index", tableId: ids.orders, index: { id: id("i:x"), name: "x_idx", columns: [ids.ordersAmount], unique: false } }, level: "additive" },
  { name: "set nullable", op: { kind: "set_nullable", columnId: ids.ordersUserId, nullable: true }, level: "additive" },
  { name: "set default", op: { kind: "set_default", columnId: ids.ordersAmount, default: "0" }, level: "additive" },
  { name: "widen varchar", op: { kind: "retype_column", columnId: id("c:v20"), type: "varchar(100)" }, level: "additive" },
  { name: "integer → bigint", op: { kind: "retype_column", columnId: id("c:int"), type: "bigint" }, level: "additive" },
  { name: "varchar → text", op: { kind: "retype_column", columnId: id("c:v20"), type: "text" }, level: "additive" },
  { name: "create table", op: { kind: "create_table", table: { id: id("t:x"), name: "x", columns: [col("c:x.id", "id", "uuid")], constraints: [], indexes: [] } }, level: "additive" },

  // needs care
  { name: "add NOT NULL column without default", op: { kind: "add_column", tableId: ids.orders, column: col("c:x", "req", "text") }, level: "needs_care" },
  { name: "set NOT NULL", op: { kind: "set_nullable", columnId: ids.ordersUserId, nullable: false }, level: "needs_care" },
  { name: "narrow varchar", op: { kind: "retype_column", columnId: id("c:v100"), type: "varchar(20)" }, level: "needs_care" },
  { name: "narrow numeric", op: { kind: "retype_column", columnId: ids.ordersAmount, type: "numeric(8,2)" }, level: "needs_care" },
  { name: "cross-family retype text → integer", op: { kind: "retype_column", columnId: id("c:txt"), type: "integer" }, level: "needs_care" },
  { name: "add unique constraint", op: { kind: "add_constraint", tableId: ids.orders, constraint: { id: id("k:x"), name: "x_key", kind: "unique", columns: [ids.ordersAmount] } }, level: "needs_care" },
  { name: "add check constraint", op: { kind: "add_constraint", tableId: ids.orders, constraint: { id: id("k:x"), name: "x_chk", kind: "check", expression: "amount > 0" } }, level: "needs_care" },
  { name: "add foreign key", op: { kind: "add_constraint", tableId: ids.orders, constraint: { id: id("k:x"), name: "x_fk", kind: "foreign_key", columns: [ids.ordersUserId], references: { table: ids.users, columns: [ids.usersId] }, onDelete: "no_action", onUpdate: "no_action" } }, level: "needs_care" },
  { name: "add unique index", op: { kind: "add_index", tableId: ids.orders, index: { id: id("i:x"), name: "x_uidx", columns: [ids.ordersAmount], unique: true } }, level: "needs_care" },

  // destructive
  { name: "drop column", op: { kind: "drop_column", columnId: ids.ordersAmount }, level: "destructive" },
  { name: "drop table", op: { kind: "drop_table", tableId: ids.orders }, level: "destructive" },
  { name: "drop constraint", op: { kind: "drop_constraint", constraintId: ids.ordersUserFk }, level: "destructive" },
  { name: "drop index", op: { kind: "drop_index", indexId: ids.ordersUserIdx }, level: "destructive" },
];

describe("safety: classification table", () => {
  const schema = (() => {
    const s = baseSchema();
    s.tables[ids.orders].columns.push(
      col("c:v20", "code", "varchar(20)", { nullable: true }),
      col("c:v100", "label", "varchar(100)", { nullable: true }),
      col("c:int", "count", "integer", { nullable: true }),
      col("c:txt", "raw", "text", { nullable: true })
    );
    return s;
  })();

  it.each(cases)("$name → $level", ({ op, level }) => {
    const result = tag(op, schema);
    expect(result.level).toBe(level);
    if (level !== "additive") expect(result.reason).toBeTruthy();
  });
});
