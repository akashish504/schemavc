"use client";

/**
 * The schema editor: renders the branch's schema with pending changes tinted
 * in place, and turns every action into exactly one typed op. The preview is
 * computed client-side with the same apply() the server runs — the server
 * stays authoritative at commit time.
 */

import { useMemo, useState } from "react";
import { bareWordDefaultSuggestion } from "@/core/defaults";
import { newId } from "@/core/ids";
import type { Column, Constraint, Id, Index, Schema, Table } from "@/core/model";
import type { Op } from "@/core/ops";
import { buildType, TYPE_CHOICES } from "@/lib/types-ui";

interface EditorProps {
  base: Schema;
  preview: Schema;
  pending: Op[];
  readOnly: boolean;
  onAddOp: (op: Op) => string | null; // returns an error message or null
}

type ActiveForm =
  | { kind: "create_table" }
  | { kind: "add_column"; tableId: Id }
  | { kind: "add_constraint"; tableId: Id }
  | { kind: "add_index"; tableId: Id }
  | { kind: "rename_table"; tableId: Id }
  | { kind: "rename_column"; columnId: Id }
  | { kind: "retype_column"; columnId: Id }
  | { kind: "set_default"; columnId: Id }
  | null;

/** Which ids the pending ops add / modify / delete, for tinting. */
function pendingTints(pending: Op[]) {
  const added = new Set<Id>();
  const modified = new Set<Id>();
  const deleted = new Set<Id>();
  for (const op of pending) {
    switch (op.kind) {
      case "create_table":
        added.add(op.table.id);
        for (const c of op.table.columns) added.add(c.id);
        for (const c of op.table.constraints) added.add(c.id);
        for (const x of op.table.indexes) added.add(x.id);
        break;
      case "add_column":
        added.add(op.column.id);
        break;
      case "add_constraint":
        added.add(op.constraint.id);
        break;
      case "add_index":
        added.add(op.index.id);
        break;
      case "drop_table":
        deleted.add(op.tableId);
        break;
      case "drop_column":
        deleted.add(op.columnId);
        break;
      case "drop_constraint":
        deleted.add(op.constraintId);
        break;
      case "drop_index":
        deleted.add(op.indexId);
        break;
      case "rename_table":
        modified.add(op.tableId);
        break;
      default:
        modified.add(op.columnId);
    }
  }
  return { added, modified, deleted };
}

