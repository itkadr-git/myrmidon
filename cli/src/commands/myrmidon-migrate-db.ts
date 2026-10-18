import { sql, type SQL } from "drizzle-orm";
import { CARRIER_SCHEME } from "./myrmidon-migrate-secrets.js";
import type { AppliedChainRow } from "./myrmidon-migrate-chain.js";

// Anything with an execute() method: the drizzle database, or a transaction of it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Q = { execute: (query: SQL) => PromiseLike<any> };

export const qi = (name: string): string => `"${name.replaceAll("\"", "\"\"")}"`;
export const ql = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export async function all<T = Record<string, unknown>>(q: Q, query: SQL): Promise<T[]> {
  const result = await q.execute(query);
  return Array.from(result as ArrayLike<T>);
}

export type ColumnInfo = {
  name: string;
  dataType: string;
  nullable: boolean;
  hasDefault: boolean;
  generated: boolean;
  identityAlways: boolean;
  hasIdentity: boolean;
  /** The column default as Postgres prints it, or null. */
  defaultExpr: string | null;
};
export type TableInfo = { name: string; columns: ColumnInfo[] };

export async function introspectTables(q: Q): Promise<Map<string, TableInfo>> {
  const rows = await all<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    is_generated: string;
    identity_generation: string | null;
  }>(
    q,
    sql`
      select c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default,
             c.is_generated, c.identity_generation
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
        and c.table_name <> '__drizzle_migrations'
      order by c.table_name, c.ordinal_position
    `,
  );
  const tables = new Map<string, TableInfo>();
  for (const row of rows) {
    let table = tables.get(row.table_name);
    if (!table) {
      table = { name: row.table_name, columns: [] };
      tables.set(row.table_name, table);
    }
    table.columns.push({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === "YES",
      hasDefault: row.column_default !== null || row.identity_generation !== null,
      generated: row.is_generated === "ALWAYS",
      identityAlways: row.identity_generation === "ALWAYS",
      hasIdentity: row.identity_generation !== null,
      defaultExpr: row.column_default,
    });
  }
  return tables;
}

/** Lists the other-schema user tables (informational exclusions). */
export async function listForeignSchemaTables(q: Q): Promise<string[]> {
  const rows = await all<{ s: string; t: string }>(
    q,
    sql`
      select table_schema as s, table_name as t
      from information_schema.tables
      where table_type = 'BASE TABLE'
        and table_schema not in ('public', 'pg_catalog', 'information_schema', 'drizzle')
      order by 1, 2
    `,
  );
  return rows.map((r) => `${r.s}.${r.t}`);
}

/** Reads the drizzle migration journal; null when there is none. Looks at `drizzle` then `public`. */
export async function readAppliedChain(q: Q): Promise<AppliedChainRow[] | null> {
  const found = await all<{ schema_name: string }>(
    q,
    sql`
      select n.nspname as schema_name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relname = '__drizzle_migrations' and c.relkind = 'r'
        and n.nspname in ('drizzle', 'public')
    `,
  );
  if (found.length === 0) return null;
  if (found.length > 1) {
    throw new Error("Ambiguous migration journal: __drizzle_migrations exists in more than one schema.");
  }
  const schema = found[0]!.schema_name;
  const cols = await all<{ column_name: string }>(
    q,
    sql`select column_name from information_schema.columns where table_schema = ${schema} and table_name = '__drizzle_migrations'`,
  );
  if (!cols.some((c) => c.column_name === "hash")) {
    throw new Error("Unsupported migration journal layout: no hash column.");
  }
  const rows = await all<{ hash: string }>(
    q,
    sql.raw(`select hash from ${qi(schema)}.${qi("__drizzle_migrations")} order by id`),
  );
  return rows.map((r) => ({ hash: String(r.hash) }));
}

/** Makes text renderings (timestamps, intervals) identical on both sides of a comparison. */
export async function normalizeSession(q: Q): Promise<void> {
  await q.execute(sql`set local timezone = 'UTC'`);
  await q.execute(sql`set local intervalstyle = 'postgres'`);
}

