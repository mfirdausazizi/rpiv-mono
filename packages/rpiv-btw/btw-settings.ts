import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { modelKey } from "@juicesharp/rpiv-config";
import { type BtwEffort, saveBtwConfig } from "./config.js";

export const BTW_SETTINGS_COMMAND_NAME = "btw-settings";
export const FOLLOW_SESSION_LABEL = "Follow current session";

const MSG_REQUIRES_INTERACTIVE = "/btw-settings requires interactive mode";
const MSG_SAVE_FAILED = "Unable to save /btw settings";

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

	const models = ctx.modelRegistry.getAvailable();
	const labels = models.map((model) => `${model.name} (${modelKey(model)})`);
	const selected = await ctx.ui.select("BTW model", [FOLLOW_SESSION_LABEL, ...labels]);
	if (!selected) return;

	if (selected === FOLLOW_SESSION_LABEL) {
		if (!saveBtwConfig({})) {
			ctx.ui.notify(MSG_SAVE_FAILED, "error");
			return;
		}
		ctx.ui.notify("BTW follows the current session model and reasoning level", "info");
		return;
	}

	const model = models[labels.indexOf(selected)];
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
