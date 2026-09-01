/**
 * Runtime validation of client-sent op payloads. The UI is the only client,
 * but the server never trusts it: a forged or stale op must fail loudly here
 * or in apply(), never corrupt a snapshot.
 */

import { z } from "zod";
import { bareWordDefaultSuggestion } from "@/core/defaults";
import type { Op } from "@/core/ops";

const id = z.string().regex(/^[0-9a-f]{8}$/, "ids are 8 lowercase hex chars");
const name = z.string().min(1).max(63);
const referentialAction = z.enum(["no_action", "restrict", "cascade", "set_null", "set_default"]);

const sqlDefault = z
  .string()
  .max(500)
  .refine((v) => bareWordDefaultSuggestion(v) === null, {
    message: "a bare word is read as a column reference by Postgres — string literals need quotes, e.g. 'US'",
  });

const column = z
  .object({
    id,
    name,
    type: z.string().min(1).max(40),
    nullable: z.boolean(),
    default: sqlDefault.nullable(),
  })
  .strict();

const constraint = z.discriminatedUnion("kind", [
  z.object({ id, name, kind: z.literal("primary_key"), columns: z.array(id).min(1).max(16) }).strict(),
  z.object({ id, name, kind: z.literal("unique"), columns: z.array(id).min(1).max(16) }).strict(),
  z.object({ id, name, kind: z.literal("check"), expression: z.string().min(1).max(1000) }).strict(),
  z
    .object({
      id,
      name,
      kind: z.literal("foreign_key"),
      columns: z.array(id).min(1).max(16),
      references: z.object({ table: id, columns: z.array(id).min(1).max(16) }).strict(),
      onDelete: referentialAction,
      onUpdate: referentialAction,
    })
    .strict(),
]);

const index = z.object({ id, name, columns: z.array(id).min(1).max(16), unique: z.boolean() }).strict();

const table = z
  .object({
    id,
    name,
    columns: z.array(column).max(100),
    constraints: z.array(constraint).max(100),
    indexes: z.array(index).max(100),
  })
  .strict();

export const opSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create_table"), table }).strict(),
  z.object({ kind: z.literal("drop_table"), tableId: id }).strict(),
  z.object({ kind: z.literal("rename_table"), tableId: id, name }).strict(),
  z.object({ kind: z.literal("add_column"), tableId: id, column }).strict(),
  z.object({ kind: z.literal("drop_column"), columnId: id }).strict(),
  z.object({ kind: z.literal("rename_column"), columnId: id, name }).strict(),
  z.object({ kind: z.literal("retype_column"), columnId: id, type: z.string().min(1).max(40) }).strict(),
  z.object({ kind: z.literal("set_nullable"), columnId: id, nullable: z.boolean() }).strict(),
  z.object({ kind: z.literal("set_default"), columnId: id, default: sqlDefault.nullable() }).strict(),
  z.object({ kind: z.literal("add_constraint"), tableId: id, constraint }).strict(),
  z.object({ kind: z.literal("drop_constraint"), constraintId: id }).strict(),
  z.object({ kind: z.literal("add_index"), tableId: id, index }).strict(),
  z.object({ kind: z.literal("drop_index"), indexId: id }).strict(),
]) satisfies z.ZodType<Op>;

export const opsSchema = z.array(opSchema).min(1).max(200);

export const resolutionSchema = z
  .object({
    conflictId: z.string().regex(/^[0-9a-f]{16}$/),
    choice: z.enum(["main", "yours", "keep_one"]),
  })
  .strict();
