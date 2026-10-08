import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtSecret, config, cookiesSecure } from "../config.js";
import { unauthorized, forbidden } from "./errors.js";
import { CSRF_COOKIE, csrfTokensMatch, isMutating, newCsrfToken } from "./security.js";
import type { UserRole } from "@arvoo/shared";

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
}

/**
 * Session lifecycle (spec §16).
 *
 * Two clocks are enforced, both from inside the token:
 *   iat  — when this session last rotated; the idle window is measured from it
 *   abs  — the first authentication time; the absolute lifetime is measured
 *          from it, so refreshing can extend activity but never the session.
 *
 * Refresh means "sign a new token for the same user", which also rotates the
 * session id: a stolen token that is refreshed by its owner stops working for
 * the thief once the window closes.
 */
interface SessionClaims extends AuthUser {
  iat: number;
  abs: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function signSession(user: AuthUser, absoluteStart?: number): string {
  const issuedAt = nowSec();
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, abs: absoluteStart ?? issuedAt },
    jwtSecret(),
    { expiresIn: config.jwtTtlSec },
  );
}

export function verifySessionToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, jwtSecret()) as {
      sub: string;
      username: string;
      role: UserRole;
      iat?: number;
      abs?: number;
    };
    // A token that carries no issue time cannot prove either clock, so it is
    // refused rather than trusted. Every token this service signs has one.
    if (typeof payload.iat !== "number" || payload.iat <= 0) return null;
    const issuedAt = payload.iat;
    const absoluteStart = typeof payload.abs === "number" && payload.abs > 0 ? payload.abs : issuedAt;

    // Absolute lifetime, independent of refreshes.
    if (nowSec() - absoluteStart > config.jwtTtlSec) return null;
    // Idle window, measured from the last rotation.
    if (nowSec() - issuedAt > config.sessionIdleSec) return null;

    return { id: payload.sub, username: payload.username, role: payload.role };
  } catch {
    return null;
  }
}

/** Remaining idle seconds for a token, so the client can refresh in time. */
export function sessionRemainingSec(token: string): number | null {
  try {
    const payload = jwt.decode(token) as { iat?: number } | null;
    if (!payload?.iat) return null;
    return Math.max(0, config.sessionIdleSec - (nowSec() - payload.iat));
  } catch {
    return null;
  }
}

/** Refresh a still-valid session, keeping its original absolute start time. */
export function refreshSession(token: string): string | null {
  try {
    const payload = jwt.verify(token, jwtSecret()) as {
      sub: string;
      username: string;
      role: UserRole;
      iat?: number;
      abs?: number;
    };
    if (typeof payload.iat !== "number" || payload.iat <= 0) return null;
    const user: AuthUser = { id: payload.sub, username: payload.username, role: payload.role };
    const issuedAt = payload.iat;
    const absoluteStart = typeof payload.abs === "number" && payload.abs > 0 ? payload.abs : issuedAt;
    if (nowSec() - absoluteStart > config.jwtTtlSec) return null;
    if (nowSec() - issuedAt > config.sessionIdleSec) return null;
    return signSession(user, absoluteStart);
  } catch {
    return null;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
}

const ROLE_RANK: Record<UserRole, number> = { viewer: 1, operator: 2, admin: 3 };

function tokenFrom(request: FastifyRequest): { token: string; fromCookie: boolean } | null {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return { token: header.slice(7), fromCookie: false };
  if (request.cookies?.arvoo_session) return { token: request.cookies.arvoo_session, fromCookie: true };
  return null;
}

export function requireAuth(request: FastifyRequest): AuthUser {
  const found = tokenFrom(request);
  if (!found) throw unauthorized();
  const user = verifySessionToken(found.token);
  if (!user) throw unauthorized("Session is invalid or expired");

  // Cookie-authenticated state changes must prove they came from the panel and
  // not from another origin that the browser happens to trust (spec §16).
  if (found.fromCookie && isMutating(request.method)) {
    const cookieToken = request.cookies?.[CSRF_COOKIE];
    const headerToken = request.headers["x-arvoo-csrf"];
    const headerValue = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    if (!csrfTokensMatch(cookieToken, headerValue)) {
      throw forbidden("CSRF check failed: reload the panel and sign in again");
    }
  }
  return user;
}

export function requireRole(min: UserRole) {
  return (request: FastifyRequest): AuthUser => {
    const user = requireAuth(request);
    if (ROLE_RANK[user.role] < ROLE_RANK[min]) throw forbidden();
    return user;
  };
}

export function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string): void {
  reply.setCookie("arvoo_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: cookiesSecure(request.protocol),
    path: "/",
    maxAge: config.jwtTtlSec,
  });
}

/** Issue the CSRF token the panel echoes back in the x-arvoo-csrf header. */
export function setCsrfCookie(request: FastifyRequest, reply: FastifyReply): string {
  const token = newCsrfToken();
  reply.setCookie(CSRF_COOKIE, token, {
    httpOnly: false, // the panel must be able to read it and echo it back
    sameSite: "strict",
    secure: cookiesSecure(request.protocol),
    path: "/",
    maxAge: config.jwtTtlSec,
  });
  return token;
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie("arvoo_session", { path: "/" });
  reply.clearCookie(CSRF_COOKIE, { path: "/" });
}

export { newCsrfToken };
