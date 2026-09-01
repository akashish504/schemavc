/**
 * Dependency ordering of an op list (Kahn's topological sort).
 *
 * Edges come from static effect sets:
 *   - the op that creates id X runs before any op that reads/writes/deletes X;
 *   - any op that reads or writes X runs before the op that deletes X.
 * Ties are broken by original sequence, so same-side ops keep their relative
 * order wherever the dependency graph allows it.
 *
 * A cycle means conflict detection let something incoherent through — it is
 * an internal error, never a user-facing state.
 */

import type { Id, Schema } from "./model";
import { tableIds } from "./model";
import type { Op } from "./ops";

interface StaticEffects {
  creates: Id[];
  modifies: Id[]; // writes to already-existing ids
  reads: Id[];
  deletes: Id[];
}

function staticEffects(op: Op, schemaBefore: Schema): StaticEffects {
  switch (op.kind) {
    case "create_table": {
      const t = op.table;
      const creates = [t.id, ...t.columns.map((c) => c.id), ...t.constraints.map((c) => c.id), ...t.indexes.map((x) => x.id)];
      const own = new Set(creates);
      const reads: Id[] = [];
      for (const c of t.constraints) {
        if (c.kind === "foreign_key") {
          for (const ref of [c.references.table, ...c.references.columns]) if (!own.has(ref)) reads.push(ref);
        }
      }
      return { creates, modifies: [], reads, deletes: [] };
    }
    case "drop_table": {
      const t = schemaBefore.tables[op.tableId];
      return { creates: [], modifies: [], reads: [], deletes: t ? [...tableIds(t)] : [op.tableId] };
    }
    case "rename_table":
      return { creates: [], modifies: [op.tableId], reads: [], deletes: [] };
    case "add_column":
      return { creates: [op.column.id], modifies: [], reads: [op.tableId], deletes: [] };
    case "drop_column":
      return { creates: [], modifies: [], reads: [], deletes: [op.columnId] };
    case "rename_column":
    case "retype_column":
    case "set_nullable":
    case "set_default":
      return { creates: [], modifies: [op.columnId], reads: [], deletes: [] };
    case "add_constraint": {
      const c = op.constraint;
      const reads: Id[] = [op.tableId];
      if (c.kind === "primary_key" || c.kind === "unique") reads.push(...c.columns);
      if (c.kind === "foreign_key") reads.push(...c.columns, c.references.table, ...c.references.columns);
      return { creates: [c.id], modifies: [], reads, deletes: [] };
    }
    case "drop_constraint":
      return { creates: [], modifies: [], reads: [], deletes: [op.constraintId] };
    case "add_index":
      return { creates: [op.index.id], modifies: [], reads: [op.tableId, ...op.index.columns], deletes: [] };
    case "drop_index":
      return { creates: [], modifies: [], reads: [], deletes: [op.indexId] };
  }
}

export type OrderResult = { ok: true; ops: Op[] } | { ok: false; cycleIndexes: number[] };

export function order(ops: Op[], schemaBefore: Schema): OrderResult {
  const n = ops.length;
  const eff = ops.map((op) => staticEffects(op, schemaBefore));

  const creatorOf = new Map<Id, number>();
  const deleterOf = new Map<Id, number>();
  for (let i = 0; i < n; i++) {
    for (const x of eff[i].creates) creatorOf.set(x, i);
    for (const x of eff[i].deletes) deleterOf.set(x, i);
  }

  const successors: Set<number>[] = Array.from({ length: n }, () => new Set());
  const indegree = new Array<number>(n).fill(0);
  const addEdge = (from: number, to: number) => {
    if (from === to || successors[from].has(to)) return;
    successors[from].add(to);
    indegree[to]++;
  };

  for (let i = 0; i < n; i++) {
    const uses = [...eff[i].reads, ...eff[i].modifies, ...eff[i].deletes];
    for (const x of uses) {
      const creator = creatorOf.get(x);
      if (creator !== undefined) addEdge(creator, i);
    }
    for (const x of [...eff[i].reads, ...eff[i].modifies]) {
      const deleter = deleterOf.get(x);
      if (deleter !== undefined) addEdge(i, deleter);
    }
  }

  // Kahn's, picking the lowest original index among available ops (stable).
  const done: number[] = [];
  const available = new Set<number>();
  for (let i = 0; i < n; i++) if (indegree[i] === 0) available.add(i);
  while (available.size > 0) {
    const next = Math.min(...available);
    available.delete(next);
    done.push(next);
    for (const s of successors[next]) {
      if (--indegree[s] === 0) available.add(s);
    }
  }

  if (done.length < n) {
    const cycleIndexes = [];
    for (let i = 0; i < n; i++) if (!done.includes(i)) cycleIndexes.push(i);
    return { ok: false, cycleIndexes };
  }
  return { ok: true, ops: done.map((i) => ops[i]) };
}
