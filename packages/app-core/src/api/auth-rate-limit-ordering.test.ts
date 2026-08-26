/**
 * Failed-auth rate limiter contract for the compat auth boundary: valid
 * credentials are validated BEFORE the limiter may deny and never consume the
 * bucket, so a window exhausted by other traffic's failures cannot 429 a
 * request whose session/token is valid; genuinely failed attempts still
 * throttle and carry a `Retry-After` header once exhausted; and buckets are
 * keyed on the real client behind a trusted (loopback) proxy via the
 * rightmost X-Forwarded-For entry, while direct remote peers keep
 * socket-address keying byte-identical (spoofed XFF from an untrusted peer is
 * ignored). Deterministic harness: synthetic Node req/res objects and a fake
 * in-memory `AuthStore`; no DB, no network.
 */
import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AuthIdentityRow,
  AuthSessionRow,
  AuthStore,
} from "../services/auth-store";
import {
  _resetAuthRateLimiter,
  ensureAuthSessionOrBootstrap,
  ensureCompatApiAuthorized,
  ensureCompatApiAuthorizedAsync,
  getSessionCookieName,
} from "./auth.ts";

const GOOD_SESSION_ID = "good-session";
const IDENTITY_ID = "identity-1";

function makeSessionRow(now: number): AuthSessionRow {
  return {
    id: GOOD_SESSION_ID,
    identityId: IDENTITY_ID,
    kind: "machine",
    createdAt: now - 1000,
    lastSeenAt: now - 1000,
    expiresAt: now + 60 * 60 * 1000,
    rememberDevice: false,
    csrfSecret: "csrf-secret",
    ip: null,
    userAgent: null,
    scopes: [],
    revokedAt: null,
  };
}

function makeIdentityRow(): AuthIdentityRow {
  return {
    id: IDENTITY_ID,
    kind: "machine",
    displayName: "paired-device",
    createdAt: 0,
    passwordHash: null,
    cloudUserId: null,
  };
}

/** In-memory store: only `good-session` resolves; everything else is absent. */
function fakeStore(): AuthStore {
  return {
    findSession: async (id: string, now?: number) =>
      id === GOOD_SESSION_ID ? makeSessionRow(now ?? Date.now()) : null,
    touchSession: async () => undefined,
    findIdentity: async (id: string) =>
      id === IDENTITY_ID ? makeIdentityRow() : null,
  } as unknown as AuthStore;
}

function makeReq(opts: {
  ip: string;
  headers?: http.IncomingHttpHeaders;
  method?: string;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = opts.method ?? "GET";
  req.url = "/api/compat/thing";
  req.headers = { host: "example.test:2138", ...(opts.headers ?? {}) };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: opts.ip,
    configurable: true,
  });
  return req;
}

function fakeRes() {
  const inner = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(inner);
  res.end = ((_chunk?: string | Buffer) => res) as typeof res.end;
  return {
    res,
    status: () => res.statusCode,
    retryAfter: () => res.getHeader("retry-after"),
  };
}

const ENV_KEYS = [
  "ELIZA_API_TOKEN",
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_TRUSTED_PROXY_ADDRS",
] as const;
const savedEnv = new Map<string, string | undefined>();

