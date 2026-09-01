"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import type { Conflict, MergeResult } from "@/core/merge";
import { api, ApiError } from "@/lib/api";
import { shortId, timeAgo } from "@/lib/format";

interface CompareResponse {
  branch: { id: string; name: string };
  mainHead: string;
  forkedAt: string;
  mainMovedBy: number;
  result: MergeResult;
  deployedMainCommits: string[];
}

type Choice = "main" | "yours" | "keep_one";

export default function ComparePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [data, setData] = useState<CompareResponse | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, Choice>>({});
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [merging, setMerging] = useState(false);

  const recompute = useCallback(
    async (withResolutions: Record<string, Choice>) => {
      setBusy(true);
      try {
        const r = await api.post<CompareResponse>(`/api/branches/${id}/compare`, {
          resolutions: Object.entries(withResolutions).map(([conflictId, choice]) => ({ conflictId, choice })),
        });
        setData(r);
        if (r.result.status !== "error") {
          // Drop resolutions whose conflicts no longer exist (main moved, or a
          // resolution dissolved a downstream conflict).
          const alive = new Set(r.result.conflicts.map((c) => c.id));
          const kept = Object.fromEntries(Object.entries(withResolutions).filter(([cid]) => alive.has(cid)));
          if (Object.keys(kept).length !== Object.keys(withResolutions).length) setResolutions(kept);
        }
        return r;
      } catch (err) {
        if (err instanceof ApiError && err.status !== 401) setBanner(err.message);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [id]
  );

  useEffect(() => {
    void api
      .post<CompareResponse>(`/api/branches/${id}/compare`, { resolutions: [] })
      .then(setData)
      .catch((err) => {
        if (err instanceof ApiError && err.status !== 401) setBanner(err.message);
      });
  }, [id]);

  async function applyResolution(conflictId: string, choice: Choice) {
    const next = { ...resolutions, [conflictId]: choice };
    setResolutions(next);
    await recompute(next);
  }

  async function reopen(conflictId: string) {
    const next = { ...resolutions };
    delete next[conflictId];
    setResolutions(next);
    await recompute(next);
  }

  async function submitMerge() {
    if (!data) return;
    setMerging(true);
    setBanner(null);
    try {
      await api.post(`/api/branches/${id}/merge`, {
        resolutions: Object.entries(resolutions).map(([conflictId, choice]) => ({ conflictId, choice })),
        expectedMainHead: data.mainHead,
        acknowledgedAdvisories: [...acknowledged],
      });
      router.push("/deploy?merged=1");
    } catch (err) {
      if (err instanceof ApiError && err.code === "main_moved") {
        setBanner("main changed while you were resolving — the comparison has been refreshed; resolutions that still apply were kept");
        await recompute(resolutions);
      } else {
        setBanner(err instanceof ApiError ? err.message : "merge failed — try again");
      }
      setMerging(false);
    }
  }

  if (!data) return <div className="page muted">{banner ?? "Computing merge…"}</div>;
  if (data.result.status === "error")
    return (
      <div className="page">
        <div className="error-banner">internal merge error: {data.result.error}</div>
      </div>
    );

  const { result } = data;
  const blocking = result.conflicts.filter((c) => c.severity !== "advisory");
  const advisories = result.conflicts.filter((c) => c.severity === "advisory");
  const unresolved = blocking.filter((c) => !resolutions[c.id]);
  const unacknowledged = advisories.filter((a) => !acknowledged.has(a.id));
  const canMerge = unresolved.length === 0 && unacknowledged.length === 0 && result.status === "clean";
  const disabledReason =
    unresolved.length > 0
      ? `Resolve ${unresolved.length} conflict${unresolved.length === 1 ? "" : "s"} to enable`
      : unacknowledged.length > 0
        ? `Acknowledge ${unacknowledged.length} warning${unacknowledged.length === 1 ? "" : "s"} to enable`
        : null;

  return (
    <div className="page">
      <div className="row">
        <h1>
          <span className="mono">{data.branch.name}</span> <span className="muted">→</span> <span className="mono">main</span>
        </h1>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        forked {timeAgo(data.forkedAt)} ·{" "}
        {data.mainMovedBy > 0 ? `main moved by ${data.mainMovedBy} commit${data.mainMovedBy === 1 ? "" : "s"} since` : "main has not changed since you forked"}
        {" · "}
        <Link href={`/branches/${id}`}>back to the branch</Link>
      </p>

      {banner && <div className="info-banner">{banner}</div>}

      <div className="counter-strip" style={{ marginBottom: 16 }}>
        <Counter label="your changes" value={result.summary.totalChanges} />
        <Counter label="auto-merge" value={result.changes.filter((c) => c.included).length} tone="green" />
        <Counter label="conflicts" value={blocking.length} tone={blocking.length > 0 ? "red" : undefined} />
        <Counter label="warnings" value={advisories.length} tone={advisories.length > 0 ? "amber" : undefined} />
      </div>

      {blocking.length > 0 && (
        <>
          <h2>Conflicts</h2>
          {blocking.map((conflict) => (
            <ConflictCard
              key={conflict.id}
              conflict={conflict}
              choice={resolutions[conflict.id]}
              deployedMainCommits={data.deployedMainCommits}
              busy={busy}
              onApply={(choice) => applyResolution(conflict.id, choice)}
              onReopen={() => reopen(conflict.id)}
            />
          ))}
        </>
      )}

      {advisories.length > 0 && (
        <>
          <h2>Warnings</h2>
          {advisories.map((a) => (
            <div key={a.id} className="conflict-card advisory">
              <p style={{ margin: "0 0 8px" }}>{a.explanation}</p>
              <label className="row small" style={{ marginBottom: 0 }}>
                <input
                  type="checkbox"
                  checked={acknowledged.has(a.id)}
                  onChange={(e) => {
                    const next = new Set(acknowledged);
                    if (e.target.checked) next.add(a.id);
                    else next.delete(a.id);
                    setAcknowledged(next);
                  }}
                />
                I&apos;ve reviewed this — merge anyway
              </label>
            </div>
          ))}
        </>
      )}

      <h2>Your changes</h2>
      <div className="card">
        {result.changes.length === 0 && <p className="muted small">This branch has no changes yet.</p>}
        {result.changes.map((change, i) => (
          <div key={i} className={`change-row ${change.included ? "" : "excluded"}`}>
            <span className={`tag ${change.tag.level}`}>{change.tag.level.replace("_", " ")}</span>
            <span className="desc">{change.ref.description}</span>
            {!change.included && <span className="tag neutral">dropped by resolution</span>}
            <span style={{ flex: 1 }} />
            <span className="muted small">
              {change.ref.author} · {shortId(change.ref.commitId)}
            </span>
          </div>
        ))}
        {result.changes.some((c) => c.tag.level !== "additive" && c.included) && (
          <p className="muted small" style={{ marginBottom: 0 }}>
            {"Tags describe risk to row data when the migration runs on a real database — "}
            <span className="tag needs_care">needs care</span> can fail on existing rows, <span className="tag destructive">destructive</span>{" "}
            loses data or objects.
          </p>
        )}
      </div>

      <div className="card row">
        <button className="primary" disabled={!canMerge || merging || busy} onClick={submitMerge}>
          {merging ? "Merging…" : "Merge into main"}
        </button>
        {disabledReason && <span className="muted small">{disabledReason}</span>}
        {canMerge && (
          <span className="muted small">
            merging writes one merge commit on main and archives this branch — the migration SQL is on the deploy page after
          </span>
        )}
      </div>
    </div>
  );
}

function Counter({ label, value, tone }: { label: string; value: number; tone?: "green" | "red" | "amber" }) {
  const color = tone === "green" ? "var(--green)" : tone === "red" ? "var(--red)" : tone === "amber" ? "var(--amber)" : undefined;
  return (
    <div className="counter">
      <div className="num" style={{ color }}>
        {value}
      </div>
      <div className="muted small">{label}</div>
    </div>
  );
}

function ConflictCard({
  conflict,
  choice,
  deployedMainCommits,
  busy,
  onApply,
  onReopen,
}: {
  conflict: Conflict;
  choice: Choice | undefined;
  deployedMainCommits: string[];
  busy: boolean;
  onApply: (choice: Choice) => void;
  onReopen: () => void;
}) {
  const [selected, setSelected] = useState<Choice | null>(null);
  const resolved = choice !== undefined;
  const mainIsDeployed = conflict.mainRefs.some((r) => deployedMainCommits.includes(r.commitId));

  if (resolved) {
    const option = conflict.options.find((o) => o.choice === choice);
    return (
      <div className="conflict-card resolved">
        <div className="row">
          <span className="tag additive">resolved</span>
          <span>
            {option?.label ?? choice} — <span className="muted">{conflict.explanation}</span>
          </span>
          <span style={{ flex: 1 }} />
          <button className="linklike small" onClick={onReopen} disabled={busy}>
            reopen
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="conflict-card">
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="tag destructive">{conflict.severity === "hard" ? "conflict" : "clashes when combined"}</span>
        <span className="muted small">{conflict.rule.replace(/_/g, " ")}</span>
      </div>
      <p style={{ margin: "0 0 4px" }}>{conflict.explanation}</p>
      {conflict.options.map((option) => (
        <label key={option.choice} className={`conflict-option ${selected === option.choice ? "selected" : ""}`}>
          <input
            type="radio"
            name={`conflict-${conflict.id}`}
            checked={selected === option.choice}
            onChange={() => setSelected(option.choice)}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>{option.label}</strong>
            <br />
            <span className="muted small">{option.consequence}</span>
            {option.choice === "yours" && mainIsDeployed && (
              <>
                <br />
                <span className="small" style={{ color: "var(--amber)" }}>
                  main&apos;s change is already deployed — reversing it recreates objects empty; any data they held is not restored
                </span>
              </>
            )}
          </span>
        </label>
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" disabled={selected === null || busy} onClick={() => selected && onApply(selected)}>
          Apply
        </button>
        <span className="muted small">applying re-checks the merged schema — new clashes surface here if they appear</span>
      </div>
    </div>
  );
}
