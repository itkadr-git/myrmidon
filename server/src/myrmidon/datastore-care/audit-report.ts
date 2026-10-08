// server/src/myrmidon/datastore-care/audit-report.ts
//
// myrmidon(DBC-4): the audit report — the section-6 criteria with their
// measured values, and the markdown export.
//
// The report is a measurement, never an action: it prints the criteria of the
// project (раздел 6) next to the numbers of the snapshot it was built from, so
// an operator can diff the .md export against their own psql output taken in
// the same hour. There are no rules and no actions in this module — the module
// only measures and stores what it measured.

import {
  prettyBytes,
  type DatastoreSnapshotPayload,
  type DatastoreTarget,
  type DatastoreTopQueryMetric,
} from "./domain.js";

/** Verdict of one criterion. */
export type AuditVerdict = "ok" | "warn" | "fail" | "unknown";

/** One section-6 criterion with the value measured in the snapshot. */
export interface AuditCriterion {
  id: string;
  /** Short title, Russian (the report is operator-facing). */
  title: string;
  /** The threshold the value is compared against, as text. */
  threshold: string;
  /** The measured value, as text — the number an operator can check in psql. */
  value: string;
  verdict: AuditVerdict;
  /** How the value was obtained (the criterion is only useful with its source). */
  source: string;
  /** Extra context when the verdict needs it. */
  detail?: string | null;
}

/** Counts of verdicts, used by the API answer and the report header. */
export interface AuditSummary {
  ok: number;
  warn: number;
  fail: number;
  unknown: number;
  worst: AuditVerdict;
  databaseBytes: number;
  databasePretty: string;
  topQueries: number;
  statStatementsAvailable: boolean;
}

function settingValue(payload: DatastoreSnapshotPayload, name: string): string | null {
  const found = payload.settings.find((setting) => setting.name === name);
  return found ? found.value : null;
}

function bytesSetting(payload: DatastoreSnapshotPayload, name: string): number | null {
  const raw = settingValue(payload, name);
  if (raw === null) return null;
  const match = raw.trim().match(/^([0-9.]+)\s*(kB|MB|GB|TB|B)?$/i);
  if (!match) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  switch ((match[2] ?? "B").toLowerCase()) {
    case "kb":
      return value * 1024;
    case "mb":
      return value * 1024 * 1024;
    case "gb":
      return value * 1024 * 1024 * 1024;
    case "tb":
      return value * 1024 * 1024 * 1024 * 1024;
    default:
      return value;
  }
}

function percent(value: number, digits = 2): string {
  return `${value.toFixed(digits)} %`;
}

/** Share of the execution time the printed top queries account for. */
export function topQueriesShare(payload: DatastoreSnapshotPayload): number | null {
  if (!payload.statStatementsAvailable || payload.topQueriesTotalMs <= 0) return null;
  const printed = payload.topQueries.reduce((sum, query) => sum + query.totalMs, 0);
  return (printed / payload.topQueriesTotalMs) * 100;
}

/**
 * Evaluates the section-6 criteria against one snapshot.
 *
 * `previous` (the snapshot before this one, when there is one) feeds the growth
 * criterion; without it that criterion is `unknown`, never a silent `ok`.
 */
