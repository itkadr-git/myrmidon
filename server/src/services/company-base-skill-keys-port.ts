// myrmidon(1.6.5 BASE-SKILLS): test seam for the base-skills read. Route and
// service tests build minimal database doubles that cannot answer a drizzle
// query on `company_base_skills`; they substitute this port instead of growing
// the double. Production wiring binds `readCompanyBaseSkillKeys` — behaviour
// on a real database is unchanged.
//
// The port stays free of drizzle/db value imports on purpose: tests import it
// before their module mocks register, and a static drizzle import would escape
// those mocks. The default reader is wired lazily inside the call itself.

import type { Db } from "@paperclipai/db";

export type CompanyBaseSkillKeysReader = (db: Db, companyId: string) => Promise<string[]>;

let companyBaseSkillKeysReader: CompanyBaseSkillKeysReader | null = null;

async function defaultCompanyBaseSkillKeysReader(db: Db, companyId: string): Promise<string[]> {
  const { readCompanyBaseSkillKeys } = await import("./company-base-skill-keys.js");
  return readCompanyBaseSkillKeys(db, companyId);
}

export function readCompanyBaseSkillKeysPort(db: Db, companyId: string): Promise<string[]> {
  const reader = companyBaseSkillKeysReader ?? defaultCompanyBaseSkillKeysReader;
  return reader(db, companyId);
}

export function setCompanyBaseSkillKeysReaderForTests(reader: CompanyBaseSkillKeysReader | null): void {
  companyBaseSkillKeysReader = reader;
}
