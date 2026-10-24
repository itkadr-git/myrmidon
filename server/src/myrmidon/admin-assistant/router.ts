// Model selection for the built-in instance administrator.

export type AdminTaskClass = "routine" | "complex";

export interface AdminModelRouting {
  routineModel: string;
  complexModel: string;
  reserveModel?: string;
}

export interface AdminAssistantRuntimeInput {
  adapterConfig: Record<string, unknown>;
  metadata: unknown;
  context: Record<string, unknown>;
  availableModels: readonly string[];
}

function readRouting(value: unknown): AdminModelRouting | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const routing = value as Record<string, unknown>;
  if (typeof routing.routineModel !== "string" || typeof routing.complexModel !== "string") return null;
  return {
    routineModel: routing.routineModel,
    complexModel: routing.complexModel,
    reserveModel: typeof routing.reserveModel === "string" ? routing.reserveModel : undefined,
  };
}

function readTaskClass(context: Record<string, unknown>): AdminTaskClass {
  const explicit = context.adminTaskClass ?? context.taskClass;
  return explicit === "complex" || context.complexity === "complex" ? "complex" : "routine";
}

/** Resolve owner-configured routing at the heartbeat adapter boundary. */
export function resolveAdminAssistantAdapterConfig(input: AdminAssistantRuntimeInput) {
  const marker = input.metadata;
  const builtIn =
    typeof marker === "object" && marker !== null
      ? (marker as Record<string, unknown>).paperclipBuiltInAgent
      : null;
  if (
    typeof builtIn !== "object" ||
    builtIn === null ||
    (builtIn as Record<string, unknown>).key !== "admin-assistant"
  ) {
    return input.adapterConfig;
  }
  const adminConfig = input.adapterConfig.adminAssistant;
  const routing = readRouting(
    typeof adminConfig === "object" && adminConfig !== null
      ? (adminConfig as Record<string, unknown>).routing
      : undefined,
  );
  if (!routing) return input.adapterConfig;
  const selected = routeAdminTask(readTaskClass(input.context), routing, input.availableModels);
  return { ...input.adapterConfig, model: selected.model };
}

export function routeAdminTask(taskClass: AdminTaskClass, routing: AdminModelRouting, availableModels: readonly string[]) {
  const available = new Set(availableModels);
  const preferred = taskClass === "routine" ? routing.routineModel : routing.complexModel;
  const candidates = [preferred, routing.reserveModel].filter((model): model is string => Boolean(model));
  const model = candidates.find((candidate) => available.has(candidate));
  if (!model) {
    throw new Error(`No configured LiteLLM model is available for ${taskClass} administrator task`);
  }
  return { model, escalated: taskClass === "complex" && model !== preferred };
}