export function evaluateCriteria(
  payload: DatastoreSnapshotPayload,
  previous: DatastoreSnapshotPayload | null = null,
): AuditCriterion[] {
  const criteria: AuditCriterion[] = [];

  // 1. Database size.
  const sizeLimitBytes = 8 * 1024 * 1024 * 1024;
  criteria.push({
    id: "db-size",
    title: "Размер базы доски",
    threshold: `≤ ${prettyBytes(sizeLimitBytes)}`,
    value: prettyBytes(payload.databaseBytes),
    verdict: payload.databaseBytes > sizeLimitBytes ? "warn" : "ok",
    source: "pg_database_size(current_database())",
    detail:
      payload.databaseBytes > sizeLimitBytes
        ? "база переросла проектный потолок 8 ГиБ — см. раздел хранения проекта"
        : null,
  });

  // 2. Daily growth against the previous snapshot.
  if (previous && previous.databaseBytes > 0) {
    const hours =
      (new Date(payload.capturedAt).getTime() - new Date(previous.capturedAt).getTime()) / 3_600_000;
    const delta = payload.databaseBytes - previous.databaseBytes;
    const perDay = hours > 0 ? (delta / previous.databaseBytes) * (24 / hours) * 100 : 0;
    criteria.push({
      id: "growth-24h",
      title: "Рост базы за сутки",
      threshold: "≤ 5 %/сутки",
      value: `${perDay >= 0 ? "+" : ""}${percent(perDay)} (${prettyBytes(delta)} за ${hours.toFixed(1)} ч)`,
      verdict: perDay > 5 ? "warn" : "ok",
      source: `снимок ${previous.capturedAt} → ${payload.capturedAt}`,
      detail: null,
    });
  } else {
    criteria.push({
      id: "growth-24h",
      title: "Рост базы за сутки",
      threshold: "≤ 5 %/сутки",
      value: "нет предыдущего снимка",
      verdict: "unknown",
      source: "datastore_snapshots: предыдущая запись отсутствует",
      detail: "первый снимок цели — критерий появится со вторым сбором",
    });
  }

  // 3. Buffer cache hit ratio.
  const hits = payload.databaseStats.blksHit;
  const reads = payload.databaseStats.blksRead;
  const hitRatio = hits + reads > 0 ? (hits / (hits + reads)) * 100 : null;
  criteria.push({
    id: "cache-hit",
    title: "Кэш-попадание буферов",
    threshold: "≥ 99 %",
    value: hitRatio === null ? "нет данных" : percent(hitRatio, 3),
    verdict: hitRatio === null ? "unknown" : hitRatio >= 99 ? "ok" : "warn",
    source: "pg_stat_database.blks_hit / (blks_hit + blks_read)",
    detail: null,
  });

  // 4. How much of the database time the printed top queries account for.
  const share = topQueriesShare(payload);
  criteria.push({
    id: "top-queries-share",
    title: `Доля топ-${payload.topQueries.length} запросов во времени БД`,
    threshold: "≤ 80 %",
    value: share === null ? "pg_stat_statements недоступен" : percent(share, 1),
    verdict: share === null ? "unknown" : share <= 80 ? "ok" : "warn",
    source: "pg_stat_statements: сумма top-N / sum(total_exec_time)",
    detail: share !== null && share > 80 ? "нагрузка сосредоточена в нескольких запросах" : null,
  });

  // 5. The statistics extension the top-query part needs.
  criteria.push({
    id: "stat-statements",
    title: "Расширение pg_stat_statements",
    threshold: "установлено",
    value: payload.statStatementsAvailable ? "да" : "нет",
    verdict: payload.statStatementsAvailable ? "ok" : "warn",
    source: "pg_extension",
    detail: payload.statStatementsAvailable
      ? null
      : "без расширения отчёт не может показать топ запросов",
  });

  // 6. The TOAST share of the largest table (the board's known hot spot).
  const largest = payload.tables[0] ?? null;
  const toastShare =
    largest && largest.totalBytes > 0 ? (largest.toastBytes / largest.totalBytes) * 100 : null;
  criteria.push({
    id: "toast-share",
    title: "TOAST самой большой таблицы",
    threshold: "≤ 90 % от её размера",
    value:
      largest === null || toastShare === null
        ? "нет данных"
        : `${largest.table}: ${prettyBytes(largest.toastBytes)} = ${percent(toastShare, 1)}`,
    verdict: toastShare === null ? "unknown" : toastShare <= 90 ? "ok" : "warn",
    source: "pg_total_relation_size(reltoastrelid) / pg_total_relation_size(oid)",
    detail: null,
  });

  // 7. Unused indexes: share and absolute size.
  const unused = payload.indexes.filter((index) => index.scans === 0);
  const unusedBytes = unused.reduce((sum, index) => sum + index.bytes, 0);
  const unusedShare = payload.indexCount > 0 ? (unused.length / payload.indexCount) * 100 : 0;
  const unusedBytesLimit = 512 * 1024 * 1024;
  criteria.push({
    id: "unused-indexes",
    title: "Неиспользуемые индексы",
    threshold: "≤ 20 % записей и ≤ 512 МиБ",
    value: `${unused.length} из ${payload.indexCount} (${percent(unusedShare, 1)}), ${prettyBytes(unusedBytes)}`,
    verdict: unusedShare > 20 || unusedBytes > unusedBytesLimit ? "warn" : "ok",
    source: "pg_stat_user_indexes: idx_scan = 0",
    detail: unused.length > 0 ? `крупнейший: ${unused[0]?.index ?? "—"}` : null,
  });

  // 8. Invalid (broken) indexes — a failing index is a correctness problem.
  criteria.push({
    id: "invalid-indexes",
    title: "Некорректные индексы",
    threshold: "= 0",
    value: String(payload.invalidIndexCount),
    verdict: payload.invalidIndexCount === 0 ? "ok" : "fail",
    source: "pg_index WHERE NOT indisvalid",
    detail: payload.invalidIndexCount > 0 ? "требуется REINDEX, индексы не обслуживают запросы" : null,
  });

  // 9. Dead tuples: worst table, since one table is enough to matter.
  const worstDead = payload.tables
    .filter((table) => table.liveRows + table.deadRows > 0)
    .map((table) => ({
      table: table.table,
      ratio: (table.deadRows / (table.liveRows + table.deadRows)) * 100,
      dead: table.deadRows,
    }))
    .sort((a, b) => b.ratio - a.ratio)[0];
  criteria.push({
    id: "dead-tuples",
    title: "Мёртвые строки (худшая таблица)",
    threshold: "≤ 10 %",
    value: worstDead ? `${worstDead.table}: ${percent(worstDead.ratio, 1)} (${worstDead.dead})` : "нет данных",
    verdict: !worstDead ? "unknown" : worstDead.ratio <= 10 ? "ok" : "warn",
    source: "pg_stat_user_tables.n_dead_tup / (n_live_tup + n_dead_tup)",
    detail: null,
  });

  // 10-11. Autovacuum thresholds (the audit asked for 0.05 / 0.02).
  const vacuumScale = settingValue(payload, "autovacuum_vacuum_scale_factor");
  criteria.push({
    id: "autovacuum-vacuum",
    title: "autovacuum_vacuum_scale_factor",
    threshold: "≤ 0.05",
    value: vacuumScale ?? "нет данных",
    verdict: vacuumScale === null ? "unknown" : Number(vacuumScale) <= 0.05 ? "ok" : "warn",
    source: "pg_settings",
    detail: null,
  });
  const analyzeScale = settingValue(payload, "autovacuum_analyze_scale_factor");
  criteria.push({
    id: "autovacuum-analyze",
    title: "autovacuum_analyze_scale_factor",
    threshold: "≤ 0.05",
    value: analyzeScale ?? "нет данных",
    verdict: analyzeScale === null ? "unknown" : Number(analyzeScale) <= 0.05 ? "ok" : "warn",
    source: "pg_settings",
    detail: null,
  });

  // 12. JIT: off for a short-query OLTP workload.
  const jit = settingValue(payload, "jit");
  criteria.push({
    id: "jit",
    title: "jit",
    threshold: "off",
    value: jit ?? "нет данных",
    verdict: jit === null ? "unknown" : jit === "off" ? "ok" : "warn",
    source: "pg_settings",
    detail: jit !== null && jit !== "off" ? "коротким запросам JIT добавляет только компиляцию" : null,
  });

  // 13. WAL compression: lz4 is cheaper than pglz at the same ratio (PG17).
  const walCompression = settingValue(payload, "wal_compression");
  criteria.push({
    id: "wal-compression",
    title: "wal_compression",
    threshold: "lz4",
    value: walCompression ?? "нет данных",
    verdict:
      walCompression === null ? "unknown" : walCompression === "lz4" ? "ok" : "warn",
    source: "pg_settings",
    detail:
      walCompression !== null && walCompression !== "lz4" && walCompression !== "off"
        ? "pglz дешевле заменить на lz4 при том же сжатии"
        : null,
  });

  // 14. work_mem against the container's memory budget.
  const workMem = bytesSetting(payload, "work_mem");
  const workMemLimit = 16 * 1024 * 1024;
  criteria.push({
    id: "work-mem",
    title: "work_mem",
    threshold: "≤ 16 МиБ",
    value: workMem === null ? "нет данных" : prettyBytes(workMem),
    verdict: workMem === null ? "unknown" : workMem <= workMemLimit ? "ok" : "warn",
    source: "pg_settings.work_mem",
    detail: null,
  });

  // 15. effective_cache_size must stay a multiple of shared_buffers.
  const sharedBuffers = bytesSetting(payload, "shared_buffers");
  const effectiveCache = bytesSetting(payload, "effective_cache_size");
  const cacheOk =
    sharedBuffers === null || effectiveCache === null ? null : effectiveCache >= sharedBuffers * 2;
  criteria.push({
    id: "effective-cache-size",
    title: "effective_cache_size",
    threshold: "≥ 2 × shared_buffers",
    value:
      effectiveCache === null || sharedBuffers === null
        ? "нет данных"
        : `${prettyBytes(effectiveCache)} при shared_buffers ${prettyBytes(sharedBuffers)}`,
    verdict: cacheOk === null ? "unknown" : cacheOk ? "ok" : "warn",
    source: "pg_settings.effective_cache_size / shared_buffers",
    detail: null,
  });

  // 16. Connection usage.
  const maxConnections = payload.databaseStats.maxConnections;
  const connectionShare = maxConnections > 0 ? (payload.databaseStats.backends / maxConnections) * 100 : null;
  criteria.push({
    id: "connections",
    title: "Занятые соединения",
    threshold: "≤ 80 % от max_connections",
    value:
      connectionShare === null
        ? "нет данных"
        : `${payload.databaseStats.backends} из ${maxConnections} (${percent(connectionShare, 1)})`,
    verdict: connectionShare === null ? "unknown" : connectionShare <= 80 ? "ok" : "warn",
    source: "pg_stat_database.numbackends / pg_settings.max_connections",
    detail: null,
  });

  // 17. Backup freshness — the release gate of the project depends on it.
  const backupAge = payload.backup.ageHours;
  criteria.push({
    id: "backup-freshness",
    title: "Свежесть бэкапа базы",
    threshold: "≤ 24 ч",
    value:
      backupAge === null
        ? `нет бэкапа в ${payload.backup.dir}`
        : `${payload.backup.latestFile ?? "—"} (${backupAge.toFixed(1)} ч, ${prettyBytes(payload.backup.bytes ?? 0)})`,
    verdict: backupAge === null ? "fail" : backupAge <= 24 ? "ok" : "fail",
    source: `каталог бэкапов ${payload.backup.dir}`,
    detail: backupAge === null ? "перед финальным релизом бэкап обязателен" : null,
  });

  // 18-19. Optional, extension-gated metrics: printed only when present.
  if (payload.optional.pgvector) {
    const columns = payload.optional.pgvector.columns;
    const unindexed = columns.filter((column) => !column.indexed);
    criteria.push({
      id: "pgvector-indexed",
      title: "pgvector: колонки с индексом",
      threshold: "все колонки проиндексированы",
      value: `${columns.length - unindexed.length} из ${columns.length}`,
      verdict: columns.length === 0 ? "unknown" : unindexed.length === 0 ? "ok" : "warn",
      source: "pg_extension = vector, pg_attribute/pg_index",
      detail:
        unindexed.length > 0
          ? `без индекса: ${unindexed.map((column) => `${column.table}.${column.column}`).join(", ")}`
          : null,
    });
  }
  if (payload.optional.fullTextSearch?.available) {
    criteria.push({
      id: "full-text-search",
      title: "Полнотекстовый поиск",
      threshold: "справочник конфигураций доступен",
      value: `${payload.optional.fullTextSearch.tsvectorColumns} tsvector-колонок, ${payload.optional.fullTextSearch.configurations} конфигураций`,
      verdict: "ok",
      source: "pg_ts_config, pg_attribute/pg_type",
      detail: null,
    });
  }

  return criteria;
}

