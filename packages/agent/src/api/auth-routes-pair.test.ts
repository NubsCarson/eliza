/**
 * Unit test for `POST /api/auth/pair` raw-token acceptance (W1-038): the
 * static API token doubles as a pairing code only for trusted loopback
 * operators — remote callers must present the rotating pairing code, so a
 * weak human-chosen `ELIZA_API_TOKEN` is no longer an online-guessing oracle
 * for anyone who can reach the port. The trusted-local classifier is mocked
 * so the test drives both trust decisions deterministically.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthorized: vi.fn(),
  isTrustedLocalRequest: vi.fn(),
}));

vi.mock("./server-helpers-auth.ts", () => ({
  isAuthorized: mocks.isAuthorized,
  isTrustedLocalRequest: mocks.isTrustedLocalRequest,
  resolveBoundaryRole: (req: unknown) =>
    mocks.isAuthorized(req) ? "OWNER" : "GUEST",
}));

import { type AuthRouteContext, handleAuthRoutes } from "./auth-routes.ts";

const API_TOKEN = "pair-test-static-api-token";
const PAIRING_CODE = "ABCD-EFGH";
const ENV_KEYS = [
  "ELIZA_API_TOKEN",
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
] as const;
const savedEnv = new Map<string, string | undefined>();

function saveEnv(): void {
  savedEnv.clear();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function mkCtx(code: string): {
  ctx: AuthRouteContext;
  captured: { body?: unknown; status?: number };
  clearPairing: ReturnType<typeof vi.fn>;
} {
  const captured: { body?: unknown; status?: number } = {};
  const clearPairing = vi.fn();
  const ctx = {
    req: {
      method: "POST",
      url: "/api/auth/pair",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    },
    res: {},
    method: "POST",
    pathname: "/api/auth/pair",
    readJsonBody: async () => ({ code }),
    json: (_res: unknown, body: unknown, status?: number) => {
      captured.body = body;
      captured.status = status ?? 200;
    },
    error: (_res: unknown, message: string, status?: number) => {
      captured.body = { error: message };
      captured.status = status ?? 500;
    },
    pairingEnabled: () => true,
    ensurePairingCode: () => PAIRING_CODE,
    normalizePairingCode: (c: string) =>
      c.replace(/[^a-zA-Z0-9]/g, "").toUpperCase(),
    rateLimitPairing: () => true,
    getPairingExpiresAt: () => Date.now() + 60_000,
    clearPairing,
  } as unknown as AuthRouteContext;
  return { ctx, captured, clearPairing };
}

describe("POST /api/auth/pair raw-token acceptance (W1-038)", () => {
  afterEach(() => {
    restoreEnv();
    vi.clearAllMocks();
  });

  it("accepts the raw API token from a trusted loopback operator", async () => {
    saveEnv();
    process.env.ELIZA_API_TOKEN = API_TOKEN;
    delete process.env.ELIZA_API_AUTH_TOKEN;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    mocks.isTrustedLocalRequest.mockReturnValue(true);

    const { ctx, captured } = mkCtx(API_TOKEN);
    expect(await handleAuthRoutes(ctx)).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ token: API_TOKEN });
  });

  it("rejects the raw API token from a remote caller", async () => {
    saveEnv();
    process.env.ELIZA_API_TOKEN = API_TOKEN;
    delete process.env.ELIZA_API_AUTH_TOKEN;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    mocks.isTrustedLocalRequest.mockReturnValue(false);

    const { ctx, captured, clearPairing } = mkCtx(API_TOKEN);
    expect(await handleAuthRoutes(ctx)).toBe(true);
    expect(captured.status).toBe(403);
    expect(captured.body).toEqual({ error: "Invalid pairing code" });
    expect(clearPairing).not.toHaveBeenCalled();
  });

  it("still accepts the rotating pairing code from a remote caller", async () => {
    saveEnv();
    process.env.ELIZA_API_TOKEN = API_TOKEN;
    delete process.env.ELIZA_API_AUTH_TOKEN;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    mocks.isTrustedLocalRequest.mockReturnValue(false);

    const { ctx, captured, clearPairing } = mkCtx(PAIRING_CODE);
    expect(await handleAuthRoutes(ctx)).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ token: API_TOKEN });
    expect(clearPairing).toHaveBeenCalled();
  });
});

describe("POST /api/auth/pair rate-limit keying + Retry-After", () => {
  afterEach(() => {
    restoreEnv();
    vi.clearAllMocks();
  });

  function remoteEnv(): void {
    saveEnv();
    process.env.ELIZA_API_TOKEN = API_TOKEN;
    delete process.env.ELIZA_API_AUTH_TOKEN;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    mocks.isTrustedLocalRequest.mockReturnValue(false);
  }

  it("keys the limiter on the rightmost XFF entry behind a loopback proxy and sets Retry-After on 429", async () => {
    remoteEnv();
    const { ctx, captured } = mkCtx("WRNG-CODE");
    const rateLimitPairing = vi.fn().mockReturnValue(false);
    const setHeader = vi.fn();
    const mutable = ctx as unknown as {
      req: {
        socket: { remoteAddress: string };
        headers: Record<string, string>;
      };
      res: { setHeader: typeof setHeader; headersSent: boolean };
      rateLimitPairing: typeof rateLimitPairing;
      pairingRetryAfterSeconds: (ip: string | null) => number;
    };
    mutable.req.socket.remoteAddress = "127.0.0.1";
    mutable.req.headers["x-forwarded-for"] = "10.9.9.9, 203.0.113.77";
    mutable.res = { setHeader, headersSent: false };
    mutable.rateLimitPairing = rateLimitPairing;
    mutable.pairingRetryAfterSeconds = () => 42;

    expect(await handleAuthRoutes(ctx)).toBe(true);
    expect(rateLimitPairing).toHaveBeenCalledWith("203.0.113.77");
    expect(setHeader).toHaveBeenCalledWith("retry-after", "42");
    expect(captured.status).toBe(429);
  });

  it("keeps socket keying for a direct remote peer despite a spoofed XFF header", async () => {
    remoteEnv();
    const { ctx } = mkCtx(PAIRING_CODE);
    const rateLimitPairing = vi.fn().mockReturnValue(true);
    const mutable = ctx as unknown as {
      req: {
        socket: { remoteAddress: string };
        headers: Record<string, string>;
      };
      rateLimitPairing: typeof rateLimitPairing;
    };
    mutable.req.socket.remoteAddress = "198.51.100.9";
    mutable.req.headers["x-forwarded-for"] = "10.0.0.1";
    mutable.rateLimitPairing = rateLimitPairing;

    expect(await handleAuthRoutes(ctx)).toBe(true);
    expect(rateLimitPairing).toHaveBeenCalledWith("198.51.100.9");
  });

  it("throttles without crashing when the context provides no retry-after resolver", async () => {
    remoteEnv();
    const { ctx, captured } = mkCtx("WRNG-CODE");
    const mutable = ctx as unknown as {
      rateLimitPairing: (ip: string | null) => boolean;
    };
    mutable.rateLimitPairing = () => false;

    expect(await handleAuthRoutes(ctx)).toBe(true);
    expect(captured.status).toBe(429);
  });
});
