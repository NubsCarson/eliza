/**
 * State-composition tests for owner-exclusive providers, including explicit
 * onlyInclude requests and same-message cache reuse after audience changes.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import { TurnAbortedError } from "../runtime/turn-controller";
import { attestDeliveryAudienceFromCanonicalRoom } from "../security";
import { runWithStreamingContext } from "../streaming-context";
import type { Character, Memory, Provider, UUID } from "../types";
import { ChannelType } from "../types";

const OWNER = "11111111-1111-1111-1111-111111111111" as UUID;
const ROOM = "22222222-2222-2222-2222-222222222222" as UUID;
const GUEST = "33333333-3333-3333-3333-333333333333" as UUID;

function message(runtime: AgentRuntime, id: UUID): Memory {
	return {
		id,
		entityId: OWNER,
		agentId: runtime.agentId,
		roomId: ROOM,
		content: { text: "private context", source: "discord" },
	};
}

function runtimeHarness(): {
	runtime: AgentRuntime;
	setParticipants: (participants: UUID[]) => void;
} {
	const runtime = new AgentRuntime({
		character: { name: "owner-private-provider-test" } as Character,
		settings: { ELIZA_ADMIN_ENTITY_ID: OWNER },
	});
	let participants = [OWNER, runtime.agentId];
	vi.spyOn(runtime, "getRoom").mockResolvedValue({
		id: ROOM,
		agentId: runtime.agentId,
		source: "discord",
		type: ChannelType.DM,
	});
	vi.spyOn(runtime, "getParticipantsForRoom").mockImplementation(async () => [
		...participants,
	]);
	return {
		runtime,
		setParticipants: (next) => {
			participants = next;
		},
	};
}

describe("composeState owner-exclusive providers", () => {
	it("does not let onlyInclude expose an unattested sensitive provider", async () => {
		const { runtime } = runtimeHarness();
		const get = vi.fn(async () => ({ text: "PRIVATE_PROVIDER_CANARY" }));
		const provider: Provider = {
			name: "PRIVATE",
			disclosureGate: { require: "owner_exclusive" },
			get,
		};
		runtime.registerProvider(provider);

		const state = await runtime.composeState(
			message(runtime, "44444444-4444-4444-4444-444444444444" as UUID),
			["PRIVATE"],
			true,
			true,
		);

		expect(get).not.toHaveBeenCalled();
		expect(state.text).not.toContain("PRIVATE_PROVIDER_CANARY");
		// Denial UX: the suppression is explicit in the composed state, so the
		// model can say the surface is unavailable instead of ignoring it.
		expect(state.text).toContain("Owner-private access notice");
		expect(state.text).toContain("missing_attestation");
	});

	it("never caches sensitive state and revalidates the same message", async () => {
		const { runtime, setParticipants } = runtimeHarness();
		const get = vi.fn(async () => ({ text: "PRIVATE_PROVIDER_CANARY" }));
		runtime.registerProvider({
			name: "PRIVATE",
			disclosureGate: { require: "owner_exclusive" },
			cacheStable: true,
			get,
		});
		const turn = message(
			runtime,
			"55555555-5555-5555-5555-555555555555" as UUID,
		);
		await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);

		const first = await runtime.composeState(turn, ["PRIVATE"], true, true);
		expect(first.text).toContain("PRIVATE_PROVIDER_CANARY");
		expect(get).toHaveBeenCalledTimes(1);
		expect(runtime.stateCache.has(turn.id as string)).toBe(false);

		setParticipants([OWNER, runtime.agentId, GUEST]);
		const second = await runtime.composeState(turn, ["PRIVATE"], true, true);
		expect(second.text).not.toContain("PRIVATE_PROVIDER_CANARY");
		expect(get).toHaveBeenCalledTimes(1);
		expect(second.text).toContain("Owner-private access notice");
		expect(second.text).toContain("audience_changed");
	});

	it("reuses public AND private providers across a same-turn refresh recompose", async () => {
		const { runtime } = runtimeHarness();
		const publicGet = vi.fn(async () => ({ text: "PUBLIC_PROVIDER_CANARY" }));
		const privateGet = vi.fn(async () => ({ text: "PRIVATE_PROVIDER_CANARY" }));
		runtime.registerProvider({ name: "PUBLIC", get: publicGet });
		runtime.registerProvider({
			name: "PRIVATE",
			disclosureGate: { require: "owner_exclusive" },
			get: privateGet,
		});
		const turn = message(
			runtime,
			"66666666-6666-6666-6666-666666666666" as UUID,
		);
		await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);

		const first = await runtime.composeState(
			turn,
			["PUBLIC", "PRIVATE"],
			true,
			false,
			[],
		);
		const second = await runtime.composeState(
			turn,
			["PUBLIC", "PRIVATE"],
			true,
			false,
			[],
		);

		expect(first.text).toContain("PUBLIC_PROVIDER_CANARY");
		expect(first.text).toContain("PRIVATE_PROVIDER_CANARY");
		expect(second.text).toContain("PUBLIC_PROVIDER_CANARY");
		expect(second.text).toContain("PRIVATE_PROVIDER_CANARY");
		expect(publicGet).toHaveBeenCalledTimes(1);
		// Same Memory object, unchanged text, identical audience key, and a
		// refresh-style recompose that did not name the provider: the sensitive
		// result is reused from the same-turn cache instead of re-running
		// (observed live: firstRun re-ran at 1.5s on the planner recompose).
		// The mixed state still never enters stateCache.
		expect(privateGet).toHaveBeenCalledTimes(1);
		expect(runtime.stateCache.has(turn.id as string)).toBe(false);
	});

	it("re-runs a sensitive provider when the refresh recompose names it", async () => {
		const { runtime } = runtimeHarness();
		const privateGet = vi.fn(async () => ({ text: "PRIVATE_PROVIDER_CANARY" }));
		runtime.registerProvider({
			name: "PRIVATE",
			disclosureGate: { require: "owner_exclusive" },
			get: privateGet,
		});
		const turn = message(
			runtime,
			"99999999-9999-9999-9999-999999999999" as UUID,
		);
		await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);

		await runtime.composeState(turn, ["PRIVATE"], true, false, []);
		await runtime.composeState(turn, ["PRIVATE"], true, false, ["PRIVATE"]);

		expect(privateGet).toHaveBeenCalledTimes(2);
	});

	it("never reuses a sensitive result after the delivery audience changes", async () => {
		const { runtime, setParticipants } = runtimeHarness();
		const privateGet = vi.fn(async () => ({ text: "PRIVATE_PROVIDER_CANARY" }));
		runtime.registerProvider({
			name: "PRIVATE",
			disclosureGate: { require: "owner_exclusive" },
			get: privateGet,
		});
		const turn = message(
			runtime,
			"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" as UUID,
		);
		await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);

		const first = await runtime.composeState(
			turn,
			["PRIVATE"],
			true,
			false,
			[],
		);
		expect(first.text).toContain("PRIVATE_PROVIDER_CANARY");
		expect(privateGet).toHaveBeenCalledTimes(1);

		setParticipants([OWNER, runtime.agentId, GUEST]);
		const second = await runtime.composeState(
			turn,
			["PRIVATE"],
			true,
			false,
			[],
		);

		// The disclosure gate denies the widened audience, and the same-turn
		// sensitive cache (stamped with the old audience key) never resurrects
		// the private text.
		expect(privateGet).toHaveBeenCalledTimes(1);
		expect(second.text).not.toContain("PRIVATE_PROVIDER_CANARY");
		expect(second.text).toContain("Owner-private access notice");
	});

	it("never reuses a sensitive result after the message text is rewritten", async () => {
		const { runtime } = runtimeHarness();
		const privateGet = vi.fn(async () => ({ text: "PRIVATE_PROVIDER_CANARY" }));
		runtime.registerProvider({
			name: "PRIVATE",
			disclosureGate: { require: "owner_exclusive" },
			get: privateGet,
		});
		const turn = message(
			runtime,
			"bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb" as UUID,
		);
		await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);

		await runtime.composeState(turn, ["PRIVATE"], true, false, []);
		turn.content.text = "rewritten private context";
		await runtime.composeState(turn, ["PRIVATE"], true, false, []);

		expect(privateGet).toHaveBeenCalledTimes(2);
	});

	it("invalidates the public-only turn cache when message text changes", async () => {
		const { runtime } = runtimeHarness();
		const publicGet = vi.fn(async () => ({ text: "PUBLIC_PROVIDER_CANARY" }));
		const privateGet = vi.fn(async () => ({ text: "PRIVATE_PROVIDER_CANARY" }));
		runtime.registerProvider({ name: "PUBLIC", get: publicGet });
		runtime.registerProvider({
			name: "PRIVATE",
			disclosureGate: { require: "owner_exclusive" },
			get: privateGet,
		});
		const turn = message(
			runtime,
			"77777777-7777-7777-7777-777777777777" as UUID,
		);
		await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);

		await runtime.composeState(turn, ["PUBLIC", "PRIVATE"], true, false, []);
		turn.content.text = "rewritten private context";
		await runtime.composeState(turn, ["PUBLIC", "PRIVATE"], true, false, []);

		expect(publicGet).toHaveBeenCalledTimes(2);
		expect(privateGet).toHaveBeenCalledTimes(2);
	});

	it("does not cache a public projection when its owner cancels during assembly", async () => {
		const { runtime } = runtimeHarness();
		const controller = new AbortController();
		let abortTriggered = false;
		const values: Record<string, string> = {};
		Object.defineProperty(values, "cancelDuringPublicProjection", {
			enumerable: true,
			get: () => {
				if (!abortTriggered) {
					abortTriggered = true;
					controller.abort("owner stopped during public projection");
				}
				return "observed";
			},
		});
		const publicGet = vi.fn(async () => ({ text: "PUBLIC", values }));
		const privateGet = vi.fn(async () => ({ text: "PRIVATE" }));
		runtime.registerProvider({ name: "PUBLIC", get: publicGet });
		runtime.registerProvider({
			name: "PRIVATE",
			disclosureGate: { require: "owner_exclusive" },
			get: privateGet,
		});
		const turn = message(
			runtime,
			"88888888-8888-8888-8888-888888888888" as UUID,
		);
		await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);

		const outcome = await runWithStreamingContext(
			{ onStreamChunk: async () => {}, abortSignal: controller.signal },
			() => runtime.composeState(turn, ["PUBLIC", "PRIVATE"], true, false, []),
		).catch((cause: unknown) => cause);

		expect(abortTriggered).toBe(true);
		expect(outcome).toBeInstanceOf(TurnAbortedError);
		await runtime.composeState(turn, ["PUBLIC", "PRIVATE"], true, false, []);
		expect(publicGet).toHaveBeenCalledTimes(2);
		expect(privateGet).toHaveBeenCalledTimes(2);
	});
});
