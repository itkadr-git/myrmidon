import { redactText, type NestRedactConfig } from "@paperclipai/shared";
import { readNestRedactConfig } from "./store.js";
import type { Db } from "@paperclipai/db";

export async function redactNestText(db: Db, nestId: string, text: string) {
  const config: NestRedactConfig = await readNestRedactConfig(db, nestId);
  return redactText(text, config);
}
