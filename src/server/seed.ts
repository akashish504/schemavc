/**
 * The starter template: a realistic e-commerce schema committed onto main.
 * Exists so an evaluator reaches a meaningful branch/merge scenario within
 * minutes instead of hand-building tables first.
 */

import { newId } from "@/core/ids";
import type { Op } from "@/core/ops";
import type { Column } from "@/core/model";
import { MAIN_BRANCH_ID } from "./db";
import { invalid } from "./errors";
import { createCommit } from "./services";
import { getBranch, getCommit } from "./store";

const column = (name: string, type: string, opts: Partial<Column> = {}): Column => ({
  id: newId(),
  name,
  type,
  nullable: false,
  default: null,
  ...opts,
});

function templateOps(): Op[] {
  const users = {
    id: newId(),
    idCol: column("id", "uuid", { default: "gen_random_uuid()" }),
    email: column("email", "text"),
    name: column("name", "text", { nullable: true }),
    createdAt: column("created_at", "timestamptz", { default: "now()" }),
  };
  const products = {
    id: newId(),
    idCol: column("id", "uuid", { default: "gen_random_uuid()" }),
    sku: column("sku", "varchar(40)"),
    title: column("title", "text"),
    price: column("price", "numeric(10,2)"),
    stock: column("stock", "integer", { default: "0" }),
  };
  const orders = {
    id: newId(),
    idCol: column("id", "uuid", { default: "gen_random_uuid()" }),
    userId: column("user_id", "uuid"),
    placedAt: column("placed_at", "timestamptz", { default: "now()" }),
    total: column("total", "numeric(12,2)"),
  };
  const orderItems = {
    id: newId(),
    idCol: column("id", "uuid", { default: "gen_random_uuid()" }),
    orderId: column("order_id", "uuid"),
    productId: column("product_id", "uuid"),
    quantity: column("quantity", "integer", { default: "1" }),
    unitPrice: column("unit_price", "numeric(10,2)"),
  };

  return [
    {
      kind: "create_table",
      table: {
        id: users.id,
        name: "users",
        columns: [users.idCol, users.email, users.name, users.createdAt],
        constraints: [
          { id: newId(), name: "users_pkey", kind: "primary_key", columns: [users.idCol.id] },
          { id: newId(), name: "users_email_key", kind: "unique", columns: [users.email.id] },
        ],
        indexes: [],
      },
    },
    {
      kind: "create_table",
      table: {
        id: products.id,
        name: "products",
        columns: [products.idCol, products.sku, products.title, products.price, products.stock],
        constraints: [
          { id: newId(), name: "products_pkey", kind: "primary_key", columns: [products.idCol.id] },
          { id: newId(), name: "products_sku_key", kind: "unique", columns: [products.sku.id] },
          { id: newId(), name: "products_price_positive", kind: "check", expression: "price >= 0" },
        ],
        indexes: [],
      },
    },
    {
      kind: "create_table",
      table: {
        id: orders.id,
        name: "orders",
        columns: [orders.idCol, orders.userId, orders.placedAt, orders.total],
        constraints: [
          { id: newId(), name: "orders_pkey", kind: "primary_key", columns: [orders.idCol.id] },
          {
            id: newId(),
            name: "orders_user_fk",
            kind: "foreign_key",
            columns: [orders.userId.id],
            references: { table: users.id, columns: [users.idCol.id] },
            onDelete: "restrict",
            onUpdate: "no_action",
          },
        ],
        indexes: [{ id: newId(), name: "orders_user_id_idx", columns: [orders.userId.id], unique: false }],
      },
    },
    {
      kind: "create_table",
      table: {
        id: orderItems.id,
        name: "order_items",
        columns: [orderItems.idCol, orderItems.orderId, orderItems.productId, orderItems.quantity, orderItems.unitPrice],
        constraints: [
          { id: newId(), name: "order_items_pkey", kind: "primary_key", columns: [orderItems.idCol.id] },
          {
            id: newId(),
            name: "order_items_order_fk",
            kind: "foreign_key",
            columns: [orderItems.orderId.id],
            references: { table: orders.id, columns: [orders.idCol.id] },
            onDelete: "cascade",
            onUpdate: "no_action",
          },
          {
            id: newId(),
            name: "order_items_product_fk",
            kind: "foreign_key",
            columns: [orderItems.productId.id],
            references: { table: products.id, columns: [products.idCol.id] },
            onDelete: "restrict",
            onUpdate: "no_action",
          },
          { id: newId(), name: "order_items_quantity_positive", kind: "check", expression: "quantity > 0" },
        ],
        indexes: [
          { id: newId(), name: "order_items_order_id_idx", columns: [orderItems.orderId.id], unique: false },
          { id: newId(), name: "order_items_product_id_idx", columns: [orderItems.productId.id], unique: false },
        ],
      },
    },
  ];
}

export async function seedTemplate(userId: string) {
  const main = await getBranch(MAIN_BRANCH_ID);
  if (!main) throw invalid("no_main", "main branch missing");
  const head = await getCommit(main.head);
  if (!head) throw invalid("no_head", "main head missing");
  if (Object.keys(head.snapshot.tables).length > 0)
    throw invalid("not_empty", "the template can only be loaded into an empty schema");
  return createCommit({
    branchId: MAIN_BRANCH_ID,
    userId,
    message: "Start from e-commerce template",
    ops: templateOps(),
    expectedHead: main.head,
  });
}
