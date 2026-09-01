/**
 * Three-way merge over typed operations: the hard sub-problem.
 *
 * Inputs are the fork snapshot and each side's ops since the fork. Conflict
 * detection is three generic rules over read/write/delete sets (write/write,
 * delete-vs-anything, otherwise auto-merge), followed by a post-merge
 * validator pass that catches emergent problems (duplicate names, dangling
 * references) as *semantic* conflicts, plus a non-blocking *advisory* pass.
 *
 * Deterministic: same input + same resolutions ⇒ identical output, including
 * conflict ids. That determinism is what lets the compare page hold
 * resolutions client-side and the server recompute the merge at submit time.
 *
 * The merged commit applies on top of main's head, so its op list contains
 * the feature's surviving ops plus any compensating ops that reverse main
 * history ("keep your change" on a conflict) — never main's own ops.
 */

import { apply } from "./apply";
import { describeOp } from "./describe";
import { replayWithEffects, touchedTableId, type Effects } from "./effects";
import { invert } from "./invert";
import type { Id, Schema } from "./model";
import type { AttributedOp, Op } from "./ops";
import { order } from "./order";
import { tag, type SafetyTag } from "./safety";
import { validate, type Violation } from "./validate";

export interface MergeInput {
  fork: Schema;
  mainOps: AttributedOp[];
  featureOps: AttributedOp[];
}

export type Choice = "main" | "yours" | "keep_one";

export interface Resolution {
  conflictId: string;
  choice: Choice;
}

/** A pointer at one attributed op on one side, with its rendered description. */
export interface OpRef {
  side: "main" | "feature";
  index: number;
  description: string;
  commitId: string;
  author: string;
  message: string;
  at: string;
}

export type ConflictRule =
  | "write_write"
  | "delete_vs_edit"
  | "duplicate_name"
  | "dangling_reference"
  | "invalid_schema"
  | "destructive_overlap";

export type Severity = "hard" | "semantic" | "advisory";

export interface ResolutionOption {
  choice: Choice;
  label: string;
  consequence: string;
}

export interface Conflict {
  id: string;
  severity: Severity;
  rule: ConflictRule;
  explanation: string;
  entityIds: Id[];
  mainRefs: OpRef[];
  featureRefs: OpRef[];
  options: ResolutionOption[];
  resolved?: {
    choice: Choice;
    /** feature op indexes removed by this resolution (direct, not transitive) */
    removedFeatureOps: number[];
    /** compensating ops added by this resolution */
    compensations: Op[];
  };
}

export interface ChangeRow {
  ref: OpRef;
  tag: SafetyTag;
  /** false when a resolution or auto-rule removed this op from the merge */
  included: boolean;
}

export interface MergeSummary {
  totalChanges: number;
  autoMerged: number;
  blocking: number;
  unresolvedBlocking: number;
  advisories: number;
}

export type MergeResult =
  | { status: "error"; error: string }
  | {
      status: "clean" | "blocked";
      conflicts: Conflict[];
      changes: ChangeRow[];
      summary: MergeSummary;
      /** present when status is "clean": the final ordered M.ops */
      mergedOps?: Op[];
      mergedSchema?: Schema;
      /** all feature op indexes excluded from the merge (resolutions + transitive) */
      omittedFeatureOps?: number[];
    };

/** Stable content hash (FNV-1a, 64-bit as hex) for deterministic conflict ids. */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000197) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

const SUPERSEDING_KINDS: ReadonlySet<Op["kind"]> = new Set([
  "rename_table",
  "rename_column",
  "retype_column",
  "set_nullable",
  "set_default",
]);

/** Ids an op introduces (as opposed to modifies). */
function createdIds(op: Op): Id[] {
  switch (op.kind) {
    case "create_table":
      return [
        op.table.id,
        ...op.table.columns.map((c) => c.id),
        ...op.table.constraints.map((c) => c.id),
        ...op.table.indexes.map((x) => x.id),
      ];
    case "add_column":
      return [op.column.id];
    case "add_constraint":
      return [op.constraint.id];
    case "add_index":
      return [op.index.id];
    default:
      return [];
  }
}

const intersect = (a: Id[], b: Id[]): Id[] => {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
};

