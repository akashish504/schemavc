import { describe, expect, it } from "vitest";
import { apply } from "../apply";
import { merge, type Conflict, type MergeInput, type MergeResult, type Severity } from "../merge";
import type { AttributedOp, Op } from "../ops";
import { validate } from "../validate";
import { baseSchema, col, id, ids } from "./fixtures";

const attr = (op: Op, side: "m" | "f", n = 0): AttributedOp => ({
  op,
  commitId: id(`commit:${side}${n}`),
  author: side === "m" ? "Priya" : "you",
  message: side === "m" ? "main change" : "feature change",
  at: "2026-09-01T10:00:00Z",
});

const attrs = (side: "m" | "f", ...ops: Op[]): AttributedOp[] => ops.map((op, n) => attr(op, side, n));

const input = (mainOps: Op[], featureOps: Op[]): MergeInput => ({
  fork: baseSchema(),
  mainOps: attrs("m", ...mainOps),
  featureOps: attrs("f", ...featureOps),
});

const run = (mainOps: Op[], featureOps: Op[]) => merge(input(mainOps, featureOps), []);

const blocking = (r: MergeResult): Conflict[] =>
  r.status === "error" ? [] : r.conflicts.filter((c) => c.severity !== "advisory");

interface Case {
  name: string;
  main: Op[];
  feature: Op[];
  expect: {
    conflicts: { rule: Conflict["rule"]; severity: Severity }[];
    status: "clean" | "blocked";
  };
}

const addStatus = (label: string, type = "text"): Op => ({
  kind: "add_column",
  tableId: ids.orders,
  column: col(label, "status", type, { nullable: true }),
});

