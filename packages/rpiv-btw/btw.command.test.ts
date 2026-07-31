import type { Api, Model } from "@earendil-works/pi-ai";
import { buildSessionEntries, createMockCtx, createMockPi, makeUserMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./btw-ui.js", () => ({
	showBtwPopup: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		getSupportedThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high"]),
	};
});

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, completeSimple: vi.fn() };
});

vi.mock("./config.js", () => ({
	loadBtwConfig: vi.fn(() => ({})),
}));

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { BTW_COMMAND_NAME, BTW_STATE_KEY, registerBtwCommand } from "./btw.js";
import { showBtwPopup } from "./btw-ui.js";
import { loadBtwConfig } from "./config.js";

const model = { provider: "a", id: "m", contextWindow: 200000, maxTokens: 8192 } as unknown as Model<Api>;
const configured = {
	provider: "cliproxyapi",
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	reasoning: true,
	contextWindow: 200000,
	maxTokens: 8192,
} as unknown as Model<Api>;

type PopupParams = Parameters<typeof showBtwPopup>[0];

function doneResponse(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		stopReason: "done",
	};
}

function register() {
	const { pi, captured } = createMockPi();
	registerBtwCommand(pi);
	return captured.commands.get(BTW_COMMAND_NAME)!;
}

function stubPopup(interaction: (params: PopupParams) => Promise<void> = async () => {}) {
	let params!: PopupParams;
	vi.mocked(showBtwPopup).mockImplementationOnce((next) => {
		params = next;
		return {
			overlayPromise: interaction(next),
			controllerReady: Promise.resolve({} as never),
		};
	});
	return () => params;
}

beforeEach(() => {
	vi.mocked(showBtwPopup).mockReset();
	vi.mocked(completeSimple).mockReset();
	vi.mocked(loadBtwConfig).mockReset().mockReturnValue({});
});

afterEach(() => {
	delete (globalThis as Record<symbol, unknown>)[BTW_STATE_KEY];
});

describe("/btw command", () => {
	it("requires interactive mode", async () => {
		const cmd = register();
		const ctx = createMockCtx({ hasUI: false, model });
		await cmd.handler("anything", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(showBtwPopup).not.toHaveBeenCalled();
	});

	it("opens an empty popup when no question is provided", async () => {
		stubPopup();
		const cmd = register();
		await cmd.handler("   ", createMockCtx({ hasUI: true, model }) as never);
		expect(showBtwPopup).toHaveBeenCalledOnce();
		expect(vi.mocked(showBtwPopup).mock.calls[0][0].initialQuestion).toBeUndefined();
	});

	it("opens with an initial question and submits it immediately", async () => {
		vi.mocked(completeSimple).mockResolvedValueOnce(doneResponse("42") as never);
		const getParams = stubPopup(async (params) => {
			await params.onSubmit(params.initialQuestion!, new AbortController());
		});
		const cmd = register();
		await cmd.handler("what is 6 times 7?", createMockCtx({ hasUI: true, model }) as never);
		const params = getParams();
		expect(params.initialQuestion).toBe("what is 6 times 7?");
		expect(completeSimple).toHaveBeenCalledWith(model, expect.anything(), expect.anything());
	});

	it("passes the effective model and reasoning label to the popup", async () => {
		vi.mocked(loadBtwConfig).mockReturnValue({ modelKey: "cliproxyapi/gpt-5.6-sol", effort: "high" });
		stubPopup();
		const cmd = register();
		await cmd.handler("question", createMockCtx({ hasUI: true, model, models: [configured] }) as never);
		expect(vi.mocked(showBtwPopup).mock.calls[0][0].modelLabel).toContain("cliproxyapi/gpt-5.6-sol");
		expect(vi.mocked(showBtwPopup).mock.calls[0][0].modelLabel).toContain("high");
	});

	it("pushes each successful popup follow-up exactly once and includes prior BTW turns once", async () => {
		vi.mocked(completeSimple)
			.mockResolvedValueOnce(doneResponse("first answer") as never)
			.mockResolvedValueOnce(doneResponse("second answer") as never);
		stubPopup(async (params) => {
			await params.onSubmit("first question", new AbortController());
			await params.onSubmit("second question", new AbortController());
		});
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true, model, branch: buildSessionEntries([makeUserMessage("branch")]) });
		await cmd.handler("first question", ctx as never);
		const secondMessages = JSON.stringify(vi.mocked(completeSimple).mock.calls[1][1].messages);
		expect(secondMessages.match(/first question/g)).toHaveLength(1);
		expect(secondMessages.match(/first answer/g)).toHaveLength(1);
		const state = (globalThis as Record<symbol, { histories: Map<string, unknown[]> }>)[BTW_STATE_KEY];
		expect(state.histories.get("/tmp/test-session.jsonl")).toHaveLength(2);
	});

	it("returns popup errors without appending history", async () => {
		let result!: unknown;
		const getParams = stubPopup(async (params) => {
			result = await params.onSubmit("bad question", new AbortController());
		});
		const cmd = register();
		await cmd.handler("bad question", createMockCtx({ hasUI: true, model }) as never);
		expect(result).toEqual({ kind: "error", error: expect.stringContaining("call") });
		expect(getParams()).toBeDefined();
	});

	it("does not persist a result after the popup aborts its controller", async () => {
		vi.mocked(completeSimple).mockResolvedValueOnce(doneResponse("late answer") as never);
		const getParams = stubPopup(async (params) => {
			const controller = new AbortController();
			controller.abort();
			const result = await params.onSubmit("aborted question", controller);
			expect(result).toEqual({ kind: "aborted" });
		});
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true, model });
		await cmd.handler("aborted question", ctx as never);
		const state = (globalThis as Record<symbol, { histories: Map<string, unknown[]> }>)[BTW_STATE_KEY];
		expect(state.histories.get("/tmp/test-session.jsonl") ?? []).toHaveLength(0);
		expect(getParams()).toBeDefined();
	});

	it("does not open when a configured model is unavailable", async () => {
		vi.mocked(loadBtwConfig).mockReturnValue({ modelKey: "missing/model", effort: "medium" });
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true, model, models: [configured] });
		await cmd.handler("question", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no longer available"), "error");
		expect(showBtwPopup).not.toHaveBeenCalled();
	});
});
