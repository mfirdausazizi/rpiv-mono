/**
 * @juicesharp/rpiv-btw — Pi extension entry point.
 *
 * Registers /btw, /btw-settings, and 2 lifecycle hooks (message_end snapshot,
 * session_compact/tree invalidation). Settings persist globally; side-question
 * history remains process-scoped and is lost when Pi exits.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBtwCommand, registerInvalidationHooks, registerMessageEndSnapshot } from "./btw.js";
import { registerBtwSettingsCommand } from "./btw-settings.js";

export default function (pi: ExtensionAPI): void {
	registerBtwCommand(pi);
	registerBtwSettingsCommand(pi);
	registerMessageEndSnapshot(pi);
	registerInvalidationHooks(pi);
}