export function merge(input: MergeInput, resolutions: Resolution[]): MergeResult {
  const { fork, mainOps, featureOps } = input;

  const mainReplay = replayWithEffects(fork, mainOps.map((a) => a.op));
  if (!mainReplay.ok) return { status: "error", error: `main history does not replay from the fork (op ${mainReplay.opIndex})` };
  const featureReplay = replayWithEffects(fork, featureOps.map((a) => a.op));
  if (!featureReplay.ok) return { status: "error", error: `feature history does not replay from the fork (op ${featureReplay.opIndex})` };

  const mainHead = mainReplay.end;

  // Both heads were validated at commit time; a violation here means corrupt
  // input, and every later step is allowed to assume it cannot happen.
  const mainHeadViolations = validate(mainHead);
  if (mainHeadViolations.length > 0)
    return { status: "error", error: `main's head does not validate: ${mainHeadViolations[0].message}` };
  const featureHeadViolations = validate(featureReplay.end);
  if (featureHeadViolations.length > 0)
    return { status: "error", error: `the branch head does not validate: ${featureHeadViolations[0].message}` };

  const resolutionByConflict = new Map(resolutions.map((r) => [r.conflictId, r.choice]));

  const mainRef = (i: number): OpRef => ref("main", i, mainOps[i], mainReplay.perOp[i].before);
  const featureRef = (i: number): OpRef => ref("feature", i, featureOps[i], featureReplay.perOp[i].before);

  // ---- auto-omit feature deletes fully covered by main deletes (both sides
  // dropped the same thing: intents agree, keeping both would double-drop) ----
  const mainDeletesAll = new Set<Id>(mainReplay.perOp.flatMap((p) => p.effects.deletes));
  const autoOmitted = new Set<number>();
  for (let j = 0; j < featureOps.length; j++) {
    const fe = featureReplay.perOp[j].effects;
    if (fe.deletes.length > 0 && fe.writes.length === 0 && fe.deletes.every((d) => mainDeletesAll.has(d))) {
      autoOmitted.add(j);
    }
  }

  // ---- rule 1 + 2: pairwise hard conflicts ----
  const conflicts: Conflict[] = [];
  const hardConflictMainIndexes = new Set<number>();

  for (let i = 0; i < mainOps.length; i++) {
    for (let j = 0; j < featureOps.length; j++) {
      if (autoOmitted.has(j)) continue;
      const me = mainReplay.perOp[i].effects;
      const fe = featureReplay.perOp[j].effects;
      const pair = classifyPair(me, fe);
      if (!pair) continue;
      hardConflictMainIndexes.add(i);
      const mRef = mainRef(i);
      const fRef = featureRef(j);
      const id = stableHash(`${pair.rule}|${pair.deleter ?? ""}|${mRef.commitId}:${i}|${fRef.commitId}:${j}|${pair.entityIds.slice().sort().join(",")}`);
      conflicts.push({
        id,
        severity: "hard",
        rule: pair.rule,
        entityIds: pair.entityIds,
        mainRefs: [mRef],
        featureRefs: [fRef],
        explanation: hardExplanation(pair.rule, pair.deleter, mRef, fRef),
        options: hardOptions(mRef, fRef, mainOps[i].op, mainReplay.perOp[i].before, featureOps[j].op),
        resolved: undefined,
      });
    }
  }

  // ---- apply hard resolutions ----
  const omitted = new Set<number>(autoOmitted);
  const compensationsByMainOp = new Map<number, Op[]>();
  let unresolvedBlocking = 0;

  for (const conflict of conflicts) {
    const choice = resolutionByConflict.get(conflict.id);
    if (!choice) {
      unresolvedBlocking++;
      continue;
    }
    const removed: number[] = [];
    const comps: Op[] = [];
    if (choice === "main" || choice === "keep_one") {
      for (const r of conflict.featureRefs) {
        omitted.add(r.index);
        removed.push(r.index);
      }
    } else {
      for (const r of conflict.mainRefs) {
        const mainOp = mainOps[r.index].op;
        const featureOp = featureOps[conflict.featureRefs[0].index].op;
        const supersedes = conflict.rule === "write_write" && mainOp.kind === featureOp.kind && SUPERSEDING_KINDS.has(mainOp.kind);
        if (!supersedes && !compensationsByMainOp.has(r.index)) {
          const inv = invert(mainOp, mainReplay.perOp[r.index].before);
          if (!inv) return { status: "error", error: `cannot invert main op ${r.index} (${mainOp.kind})` };
          compensationsByMainOp.set(r.index, inv);
          comps.push(...inv);
        }
      }
    }
    conflict.resolved = { choice, removedFeatureOps: removed, compensations: comps };
  }

  // ---- semantic pass: build candidate, validate, map violations to conflicts,
  // apply their resolutions, iterate to fixpoint ----
  let mergedOps: Op[] | undefined;
  let mergedSchema: Schema | undefined;

  if (unresolvedBlocking === 0) {
    for (let iteration = 0; iteration < 10; iteration++) {
      closeOverDeadIds(featureOps, featureReplay.perOp.map((p) => p.effects), omitted);
      const candidate: Op[] = [
        ...[...compensationsByMainOp.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, ops]) => ops),
        ...featureOps.filter((_, j) => !omitted.has(j)).map((a) => a.op),
      ];
      const ordered = order(candidate, mainHead);
      if (!ordered.ok) return { status: "error", error: "dependency cycle in merged ops — conflict detection let something incoherent through" };
      const applied = apply(mainHead, ordered.ops, { allowNameCollisions: true });
      if (!applied.ok) return { status: "error", error: `merged ops do not apply: ${applied.error.message}` };

      const violations = validate(applied.schema);
      const newConflicts: Conflict[] = [];
      let progressed = false;

      for (const violation of violations) {
        const semantic = semanticConflict(violation, input, mainReplay.perOp, featureReplay.perOp, omitted, mainRef, featureRef);
        if (!semantic) return { status: "error", error: `unattributable validation failure: ${violation.message}` };
        if (conflicts.some((c) => c.id === semantic.id) || newConflicts.some((c) => c.id === semantic.id)) continue;
        const choice = resolutionByConflict.get(semantic.id);
        if (choice) {
          const removed: number[] = [];
          const comps: Op[] = [];
          if (choice === "yours") {
            for (const r of semantic.mainRefs) {
              if (!compensationsByMainOp.has(r.index)) {
                const inv = invert(mainOps[r.index].op, mainReplay.perOp[r.index].before);
                if (!inv) return { status: "error", error: `cannot invert main op ${r.index}` };
                compensationsByMainOp.set(r.index, inv);
                comps.push(...inv);
              }
            }
          } else {
            for (const r of semantic.featureRefs) {
              if (!omitted.has(r.index)) {
                omitted.add(r.index);
                removed.push(r.index);
              }
            }
          }
          semantic.resolved = { choice, removedFeatureOps: removed, compensations: comps };
          progressed = true;
        }
        newConflicts.push(semantic);
      }

      conflicts.push(...newConflicts);
      const unresolvedSemantic = conflicts.filter((c) => c.severity === "semantic" && !c.resolved).length;

      if (!progressed) {
        if (unresolvedSemantic === 0) {
          mergedOps = ordered.ops;
          mergedSchema = applied.schema;
        } else {
          unresolvedBlocking += unresolvedSemantic;
        }
        break;
      }
      // a resolution changed the candidate — loop and re-validate
    }
  }

  // ---- advisory pass: main made risky changes on tables this branch touched ----
  const featureTables = new Set<Id>();
  for (let j = 0; j < featureOps.length; j++) {
    const t = touchedTableId(featureOps[j].op, featureReplay.perOp[j].before);
    if (t) featureTables.add(t);
  }
  for (let i = 0; i < mainOps.length; i++) {
    if (hardConflictMainIndexes.has(i)) continue;
    const before = mainReplay.perOp[i].before;
    const safety = tag(mainOps[i].op, before);
    if (safety.level === "additive") continue;
    const t = touchedTableId(mainOps[i].op, before);
    if (!t || !featureTables.has(t)) continue;
    const r = mainRef(i);
    conflicts.push({
      id: stableHash(`advisory|${r.commitId}:${i}`),
      severity: "advisory",
      rule: "destructive_overlap",
      entityIds: t ? [t] : [],
      mainRefs: [r],
      featureRefs: [],
      explanation: `while you were working, main ${r.description} (commit ${short(r.commitId)}, “${r.message}”, ${r.author}) on a table your branch also touches — ${safety.reason ?? "review before merging"}`,
      options: [],
    });
  }

  const changes: ChangeRow[] = featureOps.map((a, j) => ({
    ref: featureRef(j),
    tag: tag(a.op, featureReplay.perOp[j].before),
    included: !omitted.has(j),
  }));

  const advisories = conflicts.filter((c) => c.severity === "advisory").length;
  const blocking = conflicts.length - advisories;
  const summary: MergeSummary = {
    totalChanges: featureOps.length,
    autoMerged: featureOps.length - omitted.size - conflicts.filter((c) => c.severity === "hard" && !c.resolved).flatMap((c) => c.featureRefs).length,
    blocking,
    unresolvedBlocking,
    advisories,
  };

  return {
    status: unresolvedBlocking === 0 ? "clean" : "blocked",
    conflicts,
    changes,
    summary,
    mergedOps: unresolvedBlocking === 0 ? mergedOps : undefined,
    mergedSchema: unresolvedBlocking === 0 ? mergedSchema : undefined,
    omittedFeatureOps: [...omitted].sort((a, b) => a - b),
  };
}

