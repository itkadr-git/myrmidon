# Site-Agent Security Regression Harness (1.6.6 T10-A)

> **Статус документа:** Инженерная подготовка T10-A к 1.6.6 (OPE-8109 / OPE-7657 / OPE-7605).  
> **Область:** Автономный регрессионный security harness и тестовый адаптер site-agent / fleetd без live Docker и боевых ключей.  
> **Ограничение:** Не является финальным security sign-off и не заменяет подпись `adm-security`. Отсутствующие production-точки зафиксированы как `GAPS` для поставок T2/T10.

---

## 1. Назначение компонента

Автономный регрессионный harness для проверки инвариантов безопасности site-agent (`fleetd`, порт `:8444`):
- Односторонний management plane (board → site) без обратных credentials.
- mTLS с взаимной проверкой сертификатов клиента (`site-ca`) и Bearer token.
- Allowlist образов строго с immutable sha256-дайджестом (`ghcr.io/itkadr-git/*@sha256:...`).
- Изоляция монтирований и путей (`validateExtraMounts`).
- Режим секретных файлов 0600 и отсутствие утечек маркеров в status/logs.
- Валидация фиксированного runtime-шаблона (ro-rootfs, CapDrop ALL, UID 10001).

---

## 2. Компоненты Harness

| Компонент | Путь | Назначение |
|---|---|---|
| **Test PKI Generator** | `server/src/myrmidon/bot-containers/site-agent-pki.ts` | Генерация эфемерных CA, серверных и клиентских сертификатов в `$PAPERCLIP_SCRATCH_DIR` или `$HOME/.myrmidon-scratch`. Fallback в `/tmp` и `os.tmpdir()` запрещён. |
| **Site-Agent Test Adapter** | `server/src/myrmidon/bot-containers/site-agent-test-adapter.ts` | Клиентский адаптер управления site-agent через mTLS (не вторая реализация сервера). Подключается к mTLS endpoint. |
| **Security Harness Engine** | `server/src/myrmidon/bot-containers/site-agent-security-harness.ts` | Движок верификации негативных сценариев с валидаторами образов, монтирований, env, профилей, directionality и runtime template. |
| **Vitest Test Suite** | `server/src/myrmidon/bot-containers/site-agent-security-harness.myrmidon.test.ts` | Автоматический Vitest-сьют для CI. |
| **CLI Runner** | `scripts/myrmidon/security/run-site-agent-security-harness.mjs` | Автономный исполняемый скрипт без внешних зависимостей. Запуск: `node scripts/myrmidon/security/run-site-agent-security-harness.mjs`. |

---

## 3. Матрица Негативных Сценариев (10 Сценариев)

| ID | Категория | Сценарий | Ожидаемое поведение | Статус |
|---|---|---|---|---|
| **NEG-01** | mTLS | **Missing Client Certificate** | Запрос без клиентского сертификата к mTLS site-agent отвергается на этапе TLS handshake (`certificate required` / 400/403). | **PASS** |
| **NEG-02** | mTLS | **Foreign / Untrusted CA** | Сертификат клиента, подписанный чужим CA (`foreign-ca`), отвергается handshake (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). | **PASS** |
| **NEG-03** | mTLS | **Expired Client Certificate** | Сертификат клиента с истекшим `notAfter` (в прошлом) отвергается handshake (`CERT_HAS_EXPIRED`). | **PASS** |
| **NEG-04** | Allowlist | **Unknown Image Reference** | Образ вне allowlist (например, `docker.io/untrusted/agent@sha256:...`) отклоняется валидатором `image_not_in_allowlist`. | **PASS** |
| **NEG-05** | Allowlist | **Tag Without Digest** | Образ с тегом без дайджеста (например, `:latest`) отклоняется: требуется `@sha256:...`. | **PASS** |
| **NEG-06** | Mounts | **Arbitrary Mount & Traversal** | Монтирование неразрешённых путей (`/etc/shadow`) или путей с `..` отклоняется `validateExtraMounts`. | **PASS** |
| **NEG-07** | Env | **Arbitrary Env Injection** | Попытка передать произвольные переменные окружения (`LD_PRELOAD`, `EVIL_ADMIN_TOKEN`) отклоняется шаблоном. | **PASS** |
| **NEG-08** | Profile | **Malformed Path & Secret Mode** | Пути с traversal (`hermes/../escape`) или секретные файлы с правами, отличными от `0600`, отклоняются. | **PASS** |
| **NEG-09** | Secrets | **Secret Marker Leak Prevention** | Секретный маркер (`OPE8109_SECRET_MARKER_...`) пишется с правами `0600` и отсутствует в `status`, drift и логах. | **PASS** |
| **NEG-10** | Invariants | **Prohibition of Site→Core Creds** | Конфигурация site-agent отклоняет любые обратные ключи/токены доски (нет SSH-ключей ядра, нет токенов доски). | **PASS** |

---

## 4. Зафиксированные Production Gaps для T2 / T10

В соответствии с правилом честной сдачи (без skip-as-pass и без ложного security sign-off):

1. **GAP-1 (mTLS в daemon `fleetd`):**  
   В `origin/main` демон `tools/fleetd/cmd/fleetd/main.go` пока слушает plain HTTP. Поддержка mTLS (`SiteCA`, `ServerCert`, `ServerKey`, `tls.RequireAndVerifyClientCert`) подготовлена в ветке `origin/eng-19/OPE-7649-site-agent-v4` и ожидает интеграции в T2.
2. **GAP-2 (Site-CA дистрибуция и ротация):**  
   Генерация боевого site-ca и регламент 90-дневной ротации с перекрывающимся двойным сертификатом настраивается централизованно в задаче T1/T10.
3. **GAP-3 (Граница Docker socket и исполнение runtime-шаблона):**  
   Исполнение `BotContainerSpec` через локальный Docker socket на удалённом хосте и валидация фиксированного runtime-шаблона (ReadonlyRootfs, CapDrop ALL, UID 10001 non-root) переносит политику `dockergate` в Go-сервер `fleetd` в рамках T2. В `origin/main` демон `fleetd` предоставляет только шов проверки лимитов (`/template-drift`). Тесты для неподключённых проверок не помечаются как пройденные (без skip-as-pass).
4. **GAP-4 (Egress-валидация через `/v1/health`):**  
   Проверка выхода в интернет через NL (sing-box TUN на myr-vm1) валидируется полем `egressCheck` в T4/T10.
5. **GAP-5 (Статус приемки):**  
   Данная работа является инженерной подготовкой T10-A. Финальный security sign-off и подписание чек-листа §6 производится инженером `adm-security` на боевой канарейке перед этапом T7.

---

## 5. Способ подключения для родительской задачи (OPE-7657 / OPE-7605)

Для подключения к site-agent из родительского кода (reconciler, router, health-checker):
```typescript
import { createSiteAgentTestAdapter } from "./server/src/myrmidon/bot-containers/site-agent-test-adapter.js";

const client = createSiteAgentTestAdapter({
  baseUrl: "https://127.0.0.1:8444",
  token: process.env.MYRMIDON_FLEET_HOST_TOKEN,
  caCert: siteCaPem,
  clientCert: boardClientCertPem,
  clientKey: boardClientKeyPem,
});

// Проверка здоровья
const health = await client.health();

// Проверка статуса бота
const status = await client.status("work-finansist");
```
