"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { shortId, timeAgo } from "@/lib/format";

interface CommitDetail {
  id: string;
  branchId: string;
  message: string;
  author: string;
  at: string;
  mergedFrom: string | null;
  resolutions:
    | { conflictId: string; severity: string; rule: string; explanation: string; choice: string; resolvedBy: string; resolvedAt: string }[]
    | null;
  changes: { description: string; safety: { level: string; reason?: string } }[];
  schemaSql: string;
}

export default function CommitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [commit, setCommit] = useState<CommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);

  useEffect(() => {
    api
      .get<CommitDetail>(`/api/commits/${id}`)
      .then(setCommit)
      .catch((err) => setError(err instanceof ApiError ? err.message : "failed to load"));
  }, [id]);

  if (error) return <div className="page error-banner">{error}</div>;
  if (!commit) return <div className="page muted">Loading…</div>;

  return (
    <div className="page">
      <h1>
        <span className="mono">{shortId(commit.id)}</span> {commit.message}
      </h1>
      <p className="muted small" style={{ marginTop: 0 }}>
        {commit.author} · {timeAgo(commit.at)} · on <Link href={`/branches/${commit.branchId}`}>this branch</Link>
        {commit.mergedFrom && " · merge commit"}
      </p>

      <div className="card">
        <h2>Operations in this commit</h2>
        {commit.changes.length === 0 && <p className="muted small">No operations (root commit).</p>}
        {commit.changes.map((c, i) => (
          <div key={i} className="change-row">
            <span className={`tag ${c.safety.level}`}>{c.safety.level.replace("_", " ")}</span>
            <span className="desc">{c.description}</span>
            {c.safety.reason && (
              <span className="muted small" style={{ marginLeft: "auto" }}>
                {c.safety.reason}
              </span>
            )}
          </div>
        ))}
      </div>

      {commit.resolutions && commit.resolutions.length > 0 && (
        <div className="card">
          <h2>How conflicts were resolved</h2>
          {commit.resolutions.map((r) => (
            <div key={r.conflictId} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
              <div className="row">
                <span className={`tag ${r.severity === "advisory" ? "needs_care" : "destructive"}`}>{r.severity}</span>
                <span className="tag neutral">{r.choice === "main" ? "kept main's change" : r.choice === "yours" ? "kept branch's change" : r.choice === "keep_one" ? "kept one copy" : r.choice}</span>
              </div>
              <p className="small muted" style={{ margin: "4px 0 0" }}>
                {r.explanation}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Schema at this commit</h2>
        <p className="muted small">The full CREATE script for this snapshot, from an empty database.</p>
        <div className="row" style={{ marginBottom: 10 }}>
          <button onClick={() => setShowSql(!showSql)}>{showSql ? "Hide SQL" : "Show SQL"}</button>
          <a className="btn" href={`/api/commits/${commit.id}/sql`} download>
            Download .sql
          </a>
        </div>
        {showSql && <pre className="sql">{commit.schemaSql}</pre>}
      </div>
    </div>
  );
}
