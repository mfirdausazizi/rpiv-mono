import { type ExtensionCommandContext, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	Markdown,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { assistantMessageText, type BtwTurn, userMessageText } from "./btw-messages.js";

const POPUP_WIDTH = "75%";
const POPUP_MAX_HEIGHT = "80%";
const POPUP_PADDING = 1;
// Non-transcript rows the frame always draws: top border (carries the title),
// divider, input, footer, bottom border.
const POPUP_CHROME_ROWS = 5;
const MIN_VIEWPORT_ROWS = 3;
const FOOTER_TEXT = "Enter send · PgUp/PgDn scroll · Ctrl+L clear · Esc close";
const PENDING_TEXT = "waiting for answer";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
const PENDING_TICK_MS = 1_000;
const TRIMMED_TEXT = "context trimmed to fit budget";

type PopupTurn = {
	question: string;
	status: "pending" | "answer" | "error";
	startedAt?: number;
	answer?: string;
	error?: string;
	trimmed?: boolean;
};

export type BtwPopupSubmitResult =
	| { kind: "success"; answer: string; trimmed?: boolean }
	| { kind: "error"; error: string }
	| { kind: "aborted" };

export interface BtwPopupControllerOptions {
	initialQuestion?: string;
	history: BtwTurn[];
	modelLabel: string;
	theme: Theme;
	tui: TUI;
	done: () => void;
	onSubmit: (question: string, controller: AbortController) => Promise<BtwPopupSubmitResult>;
	onClearHistory: () => void;
}

export class BtwPopupController implements Component, Focusable {
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly done: () => void;
	private readonly onSubmit: BtwPopupControllerOptions["onSubmit"];
	private readonly onClearHistory: () => void;
	private readonly modelLabel: string;
	private readonly input = new Input();
	private readonly markdown = new Map<PopupTurn, Markdown>();
	private turns: PopupTurn[];
	private scrollFromBottom = 0;
	private activeController: AbortController | undefined;
	private lastWidth = 80;
	private closed = false;
	private _focused = true;
	private initialQuestion: string | undefined;
	private pendingTimer: ReturnType<typeof setInterval> | undefined;

	constructor(options: BtwPopupControllerOptions) {
		this.theme = options.theme;
		this.tui = options.tui;
		this.done = options.done;
		this.onSubmit = options.onSubmit;
		this.onClearHistory = options.onClearHistory;
		this.modelLabel = options.modelLabel;
		this.initialQuestion = options.initialQuestion?.trim() || undefined;
		this.turns = options.history.map((turn) => ({
			question: userMessageText(turn.userMessage),
			status: "answer",
			answer: assistantMessageText(turn.assistantMessage),
		}));
		this.input.onSubmit = (value) => void this.submit(value);
		this.input.onEscape = () => this.close();
		this.input.focused = true;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	startInitialQuestion(): void {
		const question = this.initialQuestion;
		this.initialQuestion = undefined;
		if (question) void this.submit(question);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.ctrl("l"))) {
			this.clearHistory();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollFromBottom = Math.min(this.maxScroll(), this.scrollFromBottom + this.viewportRows());
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollFromBottom = Math.max(0, this.scrollFromBottom - this.viewportRows());
			this.requestRender();
			return;
		}
		this.input.handleInput(data);
		this.requestRender();
	}

	render(width: number): string[] {
		this.lastWidth = Math.max(40, width);
		const frameWidth = this.lastWidth;
		const innerWidth = Math.max(10, frameWidth - 2);
		const bodyWidth = Math.max(10, innerWidth - POPUP_PADDING * 2);
		const transcript = this.renderTranscript(bodyWidth);
		// Height follows the transcript: the popup only grows to the terminal cap when
		// there is that much content to show, so a short answer draws a short popup.
		const viewportRows = Math.min(Math.max(transcript.length, MIN_VIEWPORT_ROWS), this.maxViewportRows());
		const maxScroll = Math.max(0, transcript.length - viewportRows);
		this.scrollFromBottom = Math.min(this.scrollFromBottom, maxScroll);
		const end = transcript.length - this.scrollFromBottom;
		const start = Math.max(0, end - viewportRows);
		const visible = transcript.slice(start, end);
		while (visible.length < MIN_VIEWPORT_ROWS) visible.push("");

		const lines = [
			this.topBorder(frameWidth),
			...visible.map((line) => this.boxRow(line, bodyWidth)),
			this.divider(innerWidth),
			this.boxRow(`> ${this.input.render(Math.max(1, bodyWidth - 2)).join("")}`, bodyWidth),
			this.boxRow(this.theme.fg("dim", FOOTER_TEXT), bodyWidth),
			this.bottomBorder(frameWidth),
		];
		return lines.map((line) => truncateToWidth(line, frameWidth, ""));
	}

	invalidate(): void {
		this.input.invalidate();
		for (const markdown of this.markdown.values()) markdown.invalidate();
	}

	private async submit(value: string): Promise<void> {
		if (this.closed || this.activeController) return;
		const question = value.trim();
		if (!question) return;
		this.input.setValue("");
		const turn: PopupTurn = { question, status: "pending", startedAt: Date.now() };
		this.turns.push(turn);
		// Tick once a second while waiting so the elapsed counter proves the request
		// is still alive — completeSimple is non-streaming, so nothing else re-renders.
		this.pendingTimer = setInterval(() => this.requestRender(), PENDING_TICK_MS);
		this.scrollFromBottom = 0;
		const controller = new AbortController();
		this.activeController = controller;
		this.requestRender();
		try {
			const result = await this.onSubmit(question, controller);
			if (this.closed || controller.signal.aborted) return;
			if (result.kind === "success") {
				turn.status = "answer";
				turn.answer = result.answer;
				turn.trimmed = result.trimmed;
			} else if (result.kind === "error") {
				turn.status = "error";
				turn.error = result.error;
			} else {
				this.turns = this.turns.filter((candidate) => candidate !== turn);
			}
			this.scrollFromBottom = 0;
			this.requestRender();
		} catch (error) {
			if (!this.closed && !controller.signal.aborted) {
				turn.status = "error";
				turn.error = error instanceof Error ? error.message : String(error);
				this.scrollFromBottom = 0;
				this.requestRender();
			}
		} finally {
			if (this.activeController === controller) this.activeController = undefined;
			if (this.pendingTimer !== undefined) {
				clearInterval(this.pendingTimer);
				this.pendingTimer = undefined;
			}
		}
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.pendingTimer !== undefined) {
			clearInterval(this.pendingTimer);
			this.pendingTimer = undefined;
		}
		this.activeController?.abort();
		this.done();
	}

	private clearHistory(): void {
		this.activeController?.abort();
		this.turns = [];
		this.markdown.clear();
		this.scrollFromBottom = 0;
		this.input.setValue("");
		this.onClearHistory();
		this.requestRender();
	}

	private renderTranscript(width: number): string[] {
		const lines: string[] = [];
		for (const turn of this.turns) {
			lines.push(this.theme.fg("accent", "You"));
			lines.push(...this.wrapPlain(`> ${turn.question}`, width, "accent"));
			lines.push(this.theme.fg("muted", "BTW"));
			if (turn.status === "pending") {
				const elapsed = Math.max(0, Math.floor((Date.now() - (turn.startedAt ?? Date.now())) / 1000));
				const frame = SPINNER_FRAMES[elapsed % SPINNER_FRAMES.length];
				lines.push(this.theme.fg("warning", `${frame} ${PENDING_TEXT} · ${elapsed}s`));
			} else if (turn.status === "error") {
				lines.push(...this.wrapPlain(turn.error ?? "unknown error", width, "error"));
			} else {
				const markdown = this.getMarkdown(turn);
				lines.push(...markdown.render(width));
				if (turn.trimmed) lines.push(this.theme.fg("warning", TRIMMED_TEXT));
			}
			lines.push("");
		}
		return lines;
	}

	private getMarkdown(turn: PopupTurn): Markdown {
		let markdown = this.markdown.get(turn);
		if (!markdown) {
			markdown = new Markdown(turn.answer ?? "", 0, 0, getMarkdownTheme());
			this.markdown.set(turn, markdown);
		} else {
			markdown.setText(turn.answer ?? "");
		}
		return markdown;
	}

	private wrapPlain(text: string, width: number, color: "accent" | "error"): string[] {
		return wrapTextWithAnsi(this.theme.fg(color, text), width);
	}

	/** Transcript rows the frame may draw at most, given the terminal height cap. */
	private maxViewportRows(): number {
		const maxRows = Math.max(MIN_VIEWPORT_ROWS + POPUP_CHROME_ROWS, Math.floor(this.terminalRows() * 0.8));
		return Math.max(MIN_VIEWPORT_ROWS, maxRows - POPUP_CHROME_ROWS);
	}

	/** Rows actually shown for the current transcript — one page for PgUp/PgDn. */
	private viewportRows(): number {
		const innerWidth = Math.max(10, this.lastWidth - 2);
		const bodyWidth = Math.max(10, innerWidth - POPUP_PADDING * 2);
		const transcript = this.renderTranscript(bodyWidth);
		return Math.min(Math.max(transcript.length, MIN_VIEWPORT_ROWS), this.maxViewportRows());
	}

	private maxScroll(): number {
		const innerWidth = Math.max(10, this.lastWidth - 2);
		const bodyWidth = Math.max(10, innerWidth - POPUP_PADDING * 2);
		return Math.max(0, this.renderTranscript(bodyWidth).length - this.viewportRows());
	}

	private terminalRows(): number {
		return (this.tui.terminal as { rows?: number } | undefined)?.rows ?? 24;
	}

	private requestRender(): void {
		this.tui.requestRender();
	}

	private boxRow(content: string, bodyWidth: number): string {
		const padded =
			truncateToWidth(content, bodyWidth, "") + " ".repeat(Math.max(0, bodyWidth - visibleWidth(content)));
		return `│ ${padded} │`;
	}

	private divider(innerWidth: number): string {
		return `├${"─".repeat(innerWidth)}┤`;
	}

	private topBorder(width: number): string {
		const title = ` BTW · ${this.modelLabel} `;
		const clipped = truncateToWidth(title, Math.max(1, width - 4), "…");
		return `╭${clipped}${"─".repeat(Math.max(0, width - 2 - visibleWidth(clipped)))}╮`;
	}

	private bottomBorder(width: number): string {
		return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
	}
}

