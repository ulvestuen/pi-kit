// Native Pi 1.1.0+ Provider definition for Antigravity (`agy acp --stdio`).

import { createProvider, type AuthContext, type Model, type Api, type ProviderEnv } from "@earendil-works/pi-ai";
import { COMMAND_ENV, LOGIN_HINT, probeAntigravity } from "./acp-client.ts";
import { API_ID, BASE_URL, modelFromDiscovery, PROVIDER_ID } from "./catalog.ts";
import { streamAntigravity } from "./stream.ts";

const PROVIDER_ENV_NAMES = [COMMAND_ENV] as const;

let lastProviderEnv: ProviderEnv | undefined;

async function providerEnvironment(ctx: AuthContext): Promise<ProviderEnv | undefined> {
  const env: ProviderEnv = {};
  await Promise.all(
    PROVIDER_ENV_NAMES.map(async (name) => {
      const value = await ctx.env(name);
      if (value !== undefined) env[name] = value;
    }),
  );
  return Object.keys(env).length ? env : undefined;
}

export function antigravityEnv(): Record<string, string | undefined> {
  return { ...process.env, ...lastProviderEnv };
}

export function createAntigravityProvider() {
  const externalOAuthMarker = () => ({
    type: "oauth" as const,
    access: "antigravity-external",
    refresh: "antigravity-external",
    expires: Date.now() + 365 * 24 * 60 * 60 * 1_000,
  });

  return createProvider({
    id: PROVIDER_ID,
    name: "Antigravity (agy CLI)",
    baseUrl: BASE_URL,
    auth: {
      apiKey: {
        name: "Antigravity CLI login",
        async check({ ctx, signal }) {
          const providerEnv = await providerEnvironment(ctx);
          lastProviderEnv = providerEnv;
          const status = await probeAntigravity(antigravityEnv(), signal);
          if (!status.available || !status.loggedIn) return undefined;
          return {
            type: status.subscription ? "oauth" : "api_key",
            source: status.subscription ? `Antigravity ${status.tierName ?? "subscription"}` : "Antigravity CLI",
          };
        },
        async resolve({ ctx, signal }) {
          signal.throwIfAborted();
          const providerEnv = await providerEnvironment(ctx);
          lastProviderEnv = providerEnv;
          return {
            auth: { apiKey: "external-process" },
            env: providerEnv,
            source: "Antigravity CLI",
          };
        },
      },
      // Subscription metadata marker for Pi's UI; credentials remain owned by `agy`.
      oauth: {
        name: "Antigravity subscription (managed by agy)",
        isSubscription: true,
        async login() {
          throw new Error(
            "Antigravity manages its own login. Run `agy` or `agy acp --login` in a terminal instead; " +
              "this provider uses it automatically.",
          );
        },
        async refresh(_credential, signal) {
          const status = await probeAntigravity(antigravityEnv(), signal, { bypassCache: true });
          if (!status.available || !status.loggedIn) {
            throw new Error(status.detail ?? LOGIN_HINT);
          }
          return externalOAuthMarker();
        },
        async toAuth() {
          return { apiKey: "external-process" };
        },
      },
    },
    models: [] as Model<Api>[],
    async fetchModels({ signal }) {
      const status = await probeAntigravity(antigravityEnv(), signal);
      if (!status.available || !status.loggedIn) return [];
      return status.models.map(modelFromDiscovery);
    },
    api: {
      stream: streamAntigravity,
      streamSimple: streamAntigravity,
    },
  });
}

export { API_ID, PROVIDER_ID };
