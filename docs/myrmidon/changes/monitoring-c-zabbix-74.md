---
settings-section: 1.6.6 — MONITORING C: fleet dashboard connections (VictoriaMetrics + Zabbix)
---

## changelog-en

### Fleet dashboard: Zabbix 7.4 client, additive settings PATCH, host mapping (1.6.6 MONITORING C)

- The Zabbix client now sends the token as `Authorization: Bearer` (never in the JSON-RPC `auth` body), and `apiinfo.version` selfcheck calls go out without auth headers — compatible with Zabbix 7.4, the `zbx-auth-shim` proxy is no longer needed.
- Dashboard item keys fall back per source in order: memory `vm.memory.utilization` → `vm.memory.util`, disk `vfs.fs.size[/,pused]` → `vfs.fs.dependent.size[/,pused]` — Zabbix 7.4 «Linux active» hosts show CPU, memory and disk instead of CPU-only.
- `PATCH /api/myrmidon/monitoring` is additive: omitted fields keep their stored values (patching `zabbixUrl` no longer nulls `vmUrl`); an explicit `null` still clears.
- New setting `zabbixHostMapping` (`{}` default) maps a VictoriaMetrics `instance` label (bare host or `host:port`) to a Zabbix host technical/visible name, merging both sources into one host card (no more `vm-core` twice); merged cards keep the VM metrics and fill CPU/memory/swap/disk gaps from Zabbix, and the build-VPS fleet rollup still resolves through the mapping.

## changelog-ru

### Дашборд флота: клиент Zabbix 7.4, аддитивный PATCH настроек, привязка хостов (1.6.6 MONITORING C)

- Клиент Zabbix теперь передаёт токен в `Authorization: Bearer` (никакого `auth` в теле JSON-RPC), а селфчек `apiinfo.version` уходит без заголовков авторизации — совместимо с Zabbix 7.4, прокладка `zbx-auth-shim` больше не нужна.
- Ключи items дашборда имеют запасные варианты по порядку: память `vm.memory.utilization` → `vm.memory.util`, диск `vfs.fs.size[/,pused]` → `vfs.fs.dependent.size[/,pused]` — хосты Zabbix 7.4 (шаблон «Linux active») показывают CPU, память и диск, а не только CPU.
- `PATCH /api/myrmidon/monitoring` аддитивный: незаданные поля сохраняют сохранённые значения (патч `zabbixUrl` больше не обнуляет `vmUrl`); явный `null` по-прежнему очищает.
- Новая настройка `zabbixHostMapping` (умолчание `{}`) сопоставляет метку `instance` VictoriaMetrics (голый хост или `host:port`) с техническим/видимым именем хоста Zabbix и объединяет оба источника в одну карточку (хост больше не задваивается); в объединённой карточке метрики VM приоритетны, пробелы CPU/память/swap/диск дополняются из Zabbix, а сборка build-VPS для экрана флота резолвится через маппинг.

## settings-en

| `myrmidonMonitoringDashboard.zabbixHostMapping` | 1.6.6 MONITORING C | `{}` | Maps a VictoriaMetrics `instance` label (bare host or `host:port`) to a Zabbix host technical name or visible name to combine both sources in one host card | — |

## settings-ru

| `myrmidonMonitoringDashboard.zabbixHostMapping` | 1.6.6 MONITORING C | `{}` | Сопоставляет метку `instance` VictoriaMetrics (голый хост или `host:port`) с техническим/видимым именем хоста Zabbix, объединяя оба источника в одну карточку хоста | — |