// ---------------------------------------------------------------- helpers

function ref(side: "main" | "feature", index: number, a: AttributedOp, before: Schema): OpRef {
  return {
    side,
    index,
    description: describeOp(a.op, before),
    commitId: a.commitId,
    author: a.author,
    message: a.message,
    at: a.at,
  };
}

const short = (commitId: string) => commitId.slice(0, 8);

function classifyPair(
  main: Effects,
  feature: Effects
): { rule: "write_write" | "delete_vs_edit"; entityIds: Id[]; deleter?: "main" | "feature" } | null {
  const ww = intersect(main.writes, feature.writes);
  if (ww.length > 0) return { rule: "write_write", entityIds: ww };
  const mainDeletes = intersect(main.deletes, [...feature.writes, ...feature.reads]);
  if (mainDeletes.length > 0) return { rule: "delete_vs_edit", entityIds: mainDeletes, deleter: "main" };
  const featureDeletes = intersect(feature.deletes, [...main.writes, ...main.reads]);
  if (featureDeletes.length > 0) return { rule: "delete_vs_edit", entityIds: featureDeletes, deleter: "feature" };
  return null;
}

function hardExplanation(rule: "write_write" | "delete_vs_edit", deleter: "main" | "feature" | undefined, m: OpRef, f: OpRef): string {
  const mainPart = `main ${m.description} (commit ${short(m.commitId)}, “${m.message}”, ${m.author})`;
  const featurePart = `your branch ${f.description} (commit ${short(f.commitId)}, “${f.message}”, ${f.author})`;
  if (rule === "write_write") return `both sides changed the same thing: ${mainPart}, while ${featurePart}. Only one change can survive.`;
  return deleter === "main"
    ? `${mainPart}, but ${featurePart} — your change targets something that no longer exists on main.`
    : `${featurePart}, but ${mainPart} — main's change targets something your branch removed.`;
}

