import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Panel security primitives (spec §13/§15/§16).
 *
 * Three things live here because they must be identical everywhere they are
 * used: the response headers that keep the control plane out of search engines
 * and out of other frames, the CSRF double-submit check for cookie
 * authentication, and the constant-time login path that stops the API from
 * revealing whether a username exists.
 */

/** Headers applied to every API response. */
export const SECURITY_HEADERS: Record<string, string> = {
  // The panel is an internal control plane: never indexable, never framed,
  // never sniffed, and never a referrer source.
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

export const CSRF_COOKIE = "arvoo_csrf";
export const CSRF_HEADER = "x-arvoo-csrf";

export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function csrfTokensMatch(cookieValue: string | undefined, headerValue: string | undefined): boolean {
  if (!cookieValue || !headerValue) return false;
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(headerValue);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutating(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/**
 * A bcrypt hash of a value nobody knows, used only to keep the login path's
 * timing flat when the username does not exist. Without it, a missing user
 * returns visibly faster than a wrong password, which enumerates usernames.
 */
export const LOGIN_TIMING_DUMMY_HASH = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

/**
 * Compare against the dummy hash so the response time does not depend on
 * whether the account exists. Returns always false.
 */
export function burnPasswordComparison(compare: (password: string) => boolean, password: string): false {
  try {
    compare(`${password}:dummy`);
  } catch {
    /* the result is intentionally ignored: this only spends the work */
  }
  return false;
}
