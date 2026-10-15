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

const pluginProviderModels = new Map<string, DynamicPluginModel[]>();

export function replacePluginProviderModels(pluginId: string, models: DynamicPluginModel[]): void {
  pluginProviderModels.set(pluginId, models);
}

export function removePluginProviderModels(pluginId: string): void {
  pluginProviderModels.delete(pluginId);
}

export function getPluginProviderModels(): DynamicPluginModel[] {
  return [...pluginProviderModels.values()].flat();
}
