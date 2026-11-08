export class BehaviorSettingRegistry {
  private settings: Map<string, BehaviorSettingDef> = new Map();

  register<T>(definition: BehaviorSettingDef<T>): void {
    if (this.settings.has(definition.key)) {
      throw new Error(`Setting with key '${definition.key}' is already registered`);
    }
    this.settings.set(definition.key, definition as BehaviorSettingDef);
  }

  get(key: string): BehaviorSettingDef | undefined {
    return this.settings.get(key);
  }

  getAll(): BehaviorSettingDef[] {
    return Array.from(this.settings.values());
  }

  getKeys(): string[] {
    return Array.from(this.settings.keys());
  }
}

export const behaviorSettingRegistry = new BehaviorSettingRegistry();

type BehaviorSettingDef<T = unknown> = import("./myrmidon-behavior-settings.js").BehaviorSettingDef<T>;
