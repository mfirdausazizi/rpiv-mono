/**
 * @juicesharp/rpiv-btw — /btw side-question slash command.
 *
 * Asks the same primary model a one-off side question using the cloned primary
 * conversation as context. Answer is rendered ephemerally in a centered chat
 * popup (never enters main agent's messages). History persists per-session-file
 * via globalThis-keyed storage; process-scoped only (no disk persistence).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	StopReason,
	ThinkingLevel,
	UserMessage,
} from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { parseModelKey } from "@juicesharp/rpiv-config";
import { BTW_CONTEXT_RESERVE, type CappedHistory, capHistory, type FitBranchResult, fitBranch } from "./btw-budget.js";
import { assistantMessageText, type BtwTurn, userMessageText } from "./btw-messages.js";
import { type BtwPopupSubmitResult, showBtwPopup } from "./btw-ui.js";
import { type BtwEffort, loadBtwConfig } from "./config.js";
import { getRuntimeCompleteSimple, loadCompleteSimple, loadIsContextOverflow } from "./pi-compat.js";

// ---------------------------------------------------------------------------
// Constants — flat named consts, grouped by concern (advisor pattern, b9428e9)
// ---------------------------------------------------------------------------

// Identity
export const BTW_COMMAND_NAME = "btw";

// Storage — globalThis-keyed survives module re-import on /new, /fork, /resume.
// Lost on Pi process exit (intentional — no disk persistence).
export const BTW_STATE_KEY = Symbol.for("rpiv-btw");

// Cross-session pattern hint: how many recent question-strings to inject
export const CROSS_SESSION_HINT_LIMIT = 10;

// Messages (static)
const MSG_REQUIRES_INTERACTIVE = "/btw requires interactive mode";
const MSG_NO_MODEL = "/btw requires an active model";
const errConfiguredModelUnavailable = (key: string) =>
	`Configured /btw model ${key} is no longer available; run /btw-settings`;

// Errors (static)
const ERR_EMPTY_RESPONSE = "/btw returned no text content.";

// Errors (parameterized)
const errMisconfigured = (label: string, err: string) => `/btw model (${label}) is misconfigured: ${err}`;
const errNoApiKey = (label: string) => `/btw model (${label}) has no API key available.`;
const errCallFailed = (err: string | undefined) => `/btw call failed: ${err ?? "unknown error"}`;
const errCallThrew = (msg: string) => `/btw call threw: ${msg}`;

function parsePromptLimit(message: string | undefined): number | undefined {
	const match = message?.match(/maximum prompt length is\s+([\d,]+)/i);
	if (!match) return undefined;
	const limit = Number(match[1]!.replaceAll(",", ""));
	return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

function modelForPromptLimit(model: Model<Api>, reportedLimit: number): Model<Api> {
	const safePromptLimit = Math.floor(reportedLimit * 0.9);
	return {
		...model,
		contextWindow: safePromptLimit + (model.maxTokens ?? 0) + BTW_CONTEXT_RESERVE,
	};
}

// Budget (context-budgeting) constants — defined in btw-budget.ts (the leaf budget
// module; keeps the module cycle type-only at runtime), re-exported here so the
// package surface is unchanged.
export { BTW_CONTEXT_RESERVE, BTW_HISTORY_TOKEN_BUDGET, BTW_NO_ANCHOR_SAFETY_FACTOR } from "./btw-budget.js";
// BtwTurn + the message-text extractors live in the cycle-break leaf
// (packages/rpiv-btw/btw-messages.ts); re-exported here so the package surface is
// unchanged (packages/rpiv-btw/btw.test.ts / btw-ui.test.ts / btw-budget.test.ts still
// import them from "./btw.js"). Import-then-re-export (not `export … from`) because
// btw.ts consumes all three internally (userMessageText at :166,
// assistantMessageText at :341, BtwTurn in BtwState/getSessionHistory/pushSessionTurn).
export { assistantMessageText, type BtwTurn, userMessageText };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BtwState {
	histories: Map<string, BtwTurn[]>;
	snapshots: Map<string, { messages: Message[]; entries: SessionEntry[] }>;
}

export function branchToMessages(branch: SessionEntry[]): Message[] {
	const agentMessages = branch
		.filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
		.map((e) => e.message);
	return convertToLlm(agentMessages);
}

// ---------------------------------------------------------------------------
// System prompt — loaded once at module init from prompts/btw-system.txt
// ---------------------------------------------------------------------------

export const BTW_SYSTEM_PROMPT = readFileSync(
	fileURLToPath(new URL("./prompts/btw-system.txt", import.meta.url)),
	"utf-8",
).trimEnd();

// ---------------------------------------------------------------------------
// Storage — globalThis-keyed, survives module re-import on /new, /fork, /resume.
// Standard Node.js `globalThis + Symbol.for()` idiom for cross-import-graph
// singleton state (used by OpenTelemetry, etc.); lost on process exit.
// ---------------------------------------------------------------------------

function getState(): BtwState {
	const g = globalThis as unknown as { [k: symbol]: BtwState | undefined };
	let state = g[BTW_STATE_KEY];
	if (!state) {
		state = {
			histories: new Map(),
			snapshots: new Map(),
		};
		g[BTW_STATE_KEY] = state;
	}
	return state;
}

function getSessionFile(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? `memory:${ctx.sessionManager.getSessionId()}`;
}

function getSessionHistory(ctx: ExtensionContext): BtwTurn[] {
	const key = getSessionFile(ctx);
	const state = getState();
	let turns = state.histories.get(key);
	if (!turns) {
		turns = [];
		state.histories.set(key, turns);
	}
	return turns;
}

function pushSessionTurn(ctx: ExtensionContext, turn: BtwTurn): void {
	getSessionHistory(ctx).push(turn);
}

export function clearSessionHistory(ctx: ExtensionContext): void {
	getState().histories.set(getSessionFile(ctx), []);
}

function getSnapshot(ctx: ExtensionContext): { messages: Message[]; entries: SessionEntry[] } | undefined {
	return getState().snapshots.get(getSessionFile(ctx));
}

function setSnapshot(ctx: ExtensionContext, snapshot: { messages: Message[]; entries: SessionEntry[] }): void {
	getState().snapshots.set(getSessionFile(ctx), snapshot);
}

export function invalidateSnapshot(ctx: ExtensionContext): void {
	getState().snapshots.delete(getSessionFile(ctx));
}

// Cross-session pattern hint — last N question-strings across ALL sessions.
function getCrossSessionHint(): string {
	const allTurns: { q: string; ts: number }[] = [];
	for (const turns of getState().histories.values()) {
		for (const t of turns) {
			allTurns.push({ q: userMessageText(t.userMessage), ts: t.userMessage.timestamp });
		}
	}
	if (allTurns.length === 0) return "";
	const recent = allTurns.sort((a, b) => a.ts - b.ts).slice(-CROSS_SESSION_HINT_LIMIT);
	const lines = recent.map((t, i) => `${i + 1}. ${t.q.replace(/\s+/g, " ").slice(0, 200)}`);
	return `\n\n## Recent /btw questions across sessions (oldest first)\n\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Executor — auth, message threading, completeSimple, four StopReason branches
// Modeled after rpiv-advisor/advisor.ts:225-336
// ---------------------------------------------------------------------------

export type BtwExecResult =
	| {
			kind: "success";
			answer: string;
			userMessage: UserMessage;
			assistantMessage: AssistantMessage;
			stopReason: StopReason;
			trimmed?: boolean;
	  }
	| { kind: "error"; error: string; stopReason?: StopReason }
	| { kind: "aborted"; stopReason: StopReason };

export interface BtwExecutionOptions {
	model?: Model<Api>;
	reasoning?: BtwEffort;
}

function resolveBtwExecution(pi: ExtensionAPI, ctx: ExtensionCommandContext): BtwExecutionOptions | { error: string } {
	const config = loadBtwConfig();
	if (!config.modelKey) {
		if (!ctx.model) return { error: MSG_NO_MODEL };
		const sessionReasoning = pi.getThinkingLevel();
		return {
			model: ctx.model,
			reasoning: sessionReasoning === "off" ? undefined : (sessionReasoning as BtwEffort),
		};
	}
	const parsed = parseModelKey(config.modelKey);
	const model = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
	if (!model) return { error: errConfiguredModelUnavailable(config.modelKey) };
	return { model, reasoning: model.reasoning ? config.effort : undefined };
}

function readBranchSnapshot(ctx: ExtensionContext): { messages: Message[]; entries: SessionEntry[] } {
	const cached = getSnapshot(ctx);
	if (cached) return cached;
	// Cold start (no message_end fired yet) — fall back to a single live read.
	const branch = ctx.sessionManager.getBranch() as SessionEntry[];
	return { messages: branchToMessages(branch), entries: branch };
}

export interface BtwBuiltContext {
	messages: Message[];
	systemPrompt: string;
	droppedTurns: number;
	branchWasTrimmed: boolean;
	stubbed: boolean;
	keepBudget: number; // reduced by the bounded overflow-retry caller to tighten the branch budget
}

export function buildBtwMessages(
	ctx: ExtensionContext,
	userMessage: UserMessage,
	keepBudget?: number,
	model: Model<Api> = ctx.model!,
): BtwBuiltContext {
	const history = getSessionHistory(ctx);
	const { messages, entries } = readBranchSnapshot(ctx);
	const systemPrompt = buildSystemPrompt();
	const fitInput = { entries, messages, model, systemPrompt, question: userMessage };

	let capped: CappedHistory;
	let fit: FitBranchResult;
	if (keepBudget === undefined) {
		// Fast-path parity: attempt the FULL history first (an Infinity budget admits
		// every turn) — when the whole request fits the window, the build is
		// byte-identical to the pre-budgeting assembly and the history cap never engages.
		capped = capHistory(history, Number.POSITIVE_INFINITY);
		fit = fitBranch({ ...fitInput, admittedEstimate: capped.estimate });
		if (fit.branchWasTrimmed || fit.stubbed) {
			// Over budget with full history → apply the history cap BEFORE branch
			// trimming, then re-fit the branch against the freed window. When the cap
			// drops nothing the inputs are identical — keep the first fit.
			const recapped = capHistory(history);
			if (recapped.droppedTurns > 0) {
				capped = recapped;
				fit = fitBranch({ ...fitInput, admittedEstimate: recapped.estimate });
			}
		}
	} else {
		// Overflow retry: the sent request has already proven too large — take the
		// capped history and trim/stub the branch to the retry budget.
		capped = capHistory(history);
		fit = fitBranch({ ...fitInput, admittedEstimate: capped.estimate, keepBudget });
	}
	const assembled: Message[] = [
		...fit.messages,
		...capped.admitted.flatMap((t) => [t.userMessage, t.assistantMessage]),
		userMessage,
	];
	return {
		messages: assembled,
		systemPrompt,
		droppedTurns: capped.droppedTurns,
		branchWasTrimmed: fit.branchWasTrimmed,
		stubbed: fit.stubbed,
		keepBudget: fit.keepBudget,
	};
}

function buildSystemPrompt(): string {
	return BTW_SYSTEM_PROMPT + getCrossSessionHint();
}

export async function executeBtw(
	question: string,
	ctx: ExtensionContext,
	controller: AbortController,
	options: BtwExecutionOptions = {},
): Promise<BtwExecResult> {
	const model = options.model ?? ctx.model;
	if (!model) {
		return { kind: "error", error: MSG_NO_MODEL };
	}
	const reasoning = options.reasoning;
	const modelLabel = `${model.provider}:${model.id}`;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { kind: "error", error: errMisconfigured(modelLabel, auth.error) };
	}
	if (!auth.apiKey) {
		return { kind: "error", error: errNoApiKey(modelLabel) };
	}

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: question }],
		timestamp: Date.now(),
	};
	// `let` because the overflow retry rebuilds `built` with a reduced model window;
	// buildBtwMessages returns BtwBuiltContext { messages, systemPrompt,
	// droppedTurns, branchWasTrimmed, stubbed, keepBudget }.
	let built = buildBtwMessages(ctx, userMessage, undefined, model);

	try {
		const runtimeCompleteSimple = getRuntimeCompleteSimple(ctx.modelRegistry);
		const completeSimple = runtimeCompleteSimple ?? (await loadCompleteSimple());
		const overflowFn = await loadIsContextOverflow();
		const callCompleteSimple = async (
			built: BtwBuiltContext,
			effectiveModel: Model<Api> = model,
		): Promise<{ kind: "aborted"; stopReason: StopReason } | { kind: "completed"; response: AssistantMessage }> => {
			const requestReasoning = reasoning as ThinkingLevel | undefined;
			const response = await completeSimple(
				effectiveModel,
				{ systemPrompt: built.systemPrompt, messages: built.messages, tools: [] },
				// Runtime auth must resolve its own key/headers/baseUrl; explicit overrides bypass it.
				runtimeCompleteSimple
					? { signal: controller.signal, ...(requestReasoning ? { reasoning: requestReasoning } : {}) }
					: {
							apiKey: auth.apiKey,
							headers: auth.headers,
							signal: controller.signal, // own AbortController, NOT ctx.signal (Decision 8)
							...(requestReasoning ? { reasoning: requestReasoning } : {}),
						},
			);
			if (response.stopReason === "aborted") {
				return { kind: "aborted", stopReason: response.stopReason };
			}
			return { kind: "completed", response };
		};
		let outcome = await callCompleteSimple(built);
		if (outcome.kind === "aborted") return outcome;
		let response = outcome.response;
		// Overflow gate — exactly one retry. Provider-reported prompt caps take
		// precedence; otherwise retain the legacy half-budget fallback.
		const reportedPromptLimit = response.stopReason === "error" ? parsePromptLimit(response.errorMessage) : undefined;
		const overflow =
			reportedPromptLimit !== undefined ||
			(response.stopReason === "error" && Boolean(overflowFn?.(response, model.contextWindow)));
		if (overflow) {
			const retryModel = reportedPromptLimit === undefined ? model : modelForPromptLimit(model, reportedPromptLimit);
			built =
				reportedPromptLimit === undefined
					? buildBtwMessages(ctx, userMessage, Math.floor(built.keepBudget / 2), retryModel)
					: buildBtwMessages(ctx, userMessage, undefined, retryModel);
			outcome = await callCompleteSimple(built, retryModel);
			if (outcome.kind === "aborted") return outcome;
			response = outcome.response;
		}
		if (response.stopReason === "error") {
			return {
				kind: "error",
				error: errCallFailed(response.errorMessage),
				stopReason: response.stopReason,
			};
		}

		const answerText = assistantMessageText(response).trim();
		if (!answerText) {
			return { kind: "error", error: ERR_EMPTY_RESPONSE, stopReason: response.stopReason };
		}

		return {
			kind: "success",
			answer: answerText,
			userMessage,
			assistantMessage: response,
			stopReason: response.stopReason,
			trimmed: built.droppedTurns > 0 || built.branchWasTrimmed || built.stubbed,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (controller.signal.aborted) {
			return { kind: "aborted", stopReason: "aborted" as const };
		}
		return { kind: "error", error: errCallThrew(message) };
	}
}

// ---------------------------------------------------------------------------
// Registrars — 3 hooks total: command + message_end snapshot + compact/tree invalidate
// ---------------------------------------------------------------------------

export function registerMessageEndSnapshot(pi: ExtensionAPI): void {
	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		if ((msg as AssistantMessage).stopReason === "toolUse") return;
		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		setSnapshot(ctx, { messages: branchToMessages(branch), entries: branch });
	});
}

export function registerInvalidationHooks(pi: ExtensionAPI): void {
	pi.on("session_compact", async (_e, ctx) => safeInvalidateSnapshot(ctx));
	pi.on("session_tree", async (_e, ctx) => safeInvalidateSnapshot(ctx));
}

// Auto-compaction races session disposal: pi-core invalidates the extension
// runner while still emitting session_compact, so `ctx` may be a dead proxy
// whose getters throw the stale error. The compacting session is being
// discarded — there is no snapshot worth invalidating — so swallow only the
// stale error. Any other error is a real bug and must propagate.
function safeInvalidateSnapshot(ctx: ExtensionContext): void {
	try {
		invalidateSnapshot(ctx);
	} catch (e) {
		if (!isStaleCtxError(e)) throw e;
	}
}

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

export function registerBtwCommand(pi: ExtensionAPI): void {
	pi.registerCommand(BTW_COMMAND_NAME, {
		description: "Ask a side question without polluting the main conversation",
		handler: (args: string, ctx: ExtensionCommandContext) => handleBtwCommand(pi, args, ctx),
	});
}

async function handleBtwCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
		return;
	}
	const question = args.trim();
	const execution = resolveBtwExecution(pi, ctx);
	if ("error" in execution) {
		ctx.ui.notify(execution.error, "error");
		return;
	}

	const model = execution.model!;
	const modelLabel = `${model.provider}/${model.id}${execution.reasoning ? ` · ${execution.reasoning}` : ""}`;
	const historySnapshot = [...getSessionHistory(ctx)];
	const { overlayPromise } = showBtwPopup({
		ctx,
		initialQuestion: question || undefined,
		history: historySnapshot,
		modelLabel,
		onClearHistory: () => clearSessionHistory(ctx),
		onSubmit: async (submittedQuestion, controller): Promise<BtwPopupSubmitResult> => {
			const result = await executeBtw(submittedQuestion, ctx, controller, execution);
			if (controller.signal.aborted) return { kind: "aborted" };
			if (result.kind === "success") {
				pushSessionTurn(ctx, {
					userMessage: result.userMessage,
					assistantMessage: result.assistantMessage,
				});
				return { kind: "success", answer: result.answer, trimmed: result.trimmed };
			}
			if (result.kind === "aborted") return { kind: "aborted" };
			return { kind: "error", error: result.error };
		},
	});
	await overlayPromise;
}
