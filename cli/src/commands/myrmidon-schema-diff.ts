import { readFile } from "node:fs/promises";

export type SchemaColumn = {
  name: string;
  dataType: string;
  nullable?: boolean;
  hasDefault?: boolean;
  generated?: boolean;
};

export type SchemaTable = { name: string; columns: SchemaColumn[] };
export type SchemaSnapshot = { tables: SchemaTable[] };

export type SchemaDiffIssue = {
  kind: "table-missing-in-target" | "column-missing-in-target" | "column-type-mismatch";
  table: string;
  column?: string;
  sourceType?: string;
  targetType?: string;
};

export type SchemaDiffReport = {
  contractVersion: 1;
  sourceTables: number;
  targetTables: number;
  issues: SchemaDiffIssue[];
  ok: boolean;
};

function parseSnapshot(value: unknown, label: string): SchemaSnapshot {
  if (!value || typeof value !== "object" || !Array.isArray((value as { tables?: unknown }).tables)) {
    throw new Error(`${label} schema snapshot must be an object with a tables array`);
  }
  const tables = (value as { tables: unknown[] }).tables.map((table, index) => {
    if (!table || typeof table !== "object") throw new Error(`${label}.tables[${index}] must be an object`);
    const candidate = table as { name?: unknown; columns?: unknown };
    if (typeof candidate.name !== "string" || !candidate.name) {
      throw new Error(`${label}.tables[${index}].name must be a non-empty string`);
    }
    if (!Array.isArray(candidate.columns)) {
      throw new Error(`${label}.tables[${index}].columns must be an array`);
    }
    const columns = candidate.columns.map((column, columnIndex) => {
      if (!column || typeof column !== "object") throw new Error(`${label}.tables[${index}].columns[${columnIndex}] must be an object`);
      const c = column as { name?: unknown; dataType?: unknown };
      if (typeof c.name !== "string" || !c.name || typeof c.dataType !== "string" || !c.dataType) {
        throw new Error(`${label}.tables[${index}].columns[${columnIndex}] requires name and dataType`);
      }
      return { ...column, name: c.name, dataType: c.dataType } as SchemaColumn;
    });
    return { name: candidate.name, columns };
  });
  return { tables };
}

export async function readSchemaSnapshot(path: string, label: string): Promise<SchemaSnapshot> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label} schema snapshot ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseSnapshot(JSON.parse(raw), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} schema snapshot is not valid JSON: ${error.message}`);
    throw error;
  }
}

export function diffSchemaSnapshots(source: SchemaSnapshot, target: SchemaSnapshot): SchemaDiffReport {
  const targetTables = new Map(target.tables.map((table) => [table.name, table]));
  const issues: SchemaDiffIssue[] = [];
  for (const sourceTable of source.tables) {
    const targetTable = targetTables.get(sourceTable.name);
    if (!targetTable) {
      issues.push({ kind: "table-missing-in-target", table: sourceTable.name });
      continue;
    }
    const targetColumns = new Map(targetTable.columns.map((column) => [column.name, column]));
    for (const sourceColumn of sourceTable.columns) {
      const targetColumn = targetColumns.get(sourceColumn.name);
      if (!targetColumn) {
        issues.push({ kind: "column-missing-in-target", table: sourceTable.name, column: sourceColumn.name });
      } else if (sourceColumn.dataType.toLowerCase() !== targetColumn.dataType.toLowerCase()) {
        issues.push({
          kind: "column-type-mismatch",
          table: sourceTable.name,
          column: sourceColumn.name,
          sourceType: sourceColumn.dataType,
          targetType: targetColumn.dataType,
        });
      }
    }
  }
  return {
    contractVersion: 1,
    sourceTables: source.tables.length,
    targetTables: target.tables.length,
    issues,
    ok: issues.length === 0,
  };
}

export async function runSchemaDiff(sourcePath: string, targetPath: string): Promise<SchemaDiffReport> {
  const [source, target] = await Promise.all([
    readSchemaSnapshot(sourcePath, "source"),
    readSchemaSnapshot(targetPath, "target"),
  ]);
  return diffSchemaSnapshots(source, target);
}

export function registerMyrmidonSchemaDiffCommand(program: { command: (name: string) => any }): void {
  program
    .command("myrmidon:schema-diff")
    .description("Compare Paperclip and Myrmidon schema snapshots without database mutations")
    .requiredOption("--source <path>", "Paperclip schema snapshot JSON")
    .requiredOption("--target <path>", "Myrmidon schema snapshot JSON")
    .option("--json", "Accepted for compatibility; output is always JSON")
    .action(async (options: { source: string; target: string }) => {
      try {
        const report = await runSchemaDiff(options.source, options.target);
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        if (!report.ok) process.exitCode = 1;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    });
}
