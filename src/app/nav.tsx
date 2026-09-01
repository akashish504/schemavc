"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface User {
  id: string;
  email: string;
  displayName: string;
}

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const onLogin = pathname.startsWith("/login");

  useEffect(() => {
    if (onLogin) return;
    api
      .get<{ user: User }>("/api/auth/me")
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, [pathname, onLogin]);

  if (onLogin) return null;

  async function logout() {
    await api.post("/api/auth/logout");
    router.push("/login");
  }

  return (
    <div className="topnav">
      <div className="topnav-inner">
        <Link href="/branches" className="brand">
          Schema<span>VC</span>
        </Link>
        <Link href="/branches" className="nav-link">
          Branches
        </Link>
        <Link href="/deploy" className="nav-link">
          Deploy
        </Link>
        <div className="spacer" />
        {user && (
          <>
            <span className="who">{user.displayName}</span>
            <button className="linklike" onClick={logout}>
              Log out
            </button>
          </>
        )}
      </div>
    </div>
  );
}
