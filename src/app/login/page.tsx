"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        await api.post("/api/auth/signup", { email, password, displayName });
      } else {
        await api.post("/api/auth/login", { email, password });
      }
      router.push("/branches");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "something went wrong — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="card">
        <h1>
          Schema<span style={{ color: "var(--accent)" }}>VC</span>
        </h1>
        <p className="muted small" style={{ marginTop: 0 }}>
          Branch, diff, and merge database schemas — semantically.
        </p>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {mode === "signup" && (
            <div className="field">
              <label htmlFor="name">Display name</label>
              <input id="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={60} placeholder="How teammates see you" />
            </div>
          )}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === "signup" ? 8 : 1}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
            />
            {mode === "signup" && <span className="muted small">at least 8 characters</span>}
          </div>
          <button className="primary" disabled={busy}>
            {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
          </button>
        </form>
        <p className="small muted" style={{ marginBottom: 0 }}>
          {mode === "login" ? (
            <>
              New here?{" "}
              <button className="linklike" onClick={() => setMode("signup")}>
                Create an account
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button className="linklike" onClick={() => setMode("login")}>
                Log in
              </button>
            </>
          )}
        </p>
      </div>
      <p className="muted small" style={{ textAlign: "center" }}>
        Everyone on the team shares one schema repository.
      </p>
    </div>
  );
}
