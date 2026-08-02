/** Fleet-owned optional adapter. This is the only Fleet module allowed to
 * cross into Spawn, and host.ts loads it only for explicit spawn mode. */
import {
  defaultConfig,
  loadConfig,
  type SpawnConfig,
} from "../spawn/config.ts";
import { createBackends } from "../spawn/host.ts";
import {
  cleanupSpawnToolingJobs,
  createSpawnToolingSpawn,
} from "../spawn/runner-adapter.ts";
import type { SpawnFn } from "./runner.ts";
import type { HostRuntime, HostSpawnSettings } from "./host.ts";

export async function createSpawnHostRuntime(
  settings: HostSpawnSettings,
  tag: string,
  fallback: SpawnFn,
  isTmuxAvailable: () => boolean,
): Promise<HostRuntime> {
  let config: SpawnConfig;
  try {
    config = loadConfig();
  } catch (error: any) {
    console.error(`[${tag}] ${error?.message ?? error}`);
    console.error(`[${tag}] Using spawn defaults. Fix spawn config or SPAWN_* env vars, then /reload.`);
    config = defaultConfig();
  }
  config.tmuxSession = settings.tmuxSession || config.tmuxSession;
  if (settings.piBinary) config.piBinary = settings.piBinary;
  if (!settings.tmux && config.backend === "tmux") {
    console.error(`[${tag}] tmux=false does not disable the Spawn tmux backend; select another SPAWN_BACKEND instead.`);
  }
  if (config.backend === "tmux" && !isTmuxAvailable()) {
    console.error(`[${tag}] SPAWN_BACKEND=tmux but tmux is not installed; dispatch will report an availability error`);
  }
  const options = {
    config,
    backends: createBackends(config),
    jobNamePrefix: tag,
    onRegistryError: (message: string) => console.error(`[${tag}] ${message}`),
  };
  return {
    mode: "spawn",
    spawnConfig: config,
    spawn: createSpawnToolingSpawn({ ...options, fallback }),
    describe: async () => config,
    cleanup: () => cleanupSpawnToolingJobs({
      ...options,
      onError: (message: string) => console.error(`[${tag}] ${message}`),
    }),
  };
}
