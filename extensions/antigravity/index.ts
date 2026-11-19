// Pi extension: routes Antigravity models through the official `agy acp --stdio`
// harness while keeping Pi in control of tools, codemode, history, and approvals.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { probeAntigravity } from "./acp-client.ts";
import { antigravityEnv, createAntigravityProvider } from "./provider.ts";
import { disposeAllAntigravitySessions } from "./stream.ts";

export default function antigravityExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createAntigravityProvider());

  pi.on("session_shutdown", () => {
    disposeAllAntigravitySessions();
  });

  pi.registerCommand("antigravity-status", {
    description: "Check the agy CLI executable, login state, tier, and discovered models",
    handler: async (_args, ctx) => {
      const status = await probeAntigravity(antigravityEnv(), ctx.signal, { bypassCache: true });
      if (!status.available || !status.loggedIn) {
        ctx.ui.notify(status.detail ?? "Antigravity CLI is not ready", "error");
        return;
      }
      const tier = status.tierName ? ` (${status.tierName})` : "";
      const ver = status.serverVersion ? ` v${status.serverVersion}` : "";
      const ids = status.models.map((m) => m.id).join(", ");
      ctx.ui.notify(`Antigravity ACP${ver} is ready${tier} — ${status.models.length} models: ${ids}`, "info");
    },
  });
}

export { createAntigravityProvider } from "./provider.ts";
export { disposeAllAntigravitySessions, streamAntigravity } from "./stream.ts";
