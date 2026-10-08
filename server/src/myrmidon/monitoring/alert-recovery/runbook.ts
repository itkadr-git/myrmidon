import { normalizeAlertTrigger } from "@paperclipai/shared";

/**
 * The runbook registry of alert recovery (myrmidon 1.6.6 MONITORING, part D).
 *
 * A trigger key selects one runbook: the numbered recovery steps, the role that
 * owns the recovery, the metric the role checks afterwards, and the document
 * that holds the same steps for people (a repository document under
 * `docs/myrmidon/runbooks/`). The document is part of the contract — the task
 * links to it by key, and a test fails when a registered runbook has no
 * document.
 *
 * Selection is deterministic: an exact trigger match wins, then the longest
 * matching pattern, then the generic runbook. The patterns are lowercase
 * fragments of the trigger names the two alert sources actually use (`disk`,
 * `unreachable`, `scrape` for Zabbix and Prometheus respectively), so a
 * renamed host never changes the runbook a trigger resolves to.
 */

export interface AlertRecoveryRunbook {
  /** Trigger key: stable, lowercase, the name the runbook is registered under. */
  key: string;
  /** Human title of the problem, as the task and the document name it. */
  title: string;
  /** Role key that owns the recovery (a company caste key). */
  ownerRole: string;
  /** Runbook document, repository-relative. */
  document: string;
  /** The metric the owner checks after walking the steps. */
  metric: string;
  /** Ordered recovery steps. */
  steps: readonly string[];
  /** Lowercase fragments of trigger names that select this runbook. */
  match: readonly string[];
}

const DOCUMENT_DIR = "docs/myrmidon/runbooks";

/** The runbook of a host whose disk filled up — the earliest warning of the fleet. */
export const DISK_SPACE_LOW_RUNBOOK: AlertRecoveryRunbook = {
  key: "disk-space-low",
  title: "Диск на хосте заполнен",
  ownerRole: "devops",
  document: `${DOCUMENT_DIR}/disk-space-low.md`,
  metric: "df -h /data — usedPercent ниже порога внимания (hostDisk: 85 %)",
  steps: [
    "Убедиться в тревоге: `df -h` — какой раздел переполнен и на сколько процентов.",
    "Найти крупнейшее: `du -xh --max-depth=2 /data | sort -h | tail -20`.",
    "Проверить рабочие каталоги ботов (`/data/bot-workspaces/*`, `/workspace/*/repo`): снести копии репозиториев, `node_modules` и сборки закрытых задач.",
    "Убрать журналы и временные файлы старше семи дней (`/data/logs`, отладочные дампы в scratch-каталогах).",
    "Проверить docker: `docker system df`, снять висящие образы и слои (`docker image prune`). Образ доски из CI не трогать — он нужен выкату.",
    "Проверить бэкапы (`/data/backups`) и удалить те, что вышли за retention.",
    "Проверить метрику ещё раз и дождаться, пока тревога снимется в Zabbix.",
  ],
  match: ["disk", "filesystem", "space", "заполнен диск", "нет места"],
};

/** The runbook of a host that stopped answering — Zabbix agent or the host itself. */
export const HOST_UNREACHABLE_RUNBOOK: AlertRecoveryRunbook = {
  key: "host-unreachable",
  title: "Хост недоступен",
  ownerRole: "devops",
  document: `${DOCUMENT_DIR}/host-unreachable.md`,
  metric: "agent.ping = 1 у хоста (zabbix_get -s <host> -k agent.ping)",
  steps: [
    "Проверить доступность хоста: `ping -c3 <host>` и `ssh <host> true`.",
    "Если хост жив, а агент молчит — проверить службу: `systemctl status zabbix-agent`, перезапустить при необходимости.",
    "Посмотреть, не умер ли хост по памяти: журнал OOM (`dmesg | grep -i oom`) и свободная память.",
    "Проверить файрвол и маршрут между сервером мониторинга и хостом (порт 10050).",
    "Если хост не поднимается — перевести его задачи на резервный хост и выдать задачу на восстановление железа.",
    "Проверить метрику: агент отвечает, тревога снята.",
  ],
  match: ["unreachable", "host down", "icmp", "zabbix agent", "недоступен"],
};

