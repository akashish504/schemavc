import { NextResponse } from "next/server";
import { schemaToSql } from "@/core/sql";
import { sessionUser } from "@/server/auth";
import { ensureBootstrapped } from "@/server/db";
import { getCommit } from "@/server/store";

/** Whole-schema CREATE script for a commit's snapshot, as a downloadable .sql file. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureBootstrapped();
  if (!(await sessionUser())) return NextResponse.json({ code: "unauthenticated", message: "log in to continue" }, { status: 401 });
  const commit = await getCommit((await params).id);
  if (!commit) return NextResponse.json({ code: "not_found", message: "commit not found" }, { status: 404 });
  return new NextResponse(schemaToSql(commit.snapshot), {
    headers: {
      "content-type": "application/sql; charset=utf-8",
      "content-disposition": `attachment; filename="schema-${commit.id.slice(0, 8)}.sql"`,
    },
  });
}