export async function countPublicTables(q: Q): Promise<number> {
  const rows = await all<{ n: number }>(
    q,
    sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  return rows[0]?.n ?? 0;
}

export async function schemaExists(q: Q, name: string): Promise<boolean> {
  const rows = await all<{ n: number }>(q, sql`select count(*)::int as n from pg_namespace where nspname = ${name}`);
  return (rows[0]?.n ?? 0) > 0;
}

export async function databaseIdentity(q: Q): Promise<{ name: string; oid: string }> {
  const rows = await all<{ name: string; oid: string }>(
    q,
    sql`select current_database() as name, (select oid::text from pg_database where datname = current_database()) as oid`,
  );
  return { name: rows[0]!.name, oid: rows[0]!.oid };
}

export async function countRows(q: Q, table: string): Promise<number> {
  const rows = await all<{ n: number }>(q, sql.raw(`select count(*)::int as n from ${qi("public")}.${qi(table)}`));
  return rows[0]?.n ?? 0;
}

// Column defaults that are plain literals; only these are ever put back into a query.
const LITERAL_DEFAULT = /^(true|false|-?[0-9]+(\.[0-9]+)?|'[^']*'(::[a-z_ ]+)?)$/i;

/**
 * Number of rows in which a column holds something other than "nothing": not
 * null, and not just the column default when that default is a plain literal.
 */
export async function countNonEmpty(q: Q, table: string, column: ColumnInfo): Promise<number> {
  const dflt = column.defaultExpr !== null && LITERAL_DEFAULT.test(column.defaultExpr.trim()) ? column.defaultExpr.trim() : null;
  const extra = dflt === null ? "" : ` and ${qi(column.name)} is distinct from ${dflt}`;
  const rows = await all<{ n: number }>(
    q,
    sql.raw(`select count(*)::int as n from ${qi("public")}.${qi(table)} where ${qi(column.name)} is not null${extra}`),
  );
  return rows[0]?.n ?? 0;
}

export type TableDigest = { rows: number; digest: string };

/** Order-independent content digest of the given columns of a table (all except `exclude`). */
export async function tableDigest(q: Q, table: string, info: TableInfo, exclude: Set<string>): Promise<TableDigest> {
  const excluded = info.columns.filter((c) => exclude.has(c.name)).map((c) => ql(c.name));
  const strip = excluded.length > 0 ? ` - array[${excluded.join(",")}]::text[]` : "";
  const rows = await all<{ n: number; d: string }>(
    q,
    sql.raw(
      `select count(*)::int as n, coalesce(md5(string_agg(h, ',' order by h collate "C")), 'empty') as d ` +
        `from (select md5((to_jsonb(t)${strip})::text) as h from ${qi("public")}.${qi(table)} t) s`,
    ),
  );
  return { rows: rows[0]?.n ?? 0, digest: rows[0]?.d ?? "empty" };
}

export type ForeignKey = { name: string; child: string; parent: string; childCols: string[]; parentCols: string[] };

export async function listForeignKeys(q: Q): Promise<ForeignKey[]> {
  const rows = await all<{ name: string; child: string; parent: string; child_cols: string[]; parent_cols: string[] }>(
    q,
    sql`
      select con.conname::text as name, cl.relname::text as child, pl.relname::text as parent,
        (select array_agg(a.attname::text order by k.ord)
           from unnest(con.conkey) with ordinality k(attnum, ord)
           join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as child_cols,
        (select array_agg(a.attname::text order by k.ord)
           from unnest(con.confkey) with ordinality k(attnum, ord)
           join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as parent_cols
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_class pl on pl.oid = con.confrelid
      join pg_namespace n on n.oid = cl.relnamespace
      join pg_namespace pn on pn.oid = pl.relnamespace
      where con.contype = 'f' and n.nspname = 'public' and pn.nspname = 'public'
    `,
  );
  return rows.map((r) => ({
    name: r.name,
    child: r.child,
    parent: r.parent,
    childCols: r.child_cols,
    parentCols: r.parent_cols,
  }));
}

/** Parents first. Tables caught in a cycle (other than self-references) are returned in `cyclic`. */
export function orderTables(names: string[], fks: ForeignKey[]): { order: string[]; cyclic: string[]; selfReferencing: Set<string> } {
  const set = new Set(names);
  const selfReferencing = new Set<string>();
  const deps = new Map<string, Set<string>>(names.map((n) => [n, new Set<string>()]));
  for (const fk of fks) {
    if (!set.has(fk.child) || !set.has(fk.parent)) continue;
    if (fk.child === fk.parent) selfReferencing.add(fk.child);
    else deps.get(fk.child)!.add(fk.parent);
  }
  const order: string[] = [];
  const placed = new Set<string>();
  let progressed = true;
  const sorted = [...names].sort();
  while (progressed) {
    progressed = false;
    for (const name of sorted) {
      if (placed.has(name)) continue;
      if ([...deps.get(name)!].every((d) => placed.has(d))) {
        order.push(name);
        placed.add(name);
        progressed = true;
      }
    }
  }
  const cyclic = sorted.filter((n) => !placed.has(n));
  return { order: [...order, ...cyclic], cyclic, selfReferencing };
}

/** Counts rows whose foreign key points to a missing parent (MATCH SIMPLE semantics). */
export async function countFkOrphans(q: Q, fks: ForeignKey[]): Promise<{ constraint: string; table: string; orphans: number }[]> {
  const problems: { constraint: string; table: string; orphans: number }[] = [];
  for (const fk of fks) {
    const notNull = fk.childCols.map((c) => `c.${qi(c)} is not null`).join(" and ");
    const match = fk.childCols.map((c, i) => `p.${qi(fk.parentCols[i]!)} = c.${qi(c)}`).join(" and ");
    const rows = await all<{ n: number }>(
      q,
      sql.raw(
        `select count(*)::int as n from ${qi("public")}.${qi(fk.child)} c where ${notNull} ` +
          `and not exists (select 1 from ${qi("public")}.${qi(fk.parent)} p where ${match})`,
      ),
    );
    const n = rows[0]?.n ?? 0;
    if (n > 0) problems.push({ constraint: fk.name, table: fk.child, orphans: n });
  }
  return problems;
}

/** Re-aligns serial/identity sequences with the copied data. */
export async function resetSequences(q: Q): Promise<number> {
  const rows = await all<{ tbl: string; col: string; seq: string }>(
    q,
    sql`
      select c.relname::text as tbl, a.attname::text as col,
             pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) as seq
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r'
        and pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) is not null
    `,
  );
  for (const row of rows) {
    await q.execute(
      sql.raw(
        `select setval(${ql(row.seq)}::regclass, coalesce(max(${qi(row.col)}), 1), max(${qi(row.col)}) is not null) ` +
          `from ${qi("public")}.${qi(row.tbl)}`,
      ),
    );
  }
  return rows.length;
}

/** Whether the connected role may set session_replication_role (superuser or granted on PG15+). */
export async function canUseReplicaRole(q: Q): Promise<boolean> {
  const su = await all<{ ok: boolean }>(q, sql`select rolsuper as ok from pg_roles where rolname = current_user`);
  if (su[0]?.ok) return true;
  const ver = await all<{ v: number }>(q, sql`select current_setting('server_version_num')::int as v`);
  if ((ver[0]?.v ?? 0) < 150000) return false;
  const granted = await all<{ ok: boolean }>(
    q,
    sql`select has_parameter_privilege(current_user, 'session_replication_role', 'SET') as ok`,
  );
  return Boolean(granted[0]?.ok);
}

export type CarrierLocation = { table: string; column: string; count: number };

/** Names of text-like columns (text, varchar, char) of a table. */
export function textColumns(info: TableInfo): string[] {
  return info.columns
    .filter((c) => ["text", "character varying", "character"].includes(c.dataType))
    .map((c) => c.name);
}

export function jsonbColumns(info: TableInfo): string[] {
  return info.columns.filter((c) => c.dataType === "jsonb").map((c) => c.name);
}

const MARKER = ql(CARRIER_SCHEME);

/** Rows of jsonb column values that mention the carrier scheme (pre-filter; exact walk happens in JS). */
export async function selectJsonbCandidates(q: Q, table: string, column: string): Promise<{ rid: string; v: unknown }[]> {
  return all<{ rid: string; v: unknown }>(
    q,
    sql.raw(
      `select ctid::text as rid, ${qi(column)} as v from ${qi("public")}.${qi(table)} ` +
        `where position(${MARKER} in ${qi(column)}::text) > 0`,
    ),
  );
}

/** Number of rows with the carrier scheme marker inside any text-like column. */
export async function countTextMarkers(q: Q, table: string, columns: string[]): Promise<number> {
  if (columns.length === 0) return 0;
  const cond = columns.map((c) => `position(${MARKER} in ${qi(c)}) > 0`).join(" or ");
  const rows = await all<{ n: number }>(
    q,
    sql.raw(`select count(*)::int as n from ${qi("public")}.${qi(table)} where ${cond}`),
  );
  return rows[0]?.n ?? 0;
}

function mergeJsonText(rest: string, extra: [string, string][]): string {
  const trimmed = rest.trim();
  if (extra.length === 0) return trimmed;
  const additions = extra.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(",");
  if (trimmed === "{}") return `{${additions}}`;
  return `${trimmed.slice(0, -1)},${additions}}`;
}

/**
 * Reads one page of rows as JSON text in physical order, resuming after `after`.
 * Carrier columns come back separately (parsed) so the caller can re-encrypt
 * them; every other value stays text, so no number is round-tripped through JS.
 */
export async function readPage(
  q: Q,
  table: string,
  carrierColumns: string[],
  after: string | null,
  limit: number | null,
): Promise<{ lastRid: string | null; rows: { rest: string; carriers: Record<string, unknown> }[] }> {
  const strip = carrierColumns.length > 0 ? ` - array[${carrierColumns.map(ql).join(",")}]::text[]` : "";
  const carrierSelect = carrierColumns.map((c, i) => `, to_jsonb(t.${qi(c)}) as ${qi(`cv${i}`)}`).join("");
  const where = after === null ? "" : ` where t.ctid > ${ql(after)}::tid`;
  const lim = limit === null ? "" : ` limit ${Math.trunc(limit)}`;
  const rows = await all<Record<string, unknown>>(
    q,
    sql.raw(
      `select t.ctid::text as rid, (to_jsonb(t)${strip})::text as rest${carrierSelect} ` +
        `from ${qi("public")}.${qi(table)} t${where} order by t.ctid${lim}`,
    ),
  );
  return {
    lastRid: rows.length > 0 ? String(rows[rows.length - 1]!.rid) : null,
    rows: rows.map((row) => ({
      rest: String(row.rest),
      carriers: Object.fromEntries(carrierColumns.map((c, i) => [c, row[`cv${i}`] ?? null])),
    })),
  };
}

export function rowJson(rest: string, carriers: Record<string, unknown>): string {
  return mergeJsonText(
    rest,
    Object.entries(carriers)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, JSON.stringify(v)] as [string, string]),
  );
}

