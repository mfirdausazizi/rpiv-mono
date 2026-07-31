import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { modelKey } from "@juicesharp/rpiv-config";
import { type BtwEffort, saveBtwConfig } from "./config.js";

export const BTW_SETTINGS_COMMAND_NAME = "btw-settings";
export const FOLLOW_SESSION_LABEL = "Follow current session";

const MSG_REQUIRES_INTERACTIVE = "/btw-settings requires interactive mode";
const MSG_SAVE_FAILED = "Unable to save /btw settings";
const FOLLOW_SESSION_VALUE = "__follow-session__";
const MAX_VISIBLE_MODELS = 12;

function isPrintable(data: string): boolean {
	return data.length === 1 && data.charCodeAt(0) >= 0x20 && data.charCodeAt(0) < 0x7f;
}

function isBackspace(data: string): boolean {
	return data === "\u0008" || data === "\u007f";
}

type ContextWithScopedModels = ExtensionCommandContext & {
	scopedModels?: ReadonlyArray<{ model: Model<Api> }>;
};

function getSelectableModels(ctx: ExtensionCommandContext): Model<Api>[] {
	const scopedModels = (ctx as ContextWithScopedModels).scopedModels ?? [];
	return scopedModels.length > 0 ? scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
}

async function selectModel(ctx: ExtensionCommandContext, models: Model<Api>[]): Promise<string | undefined> {
	const labels = models.map((model) => `${model.name} (${modelKey(model)})`);
	if (ctx.mode !== "tui") {
		const selected = await ctx.ui.select("BTW model", [FOLLOW_SESSION_LABEL, ...labels]);
		if (!selected) return undefined;
		if (selected === FOLLOW_SESSION_LABEL) return FOLLOW_SESSION_VALUE;
		const index = labels.indexOf(selected);
		return index < 0 ? undefined : modelKey(models[index]!);
	}

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const items: SelectItem[] = [
			{ value: FOLLOW_SESSION_VALUE, label: FOLLOW_SESSION_LABEL },
			...models.map((model) => ({ value: modelKey(model), label: `${model.name} (${modelKey(model)})` })),
		];
		let query = "";
		let list: SelectList;
		let container: Container;

		const rebuild = () => {
			const normalized = query.toLowerCase();
			const filtered = normalized
				? items.filter(
						(item) =>
							item.label.toLowerCase().includes(normalized) || item.value.toLowerCase().includes(normalized),
					)
				: items;
			list = new SelectList(filtered, Math.min(Math.max(filtered.length, 1), MAX_VISIBLE_MODELS), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.bg("selectedBg", theme.bold(text)),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("BTW model")), 1, 0));
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(theme.fg(query ? "accent" : "dim", query ? `Filter: ${query}` : "Type to filter…"), 1, 0),
			);
			container.addChild(new Spacer(1));
			container.addChild(list);
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		};
		rebuild();

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (isBackspace(data)) {
					if (query) {
						query = query.slice(0, -1);
						rebuild();
					}
				} else if (isPrintable(data)) {
					query += data;
					rebuild();
				} else {
					list.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
}

export function registerBtwSettingsCommand(pi: ExtensionAPI): void {
	pi.registerCommand(BTW_SETTINGS_COMMAND_NAME, {
		description: "Configure the global model and reasoning level used by /btw",
		handler: handleBtwSettingsCommand,
	});
}

async function handleBtwSettingsCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
		return;
	}

	const models = getSelectableModels(ctx);
	const selected = await selectModel(ctx, models);
	if (!selected) return;

	if (selected === FOLLOW_SESSION_VALUE) {
		if (!saveBtwConfig({})) {
			ctx.ui.notify(MSG_SAVE_FAILED, "error");
			return;
		}
		ctx.ui.notify("BTW follows the current session model and reasoning level", "info");
		return;
	}

	const model = models.find((candidate) => modelKey(candidate) === selected);
	if (!model) return;

	let effort: BtwEffort | undefined;
	if (model.reasoning) {
		const choices = getSupportedThinkingLevels(model);
		const selectedEffort = await ctx.ui.select("BTW reasoning level", choices);
		if (!selectedEffort) return;
		if (selectedEffort !== "off") effort = selectedEffort as BtwEffort;
	}

	const config = effort ? { modelKey: modelKey(model), effort } : { modelKey: modelKey(model) };
	if (!saveBtwConfig(config)) {
		ctx.ui.notify(MSG_SAVE_FAILED, "error");
		return;
	}
	ctx.ui.notify(`BTW model: ${config.modelKey}${effort ? `, ${effort}` : ""}`, "info");
}
