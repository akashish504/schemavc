"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { timeAgo } from "@/lib/format";

interface BranchItem {
  id: string;
  name: string;
  head: string;
  isMain: boolean;
  status: "active" | "archived";
  createdAt: string;
  aheadOfMain: number;
  mainMovedBy: number;
}

export default function BranchesPage() {
  const router = useRouter();
  const [branches, setBranches] = useState<BranchItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [mainHasTables, setMainHasTables] = useState<boolean | null>(null);
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(
    () =>
      api
        .get<{ branches: BranchItem[] }>("/api/branches")
        .then(async (r) => {
          setBranches(r.branches);
          const main = r.branches.find((b) => b.isMain);
          if (main) {
            const detail = await api.get<{ schema: { tables: Record<string, unknown> } }>(`/api/branches/${main.id}`);
            setMainHasTables(Object.keys(detail.schema.tables).length > 0);
          }
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status !== 401) setError(err.message);
        }),
    []
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function createBranch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const r = await api.post<{ id: string }>("/api/branches", { name: newName.trim() });
      router.push(`/branches/${r.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not create the branch");
      setCreating(false);
    }
  }

  async function seed() {
    setSeeding(true);
    setError(null);
    try {
      await api.post("/api/seed");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not load the template");
    } finally {
      setSeeding(false);
    }
  }

  if (!branches) return <div className="page muted">Loading…</div>;

  const main = branches.find((b) => b.isMain);
  const active = branches.filter((b) => !b.isMain && b.status === "active");
  const archived = branches.filter((b) => b.status === "archived");

  return (
    <div className="page">
      <h1>Branches</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        One shared repository. Branch from main, evolve the schema, merge back.
      </p>
      {error && <div className="error-banner">{error}</div>}

      {main && (
        <div className="card">
          <div className="row">
            <Link href={`/branches/${main.id}`} className="mono" style={{ fontWeight: 700, fontSize: 14 }}>
              main
            </Link>
            <span className="tag accent">default</span>
            <span className="spacer" style={{ flex: 1 }} />
            <Link className="btn" href={`/branches/${main.id}`}>
              View schema
            </Link>
          </div>
          {mainHasTables === false && (
            <div className="info-banner" style={{ marginTop: 12, marginBottom: 0 }}>
              <strong>The schema is empty.</strong> Add tables on main directly, or start from a realistic e-commerce
              template (users, products, orders with keys and indexes) to try branching and merging right away.{" "}
              <button className="linklike" onClick={seed} disabled={seeding}>
                {seeding ? "Loading…" : "Load the template"}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>Active branches</h2>
        {active.length === 0 && (
          <p className="muted small">
            No active branches. Create one below — a branch is your isolated copy of the schema on main.
          </p>
        )}
        {active.map((b) => (
          <div key={b.id} className="commit-item">
            <Link href={`/branches/${b.id}`} className="mono" style={{ fontWeight: 600 }}>
              {b.name}
            </Link>
            <span className="muted small">
              {b.aheadOfMain === 0 ? "no changes yet" : `${b.aheadOfMain} commit${b.aheadOfMain === 1 ? "" : "s"} ahead`}
              {b.mainMovedBy > 0 && ` · main moved by ${b.mainMovedBy}`}
            </span>
            <span className="muted small">created {timeAgo(b.createdAt)}</span>
            <span style={{ flex: 1 }} />
            <Link className="small" href={`/branches/${b.id}/compare`}>
              Compare &amp; merge
            </Link>
          </div>
        ))}
        <form onSubmit={createBranch} className="row" style={{ marginTop: 12 }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="feature/orders-status"
            title="lowercase letters, digits, -, _ and /"
            required
            style={{ width: 260 }}
          />
          <button className="primary" disabled={creating}>
            {creating ? "Creating…" : "New branch from main"}
          </button>
        </form>
      </div>

      {archived.length > 0 && (
        <div className="card">
          <h2>
            <button className="linklike" onClick={() => setShowArchived(!showArchived)} style={{ padding: 0, fontWeight: 650 }}>
              {showArchived ? "▾" : "▸"} Merged branches ({archived.length})
            </button>
          </h2>
          {showArchived &&
            archived.map((b) => (
              <div key={b.id} className="commit-item">
                <Link href={`/branches/${b.id}`} className="mono muted">
                  {b.name}
                </Link>
                <span className="tag neutral">merged &amp; archived</span>
                <span className="muted small">created {timeAgo(b.createdAt)}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
