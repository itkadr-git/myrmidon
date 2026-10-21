// myrmidon(LICENSING): which closed modules this board has installed — a
// board plugin of the module (any status but uninstalled) or its agent
// adapter registered. Only these modules raise the "no license" banner and
// go into the default license request.

import { and, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { plugins } from "@paperclipai/db";
import { findServerAdapter } from "../../adapters/registry.js";
import { MODULE_ADAPTER_TYPES, MODULE_PLUGIN_KEYS } from "./client-license.js";

export function installedClosedModules(db: Db): () => Promise<string[]> {
  return async () => {
    const found = new Set<string>();
    const rows = await db
      .select({ pluginKey: plugins.pluginKey })
      .from(plugins)
      .where(and(inArray(plugins.pluginKey, Object.keys(MODULE_PLUGIN_KEYS)), ne(plugins.status, "uninstalled")));
    for (const row of rows) {
      const module = MODULE_PLUGIN_KEYS[row.pluginKey];
      if (module) found.add(module);
    }
    for (const [type, module] of Object.entries(MODULE_ADAPTER_TYPES)) {
      if (findServerAdapter(type)) found.add(module);
    }
    return [...found].sort();
  };
}