/** Inserts a page of JSON rows into the target table, restricted to the given columns. */
export async function insertPage(q: Q, table: string, columns: ColumnInfo[], jsonRows: string[]): Promise<void> {
  if (jsonRows.length === 0) return;
  const names = columns.map((c) => qi(c.name)).join(", ");
  const override = columns.some((c) => c.identityAlways) ? " overriding system value" : "";
  const payload = `[${jsonRows.join(",")}]`;
  await q.execute(
    sql`${sql.raw(`insert into ${qi("public")}.${qi(table)} (${names})${override} select ${names} from jsonb_populate_recordset(null::${qi("public")}.${qi(table)}, `)}${payload}::jsonb)`,
  );
}

export type BaselineObjects = { extensions: string[]; objects: string[] };

/** Non-extension objects (sequences, views, types, functions) in public, for ownership accounting. */
export async function captureBaseline(q: Q): Promise<BaselineObjects> {
  const extensions = await all<{ e: string }>(q, sql`select extname::text as e from pg_extension order by 1`);
  const objects = await listNonTableObjects(q);
  return { extensions: extensions.map((r) => r.e), objects: objects.map((o) => `${o.kind}:${o.name}`) };
}

type NonTableObject = { kind: "view" | "sequence" | "type" | "function"; name: string; drop: string };

async function listNonTableObjects(q: Q): Promise<NonTableObject[]> {
  const rel = await all<{ kind: string; name: string }>(
    q,
    sql`
      select case c.relkind when 'v' then 'view' when 'm' then 'view' else 'sequence' end as kind, c.relname::text as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v', 'm', 'S')
        and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('e', 'a', 'i'))
      order by 2
    `,
  );
  const types = await all<{ name: string }>(
    q,
    sql`
      select t.typname::text as name
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typtype in ('e', 'd')
        and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
      order by 1
    `,
  );
  const funcs = await all<{ name: string; kind: string; args: string }>(
    q,
    sql`
      select p.proname::text as name, p.prokind::text as kind, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      order by 1
    `,
  );
  return [
    ...rel.map((r) => ({
      kind: r.kind as "view" | "sequence",
      name: r.name,
      drop: `drop ${r.kind === "view" ? "view" : "sequence"} if exists ${qi("public")}.${qi(r.name)} cascade`,
    })),
    ...types.map((t) => ({ kind: "type" as const, name: t.name, drop: `drop type if exists ${qi("public")}.${qi(t.name)} cascade` })),
    ...funcs.map((f) => ({
      kind: "function" as const,
      name: `${f.name}(${f.args})`,
      drop: `drop ${f.kind === "p" ? "procedure" : "function"} if exists ${qi("public")}.${qi(f.name)}(${f.args}) cascade`,
    })),
  ];
}

/**
 * Drops what a run created in an initially empty target: every public table
 * and every non-extension object that was not in the baseline, plus the
 * drizzle migration schema. Extensions that existed before are left alone.
 */
export async function dropOwnedObjects(q: Q, baseline: BaselineObjects): Promise<void> {
  const tables = await all<{ t: string }>(
    q,
    sql`select table_name::text as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  for (const row of tables) {
    await q.execute(sql.raw(`drop table if exists ${qi("public")}.${qi(row.t)} cascade`));
  }
  const known = new Set(baseline.objects);
  for (const object of await listNonTableObjects(q)) {
    if (known.has(`${object.kind}:${object.name}`)) continue;
    await q.execute(sql.raw(object.drop));
  }
  await q.execute(sql.raw(`drop schema if exists ${qi("drizzle")} cascade`));
}
