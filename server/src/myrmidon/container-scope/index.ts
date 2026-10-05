// server/src/myrmidon/container-scope/index.ts
//
// myrmidon(CONTAINER-SCOPE): wiring — the database behind store.ts, the service
// with the limits of a bot container, and the Express router for app.ts.

import type { Db } from "@paperclipai/db";
import type { ContainerLimits } from "@paperclipai/shared";
import { containerScopeRoutes } from "./routes.js";
import { containerScopeService, type ContainerScopeService } from "./service.js";
import { containerScopeStore } from "./store.js";

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** The limits one container runs with; a shared container gets them once. */
export function containerLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): ContainerLimits {
  return {
    memoryMb: numberFromEnv(env.MYRMIDON_BOT_CONTAINER_MEMORY_MB, 4096),
    cpus: numberFromEnv(env.MYRMIDON_BOT_CONTAINER_CPUS, 2),
  };
}

export function containerScopeServiceFor(db: Db, env: NodeJS.ProcessEnv = process.env): ContainerScopeService {
  return containerScopeService(containerScopeStore(db), { limits: containerLimitsFromEnv(env) });
}

export function myrmidonContainerScopeRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  return containerScopeRoutes({ db, service: containerScopeServiceFor(db, env) });
}