export function SchemaEditor({ base, preview, pending, readOnly, onAddOp }: EditorProps) {
  const [form, setForm] = useState<ActiveForm>(null);
  const tints = useMemo(() => pendingTints(pending), [pending]);

  // Render preview tables, plus base tables that are pending-dropped.
  const tables: { table: Table; dropped: boolean }[] = useMemo(() => {
    const out = Object.values(preview.tables).map((t) => ({ table: t, dropped: false }));
    for (const t of Object.values(base.tables)) {
      if (!preview.tables[t.id] && tints.deleted.has(t.id)) out.push({ table: t, dropped: true });
    }
    return out.sort((a, b) => a.table.name.localeCompare(b.table.name));
  }, [base, preview, tints]);

  const submit = (op: Op) => {
    const error = onAddOp(op);
    if (error === null) setForm(null);
    return error;
  };

  return (
    <div>
      {tables.map(({ table, dropped }) => (
        <TableCard
          key={table.id}
          table={table}
          baseTable={base.tables[table.id]}
          preview={preview}
          dropped={dropped}
          tints={tints}
          readOnly={readOnly || dropped}
          form={form}
          setForm={setForm}
          submit={submit}
        />
      ))}

      {!readOnly && (
        <div style={{ marginTop: 8 }}>
          {form?.kind === "create_table" ? (
            <div className="schema-table">
              <CreateTableForm submit={submit} cancel={() => setForm(null)} />
            </div>
          ) : (
            <button onClick={() => setForm({ kind: "create_table" })}>+ Create table</button>
          )}
        </div>
      )}

      {tables.length === 0 && readOnly && <p className="muted">The schema is empty at this commit.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- table card

interface TableCardProps {
  table: Table;
  baseTable: Table | undefined;
  preview: Schema;
  dropped: boolean;
  tints: ReturnType<typeof pendingTints>;
  readOnly: boolean;
  form: ActiveForm;
  setForm: (f: ActiveForm) => void;
  submit: (op: Op) => string | null;
}

function TableCard({ table, baseTable, preview, dropped, tints, readOnly, form, setForm, submit }: TableCardProps) {
  const rowClass = (id: Id): string => {
    if (dropped || tints.deleted.has(id)) return "pending-del";
    if (tints.added.has(id)) return "pending-add";
    if (tints.modified.has(id)) return "pending-mod";
    return "";
  };

  // Deleted columns/constraints/indexes still render (struck through) from base.
  const deletedColumns = (baseTable?.columns ?? []).filter((c) => tints.deleted.has(c.id) && !dropped);
  const deletedConstraints = (baseTable?.constraints ?? []).filter((c) => tints.deleted.has(c.id) && !dropped);
  const deletedIndexes = (baseTable?.indexes ?? []).filter((x) => tints.deleted.has(x.id) && !dropped);

  return (
    <div className="schema-table" style={dropped ? { opacity: 0.65 } : undefined}>
      <div className={`schema-table-header ${dropped ? "pending-del" : tints.modified.has(table.id) ? "" : ""}`}>
        {form?.kind === "rename_table" && form.tableId === table.id ? (
          <InlineNameForm
            initial={table.name}
            label="table name"
            onSubmit={(name) => submit({ kind: "rename_table", tableId: table.id, name })}
            onCancel={() => setForm(null)}
          />
        ) : (
          <span className={`tname ${dropped ? "pending-del" : ""}`} style={dropped ? { textDecoration: "line-through" } : undefined}>
            {table.name}
          </span>
        )}
        {tints.added.has(table.id) && <span className="tag additive">new</span>}
        {tints.modified.has(table.id) && !tints.added.has(table.id) && <span className="tag needs_care">renamed</span>}
        {dropped && <span className="tag destructive">dropped</span>}
        <span style={{ flex: 1 }} />
        {!readOnly && (
          <div className="row small">
            <button className="linklike small" onClick={() => setForm({ kind: "add_column", tableId: table.id })}>
              + column
            </button>
            <button className="linklike small" onClick={() => setForm({ kind: "add_constraint", tableId: table.id })}>
              + constraint
            </button>
            <button className="linklike small" onClick={() => setForm({ kind: "add_index", tableId: table.id })}>
              + index
            </button>
            <button className="linklike small" onClick={() => setForm({ kind: "rename_table", tableId: table.id })}>
              rename
            </button>
            <button
              className="linklike small"
              style={{ color: "var(--red)" }}
              onClick={() => submit({ kind: "drop_table", tableId: table.id })}
            >
              drop
            </button>
          </div>
        )}
      </div>

      {form?.kind === "add_column" && form.tableId === table.id && (
        <ColumnForm
          onSubmit={(column) => submit({ kind: "add_column", tableId: table.id, column })}
          onCancel={() => setForm(null)}
        />
      )}
      {form?.kind === "add_constraint" && form.tableId === table.id && (
        <ConstraintForm
          table={table}
          preview={preview}
          onSubmit={(constraint) => submit({ kind: "add_constraint", tableId: table.id, constraint })}
          onCancel={() => setForm(null)}
        />
      )}
      {form?.kind === "add_index" && form.tableId === table.id && (
        <IndexForm
          table={table}
          onSubmit={(index) => submit({ kind: "add_index", tableId: table.id, index })}
          onCancel={() => setForm(null)}
        />
      )}

      {[...table.columns, ...deletedColumns].map((c) => (
        <ColumnRow
          key={c.id}
          column={c}
          table={table}
          className={rowClass(c.id)}
          readOnly={readOnly || tints.deleted.has(c.id)}
          form={form}
          setForm={setForm}
          submit={submit}
        />
      ))}

      {(table.constraints.length > 0 || deletedConstraints.length > 0) && <div className="subheading">Constraints</div>}
      {[...table.constraints, ...deletedConstraints].map((c) => (
        <div key={c.id} className={`schema-row ${rowClass(c.id)}`}>
          <span>{describeConstraint(c, table, preview)}</span>
          <div className="actions">
            {!readOnly && !tints.deleted.has(c.id) && (
              <button
                className="linklike small"
                style={{ color: "var(--red)" }}
                onClick={() => submit({ kind: "drop_constraint", constraintId: c.id })}
              >
                drop
              </button>
            )}
          </div>
        </div>
      ))}

      {(table.indexes.length > 0 || deletedIndexes.length > 0) && <div className="subheading">Indexes</div>}
      {[...table.indexes, ...deletedIndexes].map((x) => (
        <div key={x.id} className={`schema-row ${rowClass(x.id)}`}>
          <span>
            {x.unique ? "unique index" : "index"} {x.name} ({columnNames(table, x.columns)})
          </span>
          <div className="actions">
            {!readOnly && !tints.deleted.has(x.id) && (
              <button
                className="linklike small"
                style={{ color: "var(--red)" }}
                onClick={() => submit({ kind: "drop_index", indexId: x.id })}
              >
                drop
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- column row

interface ColumnRowProps {
  column: Column;
  table: Table;
  className: string;
  readOnly: boolean;
  form: ActiveForm;
  setForm: (f: ActiveForm) => void;
  submit: (op: Op) => string | null;
}

function ColumnRow({ column, table, className, readOnly, form, setForm, submit }: ColumnRowProps) {
  void table;
  if (form?.kind === "rename_column" && form.columnId === column.id) {
    return (
      <div className="inline-form">
        <InlineNameForm
          initial={column.name}
          label="column name"
          onSubmit={(name) => submit({ kind: "rename_column", columnId: column.id, name })}
          onCancel={() => setForm(null)}
        />
      </div>
    );
  }
  if (form?.kind === "retype_column" && form.columnId === column.id) {
    return (
      <div className="inline-form">
        <TypePicker
          label={`new type for ${column.name} (now ${column.type})`}
          onSubmit={(type) => submit({ kind: "retype_column", columnId: column.id, type })}
          onCancel={() => setForm(null)}
        />
      </div>
    );
  }
  if (form?.kind === "set_default" && form.columnId === column.id) {
    return (
      <div className="inline-form">
        <InlineNameForm
          initial={column.default ?? ""}
          label="default expression (empty to remove)"
          allowEmpty
          free
          onSubmit={(value) => {
            const suggestion = value === "" ? null : bareWordDefaultSuggestion(value);
            if (suggestion !== null) return `Postgres reads ${value} as a column reference — for the string literal, write ${suggestion}`;
            return submit({ kind: "set_default", columnId: column.id, default: value === "" ? null : value });
          }}
          onCancel={() => setForm(null)}
        />
      </div>
    );
  }
  return (
    <div className={`schema-row ${className}`}>
      <span style={{ fontWeight: 600 }}>{column.name}</span>
      <span className="muted">{column.type}</span>
      <span className="muted">{column.nullable ? "null" : "not null"}</span>
      {column.default !== null && <span className="muted">default {column.default}</span>}
      <div className="actions">
        {!readOnly && (
          <>
            <button className="linklike small" onClick={() => setForm({ kind: "rename_column", columnId: column.id })}>
              rename
            </button>
            <button className="linklike small" onClick={() => setForm({ kind: "retype_column", columnId: column.id })}>
              retype
            </button>
            <button
              className="linklike small"
              onClick={() => submit({ kind: "set_nullable", columnId: column.id, nullable: !column.nullable })}
            >
              {column.nullable ? "set not null" : "allow null"}
            </button>
            <button className="linklike small" onClick={() => setForm({ kind: "set_default", columnId: column.id })}>
              default
            </button>
            <button
              className="linklike small"
              style={{ color: "var(--red)" }}
              onClick={() => submit({ kind: "drop_column", columnId: column.id })}
            >
              drop
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- forms

function InlineNameForm({
  initial,
  label,
  onSubmit,
  onCancel,
  allowEmpty = false,
  free = false,
}: {
  initial: string;
  label: string;
  onSubmit: (value: string) => string | null;
  onCancel: () => void;
  allowEmpty?: boolean;
  free?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        setError(onSubmit(value.trim()));
      }}
    >
      <div className="field">
        <label>{label}</label>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          required={!allowEmpty}
          pattern={free ? undefined : "[a-z_][a-z0-9_]*"}
          title={free ? undefined : "lowercase letters, digits and _"}
        />
      </div>
      <button className="primary">Save</button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {error && <span className="small" style={{ color: "var(--red)" }}>{error}</span>}
    </form>
  );
}

function TypePicker({ label, onSubmit, onCancel }: { label: string; onSubmit: (type: string) => string | null; onCancel: () => void }) {
  const [family, setFamily] = useState("text");
  const [length, setLength] = useState("255");
  const [precision, setPrecision] = useState("10");
  const [scale, setScale] = useState("2");
  const [error, setError] = useState<string | null>(null);
  const choice = TYPE_CHOICES.find((t) => t.family === family);
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        const type = buildType(family, length, precision, scale);
        setError(type === null ? "invalid type parameters" : onSubmit(type));
      }}
    >
      <div className="field">
        <label>{label}</label>
        <select value={family} onChange={(e) => setFamily(e.target.value)}>
          {TYPE_CHOICES.map((t) => (
            <option key={t.family} value={t.family}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      {choice?.params === "length" && (
        <div className="field">
          <label>length</label>
          <input value={length} onChange={(e) => setLength(e.target.value)} style={{ width: 70 }} inputMode="numeric" />
        </div>
      )}
      {choice?.params === "precision" && (
        <>
          <div className="field">
            <label>precision</label>
            <input value={precision} onChange={(e) => setPrecision(e.target.value)} style={{ width: 70 }} inputMode="numeric" />
          </div>
          <div className="field">
            <label>scale</label>
            <input value={scale} onChange={(e) => setScale(e.target.value)} style={{ width: 70 }} inputMode="numeric" />
          </div>
        </>
      )}
      <button className="primary">Save</button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {error && <span className="small" style={{ color: "var(--red)" }}>{error}</span>}
    </form>
  );
}

function ColumnForm({ onSubmit, onCancel }: { onSubmit: (column: Column) => string | null; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [family, setFamily] = useState("text");
  const [length, setLength] = useState("255");
  const [precision, setPrecision] = useState("10");
  const [scale, setScale] = useState("2");
  const [nullable, setNullable] = useState(true);
  const [defaultValue, setDefaultValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const choice = TYPE_CHOICES.find((t) => t.family === family);

  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        const type = buildType(family, length, precision, scale);
        if (type === null) {
          setError("invalid type parameters");
          return;
        }
        const def = defaultValue.trim() === "" ? null : defaultValue.trim();
        const suggestion = def === null ? null : bareWordDefaultSuggestion(def);
        if (suggestion !== null) {
          setError(`Postgres reads ${def} as a column reference — for the string literal, write ${suggestion}`);
          return;
        }
        setError(onSubmit({ id: newId(), name: name.trim(), type, nullable, default: def }));
      }}
    >
      <div className="field">
        <label>column name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required pattern="[a-z_][a-z0-9_]*" title="lowercase letters, digits and _" />
      </div>
      <div className="field">
        <label>type</label>
        <select value={family} onChange={(e) => setFamily(e.target.value)}>
          {TYPE_CHOICES.map((t) => (
            <option key={t.family} value={t.family}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      {choice?.params === "length" && (
        <div className="field">
          <label>length</label>
          <input value={length} onChange={(e) => setLength(e.target.value)} style={{ width: 70 }} inputMode="numeric" />
        </div>
      )}
      {choice?.params === "precision" && (
        <>
          <div className="field">
            <label>precision</label>
            <input value={precision} onChange={(e) => setPrecision(e.target.value)} style={{ width: 70 }} inputMode="numeric" />
          </div>
          <div className="field">
            <label>scale</label>
            <input value={scale} onChange={(e) => setScale(e.target.value)} style={{ width: 70 }} inputMode="numeric" />
          </div>
        </>
      )}
      <div className="field">
        <label>nullable</label>
        <input type="checkbox" checked={nullable} onChange={(e) => setNullable(e.target.checked)} style={{ width: 18, height: 18 }} />
      </div>
      <div className="field">
        <label>default (optional, SQL expression)</label>
        <input value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)} placeholder="e.g. now()" />
      </div>
      <button className="primary">Add column</button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {error && <span className="small" style={{ color: "var(--red)" }}>{error}</span>}
      {!nullable && defaultValue.trim() === "" && (
        <span className="small" style={{ color: "var(--amber)" }}>
          not null without a default fails on tables with existing rows
        </span>
      )}
    </form>
  );
}

function ConstraintForm({
  table,
  preview,
  onSubmit,
  onCancel,
}: {
  table: Table;
  preview: Schema;
  onSubmit: (constraint: Constraint) => string | null;
  onCancel: () => void;
}) {
  const hasPk = table.constraints.some((c) => c.kind === "primary_key");
  const [kind, setKind] = useState<Constraint["kind"]>(hasPk ? "unique" : "primary_key");
  const [name, setName] = useState("");
  const [columns, setColumns] = useState<Id[]>([]);
  const [expression, setExpression] = useState("");
  const [targetTable, setTargetTable] = useState("");
  const [targetColumn, setTargetColumn] = useState("");
  const [onDelete, setOnDelete] = useState<"no_action" | "restrict" | "cascade" | "set_null" | "set_default">("no_action");
  const [error, setError] = useState<string | null>(null);

  const otherTables = Object.values(preview.tables).sort((a, b) => a.name.localeCompare(b.name));
  const target = preview.tables[targetTable];

  const suggested = (() => {
    const colPart = columns.map((id) => table.columns.find((c) => c.id === id)?.name ?? "col").join("_");
    switch (kind) {
      case "primary_key":
        return `${table.name}_pkey`;
      case "unique":
        return `${table.name}_${colPart || "cols"}_key`;
      case "check":
        return `${table.name}_check`;
      case "foreign_key":
        return `${table.name}_${colPart || "cols"}_fk`;
    }
  })();

  const toggleColumn = (id: Id) => setColumns((cur) => (cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id]));

  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        const finalName = (name.trim() || suggested).trim();
        const id = newId();
        let constraint: Constraint;
        if (kind === "check") {
          if (expression.trim() === "") {
            setError("a check constraint needs an expression");
            return;
          }
          constraint = { id, name: finalName, kind, expression: expression.trim() };
        } else if (kind === "foreign_key") {
          if (columns.length !== 1 || !target || !targetColumn) {
            setError("pick one local column, a target table and its column");
            return;
          }
          constraint = {
            id,
            name: finalName,
            kind,
            columns,
            references: { table: target.id, columns: [targetColumn] },
            onDelete,
            onUpdate: "no_action",
          };
        } else {
          if (columns.length === 0) {
            setError("pick at least one column");
            return;
          }
          constraint = { id, name: finalName, kind, columns };
        }
        setError(onSubmit(constraint));
      }}
    >
      <div className="field">
        <label>constraint</label>
        <select value={kind} onChange={(e) => setKind(e.target.value as Constraint["kind"])}>
          {!hasPk && <option value="primary_key">primary key</option>}
          <option value="unique">unique</option>
          <option value="check">check</option>
          <option value="foreign_key">foreign key</option>
        </select>
      </div>
      {kind !== "check" && (
        <div className="field">
          <label>{kind === "foreign_key" ? "local column (pick one)" : "columns"}</label>
          <div className="row">
            {table.columns.map((c) => (
              <label key={c.id} className="row small" style={{ gap: 4, marginBottom: 0 }}>
                <input
                  type={kind === "foreign_key" ? "radio" : "checkbox"}
                  name="fkcol"
                  checked={columns.includes(c.id)}
                  onChange={() => (kind === "foreign_key" ? setColumns([c.id]) : toggleColumn(c.id))}
                />
                {c.name}
              </label>
            ))}
          </div>
        </div>
      )}
      {kind === "check" && (
        <div className="field" style={{ minWidth: 220 }}>
          <label>expression</label>
          <input value={expression} onChange={(e) => setExpression(e.target.value)} placeholder="price >= 0" />
        </div>
      )}
      {kind === "foreign_key" && (
        <>
          <div className="field">
            <label>references table</label>
            <select value={targetTable} onChange={(e) => { setTargetTable(e.target.value); setTargetColumn(""); }}>
              <option value="">choose…</option>
              {otherTables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>target column</label>
            <select value={targetColumn} onChange={(e) => setTargetColumn(e.target.value)} disabled={!target}>
              <option value="">choose…</option>
              {target?.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>on delete</label>
            <select value={onDelete} onChange={(e) => setOnDelete(e.target.value as typeof onDelete)}>
              <option value="no_action">no action</option>
              <option value="restrict">restrict</option>
              <option value="cascade">cascade</option>
              <option value="set_null">set null</option>
            </select>
          </div>
        </>
      )}
      <div className="field">
        <label>name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested} pattern="[a-z_][a-z0-9_]*" />
      </div>
      <button className="primary">Add constraint</button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {error && <span className="small" style={{ color: "var(--red)" }}>{error}</span>}
    </form>
  );
}

function IndexForm({ table, onSubmit, onCancel }: { table: Table; onSubmit: (index: Index) => string | null; onCancel: () => void }) {
  const [columns, setColumns] = useState<Id[]>([]);
  const [unique, setUnique] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const suggested = `${table.name}_${columns.map((id) => table.columns.find((c) => c.id === id)?.name ?? "col").join("_") || "cols"}_idx`;
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (columns.length === 0) {
          setError("pick at least one column");
          return;
        }
        setError(onSubmit({ id: newId(), name: name.trim() || suggested, columns, unique }));
      }}
    >
      <div className="field">
        <label>columns (in order)</label>
        <div className="row">
          {table.columns.map((c) => (
            <label key={c.id} className="row small" style={{ gap: 4, marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={columns.includes(c.id)}
                onChange={() => setColumns((cur) => (cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id]))}
              />
              {c.name}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label>unique</label>
        <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} style={{ width: 18, height: 18 }} />
      </div>
      <div className="field">
        <label>name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested} pattern="[a-z_][a-z0-9_]*" />
      </div>
      <button className="primary">Add index</button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {error && <span className="small" style={{ color: "var(--red)" }}>{error}</span>}
    </form>
  );
}

function CreateTableForm({ submit, cancel }: { submit: (op: Op) => string | null; cancel: () => void }) {
  const [name, setName] = useState("");
  const [colName, setColName] = useState("id");
  const [withPk, setWithPk] = useState(true);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="inline-form"
      style={{ borderBottom: "none" }}
      onSubmit={(e) => {
        e.preventDefault();
        const columnId = newId();
        const table: Table = {
          id: newId(),
          name: name.trim(),
          columns: [{ id: columnId, name: colName.trim(), type: "uuid", nullable: false, default: "gen_random_uuid()" }],
          constraints: withPk ? [{ id: newId(), name: `${name.trim()}_pkey`, kind: "primary_key", columns: [columnId] }] : [],
          indexes: [],
        };
        setError(submit({ kind: "create_table", table }));
      }}
    >
      <div className="field">
        <label>table name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required pattern="[a-z_][a-z0-9_]*" title="lowercase letters, digits and _" />
      </div>
      <div className="field">
        <label>first column (uuid)</label>
        <input value={colName} onChange={(e) => setColName(e.target.value)} required pattern="[a-z_][a-z0-9_]*" />
      </div>
      <div className="field">
        <label>primary key on it</label>
        <input type="checkbox" checked={withPk} onChange={(e) => setWithPk(e.target.checked)} style={{ width: 18, height: 18 }} />
      </div>
      <button className="primary">Create table</button>
      <button type="button" onClick={cancel}>
        Cancel
      </button>
      {error && <span className="small" style={{ color: "var(--red)" }}>{error}</span>}
      <span className="muted small">add more columns after creating</span>
    </form>
  );
}

// ---------------------------------------------------------------- helpers

function columnNames(table: Table, ids: Id[]): string {
  return ids.map((id) => table.columns.find((c) => c.id === id)?.name ?? "?").join(", ");
}

function describeConstraint(c: Constraint, table: Table, schema: Schema): string {
  switch (c.kind) {
    case "primary_key":
      return `primary key ${c.name} (${columnNames(table, c.columns)})`;
    case "unique":
      return `unique ${c.name} (${columnNames(table, c.columns)})`;
    case "check":
      return `check ${c.name}: ${c.expression}`;
    case "foreign_key": {
      const target = schema.tables[c.references.table];
      const targetCols = target ? columnNames(target, c.references.columns) : "?";
      return `foreign key ${c.name}: (${columnNames(table, c.columns)}) → ${target?.name ?? "?"} (${targetCols}) on delete ${c.onDelete.replace("_", " ")}`;
    }
  }
}