/** The runbook of a scrape target that stopped answering — Prometheus side of the alerting. */
export const METRICS_SCRAPE_FAILING_RUNBOOK: AlertRecoveryRunbook = {
  key: "metrics-scrape-failing",
  title: "Метрики цели не собираются",
  ownerRole: "devops",
  document: `${DOCUMENT_DIR}/metrics-scrape-failing.md`,
  metric: "Prometheus target UP = 1 и selfcheck доски отвечает 200",
  steps: [
    "Проверить эндпоинт цели вручную: `curl -sS -o /dev/null -w '%{http_code}\\n' http://<target>:3100/api/myrmidon/monitoring/selfcheck`.",
    "Проверить, что сама доска жива: `curl -sS http://<target>:3100/api/health`.",
    "Посмотреть страницу Prometheus → Targets: текст ошибки скрейпа (таймаут, 401, 404).",
    "Проверить токен и сеть между Prometheus и целью: адрес, порт, TLS, заголовок авторизации.",
    "Проверить нагрузку на цель: таймаут скрейпа лечится таймаутом опроса, а не его учащением.",
    "Проверить метрику: цель снова UP, тревога снята.",
  ],
  match: ["scrape", "prometheus", "target down", "метрики"],
};

/** Named runbooks, in the order the settings page lists them. */
export const ALERT_RECOVERY_RUNBOOKS: readonly AlertRecoveryRunbook[] = [
  DISK_SPACE_LOW_RUNBOOK,
  HOST_UNREACHABLE_RUNBOOK,
  METRICS_SCRAPE_FAILING_RUNBOOK,
];

/**
 * The runbook of a trigger nobody wrote one for: the task still carries steps
 * and a document, so the owner role is never left without instructions.
 */
export const ALERT_RECOVERY_DEFAULT_RUNBOOK: AlertRecoveryRunbook = {
  key: "generic",
  title: "Тревога без своего runbook",
  ownerRole: "devops",
  document: `${DOCUMENT_DIR}/generic.md`,
  metric: "метрика, по которой зажглась тревога, вернулась в норму",
  steps: [
    "Определить источник тревоги (Zabbix или Alertmanager) и метрику, по которой она зажглась.",
    "Проверить метрику вручную на затронутых хостах — не снялась ли тревога сама.",
    "Устранить причину по существу: перезапуск службы, освобождение места, снятие блокировки, замена хоста.",
    "Проверить, что метрика вернулась в норму и тревога снята в источнике.",
    "Если у тревоги будет свой runbook — добавить его в реестр (`server/src/myrmidon/monitoring/alert-recovery/runbook.ts`) и документ в `docs/myrmidon/runbooks/`.",
  ],
  match: [],
};

/** Every runbook the module knows, the generic one last. */
export function alertRecoveryRunbooks(): AlertRecoveryRunbook[] {
  return [...ALERT_RECOVERY_RUNBOOKS, ALERT_RECOVERY_DEFAULT_RUNBOOK];
}

/** One runbook by key, or null — the settings page and the tests read it this way. */
export function alertRecoveryRunbookByKey(key: string): AlertRecoveryRunbook | null {
  const normalized = normalizeAlertTrigger(key);
  return alertRecoveryRunbooks().find((runbook) => runbook.key === normalized) ?? null;
}

/**
 * The runbook of one trigger: an exact trigger match wins (the key itself is a
 * pattern too), then the longest matching fragment, then the generic runbook.
 */
export function selectAlertRecoveryRunbook(trigger: string): AlertRecoveryRunbook {
  const normalized = normalizeAlertTrigger(trigger);
  if (!normalized) return ALERT_RECOVERY_DEFAULT_RUNBOOK;

  const candidates: Array<{ runbook: AlertRecoveryRunbook; score: number }> = [];
  for (const runbook of ALERT_RECOVERY_RUNBOOKS) {
    const patterns = [runbook.key, ...runbook.match];
    for (const pattern of patterns) {
      const needle = normalizeAlertTrigger(pattern);
      if (!needle) continue;
      if (normalized === needle) candidates.push({ runbook, score: 1000 + needle.length });
      else if (normalized.includes(needle)) candidates.push({ runbook, score: needle.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.runbook.key.localeCompare(b.runbook.key));
  return candidates[0]?.runbook ?? ALERT_RECOVERY_DEFAULT_RUNBOOK;
}

/**
 * The recovery section of the task: the runbook it came from, the document
 * link, the owner role, the checked metric and the numbered steps.
 */
export function renderAlertRecoverySection(
  runbook: AlertRecoveryRunbook,
  ownerRole: string = runbook.ownerRole,
): string {
  const lines: string[] = [
    "## Шаги восстановления",
    "",
    `Runbook: \`${runbook.key}\` — «${runbook.title}», документ \`${runbook.document}\``,
    `Владелец: роль \`${ownerRole}\``,
    `Проверяемая метрика: ${runbook.metric}`,
    "",
  ];
  runbook.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step}`);
  });
  lines.push(
    "",
    "Шаги walk-through выполняет владелец задачи; после них проверяется метрика выше.",
  );
  return lines.join("\n");
}