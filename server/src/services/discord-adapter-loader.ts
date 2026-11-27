import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { DiscordAdapter, DiscordAdapterConfig } from "@chat-adapter/discord";

let factory: typeof import("@chat-adapter/discord").createDiscordAdapter | undefined;

export async function preloadDiscordAdapter(): Promise<void> {
  factory ??= (await import("@chat-adapter/discord")).createDiscordAdapter;
}

export function createDiscordAdapterLazy(config: DiscordAdapterConfig): DiscordAdapter {
  if (factory) return factory(config);
  // The pinned ESM adapter has no top-level await; Node 24 loads it on demand.
  const require = createRequire(import.meta.url);
  const entry = fileURLToPath(import.meta.resolve("@chat-adapter/discord"));
  const { createDiscordAdapter } = require(entry) as typeof import("@chat-adapter/discord");
  return createDiscordAdapter(config);
}
