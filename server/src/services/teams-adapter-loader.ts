import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { TeamsAdapter, TeamsAdapterConfig } from "@chat-adapter/teams";

type TeamsModule = typeof import("@chat-adapter/teams");
let teamsModule: TeamsModule | undefined;

export async function preloadTeamsAdapter(): Promise<void> {
  teamsModule ??= await import("@chat-adapter/teams");
}

export function getTeamsAdapterModule(): TeamsModule {
  if (!teamsModule) {
    // The pinned ESM module supports synchronous loading on Node 24.
    const require = createRequire(import.meta.url);
    const entry = fileURLToPath(import.meta.resolve("@chat-adapter/teams"));
    teamsModule = require(entry) as TeamsModule;
  }
  return teamsModule;
}

export function createTeamsAdapterLazy(config: TeamsAdapterConfig): TeamsAdapter {
  return getTeamsAdapterModule().createTeamsAdapter(config);
}