/** Counts the verdicts; the API answer and the report header both use it. */
export function summarizeCriteria(
  criteria: AuditCriterion[],
  payload: DatastoreSnapshotPayload,
): AuditSummary {
  const ok = criteria.filter((criterion) => criterion.verdict === "ok").length;
  const warn = criteria.filter((criterion) => criterion.verdict === "warn").length;
  const fail = criteria.filter((criterion) => criterion.verdict === "fail").length;
  const unknown = criteria.filter((criterion) => criterion.verdict === "unknown").length;
  const worst: AuditVerdict = fail > 0 ? "fail" : warn > 0 ? "warn" : ok > 0 ? "ok" : "unknown";
  return {
    ok,
    warn,
    fail,
    unknown,
    worst,
    databaseBytes: payload.databaseBytes,
    databasePretty: prettyBytes(payload.databaseBytes),
    topQueries: payload.topQueries.length,
    statStatementsAvailable: payload.statStatementsAvailable,
  };
}

const VERDICT_LABEL: Record<AuditVerdict, string> = {
  ok: "норма",
  warn: "внимание",
  fail: "нарушение",
  unknown: "нет данных",
};

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

function truncateQuery(query: string, limit = 160): string {
  const single = query.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

/** What the markdown export needs; everything is measured data. */
export interface AuditReportInput {
  target: DatastoreTarget;
  generatedAt: string;
  trigger: string;
  snapshotId: string | null;
  payload: DatastoreSnapshotPayload;
  criteria: AuditCriterion[];
  summary: AuditSummary;
}

/**
 * Builds the markdown the API exports as `<target>-db-audit-<ts>.md`.
 *
 * The layout follows the manual audit of the project (OPE-4270): identity,
 * criteria with values, sizes, TOAST, indexes, top queries, server parameters,
 * backup — so the two can be compared line by line.
 */
export function buildAuditReportMarkdown(input: AuditReportInput): string {
  const { payload, criteria, summary, target } = input;
  const lines: string[] = [];

  lines.push(`# Аудит базы доски — цель \`${target.key}\` (DBC-4, автоотчёт)`);
  lines.push("");
  lines.push(`- Сформирован: ${input.generatedAt} (запрос: ${input.trigger})`);
  lines.push(`- База: ${payload.database} (dbid ${payload.dbId ?? "—"}), ${payload.serverVersion.split(",")[0] ?? ""}`);
  lines.push(`- Соединение: ${payload.connectionRef}; снимок: ${input.snapshotId ?? "нет (отчёт по живым метрикам)"}`);
  lines.push(`- Объём базы: ${summary.databasePretty} (pg_database_size, ±1 % от ручного \`psql\`)`);
  lines.push(
    `- Критерии: норма ${summary.ok} · внимание ${summary.warn} · нарушение ${summary.fail} · нет данных ${summary.unknown}`,
  );
  lines.push("");
  lines.push("## Критерии (раздел 6)");
  lines.push("");
  // The id is the key the API and the release gate read (`.criteria[].id`), so
  // the exported file can be diffed against the JSON without matching titles.
  lines.push("| # | id | Критерий | Порог | Значение | Итог | Источник |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  criteria.forEach((criterion, index) => {
    lines.push(
      `| ${index + 1} | ${escapeCell(criterion.id)} | ${escapeCell(criterion.title)} | ${escapeCell(criterion.threshold)} | ${escapeCell(criterion.value)} | ${VERDICT_LABEL[criterion.verdict]} | ${escapeCell(criterion.source)} |`,
    );
  });
  const withDetail = criteria.filter((criterion) => criterion.detail);
  if (withDetail.length > 0) {
    lines.push("");
    for (const criterion of withDetail) {
      lines.push(`- **${criterion.title}** — ${criterion.detail}`);
    }
  }

  lines.push("");
  lines.push("## Размеры");
  lines.push("");
  lines.push(`- База: ${prettyBytes(payload.databaseBytes)}`);
  lines.push(
    `- Таблицы (${payload.tables.length} крупнейших): ${prettyBytes(payload.tablesBytes)}; из них TOAST ${prettyBytes(payload.toastBytes)}, индексы таблиц ${prettyBytes(payload.indexBytes)}`,
  );
  lines.push("");
  lines.push("| Таблица | Всего | Heap | TOAST | Индексы | Живых строк | Мёртвых |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const table of payload.tables) {
    lines.push(
      `| ${escapeCell(table.table)} | ${prettyBytes(table.totalBytes)} | ${prettyBytes(table.heapBytes)} | ${prettyBytes(table.toastBytes)} | ${prettyBytes(table.indexBytes)} | ${table.liveRows} | ${table.deadRows} |`,
    );
  }

  lines.push("");
  lines.push("## TOAST");
  lines.push("");
  const toastTables = payload.tables
    .filter((table) => table.toastBytes > 0)
    .sort((a, b) => b.toastBytes - a.toastBytes)
    .slice(0, 10);
  if (toastTables.length === 0) {
    lines.push("TOAST-отношений с данными не найдено.");
  } else {
    lines.push("| Таблица | TOAST | Доля таблицы |");
    lines.push("| --- | --- | --- |");
    for (const table of toastTables) {
      const share = table.totalBytes > 0 ? (table.toastBytes / table.totalBytes) * 100 : 0;
      lines.push(`| ${escapeCell(table.table)} | ${prettyBytes(table.toastBytes)} | ${percent(share, 1)} |`);
    }
  }

  lines.push("");
  lines.push("## Индексы");
  lines.push("");
  const unusedIndexes = payload.indexes.filter((index) => index.scans === 0);
  const unusedBytes = unusedIndexes.reduce((sum, index) => sum + index.bytes, 0);
  lines.push(
    `- Всего индексов: ${payload.indexCount}; неиспользуемых (idx_scan = 0): ${unusedIndexes.length} на ${prettyBytes(unusedBytes)}; некорректных: ${payload.invalidIndexCount}`,
  );
  lines.push("");
  lines.push("| Индекс | Таблица | Размер | Сканов |");
  lines.push("| --- | --- | --- | --- |");
  for (const index of payload.indexes.slice(0, 15)) {
    lines.push(
      `| ${escapeCell(index.index)} | ${escapeCell(index.table)} | ${prettyBytes(index.bytes)} | ${index.scans} |`,
    );
  }

  lines.push("");
  lines.push(`## Топ-${payload.topQueries.length} запросов (pg_stat_statements)`);
  lines.push("");
  if (!payload.statStatementsAvailable) {
    lines.push("`pg_stat_statements` не установлено — топ запросов недоступен.");
  } else if (payload.topQueries.length === 0) {
    lines.push("`pg_stat_statements` установлено, но записей нет (сброшена статистика).");
  } else {
    const share = topQueriesShare(payload);
    lines.push(
      `- Суммарное время всех запросов: ${(payload.topQueriesTotalMs / 1000).toFixed(1)} с; на топ-${payload.topQueries.length} приходится ${share === null ? "—" : percent(share, 1)}`,
    );
    lines.push("");
    lines.push("| # | queryid | Вызовов | Всего, с | Среднее, мс | Строк | Доля | Запрос |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    payload.topQueries.forEach((query: DatastoreTopQueryMetric, index: number) => {
      const queryShare =
        payload.topQueriesTotalMs > 0 ? (query.totalMs / payload.topQueriesTotalMs) * 100 : 0;
      lines.push(
        `| ${index + 1} | ${escapeCell(query.queryId)} | ${query.calls} | ${(query.totalMs / 1000).toFixed(1)} | ${query.meanMs.toFixed(2)} | ${query.rows} | ${percent(queryShare, 1)} | \`${escapeCell(truncateQuery(query.query))}\` |`,
      );
    });
  }

  lines.push("");
  lines.push("## Параметры сервера");
  lines.push("");
  lines.push("| Параметр | Значение |");
  lines.push("| --- | --- |");
  for (const setting of payload.settings) {
    lines.push(`| ${escapeCell(setting.name)} | ${escapeCell(setting.unit ? `${setting.value} ${setting.unit}` : setting.value)} |`);
  }

  lines.push("");
  lines.push("## Бэкап");
  lines.push("");
  if (!payload.backup.available) {
    lines.push(`- Бэкапа нет: ${payload.backup.dir} (${payload.backup.note ?? "нет файлов"})`);
  } else {
    lines.push(
      `- Каталог: ${payload.backup.dir}; файлов ${payload.backup.fileCount}; последний: ${payload.backup.latestFile} (${payload.backup.latestAt}, возраст ${payload.backup.ageHours ?? "—"} ч, ${prettyBytes(payload.backup.bytes ?? 0)})`,
    );
  }

  if (payload.warnings.length > 0) {
    lines.push("");
    lines.push("## Предупреждения сбора");
    lines.push("");
    for (const warning of payload.warnings) lines.push(`- ${warning}`);
  }

  lines.push("");
  lines.push("## Как проверить вручную");
  lines.push("");
  lines.push("```sql");
  lines.push("SELECT pg_size_pretty(pg_database_size(current_database()));");
  lines.push(
    "SELECT queryid, calls, total_exec_time, mean_exec_time FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 25;",
  );
  lines.push("SELECT indexrelname, pg_relation_size(indexrelid), idx_scan FROM pg_stat_user_indexes ORDER BY 2 DESC LIMIT 15;");
  lines.push("```");
  lines.push("");
  lines.push(
    "Отчёт только измеряет: правила и действия (rules/actions) в модуле отсутствуют, ничего в базе не меняется.",
  );
  lines.push("");

  return lines.join("\n");
}