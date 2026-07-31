import type { Api, Model } from "@earendil-works/pi-ai";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
	saveBtwConfig: vi.fn(() => true),
}));

import { BTW_SETTINGS_COMMAND_NAME, FOLLOW_SESSION_LABEL, registerBtwSettingsCommand } from "./btw-settings.js";
import { saveBtwConfig } from "./config.js";

const plain = { provider: "a", id: "plain", name: "Plain" } as unknown as Model<Api>;
const matchFirst = { provider: "a", id: "first", name: "Match First" } as unknown as Model<Api>;
const matchSecond = { provider: "a", id: "second", name: "Match Second" } as unknown as Model<Api>;
const reasoning = {
	provider: "cliproxyapi",
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	reasoning: true,
} as unknown as Model<Api>;

function register() {
	const { pi, captured } = createMockPi();
	registerBtwSettingsCommand(pi);
	return captured.commands.get(BTW_SETTINGS_COMMAND_NAME)!;
}

type CustomFactory = (
	tui: { requestRender: () => void },
	theme: {
		fg: (_color: string, text: string) => string;
		bg: (_color: string, text: string) => string;
		bold: (text: string) => string;
	},
	keybindings: unknown,
	done: (value: string | undefined) => void,
) => { handleInput: (data: string) => void };

function searchableCustom(query: string) {
	return vi.fn(async (factory: CustomFactory) => {
		let selected: string | undefined;
		let closed = false;
		const component = factory(
			{ requestRender: vi.fn() },
			{ fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
			{},
			(value) => {
				selected = value;
				closed = true;
			},
		);
		for (const character of query) {
			if (!closed) component.handleInput(character);
		}
		if (!closed) component.handleInput("\r");
		return selected;
	});
}

beforeEach(() => {
	vi.mocked(saveBtwConfig).mockReset().mockReturnValue(true);
});

describe("/btw-settings", () => {
	it("requires interactive mode", async () => {
		const ctx = createMockCtx({ hasUI: false });
		await register().handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("writes nothing when model selection is cancelled", async () => {
		const ctx = createMockCtx({ hasUI: true, models: [reasoning] });
		await register().handler("", ctx as never);
		expect(saveBtwConfig).not.toHaveBeenCalled();
	});

	it("shows only scoped models when a scope is configured", async () => {
		const ctx = createMockCtx({ hasUI: true, mode: "rpc", models: [plain, reasoning] });
		(ctx as never as { scopedModels: Array<{ model: Model<Api> }> }).scopedModels = [{ model: plain }];
		vi.mocked(ctx.ui.select).mockResolvedValueOnce("Plain (a/plain)");
		await register().handler("", ctx as never);
		expect(ctx.ui.select).toHaveBeenNthCalledWith(1, "BTW model", [FOLLOW_SESSION_LABEL, "Plain (a/plain)"]);
		expect(saveBtwConfig).toHaveBeenCalledWith({ modelKey: "a/plain" });
	});

	it("shows all available models when no scope is configured", async () => {
		const ctx = createMockCtx({ hasUI: true, mode: "rpc", models: [plain, reasoning] });
		(ctx as never as { scopedModels: [] }).scopedModels = [];
		vi.mocked(ctx.ui.select).mockResolvedValueOnce("Plain (a/plain)");
		await register().handler("", ctx as never);
		expect(ctx.ui.select).toHaveBeenNthCalledWith(1, "BTW model", [
			FOLLOW_SESSION_LABEL,
			"Plain (a/plain)",
			"GPT 5.6 Sol (cliproxyapi/gpt-5.6-sol)",
		]);
	});

	it("searches multi-word model names in TUI mode", async () => {
		const custom = searchableCustom("match second");
		const ctx = createMockCtx({
			hasUI: true,
			mode: "tui",
			models: [matchFirst, matchSecond],
			ui: { custom } as never,
		});
		await register().handler("", ctx as never);
		expect(custom).toHaveBeenCalledOnce();
		expect(saveBtwConfig).toHaveBeenCalledWith({ modelKey: "a/second" });
	});

	it("searches provider and model IDs in TUI mode", async () => {
		const custom = searchableCustom("cliproxyapi/gpt-5.6-sol");
		const ctx = createMockCtx({ hasUI: true, mode: "tui", models: [plain, reasoning], ui: { custom } as never });
		vi.mocked(ctx.ui.select).mockResolvedValueOnce("medium");
		await register().handler("", ctx as never);
		expect(saveBtwConfig).toHaveBeenCalledWith({
			modelKey: "cliproxyapi/gpt-5.6-sol",
			effort: "medium",
		});
	});

	it("clears overrides when following the current session", async () => {
		const ctx = createMockCtx({ hasUI: true, models: [plain] });
		vi.mocked(ctx.ui.select).mockResolvedValueOnce(FOLLOW_SESSION_LABEL);
		await register().handler("", ctx as never);
		expect(saveBtwConfig).toHaveBeenCalledWith({});
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("current session"), "info");
	});

	it("saves a reasoning model and selected effort", async () => {
		const ctx = createMockCtx({ hasUI: true, models: [reasoning] });
		vi.mocked(ctx.ui.select)
			.mockResolvedValueOnce("GPT 5.6 Sol (cliproxyapi/gpt-5.6-sol)")
			.mockResolvedValueOnce("medium");
		await register().handler("", ctx as never);
		expect(saveBtwConfig).toHaveBeenCalledWith({
			modelKey: "cliproxyapi/gpt-5.6-sol",
			effort: "medium",
		});
	});

	it("persists off by omitting effort", async () => {
		const ctx = createMockCtx({ hasUI: true, models: [reasoning] });
		vi.mocked(ctx.ui.select)
			.mockResolvedValueOnce("GPT 5.6 Sol (cliproxyapi/gpt-5.6-sol)")
			.mockResolvedValueOnce("off");
		await register().handler("", ctx as never);
		expect(saveBtwConfig).toHaveBeenCalledWith({ modelKey: "cliproxyapi/gpt-5.6-sol" });
	});

	it("skips effort selection for a non-reasoning model", async () => {
		const ctx = createMockCtx({ hasUI: true, models: [plain] });
		vi.mocked(ctx.ui.select).mockResolvedValueOnce("Plain (a/plain)");
		await register().handler("", ctx as never);
		expect(ctx.ui.select).toHaveBeenCalledTimes(1);
		expect(saveBtwConfig).toHaveBeenCalledWith({ modelKey: "a/plain" });
	});

	it("does not claim success when persistence fails", async () => {
		vi.mocked(saveBtwConfig).mockReturnValue(false);
		const ctx = createMockCtx({ hasUI: true, models: [plain] });
		vi.mocked(ctx.ui.select).mockResolvedValueOnce("Plain (a/plain)");
		await register().handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("save"), "error");
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("BTW model:"), "info");
	});
});
