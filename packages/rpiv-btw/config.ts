import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { configPath, loadJsonConfigWithLegacyFallback, parseModelKey, saveJsonConfig } from "@juicesharp/rpiv-config";

const BTW_CONFIG_PATH = configPath("rpiv-btw");
export type BtwEffort = ThinkingLevel | "max";
const THINKING_LEVELS = new Set<BtwEffort>(["minimal", "low", "medium", "high", "xhigh", "max"]);

export interface BtwConfig {
	modelKey?: string;
	effort?: BtwEffort;
}

function validateBtwConfig(value: unknown): BtwConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const raw = value as Record<string, unknown>;
	if (typeof raw.modelKey !== "string" || !parseModelKey(raw.modelKey)) return {};
	const config: BtwConfig = { modelKey: raw.modelKey };
	if (typeof raw.effort === "string" && THINKING_LEVELS.has(raw.effort as BtwEffort)) {
		config.effort = raw.effort as BtwEffort;
	}
	return config;
}

export function loadBtwConfig(): BtwConfig {
	return validateBtwConfig(loadJsonConfigWithLegacyFallback<unknown>("rpiv-btw"));
}

export function saveBtwConfig(config: BtwConfig): boolean {
	const validated = validateBtwConfig(config);
	if (validated.modelKey !== config.modelKey || validated.effort !== config.effort) return false;
	return saveJsonConfig(BTW_CONFIG_PATH, validated);
}
