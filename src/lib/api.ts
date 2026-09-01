/**
 * Client-side fetch wrapper: JSON in/out, structured errors, and a redirect
 * to /login on 401 so every page gets auth handling for free.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !window.location.pathname.startsWith("/login")) {
      // A hard navigation is intentional: the session is gone, so all client
      // state is stale, and this module has no access to the router.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/login";
    }
    throw new ApiError(
      response.status,
      payload?.code ?? "unknown",
      payload?.message ?? `request failed (${response.status})`,
      payload?.details ?? null
    );
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
};