const cases: Case[] = [
  {
    name: "independent changes to different tables auto-merge",
    main: [{ kind: "add_column", tableId: ids.users, column: col("c:users.name", "name", "text", { nullable: true }) }],
    feature: [{ kind: "add_column", tableId: ids.orders, column: col("c:orders.note", "note", "text", { nullable: true }) }],
    expect: { conflicts: [], status: "clean" },
  },
  {
    name: "main unchanged: all feature ops merge",
    main: [],
    feature: [
      { kind: "add_column", tableId: ids.orders, column: col("c:orders.note", "note", "text", { nullable: true }) },
      { kind: "rename_column", columnId: ids.ordersUserId, name: "account_id" },
    ],
    expect: { conflicts: [], status: "clean" },
  },
  {
    name: "rename on one side + index on the old name on the other auto-merges (stable ids)",
    main: [{ kind: "rename_column", columnId: ids.ordersAmount, name: "total" }],
    feature: [{ kind: "add_index", tableId: ids.orders, index: { id: id("i:amt"), name: "orders_amount_idx", columns: [ids.ordersAmount], unique: false } }],
    expect: { conflicts: [], status: "clean" },
  },
  {
    name: "both rename the same column to different names",
    main: [{ kind: "rename_column", columnId: ids.ordersAmount, name: "total" }],
    feature: [{ kind: "rename_column", columnId: ids.ordersAmount, name: "value" }],
    expect: { conflicts: [{ rule: "write_write", severity: "hard" }], status: "blocked" },
  },
  {
    name: "both retype the same column",
    main: [{ kind: "retype_column", columnId: ids.ordersAmount, type: "numeric(12,2)" }],
    feature: [{ kind: "retype_column", columnId: ids.ordersAmount, type: "numeric(14,4)" }],
    expect: { conflicts: [{ rule: "write_write", severity: "hard" }], status: "blocked" },
  },
  {
    name: "rename vs retype of the same column is still write/write",
    main: [{ kind: "rename_column", columnId: ids.ordersAmount, name: "total" }],
    feature: [{ kind: "retype_column", columnId: ids.ordersAmount, type: "numeric(12,2)" }],
    expect: { conflicts: [{ rule: "write_write", severity: "hard" }], status: "blocked" },
  },
  {
    name: "drop table vs add column to it",
    main: [{ kind: "drop_table", tableId: ids.orders }],
    feature: [{ kind: "add_column", tableId: ids.orders, column: col("c:orders.note", "note", "text", { nullable: true }) }],
    expect: { conflicts: [{ rule: "delete_vs_edit", severity: "hard" }], status: "blocked" },
  },
  {
    name: "drop column vs unique constraint including it",
    main: [{ kind: "drop_column", columnId: ids.ordersAmount }],
    feature: [{ kind: "add_constraint", tableId: ids.orders, constraint: { id: id("k:amt"), name: "orders_amount_key", kind: "unique", columns: [ids.ordersAmount] } }],
    expect: { conflicts: [{ rule: "delete_vs_edit", severity: "hard" }], status: "blocked" },
  },
  {
    name: "drop table on main vs FK to it from the feature (cross-table)",
    main: [
      { kind: "drop_constraint", constraintId: ids.ordersUserFk },
      { kind: "drop_index", indexId: ids.ordersUserIdx },
      { kind: "drop_column", columnId: ids.ordersUserId },
      { kind: "drop_table", tableId: ids.users },
    ],
    feature: [
      { kind: "add_column", tableId: ids.orders, column: col("c:orders.owner", "owner_id", "uuid", { nullable: true }) },
      {
        kind: "add_constraint",
        tableId: ids.orders,
        constraint: {
          id: id("k:owner"),
          name: "orders_owner_fk",
          kind: "foreign_key",
          columns: [id("c:orders.owner")],
          references: { table: ids.users, columns: [ids.usersId] },
          onDelete: "no_action",
          onUpdate: "no_action",
        },
      },
    ],
    expect: { conflicts: [{ rule: "delete_vs_edit", severity: "hard" }], status: "blocked" },
  },
  {
    name: "drop column vs rename of it",
    main: [{ kind: "drop_column", columnId: ids.ordersAmount }],
    feature: [{ kind: "rename_column", columnId: ids.ordersAmount, name: "total" }],
    expect: { conflicts: [{ rule: "delete_vs_edit", severity: "hard" }], status: "blocked" },
  },
  {
    name: "feature drops a column that main built an index on (deleter on the feature side)",
    main: [{ kind: "add_index", tableId: ids.orders, index: { id: id("i:amt"), name: "orders_amount_idx", columns: [ids.ordersAmount], unique: false } }],
    feature: [{ kind: "drop_column", columnId: ids.ordersAmount }],
    expect: { conflicts: [{ rule: "delete_vs_edit", severity: "hard" }], status: "blocked" },
  },
  {
    name: "both add a column with the same name, different definitions (semantic)",
    main: [addStatus("c:m.status", "text")],
    feature: [addStatus("c:f.status", "varchar(20)")],
    expect: { conflicts: [{ rule: "duplicate_name", severity: "semantic" }], status: "blocked" },
  },
  {
    name: "both add an identical column (still flagged, keep-one)",
    main: [addStatus("c:m.status")],
    feature: [addStatus("c:f.status")],
    expect: { conflicts: [{ rule: "duplicate_name", severity: "semantic" }], status: "blocked" },
  },
  {
    name: "both rename different columns to the same name (semantic)",
    main: [{ kind: "rename_column", columnId: ids.ordersAmount, name: "ref" }],
    feature: [{ kind: "rename_column", columnId: ids.ordersUserId, name: "ref" }],
    expect: { conflicts: [{ rule: "duplicate_name", severity: "semantic" }], status: "blocked" },
  },
  {
    name: "both drop the same column: intents agree, feature op auto-omitted",
    main: [{ kind: "drop_column", columnId: ids.ordersAmount }],
    feature: [{ kind: "drop_column", columnId: ids.ordersAmount }],
    expect: { conflicts: [], status: "clean" },
  },
];

describe("merge: taxonomy table", () => {
  it.each(cases)("$name", ({ main, feature, expect: expected }) => {
    const result = run(main, feature);
    expect(result.status).not.toBe("error");
    if (result.status === "error") return;
    const found = blocking(result)
      .map((c) => ({ rule: c.rule, severity: c.severity }))
      .sort((a, b) => a.rule.localeCompare(b.rule));
    const want = [...expected.conflicts].sort((a, b) => a.rule.localeCompare(b.rule));
    expect(found).toEqual(want);
    expect(result.status).toBe(expected.status);
  });

  it.each(cases)("symmetry: $name flags the same conflicts with sides swapped", ({ main, feature }) => {
    const forward = run(main, feature);
    const backward = run(feature, main);
    expect(forward.status).not.toBe("error");
    expect(backward.status).not.toBe("error");
    if (forward.status === "error" || backward.status === "error") return;
    const rules = (r: typeof forward) => blocking(r).map((c) => `${c.severity}:${c.rule}`).sort();
    expect(rules(backward)).toEqual(rules(forward));
  });

  it.each(cases)("clean results validate: $name", ({ main, feature }) => {
    const result = run(main, feature);
    if (result.status !== "clean" || !result.mergedSchema) return;
    expect(validate(result.mergedSchema)).toEqual([]);
  });
});

