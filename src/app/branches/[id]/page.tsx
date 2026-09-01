"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { apply } from "@/core/apply";
import { describeOp } from "@/core/describe";
import type { Schema } from "@/core/model";
import type { Op } from "@/core/ops";
import { tag, type SafetyTag } from "@/core/safety";
import { validate } from "@/core/validate";
import { api, ApiError } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { SchemaEditor } from "./editor";

interface BranchDetail {
  branch: { id: string; name: string; head: string; isMain: boolean; status: "active" | "archived" };
  schema: Schema;
  aheadOfMain: number;
  mainMovedBy: number;
  commits: { id: string; message: string; author: string; at: string; opCount: number; mergedFrom: string | null }[];
}

export default function BranchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<BranchDetail | null>(null);
  const [pending, setPending] = useState<Op[]>([]);
  const [message, setMessage] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  const load = useCallback(
    () =>
      api
        .get<BranchDetail>(`/api/branches/${id}`)
        .then(setDetail)
        .catch((err) => {
          if (err instanceof ApiError && err.status !== 401) setBanner(err.message);
        }),
    [id]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Preview = base schema + pending ops, computed with the same apply() the server runs.
  const preview = useMemo(() => {
    if (!detail) return null;
    const result = apply(detail.schema, pending);
    return result.ok ? result.schema : null;
  }, [detail, pending]);

  // Descriptions and safety tags for the tray, against the evolving schema.
  const trayRows = useMemo(() => {
    if (!detail) return [];
    const rows: { description: string; safety: SafetyTag }[] = [];
    let current = detail.schema;
    for (const op of pending) {
      rows.push({ description: describeOp(op, current), safety: tag(op, current) });
      const next = apply(current, [op]);
      if (next.ok) current = next.schema;
    }
    return rows;
  }, [detail, pending]);

  if (!detail) return <div className="page muted">{banner ?? "Loading…"}</div>;

  const readOnly = detail.branch.status === "archived" || detail.branch.isMain;

  const addOp = (op: Op): string | null => {
    // Validate against the previewed schema before accepting into the tray.
    const base = preview ?? detail.schema;
    const result = apply(base, [op]);
    if (!result.ok) return result.error.message;
    setPending((cur) => [...cur, op]);
    setBanner(null);
    return null;
  };

  async function commit(e: React.FormEvent) {
    e.preventDefault();
    if (!detail) return;
    // Pre-commit validation locally for a friendlier error than a 422.
    const result = apply(detail.schema, pending);
    if (result.ok) {
      const violations = validate(result.schema);
      if (violations.length > 0) {
        setBanner(`this change would leave the schema inconsistent: ${violations[0].message}`);
        return;
      }
    }
    setCommitting(true);
    setBanner(null);
    try {
      await api.post(`/api/branches/${detail.branch.id}/commits`, {
        message,
        ops: pending,
        expectedHead: detail.branch.head,
      });
      setPending([]);
      setMessage("");
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "head_moved") {
        setBanner("someone else committed to this branch while you were editing — the page reloaded with the latest schema; your pending changes are kept and re-checked");
        await load();
      } else {
        setBanner(err instanceof ApiError ? err.message : "commit failed — try again");
      }
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 4 }}>
        <h1 className="mono" style={{ fontSize: 18 }}>
          {detail.branch.name}
        </h1>
        {detail.branch.isMain && <span className="tag accent">default</span>}
        {detail.branch.isMain && <span className="tag neutral">changes arrive through merges</span>}
        {readOnly && !detail.branch.isMain && <span className="tag neutral">merged &amp; archived — read only</span>}
        <span style={{ flex: 1 }} />
        {!detail.branch.isMain && !readOnly && (
          <Link className="btn primary" href={`/branches/${detail.branch.id}/compare`}>
            Compare with main
          </Link>
        )}
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        {detail.branch.isMain
          ? "The shared source of truth. It changes only through merges — create a branch to make a change."
          : readOnly
            ? "This branch was merged into main and is kept for history."
            : `${detail.aheadOfMain} commit${detail.aheadOfMain === 1 ? "" : "s"} ahead of main` +
              (detail.mainMovedBy > 0 ? ` · main has moved by ${detail.mainMovedBy} since you forked` : " · main has not changed since you forked")}
      </p>

      {banner && <div className="error-banner">{banner}</div>}
      {preview === null && pending.length > 0 && (
        <div className="error-banner">your pending changes no longer apply to the latest schema — discard them or review below</div>
      )}

      <div className={pending.length > 0 || !readOnly ? "editor-layout" : undefined}>
        <div>
          {Object.keys(detail.schema.tables).length === 0 && pending.length === 0 && (
            <div className="empty-state card">
              <h2>{detail.branch.isMain ? "The schema is empty" : "Your branch starts from an empty schema"}</h2>
              <p>
                {detail.branch.isMain
                  ? "Load the e-commerce template from the branches page, or create a branch to add your first table — main itself only changes through merges."
                  : "Create the first table below. Every change you make lands in the tray on the right; commit them as one batch with a message."}
              </p>
            </div>
          )}
          <SchemaEditor base={detail.schema} preview={preview ?? detail.schema} pending={pending} readOnly={readOnly} onAddOp={addOp} />

          <div className="card" style={{ marginTop: 16 }}>
            <h2>History</h2>
            {detail.commits.length === 0 && <p className="muted small">No commits on this branch yet.</p>}
            {detail.commits.map((c) => (
              <div key={c.id} className="commit-item">
                <Link href={`/commits/${c.id}`} className="mono small">
                  {c.id.slice(0, 8)}
                </Link>
                <span>{c.message}</span>
                {c.mergedFrom && <span className="tag accent">merge</span>}
                <span className="muted small">
                  {c.author} · {timeAgo(c.at)} · {c.opCount} op{c.opCount === 1 ? "" : "s"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {!readOnly && (
          <div className="tray">
            <div className="card">
              <h2>Pending changes {pending.length > 0 && `(${pending.length})`}</h2>
              {pending.length === 0 && (
                <p className="muted small" style={{ marginBottom: 0 }}>
                  Edit the schema — every action lands here as one operation. Commit a batch with a message.
                </p>
              )}
              {trayRows.map((row, i) => (
                <div key={i} className="tray-op">
                  <span className={`tag ${row.safety.level}`}>{row.safety.level === "needs_care" ? "care" : row.safety.level === "destructive" ? "drop" : "add"}</span>
                  <span>{row.description}</span>
                </div>
              ))}
              {pending.length > 0 && (
                <form onSubmit={commit} style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  <input
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="what &amp; why (commit message)"
                    required
                    maxLength={300}
                  />
                  <div className="row">
                    <button className="primary" disabled={committing}>
                      {committing ? "Committing…" : `Commit ${pending.length} change${pending.length === 1 ? "" : "s"}`}
                    </button>
                    <button type="button" onClick={() => setPending([])}>
                      Discard
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
