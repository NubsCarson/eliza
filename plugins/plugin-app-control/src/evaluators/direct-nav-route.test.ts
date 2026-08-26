/**
 * Route matrix for the deterministic direct-channel navigation evaluator:
 * closed-set commands fire on direct surfaces, conversational phrasings and
 * ambient group text never do.
 */

import type { ResponseHandlerEvaluatorContext } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	directNavRouteEvaluator,
	resolveDirectNavCommandView,
} from "./direct-nav-route.ts";

function ctx(
	text: string,
	opts: {
		channelType?: string;
		hasViews?: boolean;
		requiresTool?: boolean;
		processMessage?: string;
	} = {},
): ResponseHandlerEvaluatorContext {
	const hasViews = opts.hasViews ?? true;
	return {
		runtime: {
			actions: hasViews
				? [{ name: "VIEWS" }, { name: "REPLY" }]
				: [{ name: "REPLY" }],
		},
		message: {
			content: {
				text,
				...(opts.channelType ? { channelType: opts.channelType } : {}),
			},
		},
		state: {},
		messageHandler: {
			processMessage: opts.processMessage ?? "RESPOND",
			plan: { requiresTool: opts.requiresTool ?? false },
		},
		availableContexts: [],
	} as unknown as ResponseHandlerEvaluatorContext;
}

async function run(
	text: string,
	opts: Parameters<typeof ctx>[1] = { channelType: ChannelType.DM },
) {
	const c = ctx(text, opts);
	const should = await directNavRouteEvaluator.shouldRun(c);
	if (!should) return null;
	return directNavRouteEvaluator.evaluate(c);
}

describe("directNavRouteEvaluator — deterministic VIEWS route on direct channels", () => {
	it("declares VIEWS as its only deterministic action", () => {
		expect(directNavRouteEvaluator.deterministicActions).toEqual(["VIEWS"]);
	});

	it("runs ahead of the core capability-request evaluators", () => {
		expect(directNavRouteEvaluator.priority).toBeLessThan(15);
	});

	const commands: Array<[text: string, view: string]> = [
		["go home", "chat"],
		["Go Home!", "chat"],
		["go home please", "chat"],
		["open settings", "settings"],
		["open the settings", "settings"],
		["show wallet", "wallet"],
		["show me my calendar", "calendar"],
		["go to task coordinator", "task-coordinator"],
		["go back to settings", "settings"],
		["open inbox", "inbox"],
		["show my notes", "notes"],
	];
	for (const [text, view] of commands) {
		it(`routes ${JSON.stringify(text)} to VIEWS show ${view} on a DM surface`, async () => {
			const patch = await run(text, { channelType: ChannelType.DM });
			expect(patch?.deterministicToolCall).toEqual({
				name: "VIEWS",
				params: { action: "show", view },
			});
			expect(patch?.requiresTool).toBe(true);
			expect(patch?.clearReply).toBe(true);
			expect(patch?.clearCandidateActions).toBe(true);
			expect(patch?.addCandidateActions).toEqual(["VIEWS"]);
		});
	}

	for (const channelType of [
		ChannelType.VOICE_DM,
		ChannelType.SELF,
		ChannelType.API,
	]) {
		it(`fires on the ${channelType} direct surface`, async () => {
			const patch = await run("go home", { channelType });
			expect(patch?.deterministicToolCall?.params).toEqual({
				action: "show",
				view: "chat",
			});
		});
	}

	const conversational = [
		"i want to go home",
		"did you go home last night",
		"go home and rest",
		"lets go home",
		"can we talk about my settings",
		"when i go home i will call you",
		"go back",
		"back",
		"what is home",
		"tell me about the wallet view",
		"go home tomorrow",
	];
	for (const text of conversational) {
		it(`leaves conversational ${JSON.stringify(text)} to the model even on a DM surface`, async () => {
			expect(await run(text, { channelType: ChannelType.DM })).toBeNull();
		});
	}

	const ambientChannels = [
		ChannelType.GROUP,
		ChannelType.VOICE_GROUP,
		ChannelType.FEED,
		ChannelType.THREAD,
		ChannelType.WORLD,
	];
	for (const channelType of ambientChannels) {
		it(`never fires on ambient ${channelType} text ("go home" to a person stays conversation)`, async () => {
			expect(await run("go home", { channelType })).toBeNull();
		});
	}

	it("never fires when the message has no stamped channelType", async () => {
		expect(await run("go home", {})).toBeNull();
	});

	it("is inert when no VIEWS action is registered", async () => {
		expect(
			await run("go home", { channelType: ChannelType.DM, hasViews: false }),
		).toBeNull();
	});

	it("warns once (per process) when a nav command matches during the missing-VIEWS boot window", async () => {
		const warn = vi.fn();
		const c = ctx("go home", {
			channelType: ChannelType.DM,
			hasViews: false,
		});
		(c.runtime as { logger?: { warn: typeof warn } }).logger = { warn };
		expect(await directNavRouteEvaluator.shouldRun(c)).toBe(false);
		// One-shot: earlier suite runs may already have consumed the warning
		// (module-level latch); this pins "at most once", never per-message spam.
		const callsAfterFirst = warn.mock.calls.length;
		expect(callsAfterFirst).toBeLessThanOrEqual(1);
		expect(await directNavRouteEvaluator.shouldRun(c)).toBe(false);
		expect(warn.mock.calls.length).toBe(callsAfterFirst);
	});
});

describe("resolveDirectNavCommandView — sentence boundary ownership", () => {
	it("requires the whole message to be the command", () => {
		expect(resolveDirectNavCommandView("go home")).toBe("chat");
		expect(resolveDirectNavCommandView("i want to go home")).toBeNull();
		expect(resolveDirectNavCommandView("go home and rest")).toBeNull();
	});

	it("resolves only registered view nouns — no free-text guessing", () => {
		expect(resolveDirectNavCommandView("open the mainframe")).toBeNull();
		expect(resolveDirectNavCommandView("show me a good time")).toBeNull();
		expect(resolveDirectNavCommandView("go to narnia")).toBeNull();
	});

	it("keeps bare back navigation with the planner", () => {
		expect(resolveDirectNavCommandView("go back")).toBeNull();
		expect(resolveDirectNavCommandView("back")).toBeNull();
	});
});
