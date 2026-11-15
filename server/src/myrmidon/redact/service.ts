import { redactText, type NestRedactConfig } from "@myrmidon/shared";
import { readNestRedactConfig } from "./store.js";
import type { Db } from "@myrmidon/db";

export async function redactNestText(db: Db, nestId: string, text: string) {
  const config: NestRedactConfig = await readNestRedactConfig(db, nestId);
  return redactText(text, config);
}
