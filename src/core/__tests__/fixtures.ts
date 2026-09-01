/**
 * Shared test fixtures: deterministic ids and a small realistic schema
 * (users + orders with PK, FK, unique constraint, index).
 */

import type { Column, Constraint, Index, Schema, Table } from "../model";

/** Deterministic 8-hex-char id from a label, readable in test failures. */
export function id(label: string): string {
  let hash = 0;
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

export const col = (label: string, name: string, type: string, opts: Partial<Column> = {}): Column => ({
  id: id(label),
  name,
  type,
  nullable: false,
  default: null,
  ...opts,
});

export const ids = {
  users: id("t:users"),
  usersId: id("c:users.id"),
  usersEmail: id("c:users.email"),
  usersPk: id("k:users.pk"),
  usersEmailUnique: id("k:users.email_unique"),
  orders: id("t:orders"),
  ordersId: id("c:orders.id"),
  ordersUserId: id("c:orders.user_id"),
  ordersAmount: id("c:orders.amount"),
  ordersPk: id("k:orders.pk"),
  ordersUserFk: id("k:orders.user_fk"),
  ordersUserIdx: id("i:orders.user_idx"),
};

export function usersTable(): Table {
  return {
    id: ids.users,
    name: "users",
    columns: [
      col("c:users.id", "id", "uuid", { default: "gen_random_uuid()" }),
      col("c:users.email", "email", "text"),
    ],
    constraints: [
      { id: ids.usersPk, name: "users_pkey", kind: "primary_key", columns: [ids.usersId] },
      { id: ids.usersEmailUnique, name: "users_email_key", kind: "unique", columns: [ids.usersEmail] },
    ],
    indexes: [],
  };
}

export function ordersTable(): Table {
  const fk: Constraint = {
    id: ids.ordersUserFk,
    name: "orders_user_fk",
    kind: "foreign_key",
    columns: [ids.ordersUserId],
    references: { table: ids.users, columns: [ids.usersId] },
    onDelete: "cascade",
    onUpdate: "no_action",
  };
  const idx: Index = { id: ids.ordersUserIdx, name: "orders_user_id_idx", columns: [ids.ordersUserId], unique: false };
  return {
    id: ids.orders,
    name: "orders",
    columns: [
      col("c:orders.id", "id", "uuid", { default: "gen_random_uuid()" }),
      col("c:orders.user_id", "user_id", "uuid"),
      col("c:orders.amount", "amount", "numeric(10,2)"),
    ],
    constraints: [{ id: ids.ordersPk, name: "orders_pkey", kind: "primary_key", columns: [ids.ordersId] }, fk],
    indexes: [idx],
  };
}

export function baseSchema(): Schema {
  return { tables: { [ids.users]: usersTable(), [ids.orders]: ordersTable() } };
}
