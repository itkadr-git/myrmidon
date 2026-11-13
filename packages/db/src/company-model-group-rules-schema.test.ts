import fs from \"node:fs\";
import { getTableConfig } from \"drizzle-orm/pg-core\";
import { describe, expect, it } from \"vitest\";
import { companyModelGroupRules } from \"./schema/company_model_group_rules.js\";

type PgTable = Parameters<typeof getTableConfig>[0];

function indexColumns(table: PgTable, indexName: string): string[] {
  const index = getTableConfig(table).indexes.find((candidate) => candidate.config.name === indexName);
  if (!index) return [];
  return index.config.columns.map((column) => (column as { name: string }).name);
}

function uniqueConstraint(table: PgTable, constraintName: string) {
  return getTableConfig(table).uniqueConstraints.find((candidate) => candidate.name === constraintName);
}

function column(table: PgTable, columnName: string) {
  const match = getTableConfig(table).columns.find((candidate) => candidate.name === columnName);
  if (!match) throw new Error(`Column ${columnName} not found`);
  return match;
}

const MIGRATION_FILE = \"0483_last_pepper_potts.sql\";

describe(\"company model group rules schema\", () => {
  it(\"enforces uniqueness across company, caste, and step class with nullsNotDistinct\", () => {
    const constraint = uniqueConstraint(companyModelGroupRules, \"company_model_group_rules_scope_step_uq\");
    expect(constraint).toBeDefined();
    expect(constraint?.columns.map((candidate) => candidate.name)).toEqual([
      \"company_id\",\n      \"caste_key\",\n      \"step_class\",
    ]);
    expect(constraint?.nullsNotDistinct).toBe(true);
  });

  it(\"keeps lookup index company-scoped\", () => {
    expect(indexColumns(companyModelGroupRules, \"company_model_group_rules_company_idx\")).toEqual([
      \"company_id\",
    ]);
  });

  it(\"defines expected columns and nullability for company model group rules\", () => {
    const columns = getTableConfig(companyModelGroupRules).columns.map((candidate) => candidate.name);
    expect(columns).toEqual([
      \"id\",
      \"company_id\",
      \"step_class\",
      \"model_group\",
      \"caste_key\",
      \"created_at\",
      \"updated_at\",
    ]);

    expect(column(companyModelGroupRules, \"id\").notNull).toBe(true);
    expect(column(companyModelGroupRules, \"company_id\").notNull).toBe(true);
    expect(column(companyModelGroupRules, \"step_class\").notNull).toBe(true);
    expect(column(companyModelGroupRules, \"model_group\").notNull).toBe(true);
    expect(column(companyModelGroupRules, \"caste_key\").notNull).toBe(false);
    expect(column(companyModelGroupRules, \"created_at\").notNull).toBe(true);
    expect(column(companyModelGroupRules, \"updated_at\").notNull).toBe(true);
  });

  it(\"declares UNIQUE NULLS NOT DISTINCT in migration SQL\", () => {
    const migrationPath = new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url);
    const content = fs.readFileSync(migrationPath, \"utf8\");
    expect(content).toContain(
      'CONSTRAINT \"company_model_group_rules_scope_step_uq\" UNIQUE NULLS NOT DISTINCT(\"company_id\",\"caste_key\",\"step_class\")',
    );
    expect(content).toContain('REFERENCES \"public\".\"companies\"(\"id\") ON DELETE cascade');
  });
});
