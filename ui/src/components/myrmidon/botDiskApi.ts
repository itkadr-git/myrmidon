export interface BotDiskView {
  settings: {
    "shared.packageStore": string | undefined;
    "shared.enabled": boolean;
    sharedPackageCachePath: string | undefined;
  };
}

export const botDiskQueryKey = ["myrmidon", "bot-disk"] as const;

export const botDiskApi = {
  async get(): Promise<BotDiskView> {
    const response = await fetch("/api/myrmidon/bot-disk");
    if (!response.ok) {
      throw new Error(`Failed to fetch bot disk settings: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return { 
      settings: {
        "shared.packageStore": data["shared.packageStore"],
        "shared.enabled": data["shared.enabled"],
        sharedPackageCachePath: data.sharedPackageCachePath,
      }
    };
  },

  async update(settings: { "shared.packageStore"?: string, "shared.enabled"?: boolean, sharedPackageCachePath?: string }): Promise<void> {
    const response = await fetch("/api/myrmidon/bot-disk", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
    });
    if (!response.ok) {
      throw new Error(`Failed to update bot disk settings: ${response.status} ${response.statusText}`);
    }
  },
};
