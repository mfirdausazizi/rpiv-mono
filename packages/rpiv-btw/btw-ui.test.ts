import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BtwTurn } from "./btw-messages.js";
import { BtwPopupController, type BtwPopupSubmitResult, showBtwPopup } from "./btw-ui.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getMarkdownTheme: () => ({
		heading: (text: string) => text,
		link: (text: string) => text,
		linkUrl: (text: string) => text,
		code: (text: string) => text,
		codeBlock: (text: string) => text,
		codeBlockBorder: (text: string) => text,
		quote: (text: string) => text,
		quoteBorder: (text: string) => text,
		hr: (text: string) => text,
		listBullet: (text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		underline: (text: string) => text,
	}),
}));

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
} as unknown as Theme;

function makeTui(rows = 24): TUI {
	return { requestRender: vi.fn(), terminal: { rows, columns: 100 } } as unknown as TUI;
}

function makeTurn(q: string, a = "answer"): BtwTurn {
	return {
		userMessage: { role: "user", content: q, timestamp: 0 },
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text: a }],
			api: "anthropic" as never,
			provider: "anthropic" as never,
			model: "m",
			usage: {} as never,
			stopReason: "done" as never,
			timestamp: 0,
		},
	};
}

function makeController(
	opts: {
		history?: BtwTurn[];
		initialQuestion?: string;
		rows?: number;
		onSubmit?: (question: string, controller: AbortController) => Promise<BtwPopupSubmitResult>;
	} = {},
) {
	const tui = makeTui(opts.rows);
	const done = vi.fn();
	const onSubmit = opts.onSubmit ?? vi.fn(async () => ({ kind: "success", answer: "answer" }) as BtwPopupSubmitResult);
	const onClearHistory = vi.fn();
	const ctl = new BtwPopupController({
		initialQuestion: opts.initialQuestion,
		history: opts.history ?? [],
		modelLabel: "cliproxyapi/gpt-5.6-sol · medium",
		theme: identityTheme,
		tui,
		done,
		onSubmit,
		onClearHistory,
	});
	return { ctl, tui, done, onSubmit, onClearHistory };
}

afterEach(() => vi.restoreAllMocks());

describe("BtwPopupController shell", () => {
	it("renders a centered-popup header, empty focused input, and controls", () => {
		const { ctl } = makeController();
		ctl.focused = true;
		const output = ctl.render(80).join("\n");
		expect(output).toContain("BTW");
		expect(output).toContain("cliproxyapi/gpt-5.6-sol · medium");
		expect(output).toContain("Enter send");
		expect(output).toContain(CURSOR_MARKER);
	});

	it("renders prior successful turns as distinct user and assistant content", () => {
		const { ctl } = makeController({ history: [makeTurn("previous question", "**previous answer**")] });
		const output = ctl.render(100).join("\n");
		expect(output).toContain("previous question");
		expect(output).toContain("previous answer");
		expect(output).not.toContain("**previous answer**");
	});
});