describe("merge: results and invariants", () => {
  it("auto-merge result equals both sides' changes applied", () => {
    const result = run(
      [{ kind: "add_column", tableId: ids.users, column: col("c:users.name", "name", "text", { nullable: true }) }],
      [{ kind: "add_column", tableId: ids.orders, column: col("c:orders.note", "note", "text", { nullable: true }) }]
    );
    expect(result.status).toBe("clean");
    if (result.status !== "clean" || !result.mergedSchema) return;
    expect(result.mergedSchema.tables[ids.users].columns.map((c) => c.name)).toContain("name");
    expect(result.mergedSchema.tables[ids.orders].columns.map((c) => c.name)).toContain("note");
  });

  it("rename + index-on-old-name: merged schema has the index under the new name's column id", () => {
    const result = run(
      [{ kind: "rename_column", columnId: ids.ordersAmount, name: "total" }],
      [{ kind: "add_index", tableId: ids.orders, index: { id: id("i:amt"), name: "orders_amount_idx", columns: [ids.ordersAmount], unique: false } }]
    );
    expect(result.status).toBe("clean");
    if (result.status !== "clean" || !result.mergedSchema) return;
    const orders = result.mergedSchema.tables[ids.orders];
    expect(orders.columns.find((c) => c.id === ids.ordersAmount)?.name).toBe("total");
    expect(orders.indexes.some((x) => x.columns.includes(ids.ordersAmount))).toBe(true);
    expect(validate(result.mergedSchema)).toEqual([]);
  });

  it("mergedOps apply cleanly onto main's head and pass the validator (all clean cases)", () => {
    for (const c of cases) {
      const result = run(c.main, c.feature);
      if (result.status !== "clean" || !result.mergedOps) continue;
      const mainHead = apply(baseSchema(), c.main);
      expect(mainHead.ok).toBe(true);
      if (!mainHead.ok) continue;
      const applied = apply(mainHead.schema, result.mergedOps);
      expect(applied.ok).toBe(true);
      if (applied.ok) expect(validate(applied.schema)).toEqual([]);
    }
  });

  it("conflict ids are deterministic across recomputation", () => {
    const a = run([{ kind: "drop_column", columnId: ids.ordersAmount }], [{ kind: "rename_column", columnId: ids.ordersAmount, name: "total" }]);
    const b = run([{ kind: "drop_column", columnId: ids.ordersAmount }], [{ kind: "rename_column", columnId: ids.ordersAmount, name: "total" }]);
    if (a.status === "error" || b.status === "error") throw new Error("unexpected error status");
    expect(a.conflicts.map((c) => c.id)).toEqual(b.conflicts.map((c) => c.id));
  });

  it("explanations carry attribution from both sides", () => {
    const result = run([{ kind: "drop_table", tableId: ids.orders }], [{ kind: "add_column", tableId: ids.orders, column: col("c:x", "note", "text", { nullable: true }) }]);
    if (result.status === "error") throw new Error("unexpected error");
    const conflict = blocking(result)[0];
    expect(conflict.explanation).toContain("Priya");
    expect(conflict.explanation).toContain("main change");
    expect(conflict.explanation).toContain("your branch");
    expect(conflict.explanation).toContain("drop table orders");
  });
});

