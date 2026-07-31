import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBtwConfig, saveBtwConfig } from "./config.js";

const CONFIG_PATH = join(process.env.HOME!, ".config", "rpiv-btw", "config.json");

beforeEach(() => {
	rmSync(CONFIG_PATH, { force: true });
});

afterEach(() => {
	rmSync(CONFIG_PATH, { force: true });
});

describe("loadBtwConfig", () => {
	it("returns session-follow mode when the file is absent", () => {
		expect(loadBtwConfig()).toEqual({});
	});

	it("returns session-follow mode for malformed or non-object JSON", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, "{not json", "utf8");
		expect(loadBtwConfig()).toEqual({});
		writeFileSync(CONFIG_PATH, "null", "utf8");
		expect(loadBtwConfig()).toEqual({});
	});

	it("keeps a valid model and effort", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, '{"modelKey":"cliproxyapi/gpt-5.6-sol","effort":"medium"}', "utf8");
		expect(loadBtwConfig()).toEqual({ modelKey: "cliproxyapi/gpt-5.6-sol", effort: "medium" });
	});

	it("keeps the max effort supported by newer Pi hosts", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, '{"modelKey":"cliproxyapi/gpt-5.6-sol","effort":"max"}', "utf8");
		expect(loadBtwConfig()).toEqual({ modelKey: "cliproxyapi/gpt-5.6-sol", effort: "max" });
	});

	it("drops invalid fields", () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, '{"modelKey":42,"effort":"turbo"}', "utf8");
		expect(loadBtwConfig()).toEqual({});
	});
});

describe("saveBtwConfig", () => {
	it("round-trips model and effort with owner-only permissions", () => {
		expect(saveBtwConfig({ modelKey: "cliproxyapi/gpt-5.6-sol", effort: "medium" })).toBe(true);
		expect(loadBtwConfig()).toEqual({ modelKey: "cliproxyapi/gpt-5.6-sol", effort: "medium" });
		expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8"))).toEqual({
			modelKey: "cliproxyapi/gpt-5.6-sol",
			effort: "medium",
		});
		if (process.platform !== "win32") expect(statSync(CONFIG_PATH).mode & 0o777).toBe(0o600);
	});

	it("clears both overrides for session-follow mode", () => {
		expect(saveBtwConfig({ modelKey: "a/b", effort: "high" })).toBe(true);
		expect(saveBtwConfig({})).toBe(true);
		expect(loadBtwConfig()).toEqual({});
		expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8"))).toEqual({});
	});

	it("rejects invalid values instead of writing a downgraded success", () => {
		expect(saveBtwConfig({ modelKey: "/invalid" })).toBe(false);
		expect(() => readFileSync(CONFIG_PATH, "utf8")).toThrow();
	});
});
