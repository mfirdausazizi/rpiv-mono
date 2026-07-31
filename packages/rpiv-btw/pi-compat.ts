/**
 * Host-version-tolerant completion helpers.
 *
 * Prefer Pi's auth-aware ModelRuntime facade when available. It dispatches
 * extension-registered providers and applies credential-derived request fields.
 * Older hosts fall back to pi-ai's global `completeSimple`: Pi >= 0.80.1 exports
 * it from "@earendil-works/pi-ai/compat"; hosts <= 0.79.x export it from the
 * package root. The imports stay dynamic so they resolve against the host copy.
 *
 * The root fallback is reserved for resolution failures. Any other /compat
 * initialization error is rethrown so the real failure is not masked.
 */

type CompleteSimpleFn = typeof import("@earendil-works/pi-ai/compat").completeSimple;
type IsContextOverflowFn = typeof import("@earendil-works/pi-ai/compat").isContextOverflow;

/**
 * Resolve Pi's auth-aware completion facade when the host exposes one.
 *
 * Do not pass preflight apiKey/headers to this path: the runtime applies OAuth
 * credentials and credential-derived fields such as provider-specific baseUrl.
 * Older or future hosts with a different private shape use the legacy fallback.
 */
export function getRuntimeCompleteSimple(modelRegistry: unknown): CompleteSimpleFn | undefined {
	try {
		if (modelRegistry === null || typeof modelRegistry !== "object") return undefined;
		const runtime = (modelRegistry as { runtime?: unknown }).runtime;
		if (runtime === null || typeof runtime !== "object") return undefined;
		const completeSimple = (runtime as { completeSimple?: unknown }).completeSimple;
		return typeof completeSimple === "function" ? (completeSimple.bind(runtime) as CompleteSimpleFn) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Error codes meaning "the /compat entrypoint is not resolvable on this host":
 *   - `ERR_PACKAGE_PATH_NOT_EXPORTED` — Node's ESM resolver when the installed
 *     pi-ai (<= 0.79.x) resolves but has no "./compat" in its `exports` map —
 *     the code an old host actually produces.
 *   - `ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND` — Node's / jiti's resolver
 *     for an unresolvable module (jiti is what Pi loads `.ts` extensions with).
 * Mirrors rpiv-core's `isModuleNotFound` (plus the subpath-export code) —
 * duplicated because siblings never import each other at runtime.
 */
const MODULE_NOT_FOUND_CODES = new Set(["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/** True for a module-resolution failure. Walks the `cause` chain — ESM loaders
 *  and tooling (vitest's mock layer, some bundlers) nest the real code under
 *  `.cause`. Bounded against pathological self-referential chains. */
function isModuleNotFound(err: unknown): boolean {
	for (
		let cur: unknown = err, depth = 0;
		cur != null && depth < 16;
		cur = (cur as { cause?: unknown }).cause, depth++
	) {
		if (typeof cur === "object" && MODULE_NOT_FOUND_CODES.has((cur as { code?: unknown }).code as string)) {
			return true;
		}
	}
	return false;
}

export async function loadCompleteSimple(): Promise<CompleteSimpleFn> {
	let mod: { completeSimple?: CompleteSimpleFn };
	try {
		mod = (await import("@earendil-works/pi-ai/compat")) as { completeSimple?: CompleteSimpleFn };
	} catch (err) {
		if (!isModuleNotFound(err)) throw err; // a real /compat failure must surface, not mask as a fallback
		mod = (await import("@earendil-works/pi-ai")) as { completeSimple?: CompleteSimpleFn };
	}
	const completeSimple = mod.completeSimple;
	if (typeof completeSimple !== "function") {
		throw new Error(
			"pi-ai does not expose completeSimple on /compat or the package root — unsupported host pi-ai version",
		);
	}
	return completeSimple;
}

/**
 * Host-version-tolerant loader for pi-ai's `isContextOverflow` — the overflow
 * detector that gates the /btw single-retry.
 *
 * `isContextOverflow` is re-exported from BOTH the `/compat` entrypoint and the
 * package root (defined in pi-ai's `utils/overflow`), so the resolution path
 * mirrors `loadCompleteSimple`: try `/compat`, fall back to the root only on a
 * module-resolution failure, and rethrow a real `/compat` init failure so it is
 * not masked by the fallback. Unlike `completeSimple`, the export's ABSENCE is
 * an expected host state (older pi-ai, or a host that surfaces it from neither
 * entrypoint), not an unsupported-host error: per the Option-3 refinement the
 * missing-export case returns `undefined` so the caller degrades gracefully
 * (skips the retry) instead of crashing. A non-resolution `/compat` failure
 * still rethrows.
 */
export async function loadIsContextOverflow(): Promise<IsContextOverflowFn | undefined> {
	let mod: { isContextOverflow?: IsContextOverflowFn };
	try {
		mod = (await import("@earendil-works/pi-ai/compat")) as { isContextOverflow?: IsContextOverflowFn };
	} catch (err) {
		if (!isModuleNotFound(err)) throw err; // a real /compat failure must surface, not mask as a fallback
		mod = (await import("@earendil-works/pi-ai")) as { isContextOverflow?: IsContextOverflowFn };
	}
	const isContextOverflow = mod.isContextOverflow;
	if (typeof isContextOverflow !== "function") {
		return undefined; // expected absence on a host lacking the export — degrade, don't crash
	}
	return isContextOverflow;
}
