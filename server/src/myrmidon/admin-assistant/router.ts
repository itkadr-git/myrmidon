// Model selection for the built-in instance administrator.

export type AdminTaskClass = "routine" | "complex";

export interface AdminModelRouting {
  routineModel: string;
  complexModel: string;
  reserveModel?: string;
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