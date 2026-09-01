"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { shortId, timeAgo } from "@/lib/format";

interface DeployStatus {
  target: { id: string; name: string; hasConnection: boolean; deployedCommit: string };
  mainHead: string;
  pendingCommits: number;
  pendingOps: number;
  sql: string;
  preflight: { description: string; safety: { level: string; reason?: string }; author: string; commitId: string }[];
  timeline: { id: string; message: string; author: string; at: string; opCount: number; isDeployed: boolean; isHead: boolean; mergedFrom: string | null }[];
  deployments: {
    id: string;
    status: string;
    fromCommit: string | null;
    toCommit: string;
    errorStatement: string | null;
    errorMessage: string | null;
    triggeredBy: string | null;
    startedAt: string;
    finishedAt: string | null;
  }[];
}

export default function DeployPage() {
  const [status, setStatus] = useState<DeployStatus | null>(null);
  const [banner, setBanner] = useState<{ kind: "error" | "info"; text: string } | null>(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("merged")
      ? { kind: "info", text: "merged into main — the migration below takes the deployed database to the new head" }
      : null
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api
        .get<DeployStatus>("/api/deploy")
        .then(setStatus)
        .catch((err) => {
          if (err instanceof ApiError && err.status !== 401) setBanner({ kind: "error", text: err.message });
        }),
    []
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function act(path: string) {
    if (!status) return;
    setBusy(true);
    setBanner(null);
    try {
      const r = await api.post<{ status: string }>(path, { expectedHead: status.mainHead });
      setBanner(
        r.status === "succeeded"
          ? { kind: "info", text: "deployed — the target database now matches main" }
          : { kind: "info", text: "marked as deployed — the pointer moved to main's head" }
      );
      setAcknowledged(false);
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        const statement = (err.details as { statement?: string } | null)?.statement;
        setBanner({ kind: "error", text: statement ? `${err.message} — failing statement: ${statement}` : err.message });
      } else {
        setBanner({ kind: "error", text: "something went wrong — try again" });
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <div className="page muted">Loading…</div>;

  const needsAck = status.preflight.length > 0;
  const nothingPending = status.pendingCommits === 0;

  return (
    <div className="page">
      <h1>Deploy</h1>
      <p className="muted small" style={{ marginTop: 0 }}>
        Everything merged to main after the <strong>deployed</strong> marker is pending. Deploying runs the whole migration in one
        transaction{status.target.hasConnection ? "" : " — no target database is connected, so run the SQL yourself and mark it deployed"}.
      </p>

      {banner && <div className={banner.kind === "error" ? "error-banner" : "info-banner"}>{banner.text}</div>}

      <div className="card">
        <h2>Main timeline</h2>
        {status.timeline.map((c) => (
          <div key={c.id} className="commit-item">
            <Link href={`/commits/${c.id}`} className="mono small">
              {shortId(c.id)}
            </Link>
            <span>{c.message}</span>
            {c.mergedFrom && <span className="tag accent">merge</span>}
            {c.id === status.target.deployedCommit && <span className="tag additive">deployed</span>}
            {c.isHead && <span className="tag neutral">head</span>}
            {!c.isDeployed && <span className="tag needs_care">pending</span>}
            <span className="muted small" style={{ marginLeft: "auto" }}>
              {c.author} · {timeAgo(c.at)}
            </span>
          </div>
        ))}
      </div>

      {nothingPending ? (
        <div className="card">
          <h2>Nothing to deploy</h2>
          <p className="muted small" style={{ marginBottom: 0 }}>
            The deployed database matches main&apos;s head. Merge a branch and the migration will appear here.
          </p>
        </div>
      ) : (
        <>
          <div className="card">
            <h2>
              Pending migration <span className="muted small">({status.pendingCommits} commit{status.pendingCommits === 1 ? "" : "s"}, {status.pendingOps} operation{status.pendingOps === 1 ? "" : "s"})</span>
            </h2>
            <pre className="sql">{status.sql}</pre>
            <div className="row">
              <button onClick={() => navigator.clipboard.writeText(status.sql)}>Copy SQL</button>
              <a
                className="btn"
                href={`data:application/sql;charset=utf-8,${encodeURIComponent(status.sql)}`}
                download={`migration-${shortId(status.target.deployedCommit)}-${shortId(status.mainHead)}.sql`}
              >
                Download .sql
              </a>
            </div>
          </div>

          {needsAck && (
            <div className="card" style={{ borderLeft: "4px solid var(--amber)" }}>
              <h2>Preflight — review before deploying</h2>
              {status.preflight.map((p, i) => (
                <div key={i} className="change-row">
                  <span className={`tag ${p.safety.level}`}>{p.safety.level.replace("_", " ")}</span>
                  <span className="desc">{p.description}</span>
                  <span className="muted small" style={{ marginLeft: "auto" }}>
                    {p.safety.reason} · {p.author}
                  </span>
                </div>
              ))}
              <label className="row small" style={{ marginTop: 10 }}>
                <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                I&apos;ve reviewed these — they may fail or lose data on a non-empty database
              </label>
            </div>
          )}

          <div className="card row">
            {status.target.hasConnection ? (
              <button className="primary" disabled={busy || (needsAck && !acknowledged)} onClick={() => act("/api/deploy")}>
                {busy ? "Deploying…" : "Deploy to target"}
              </button>
            ) : (
              <span className="muted small">no target connection configured (TARGET_DATABASE_URL)</span>
            )}
            <button disabled={busy || (needsAck && !acknowledged)} onClick={() => act("/api/deploy/mark")}>
              Mark as deployed
            </button>
            <span className="muted small">— use this when you ran the SQL yourself</span>
          </div>
        </>
      )}

      <div className="card">
        <h2>Deployment history</h2>
        {status.deployments.length === 0 && <p className="muted small">No deployments yet.</p>}
        {status.deployments.map((d) => (
          <div key={d.id} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
            <div className="row">
              <span
                className={`tag ${d.status === "succeeded" ? "additive" : d.status === "failed" ? "destructive" : d.status === "manual" ? "accent" : "neutral"}`}
              >
                {d.status}
              </span>
              <span className="mono small">
                {d.fromCommit ? shortId(d.fromCommit) : "∅"} → {shortId(d.toCommit)}
              </span>
              <span className="muted small" style={{ marginLeft: "auto" }}>
                {d.triggeredBy ?? "system"} · {timeAgo(d.startedAt)}
              </span>
            </div>
            {d.status === "failed" && (
              <div className="small" style={{ color: "var(--red)", marginTop: 4 }}>
                {d.errorMessage}
                {d.errorStatement && (
                  <>
                    {" — at: "}
                    <span className="mono">{d.errorStatement}</span>
                  </>
                )}
                <span className="muted"> · everything rolled back; the pointer did not move</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
