/**
 * Deterministic direct-navigation route for private chat surfaces.
 *
 * A pure view-navigation command ("go home", "open settings", "show wallet")
 * needs no model planning: on a DIRECT channel (DM / VOICE_DM / SELF / API —
 * surfaces where the message is addressed to the agent by construction) a
 * closed verb set plus the rigid view-name table routes straight to the VIEWS
 * action as a deterministic tool call, skipping tool retrieval and the whole
 * planner loop (observed live: "go home" cost 10.6s wall, ~7.3s of it planner
 * machinery — trace 847787e3b15c467da3ef0d004aa31085).
 *
 * Boundary rules — precision over recall, a misfire navigates the user's UI:
 * - The WHOLE message must be nav-verb + optional article/possessive + target.
 *   "i want to go home", "did you go home last night", "go home and rest"
 *   never match. `matchViewCommand` alone is looser (it also matches phrases
 *   embedded in conversation), so this recognizer owns the sentence boundary
 *   and delegates only TARGET resolution to the matcher's closed noun table —
 *   no free-text guessing.
 * - Group/ambient surfaces (GROUP, VOICE_GROUP, FEED, THREAD, WORLD, FORUM,
 *   AUTONOMOUS) and messages without a stamped channelType keep the
 *   model-owned path: "go home" said to a person in a group chat is
 *   conversation, not a command to this agent.
 * - Bare "back" / "go back" (no target) stays with the planner: it means the
 *   PREVIOUS view, which a stateless recognizer cannot resolve.
 *
 * This deliberately narrows 567580dd9f9 ("keep view selection model-owned"):
 * the model keeps every ambiguous surface; only the closed-set command form
 * on a direct channel is deterministic.
 */
import type {
	Memory,
	ResponseHandlerEvaluator,
	ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { matchViewCommand } from "../actions/view-command-matcher.js";
import { userRequestMessageText } from "../params.js";
import { VIEWS_ACTION_NAME } from "./view-command-routing.js";

/** Surfaces where an inbound message is addressed to the agent by construction. */
const DIRECT_NAV_CHANNEL_TYPES: ReadonlySet<string> = new Set([
	ChannelType.DM,
	ChannelType.VOICE_DM,
	ChannelType.SELF,
	ChannelType.API,
]);

/**
 * Closed verb set (go / go to / go back to / open / show / show me / back to)
 * followed by one optional article or possessive and the target words. The
 * anchors make the command own the whole message; the target's validity is
 * decided by `matchViewCommand`'s closed view-noun table, never guessed.
 */
const DIRECT_NAV_COMMAND =
	/^(?:go(?:\s+back)?(?:\s+to)?|open|show(?:\s+me)?|back\s+to)\s+(?:the\s+|my\s+)?(?<target>[\p{L}\p{N}][\p{L}\p{N} -]{0,60})$/iu;

/** Trailing politeness/punctuation an ASR transcript or typed command carries. */
function normalizeNavText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[\s.!?]+$/u, "")
		.replace(/\s+please$/u, "")
		.replace(/\s+/gu, " ")
		.trim();
}

/**
 * Resolve a whole-message direct navigation command to a view id, or null.
 * Pure and deterministic — exported for the route matrix tests.
 */
export function resolveDirectNavCommandView(text: string): string | null {
	const normalized = normalizeNavText(text);
	if (!normalized) return null;
	const match = DIRECT_NAV_COMMAND.exec(normalized);
	const target = match?.groups?.target?.trim();
	if (!target) return null;
	return matchViewCommand(target);
}

function isDirectNavChannel(message: Memory | undefined): boolean {
	const channelType = message?.content?.channelType;
	return (
		typeof channelType === "string" && DIRECT_NAV_CHANNEL_TYPES.has(channelType)
	);
}

function resolveRoute(context: ResponseHandlerEvaluatorContext): string | null {
	if (!isDirectNavChannel(context.message)) return null;
	const hasViewsAction = (context.runtime.actions ?? []).some(
		(action) => action.name?.toUpperCase() === VIEWS_ACTION_NAME,
	);
	if (!hasViewsAction) return null;
	// Security-unwrapped user words — envelope warning text never feeds the
	// navigation matcher (same contract as view-command-routing).
	return resolveDirectNavCommandView(userRequestMessageText(context.message));
}

export const directNavRouteEvaluator: ResponseHandlerEvaluator = {
	name: "app-control.direct-nav-route",
	description:
		"Deterministic direct-channel navigation: when the whole message is a closed-set nav command (go/open/show/back-to + a registered view name) on a DM/voice-DM/self/API surface, routes straight to the VIEWS action and skips the planner.",
	// Before core.direct_registered_capability_request (15) and
	// core.simple_registered_action_request (20), matching the retired
	// view-command-shortcut slot, so a rigid nav command is never captured by
	// a broader text-inference route first.
	priority: 10,
	deterministicActions: [VIEWS_ACTION_NAME],
	shouldRun: (context) => resolveRoute(context) !== null,
	evaluate: (context) => {
		const viewId = resolveRoute(context);
		if (!viewId) return undefined;
		return {
			requiresTool: true,
			// Navigation must succeed or fail before anything claims completion:
			// the VIEWS callback owns this turn's one visible response.
			clearReply: true,
			clearCandidateActions: true,
			addCandidateActions: [VIEWS_ACTION_NAME],
			clearParentActionHints: true,
			addParentActionHints: [VIEWS_ACTION_NAME],
			deterministicToolCall: {
				name: VIEWS_ACTION_NAME,
				params: { action: "show", view: viewId },
			},
			debug: [
				`direct-channel nav command -> ${viewId}; deterministic VIEWS route (planner skipped)`,
			],
		};
	},
};