function hardOptions(m: OpRef, f: OpRef, mainOp: Op, mainBefore: Schema, featureOp: Op): ResolutionOption[] {
  const supersedes = mainOp.kind === featureOp.kind && SUPERSEDING_KINDS.has(mainOp.kind);
  const inv = supersedes ? null : invert(mainOp, mainBefore);
  const yoursConsequence = supersedes
    ? `your change replaces main's (${m.description} is overridden)`
    : inv
      ? `main's change is reversed in the merge commit (${inv.map((op) => describeOp(op, mainBefore)).join("; ")}), then yours applies`
      : "main's change is reversed in the merge commit, then yours applies";
  return [
    { choice: "main", label: "Keep main's change", consequence: `your change (${f.description}) is dropped from the merge; your branch history still shows it` },
    { choice: "yours", label: "Keep your change", consequence: yoursConsequence },
  ];
}

/**
 * Remove feature ops that depend on ids created by already-omitted feature
 * ops (an omitted add_column takes the index built on it down too).
 */
function closeOverDeadIds(featureOps: AttributedOp[], perOpEffects: Effects[], omitted: Set<number>): void {
  const dead = new Set<Id>();
  for (const j of omitted) for (const id of createdIds(featureOps[j].op)) dead.add(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (let j = 0; j < featureOps.length; j++) {
      if (omitted.has(j)) continue;
      const e = perOpEffects[j];
      if ([...e.reads, ...e.writes, ...e.deletes].some((id) => dead.has(id))) {
        omitted.add(j);
        for (const id of createdIds(featureOps[j].op)) dead.add(id);
        changed = true;
      }
    }
  }
}