describe("merge: resolutions", () => {
  const dropVsRename = () =>
    input([{ kind: "drop_column", columnId: ids.ordersAmount }], [{ kind: "rename_column", columnId: ids.ordersAmount, name: "total" }]);

  it("keep main's change omits the feature op", () => {
    const first = merge(dropVsRename(), []);
    if (first.status === "error") throw new Error("unexpected error");
    const conflictId = blocking(first)[0].id;
    const result = merge(dropVsRename(), [{ conflictId, choice: "main" }]);
    expect(result.status).toBe("clean");
    if (result.status !== "clean" || !result.mergedSchema) return;
    expect(result.mergedOps).toEqual([]);
    expect(result.omittedFeatureOps).toEqual([0]);
    // main's drop stands: the column is gone
    expect(result.mergedSchema.tables[ids.orders].columns.some((c) => c.id === ids.ordersAmount)).toBe(false);
  });

  it("keep your change emits a compensating op reversing main's drop", () => {
    const first = merge(dropVsRename(), []);
    if (first.status === "error") throw new Error("unexpected error");
    const conflictId = blocking(first)[0].id;
    const result = merge(dropVsRename(), [{ conflictId, choice: "yours" }]);
    expect(result.status).toBe("clean");
    if (result.status !== "clean" || !result.mergedOps || !result.mergedSchema) return;
    // compensation re-adds the column as it was at the fork, then the rename applies
    expect(result.mergedOps[0]).toMatchObject({ kind: "add_column", tableId: ids.orders });
    expect(result.mergedOps[1]).toMatchObject({ kind: "rename_column", columnId: ids.ordersAmount });
    const restored = result.mergedSchema.tables[ids.orders].columns.find((c) => c.id === ids.ordersAmount);
    expect(restored?.name).toBe("total");
    expect(restored?.type).toBe("numeric(10,2)");
    expect(validate(result.mergedSchema)).toEqual([]);
  });

  it("keep your change on drop-table-vs-FK recreates the table before the FK (ordering)", () => {
    const mk = () =>
      input(
        [
          { kind: "drop_constraint", constraintId: ids.ordersUserFk },
          { kind: "drop_index", indexId: ids.ordersUserIdx },
          { kind: "drop_column", columnId: ids.ordersUserId },
          { kind: "drop_table", tableId: ids.users },
        ],
        [
          { kind: "add_column", tableId: ids.orders, column: col("c:orders.owner", "owner_id", "uuid", { nullable: true }) },
          {
            kind: "add_constraint",
            tableId: ids.orders,
            constraint: {
              id: id("k:owner"),
              name: "orders_owner_fk",
              kind: "foreign_key",
              columns: [id("c:orders.owner")],
              references: { table: ids.users, columns: [ids.usersId] },
              onDelete: "no_action",
              onUpdate: "no_action",
            },
          },
        ]
      );
    const first = merge(mk(), []);
    if (first.status === "error") throw new Error("unexpected error");
    const resolutions = blocking(first).map((c) => ({ conflictId: c.id, choice: "yours" as const }));
    const result = merge(mk(), resolutions);
    expect(result.status).toBe("clean");
    if (result.status !== "clean" || !result.mergedOps || !result.mergedSchema) return;
    const kinds = result.mergedOps.map((o) => o.kind);
    expect(kinds.indexOf("create_table")).toBeLessThan(kinds.indexOf("add_constraint"));
    expect(result.mergedSchema.tables[ids.users]).toBeDefined();
    expect(validate(result.mergedSchema)).toEqual([]);
  });

  it("write/write same kind: keep yours supersedes without a compensating op", () => {
    const mk = () =>
      input([{ kind: "rename_column", columnId: ids.ordersAmount, name: "total" }], [{ kind: "rename_column", columnId: ids.ordersAmount, name: "value" }]);
    const first = merge(mk(), []);
    if (first.status === "error") throw new Error("unexpected error");
    const result = merge(mk(), [{ conflictId: blocking(first)[0].id, choice: "yours" }]);
    expect(result.status).toBe("clean");
    if (result.status !== "clean" || !result.mergedOps || !result.mergedSchema) return;
    expect(result.mergedOps).toHaveLength(1);
    expect(result.mergedSchema.tables[ids.orders].columns.find((c) => c.id === ids.ordersAmount)?.name).toBe("value");
  });

  it("keep main on an add cascades away dependent feature ops (transitive omission)", () => {
    const noteId = id("c:orders.note");
    const mk = () =>
      input(
        [{ kind: "add_column", tableId: ids.orders, column: col("c:m.note", "note", "text", { nullable: true }) }],
        [
          { kind: "add_column", tableId: ids.orders, column: { id: noteId, name: "note", type: "varchar(50)", nullable: true, default: null } },
          { kind: "add_index", tableId: ids.orders, index: { id: id("i:note"), name: "orders_note_idx", columns: [noteId], unique: false } },
        ]
      );
    const first = merge(mk(), []);
    if (first.status === "error") throw new Error("unexpected error");
    const semantic = blocking(first).find((c) => c.severity === "semantic");
    expect(semantic).toBeDefined();
    if (!semantic) return;
    const result = merge(mk(), [{ conflictId: semantic.id, choice: "main" }]);
    expect(result.status).toBe("clean");
    if (result.status !== "clean" || !result.mergedSchema) return;
    expect(result.omittedFeatureOps).toEqual([0, 1]);
    // main's column survives; the feature index on the omitted column is gone
    const orders = result.mergedSchema.tables[ids.orders];
    expect(orders.columns.filter((c) => c.name === "note")).toHaveLength(1);
    expect(orders.columns.find((c) => c.name === "note")?.type).toBe("text");
    expect(orders.indexes.some((x) => x.name === "orders_note_idx")).toBe(false);
    expect(validate(result.mergedSchema)).toEqual([]);
  });

  it("semantic keep yours reverses main's add", () => {
    const mk = () => input([addStatus("c:m.status", "text")], [addStatus("c:f.status", "varchar(20)")]);
    const first = merge(mk(), []);
    if (first.status === "error") throw new Error("unexpected error");
    const semantic = blocking(first)[0];
    const result = merge(mk(), [{ conflictId: semantic.id, choice: "yours" }]);
    expect(result.status).toBe("clean");
    if (result.status !== "clean" || !result.mergedSchema) return;
    const statusCols = result.mergedSchema.tables[ids.orders].columns.filter((c) => c.name === "status");
    expect(statusCols).toHaveLength(1);
    expect(statusCols[0].type).toBe("varchar(20)");
    expect(validate(result.mergedSchema)).toEqual([]);
  });

  it("identical adds offer a single keep-one option that keeps main's copy", () => {
    const mk = () => input([addStatus("c:m.status")], [addStatus("c:f.status")]);
    const first = merge(mk(), []);
    if (first.status === "error") throw new Error("unexpected error");
    const conflict = blocking(first)[0];
    expect(conflict.options.map((o) => o.choice)).toEqual(["keep_one"]);
    const result = merge(mk(), [{ conflictId: conflict.id, choice: "keep_one" }]);
    expect(result.status).toBe("clean");
    if (result.status !== "clean" || !result.mergedSchema) return;
    const statusCols = result.mergedSchema.tables[ids.orders].columns.filter((c) => c.name === "status");
    expect(statusCols).toHaveLength(1);
    expect(statusCols[0].id).toBe(id("c:m.status"));
  });
});

