/** Typed fetch client for the Arvoo API. */

export class ApiError extends Error {
  status: number;
  details: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * The API requires the CSRF token on cookie-authenticated state changes, sent
 * as a header that must match the readable cookie set at login. This is the
 * double-submit pattern: another origin can make the browser send the cookie,
 * but it cannot read the cookie to forge the header.
 */
function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)arvoo_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : "";
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (MUTATING.has(method)) headers["x-arvoo-csrf"] = csrfToken();

  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: "include",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/auth/")) {
    // Session expired: hard-redirect keeps state clean.
    window.location.href = "/login";
    throw new ApiError(401, "Session expired");
  }
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const err = (data as { error?: { message?: string; details?: unknown } })?.error;
    throw new ApiError(res.status, err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

export function downloadText(filename: string, text: string, mime = "text/plain"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
