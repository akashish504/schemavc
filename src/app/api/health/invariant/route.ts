import { NextResponse } from "next/server";
import { apply } from "@/core/apply";
import { emptySchema } from "@/core/model";
import type { Op } from "@/core/ops";
import type { Schema } from "@/core/model";
import { ensureBootstrapped, pool } from "@/server/db";

/**
 * The replay invariant, live: for every commit, applying its ops to its
 * parent's snapshot must equal its stored snapshot. Snapshots are derived
 * data; this is the checksum that proves the store hasn't drifted.
 */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)])
    );
  }
  return value;
}

export async function GET() {
  try {
    await ensureBootstrapped();
    const r = await pool().query("SELECT id, parent, ops, snapshot FROM commits");
    const byId = new Map<string, { id: string; parent: string | null; ops: Op[]; snapshot: Schema }>(
      r.rows.map((row) => [row.id as string, row])
    );
    const failures: string[] = [];
    for (const commit of byId.values()) {
      // Merge commits may legitimately contain colliding-name intermediates; final snapshots never do.
      const base = commit.parent ? byId.get(commit.parent)?.snapshot : emptySchema();
      if (!base) {
        failures.push(`${commit.id}: parent ${commit.parent} missing`);
        continue;
      }
      const replayed = apply(base, commit.ops, { allowNameCollisions: true });
      if (!replayed.ok) {
        failures.push(`${commit.id}: ops do not apply (${replayed.error.message})`);
        continue;
      }
      // jsonb does not preserve key order, so compare canonically.
      if (canonical(replayed.schema) !== canonical(commit.snapshot)) {
        failures.push(`${commit.id}: replayed snapshot differs from stored snapshot`);
      }
    }
    return NextResponse.json(
      { ok: failures.length === 0, commitsChecked: byId.size, failures },
      { status: failures.length === 0 ? 200 : 500 }
    );
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
