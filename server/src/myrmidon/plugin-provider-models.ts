import type { PluginRecord, PluginProviderModelDeclaration } from "@paperclipai/shared";

export interface DynamicPluginModel {
  modelId: string;
  label: string;
  pluginId: string;
  pluginKey: string;
  provider: string;
}

export function listPluginProviderModels(plugins: PluginRecord[]): DynamicPluginModel[] {
  return plugins
    .filter((plugin) => plugin.status === "ready")
    .flatMap((plugin) => {
      const declaration = (plugin.manifestJson as { providerModels?: PluginProviderModelDeclaration } | null)?.providerModels;
      if (!declaration) return [];
      return declaration.models.map((model) => ({
        modelId: `${declaration.provider}/${model.id}`,
        label: model.label ?? model.id,
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        provider: declaration.provider,
      }));
    });
}

const pluginProviderModels = new Map<string, Map<string, DynamicPluginModel[]>>();

export function replacePluginProviderModels(companyId: string, pluginId: string, models: DynamicPluginModel[]): void {
  const companyModels = pluginProviderModels.get(companyId) ?? new Map();
  companyModels.set(pluginId, models);
  pluginProviderModels.set(companyId, companyModels);
}

export function removePluginProviderModels(companyId: string, pluginId: string): void {
  const companyModels = pluginProviderModels.get(companyId);
  if (!companyModels) return;
  companyModels.delete(pluginId);
  if (companyModels.size === 0) pluginProviderModels.delete(companyId);
}

export function getPluginProviderModels(companyId: string): DynamicPluginModel[] {
  return [...(pluginProviderModels.get(companyId)?.values() ?? [])].flat();
}