export interface ShowBtwPopupParams {
	ctx: ExtensionCommandContext;
	initialQuestion?: string;
	history: BtwTurn[];
	modelLabel: string;
	onSubmit: BtwPopupControllerOptions["onSubmit"];
	onClearHistory: () => void;
}

export interface ShowBtwPopupResult {
	overlayPromise: Promise<void>;
	controllerReady: Promise<BtwPopupController>;
}

export function showBtwPopup(params: ShowBtwPopupParams): ShowBtwPopupResult {
	let resolveController!: (controller: BtwPopupController) => void;
	const controllerReady = new Promise<BtwPopupController>((resolve) => {
		resolveController = resolve;
	});
	const overlayPromise = params.ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const controller = new BtwPopupController({
				initialQuestion: params.initialQuestion,
				history: params.history,
				modelLabel: params.modelLabel,
				theme,
				tui,
				done,
				onSubmit: params.onSubmit,
				onClearHistory: params.onClearHistory,
			});
			resolveController(controller);
			if (params.initialQuestion?.trim()) queueMicrotask(() => controller.startInitialQuestion());
			return controller;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: POPUP_WIDTH,
				maxHeight: POPUP_MAX_HEIGHT,
				margin: 1,
			},
			onHandle: (handle) => handle.focus(),
		},
	);
	return { overlayPromise, controllerReady };
}
