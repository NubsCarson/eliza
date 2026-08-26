/**
 * firstRunProvider composition-cost contract: on a completed install the
 * provider answers from one lifecycle-cache read and never touches role
 * resolution — the ordering that keeps this always-on, never-cached
 * (owner-exclusive) provider cheap on every compose pass. Deterministic fake
 * runtime; no database or model.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { firstRunProvider } from "./first-run.js";

const FIRST_RUN_CACHE_KEY = "eliza:lifeops:first-run:v1";

function makeMessage(): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000b1",
    entityId: "00000000-0000-0000-0000-0000000000c1",
    roomId: "00000000-0000-0000-0000-0000000000d1",
    content: { text: "go home", channelType: ChannelType.DM },
  } as unknown as Memory;
}

/**
 * A runtime that serves ONLY the lifecycle cache; any other property access
 * throws, so the test proves the completed fast path performs no role lookup,
 * room read, or other runtime work.
 */
function cacheOnlyRuntime(record: unknown): IAgentRuntime {
  const allowed: Record<string, unknown> = {
    getCache: async (key: string) =>
      key === FIRST_RUN_CACHE_KEY ? record : undefined,
    setCache: async () => true,
    deleteCache: async () => true,
  };
  return new Proxy(allowed, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === "then" || typeof prop === "symbol") return undefined;
      throw new Error(
        `firstRunProvider touched runtime.${String(prop)} on the completed fast path`,
      );
    },
  }) as unknown as IAgentRuntime;
}

describe("firstRunProvider — completed installs stay one cache read", () => {
  it("goes quiet on a complete record without any role resolution", async () => {
    const runtime = cacheOnlyRuntime({
      status: "complete",
      partialAnswers: {},
      completionCount: 1,
      completedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await firstRunProvider.get(
      runtime,
      makeMessage(),
      {} as State,
    );

    expect(result.text).toBe("");
    expect(result.values).toEqual({ firstRunPending: false });
  });

  it("goes quiet when the lifecycle read fails, still without role resolution", async () => {
    const runtime = cacheOnlyRuntime(undefined);
    (runtime as unknown as Record<string, unknown>).getCache = async () => {
      throw new Error("cache offline");
    };

    const result = await firstRunProvider.get(
      runtime,
      makeMessage(),
      {} as State,
    );

    expect(result.values).toEqual({ firstRunPending: false });
  });
});
