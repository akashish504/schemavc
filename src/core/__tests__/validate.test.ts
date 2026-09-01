import { describe, expect, it } from "vitest";
import type { Schema } from "../model";
import { validate, type Violation } from "../validate";
import { baseSchema, col, id, ids } from "./fixtures";

const mutate = (fn: (s: Schema) => void): Schema => {
  const s = baseSchema();
  fn(s);
  return s;
};

interface Case {
  name: string;
  schema: Schema;
  expect: Violation["code"][];
}

const cases: Case[] = [
  { name: "the base fixture is clean", schema: baseSchema(), expect: [] },
  {
    name: "two tables with the same name",
    schema: mutate((s) => {
      s.tables[ids.orders].name = "users";
    }),
    expect: ["duplicate_table_name"],
  },
  {
    name: "two columns with the same name in one table (the merge same-name-add case)",
    schema: mutate((s) => {
      s.tables[ids.orders].columns.push(col("c:orders.amount2", "amount", "text", { nullable: true }));
    }),
    expect: ["duplicate_column_name"],
  },
  {
    name: "index and constraint sharing a name across tables",
    schema: mutate((s) => {
      s.tables[ids.users].indexes.push({ id: id("i:clash"), name: "orders_user_fk", columns: [ids.usersEmail], unique: false });
    }),
    expect: ["duplicate_object_name"],
  },
  {
    name: "FK whose target table was dropped (the cross-table merge case)",
    schema: mutate((s) => {
      delete s.tables[ids.users];
    }),
    expect: ["fk_target_table_missing"],
  },
  {
    name: "FK whose target column was dropped",
    schema: mutate((s) => {
      s.tables[ids.users].columns = s.tables[ids.users].columns.filter((c) => c.id !== ids.usersId);
    }),
    // users_pkey also loses its column, so both fire — that is correct.
    expect: ["fk_target_column_missing", "referenced_column_missing"],
  },
  {
    name: "index over a column that no longer exists",
    schema: mutate((s) => {
      s.tables[ids.orders].columns = s.tables[ids.orders].columns.filter((c) => c.id !== ids.ordersUserId);
    }),
    // the FK's local column is also gone
    expect: ["referenced_column_missing", "referenced_column_missing"],
  },
  {
    name: "primary key over a nullable column",
    schema: mutate((s) => {
      s.tables[ids.orders].columns[0].nullable = true;
    }),
    expect: ["pk_column_nullable"],
  },
  {
    name: "two primary keys on one table",
    schema: mutate((s) => {
      s.tables[ids.orders].constraints.push({ id: id("k:pk2"), name: "orders_pkey2", kind: "primary_key", columns: [ids.ordersUserId] });
    }),
    expect: ["multiple_primary_keys"],
  },
  {
    name: "unsupported column type",
    schema: mutate((s) => {
      s.tables[ids.orders].columns[2].type = "money";
    }),
    expect: ["invalid_type"],
  },
  {
    name: "table with no columns",
    schema: mutate((s) => {
      s.tables[id("t:empty")] = { id: id("t:empty"), name: "empty", columns: [], constraints: [], indexes: [] };
    }),
    expect: ["empty_table"],
  },
  {
    name: "index with an empty column list",
    schema: mutate((s) => {
      s.tables[ids.orders].indexes[0].columns = [];
    }),
    expect: ["empty_column_list"],
  },
  {
    name: "FK arity mismatch",
    schema: mutate((s) => {
      const fk = s.tables[ids.orders].constraints.find((c) => c.kind === "foreign_key");
      if (fk && fk.kind === "foreign_key") fk.columns = [ids.ordersUserId, ids.ordersAmount];
    }),
    expect: ["fk_arity_mismatch"],
  },
];

describe("validate: rule-by-rule table", () => {
  it.each(cases)("$name", ({ schema, expect: expectedCodes }) => {
    const codes = validate(schema)
      .map((violation) => violation.code)
      .sort();
    expect(codes).toEqual([...expectedCodes].sort());
  });

  it("every violation carries entity ids and a message", () => {
    const schema = mutate((s) => {
      delete s.tables[ids.users];
      s.tables[ids.orders].columns[0].nullable = true;
    });
    for (const violation of validate(schema)) {
      expect(violation.entityIds.length).toBeGreaterThan(0);
      expect(violation.message).toBeTruthy();
    }
  });
});
