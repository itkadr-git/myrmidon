// server/src/myrmidon/castes/directory.ts
//
// myrmidon(1.6.5 OPE-6608, review item 6): the caste directory as the swarm reads
// it — the `CompanyCastesReader` port of the claim gate and the board-side
// matcher, bound to the database. Read fresh on every call (the directory has no
// row cache, so a caste switched off is honoured without a restart).

import type { CompanyCastesReader } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { createCasteStore } from "./store.js";

export function createCasteDirectoryReader(db: Db): CompanyCastesReader {
  const store = createCasteStore({ db });
  return async (companyId) =>
    (await store.listCastes(companyId)).map((row) => ({
      key: row.key,
      swarmEligible: row.swarmEligible,
      maxActiveTasks: row.maxActiveTasks,
    }));
}