describe("failed-auth limiter: ordering, keying, Retry-After", () => {
  beforeEach(() => {
    _resetAuthRateLimiter();
    savedEnv.clear();
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetAuthRateLimiter();
  });

  async function failBearer(ip: string, headers?: http.IncomingHttpHeaders) {
    const { res, status, retryAfter } = fakeRes();
    const ok = await ensureCompatApiAuthorizedAsync(
      makeReq({
        ip,
        headers: { authorization: "Bearer bad-session", ...(headers ?? {}) },
      }),
      res,
      { store: fakeStore() },
    );
    return { ok, status: status(), retryAfter: retryAfter() };
  }

  async function validBearer(ip: string, headers?: http.IncomingHttpHeaders) {
    const { res, status } = fakeRes();
    const ok = await ensureCompatApiAuthorizedAsync(
      makeReq({
        ip,
        headers: {
          authorization: `Bearer ${GOOD_SESSION_ID}`,
          ...(headers ?? {}),
        },
      }),
      res,
      { store: fakeStore() },
    );
    return { ok, status: status() };
  }

  it("a valid session bearer passes while the bucket is exhausted by failures", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < 20; i += 1) {
      expect((await failBearer(ip)).status).toBe(401);
    }
    const throttled = await failBearer(ip);
    expect(throttled.status).toBe(429);

    const valid = await validBearer(ip);
    expect(valid.ok).toBe(true);
    expect(valid.status).not.toBe(429);
  });

  it("failed attempts past the window answer 429 with a Retry-After header", async () => {
    const ip = "203.0.113.51";
    for (let i = 0; i < 20; i += 1) await failBearer(ip);
    const throttled = await failBearer(ip);
    expect(throttled.ok).toBe(false);
    expect(throttled.status).toBe(429);
    const retryAfter = Number(throttled.retryAfter);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("successful auth does not consume the failed-attempt bucket", async () => {
    const ip = "203.0.113.52";
    for (let i = 0; i < 19; i += 1) await failBearer(ip);
    for (let i = 0; i < 5; i += 1) {
      expect((await validBearer(ip)).ok).toBe(true);
    }
    // 20th FAILURE is still a 401 — the five successes added nothing.
    expect((await failBearer(ip)).status).toBe(401);
    expect((await failBearer(ip)).status).toBe(429);
  });

  it("keys per real client behind a loopback proxy via rightmost XFF", async () => {
    const clientA = { "x-forwarded-for": "203.0.113.60" };
    const clientB = { "x-forwarded-for": "203.0.113.61" };
    for (let i = 0; i < 20; i += 1) await failBearer("127.0.0.1", clientA);
    expect((await failBearer("127.0.0.1", clientA)).status).toBe(429);

    // Client B behind the SAME proxy socket has its own untouched bucket.
    expect((await failBearer("127.0.0.1", clientB)).status).toBe(401);
    // And client A's valid bearer still passes despite its exhausted bucket.
    expect((await validBearer("127.0.0.1", clientA)).ok).toBe(true);
  });

  it("keeps socket keying for direct remote peers — rotating XFF cannot fragment", async () => {
    const ip = "198.51.100.9";
    for (let i = 0; i < 20; i += 1) {
      await failBearer(ip, { "x-forwarded-for": `10.0.0.${i + 1}` });
    }
    const throttled = await failBearer(ip, {
      "x-forwarded-for": "10.0.0.99",
    });
    expect(throttled.status).toBe(429);
  });

  it("sync token gate: valid token passes an exhausted bucket; failures 429 with Retry-After", () => {
    process.env.ELIZA_API_TOKEN = "configured-token-value";
    const ip = "203.0.113.53";

    const attempt = (authorization: string) => {
      const { res, status, retryAfter } = fakeRes();
      const ok = ensureCompatApiAuthorized(
        makeReq({ ip, headers: { authorization } }),
        res,
      );
      return { ok, status: status(), retryAfter: retryAfter() };
    };

    for (let i = 0; i < 20; i += 1) {
      expect(attempt("Bearer wrong-token").status).toBe(401);
    }
    const throttled = attempt("Bearer wrong-token");
    expect(throttled.status).toBe(429);
    expect(Number(throttled.retryAfter)).toBeGreaterThanOrEqual(1);

    expect(attempt("Bearer configured-token-value").ok).toBe(true);
  });

  it("session-or-bootstrap: cookie holders pass an exhausted bucket; credential-less 429s carry retryAfterSeconds", () => {
    const ip = "203.0.113.70";
    const bare = () => ensureAuthSessionOrBootstrap(makeReq({ ip }));

    for (let i = 0; i < 20; i += 1) {
      expect(bare()).toMatchObject({ kind: "denied", status: 401 });
    }
    const throttled = bare();
    expect(throttled).toMatchObject({ kind: "denied", status: 429 });
    if (throttled.kind === "denied") {
      expect(throttled.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }

    const withCookie = ensureAuthSessionOrBootstrap(
      makeReq({
        ip,
        headers: { cookie: `${getSessionCookieName()}=some-session-id` },
      }),
    );
    expect(withCookie).toMatchObject({
      kind: "session",
      sessionId: "some-session-id",
    });
  });
});