describe("BtwPopupController input and requests", () => {
	it("submits a complete multi-word question once", async () => {
		const deferred = Promise.resolve({ kind: "success", answer: "ok" } as BtwPopupSubmitResult);
		const { ctl, onSubmit } = makeController({ onSubmit: vi.fn(async () => deferred) });
		for (const char of "what is this") ctl.handleInput(char);
		ctl.handleInput("\r");
		await deferred;
		expect(onSubmit).toHaveBeenCalledOnce();
		expect(onSubmit).toHaveBeenCalledWith("what is this", expect.any(AbortController));
	});

	it("does not submit a second request while one is pending", async () => {
		let resolve!: (result: BtwPopupSubmitResult) => void;
		const onSubmit = vi.fn(() => new Promise<BtwPopupSubmitResult>((r) => (resolve = r)));
		const { ctl } = makeController({ onSubmit });
		for (const char of "first") ctl.handleInput(char);
		ctl.handleInput("\r");
		for (const char of "second") ctl.handleInput(char);
		ctl.handleInput("\r");
		expect(onSubmit).toHaveBeenCalledOnce();
		resolve({ kind: "success", answer: "done" });
		await vi.waitFor(() => expect(ctl.render(80).join("\n")).toContain("done"));
	});

	it("keeps errors visible and accepts a later follow-up", async () => {
		const onSubmit = vi
			.fn<(_: string, __: AbortController) => Promise<BtwPopupSubmitResult>>()
			.mockResolvedValueOnce({ kind: "error", error: "upstream failed" })
			.mockResolvedValueOnce({ kind: "success", answer: "recovered" });
		const { ctl } = makeController({ onSubmit });
		for (const char of "first") ctl.handleInput(char);
		ctl.handleInput("\r");
		await vi.waitFor(() => expect(ctl.render(80).join("\n")).toContain("upstream failed"));
		for (const char of "second") ctl.handleInput(char);
		ctl.handleInput("\r");
		await vi.waitFor(() => expect(ctl.render(80).join("\n")).toContain("recovered"));
		expect(onSubmit).toHaveBeenCalledTimes(2);
	});

	it("aborts the active request and closes on Escape", () => {
		let requestController!: AbortController;
		const onSubmit = vi.fn((_question: string, controller: AbortController) => {
			requestController = controller;
			return new Promise<BtwPopupSubmitResult>(() => {});
		});
		const { ctl, done } = makeController({ onSubmit });
		for (const char of "pending") ctl.handleInput(char);
		ctl.handleInput("\r");
		ctl.handleInput("\u001b");
		expect(requestController.signal.aborted).toBe(true);
		expect(done).toHaveBeenCalledOnce();
	});

	it("clears transcript and process history without closing", () => {
		const { ctl, onClearHistory, done } = makeController({ history: [makeTurn("old", "old answer")] });
		ctl.handleInput("\u000c");
		expect(onClearHistory).toHaveBeenCalledOnce();
		expect(done).not.toHaveBeenCalled();
		expect(ctl.render(100).join("\n")).not.toContain("old answer");
	});

	it("animates the pending indicator with elapsed time while waiting", async () => {
		vi.useFakeTimers();
		try {
			const onSubmit = vi.fn(() => new Promise<BtwPopupSubmitResult>(() => {}));
			const { ctl, tui } = makeController({ onSubmit });
			for (const char of "slow question") ctl.handleInput(char);
			ctl.handleInput("\r");

			const initial = ctl.render(80).join("\n");
			expect(initial).toContain("waiting for answer");
			expect(initial).toContain("0s");

			const rendersBefore = vi.mocked(tui.requestRender).mock.calls.length;
			await vi.advanceTimersByTimeAsync(3_000);
			expect(vi.mocked(tui.requestRender).mock.calls.length).toBeGreaterThan(rendersBefore);
			expect(ctl.render(80).join("\n")).toContain("3s");
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops the pending ticker once the request settles", async () => {
		vi.useFakeTimers();
		try {
			let resolve!: (result: BtwPopupSubmitResult) => void;
			const onSubmit = vi.fn(() => new Promise<BtwPopupSubmitResult>((r) => (resolve = r)));
			const { ctl, tui } = makeController({ onSubmit });
			for (const char of "q") ctl.handleInput(char);
			ctl.handleInput("\r");
			resolve({ kind: "success", answer: "done answer" });
			await vi.advanceTimersByTimeAsync(0);
			expect(ctl.render(80).join("\n")).toContain("done answer");

			const rendersAfterSettle = vi.mocked(tui.requestRender).mock.calls.length;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(vi.mocked(tui.requestRender).mock.calls.length).toBe(rendersAfterSettle);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("BtwPopupController viewport", () => {
	it("shows older transcript content after PageUp and returns to newest on PageDown", () => {
		const history = Array.from({ length: 12 }, (_, i) => makeTurn(`marker-${i}`, `answer-${i}`));
		const { ctl } = makeController({ history, rows: 12 });
		const newest = ctl.render(100).join("\n");
		expect(newest).toContain("answer-11");
		expect(newest).not.toContain("marker-0");
		let older = newest;
		for (let i = 0; i < 30 && !older.includes("marker-0"); i++) {
			ctl.handleInput("\u001b[5~");
			older = ctl.render(100).join("\n");
		}
		expect(older).toContain("marker-0");
		for (let i = 0; i < 30; i++) ctl.handleInput("\u001b[6~");
		expect(ctl.render(100).join("\n")).toContain("answer-11");
	});

	it("renders a short popup for short content and grows to the terminal cap for long content", () => {
		const short = makeController({ rows: 24 });
		const long = makeController({
			rows: 24,
			history: Array.from({ length: 20 }, (_, i) => makeTurn(`question-${i}`, `answer-${i}`)),
		});

		expect(short.ctl.render(80).length).toBe(8); // 3 minimum transcript rows + 5 chrome rows
		expect(long.ctl.render(80).length).toBe(19); // 80% of 24 rows, rounded down
	});

	it("forwards arrow keys to Input instead of scrolling", () => {
		const input = vi.spyOn(Input.prototype, "handleInput");
		const { ctl } = makeController({ history: [makeTurn("old")] });
		ctl.handleInput("\u001b[A");
		expect(input).toHaveBeenCalledWith("\u001b[A");
	});

	it("invalidates the input and rendered markdown components", () => {
		const { ctl } = makeController({ history: [makeTurn("q", "**answer**")] });
		const input = vi.spyOn(Input.prototype, "invalidate");
		ctl.render(80);
		ctl.invalidate();
		expect(input).toHaveBeenCalled();
	});
});

describe("showBtwPopup", () => {
	it("uses a centered responsive overlay and starts an initial question", async () => {
		let component!: BtwPopupController;
		const custom = vi.fn((factory: any, opts: any) => {
			component = factory(makeTui(), identityTheme, {}, () => {});
			(custom as any).options = opts;
			return new Promise<void>(() => {});
		});
		const onSubmit = vi.fn(async () => ({ kind: "success", answer: "ok" }) as BtwPopupSubmitResult);
		const ctx = { ui: { custom } } as never;
		showBtwPopup({
			ctx,
			history: [],
			initialQuestion: "initial question",
			modelLabel: "model",
			onSubmit,
			onClearHistory: vi.fn(),
		});
		await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith("initial question", expect.any(AbortController)));
		expect(component).toBeInstanceOf(BtwPopupController);
		expect((custom as any).options).toMatchObject({
			overlay: true,
			overlayOptions: { anchor: "center", width: "75%", maxHeight: "80%", margin: 1 },
		});
	});
});