function semanticConflict(
  violation: Violation,
  input: MergeInput,
  mainPerOp: { effects: Effects; before: Schema }[],
  featurePerOp: { effects: Effects; before: Schema }[],
  omitted: Set<number>,
  mainRef: (i: number) => OpRef,
  featureRef: (i: number) => OpRef
): Conflict | null {
  const involved = new Set(violation.entityIds);
  const mainRefs: OpRef[] = [];
  const featureRefs: OpRef[] = [];
  for (let i = 0; i < input.mainOps.length; i++) {
    const op = input.mainOps[i].op;
    if (createdIds(op).some((id) => involved.has(id)) || (op.kind === "rename_column" && involved.has(op.columnId))) {
      mainRefs.push(mainRef(i));
    }
  }
  for (let j = 0; j < input.featureOps.length; j++) {
    if (omitted.has(j)) continue;
    const op = input.featureOps[j].op;
    if (createdIds(op).some((id) => involved.has(id)) || (op.kind === "rename_column" && involved.has(op.columnId))) {
      featureRefs.push(featureRef(j));
    }
  }
  if (featureRefs.length === 0 && mainRefs.length === 0) return null;

  const rule: ConflictRule = violation.code.startsWith("duplicate")
    ? "duplicate_name"
    : violation.code.includes("missing")
      ? "dangling_reference"
      : "invalid_schema";

  const identical = rule === "duplicate_name" && areIdenticalAdds(input, mainRefs, featureRefs);
  const id = stableHash(`semantic|${violation.code}|${violation.entityIds.slice().sort().join(",")}`);

  const mainSide = mainRefs.map((r) => `main ${r.description} (commit ${short(r.commitId)}, “${r.message}”, ${r.author})`).join("; ");
  const featureSide = featureRefs.map((r) => `your branch ${r.description} (commit ${short(r.commitId)}, “${r.message}”, ${r.author})`).join("; ");
  const explanation =
    mainRefs.length > 0 && featureRefs.length > 0
      ? `both sides' changes are valid alone but clash when combined: ${mainSide}, while ${featureSide}. ${violation.message}.`
      : `combining the branches leaves the schema inconsistent: ${violation.message}. ${mainSide}${featureSide}`;

  const options: ResolutionOption[] = identical
    ? [{ choice: "keep_one", label: "These are identical — keep one", consequence: "main's copy stays; your duplicate op is dropped from the merge" }]
    : [
        ...(featureRefs.length > 0
          ? [{ choice: "main" as Choice, label: "Keep main's change", consequence: `your change (${featureRefs.map((r) => r.description).join("; ")}) is dropped from the merge` }]
          : []),
        ...(mainRefs.length > 0
          ? [{ choice: "yours" as Choice, label: "Keep your change", consequence: "main's change is reversed in the merge commit, then yours applies" }]
          : []),
      ];

  return { id, severity: "semantic", rule, entityIds: violation.entityIds, mainRefs, featureRefs, explanation, options };
}

/** True when the duplicate-name conflict is two column adds with equal definitions. */
function areIdenticalAdds(input: MergeInput, mainRefs: OpRef[], featureRefs: OpRef[]): boolean {
  if (mainRefs.length !== 1 || featureRefs.length !== 1) return false;
  const m = input.mainOps[mainRefs[0].index].op;
  const f = input.featureOps[featureRefs[0].index].op;
  if (m.kind !== "add_column" || f.kind !== "add_column") return false;
  return (
    m.column.name === f.column.name &&
    m.column.type === f.column.type &&
    m.column.nullable === f.column.nullable &&
    m.column.default === f.column.default
  );
}