describe("merge: advisory warnings", () => {
  it("main's destructive change on a table the feature touched is advisory, non-blocking", () => {
    const result = run(
      [{ kind: "drop_column", columnId: ids.ordersUserId }, { kind: "drop_constraint", constraintId: ids.ordersUserFk }, { kind: "drop_index", indexId: ids.ordersUserIdx }],
      [{ kind: "add_column", tableId: ids.orders, column: col("c:orders.note", "note", "text", { nullable: true }) }]
    );
    if (result.status === "error") throw new Error("unexpected error");
    const advisories = result.conflicts.filter((c) => c.severity === "advisory");
    expect(advisories.length).toBeGreaterThan(0);
    expect(result.status).toBe("clean");
    for (const a of advisories) expect(a.explanation).toContain("Priya");
  });

  it("main's destructive change on an untouched table raises no advisory", () => {
    const result = run(
      [{ kind: "drop_constraint", constraintId: ids.usersEmailUnique }],
      [{ kind: "add_column", tableId: ids.orders, column: col("c:orders.note", "note", "text", { nullable: true }) }]
    );
    if (result.status === "error") throw new Error("unexpected error");
    expect(result.conflicts).toHaveLength(0);
  });
});

describe("merge: compensation ordering on a real database", () => {
  it("keep-yours over a teammate's column+index emits DROP INDEX before DROP COLUMN", () => {
    // main added a column and an index on it; feature adds a same-named column.
    // Keep-yours compensates by dropping main's column AND its index — the
    // index drop must come first, or Postgres cascades it away with the column
    // and the explicit DROP INDEX fails mid-transaction.
    const mainColId = id("c:m.chan");
    const mk = (): MergeInput => ({
      fork: baseSchema(),
      mainOps: attrs(
        "m",
        { kind: "add_column", tableId: ids.orders, column: { id: mainColId, name: "channel", type: "text", nullable: true, default: null } },
        { kind: "add_index", tableId: ids.orders, index: { id: id("i:m.chan"), name: "m_channel_idx", columns: [mainColId], unique: false } }
      ),
      featureOps: attrs("f", { kind: "add_column", tableId: ids.orders, column: col("c:f.chan", "channel", "varchar(20)", { nullable: true }) }),
    });
    const first = merge(mk(), []);
    if (first.status === "error") throw new Error("unexpected error");
    const resolutions = blocking(first).map((c) => ({ conflictId: c.id, choice: "yours" as const }));
    let result = merge(mk(), resolutions);
    // resolving may surface the dangling index as a follow-up conflict
    for (let i = 0; i < 3 && result.status === "blocked"; i++) {
      resolutions.push(...blocking(result).filter((c) => !c.resolved).map((c) => ({ conflictId: c.id, choice: "yours" as const })));
      result = merge(mk(), resolutions);
    }
    expect(result.status).toBe("clean");
    if (result.status !== "clean" || !result.mergedOps) return;
    const kinds = result.mergedOps.map((o) => o.kind);
    expect(kinds).toContain("drop_index");
    expect(kinds).toContain("drop_column");
    expect(kinds.indexOf("drop_index")).toBeLessThan(kinds.indexOf("drop_column"));
  });
});
