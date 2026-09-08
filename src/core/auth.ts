import { getConfig } from "./config.ts";

/**
 * The session, in full: a signed cookie and nothing else. No table, no store,
 * no revocation — ADR 12, and `specs/003-auth-app-shell/contracts/session-cookie.md`,
 * which this file implements literally.
 *
 * Signing runs on Web Crypto rather than `node:crypto` so the same primitive
 * serves the request guard (`src/proxy.ts`) and the Node-side services with no
 * runtime assumption to get wrong. That is why `sign`/`verify` are async.
 */

export type UserRole = "broker" | "salesManager";

export interface SessionPayload {
  userId: string;
  agencyId: string;
  role: UserRole;
  /** Epoch seconds. Diagnostics only — nothing branches on it. */
  issuedAt: number;
  /** Epoch seconds. `verify` rejects anything at or past this. */
  expiresAt: number;
}

export const SESSION_COOKIE = "session";

export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Options every write of the cookie uses — set and clear alike. */
export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: getConfig().NODE_ENV !== "development",
    path: "/",
  };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

let cachedKey: { secret: string; key: Promise<CryptoKey> } | undefined;

function signingKey(): Promise<CryptoKey> {
  const secret = getConfig().AUTH_SECRET;
  // Re-imported only when the secret itself changes, which outside tests is
  // never — importKey is cheap but it is not free per request.
  if (cachedKey?.secret !== secret) {
    cachedKey = {
      secret,
      key: globalThis.crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    };
  }
  return cachedKey.key;
}

/** Builds the payload for a user who has just proven who they are. */
export function newSession(
  user: { userId: string; agencyId: string; role: UserRole },
  now = Date.now(),
): SessionPayload {
  const issuedAt = Math.floor(now / 1000);
  return { ...user, issuedAt, expiresAt: issuedAt + SESSION_MAX_AGE_SECONDS };
}

export async function sign(payload: SessionPayload): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    await signingKey(),
    body as unknown as ArrayBuffer,
  );
  return `${toBase64Url(body)}.${toBase64Url(new Uint8Array(signature))}`;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.userId === "string" &&
    candidate.userId !== "" &&
    typeof candidate.agencyId === "string" &&
    candidate.agencyId !== "" &&
    (candidate.role === "broker" || candidate.role === "salesManager") &&
    typeof candidate.issuedAt === "number" &&
    typeof candidate.expiresAt === "number"
  );
}

/**
 * `null` — never a throw — for every failure: absent, malformed, unsigned,
 * tampered, incomplete, expired. Callers read `null` as "unauthenticated",
 * so a bug here fails closed rather than open.
 */
export async function verify(cookieValue: string | undefined): Promise<SessionPayload | null> {
  if (!cookieValue) return null;
  try {
    const [encodedBody, encodedSignature, ...rest] = cookieValue.split(".");
    if (!encodedBody || !encodedSignature || rest.length > 0) return null;

    const body = fromBase64Url(encodedBody);
    const valid = await globalThis.crypto.subtle.verify(
      "HMAC",
      await signingKey(),
      fromBase64Url(encodedSignature) as unknown as ArrayBuffer,
      body as unknown as ArrayBuffer,
    );
    if (!valid) return null;

    const payload: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!isSessionPayload(payload)) return null;
    if (payload.expiresAt * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request-bound helpers (Server Components, Server Actions)
// ---------------------------------------------------------------------------

/**
 * `next/headers` is imported lazily, not at module scope: everything above
 * this line is plain crypto that `node --test` must be able to import without
 * a Next.js request context, and a static import would drag one in.
 */
async function cookieStore() {
  const { cookies } = await import("next/headers");
  return cookies();
}

/** The decoded session of the current request, or `null`. No database round trip. */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookieStore();
  return verify(store.get(SESSION_COOKIE)?.value);
}

export async function setSessionCookie(payload: SessionPayload): Promise<void> {
  const store = await cookieStore();
  store.set(SESSION_COOKIE, await sign(payload), {
    ...sessionCookieOptions(),
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/**
 * Logout. There is no server-side session to invalidate (spec.md
 * clarifications), so this overwrites the cookie with an already-expired one.
 *
 * Async only because Next 16's `cookies()` is; no crypto is involved.
 */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookieStore();
  store.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
}
