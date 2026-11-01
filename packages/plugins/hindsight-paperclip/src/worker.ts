import { runWorker } from "@myrmidon/plugin-sdk";
import { createHindsightPlugin } from "./plugin.js";

const plugin = createHindsightPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
