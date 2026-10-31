# Справочник runtime возможностей (capabilities) плагинов

Плагины в Myrmidon работают в изолированных процессах и взаимодействуют с плоскостью управления (control plane) через изолированный хост-мост без передачи прямых учётных данных. Доступ к операциям системы строго разграничен системой прав (capabilities): каждый плагин статически объявляет требуемые возможности в своём манифесте, а хост проверяет наличие прав перед выполнением каждой операции воркера.

## Обзор возможностей плагинов

Возможности обязательны и статичны. Каждый плагин перечисляет их в массиве `manifest.capabilities`. Хост проверяет поступающие RPC-вызовы и отклоняет любые операции, не входящие в согласованный набор (`CapabilityDeniedError`).

### Основные группы возможностей

- **Задачи (issues)**: `issues.read`, `issues.create`, `issues.update`, `issues.checkout`, `issues.wakeup`
- **Обсуждения задач**: `issue.comments.read`, `issue.comments.create`, `issue.comments.create_human_attributed`, `issue.interactions.create`, `issue.interactions.read`, `issue.interactions.respond`
- **Вложения задач**: `issue.attachments.read`, `issue.attachments.write`
- **Документы и связи**: `issue.documents.read`, `issue.documents.write`, `issue.relations.read`, `issue.relations.write`, `issue.subtree.read`
- **Агенты и сессии**: `agents.read`, `agents.managed`, `agents.pause`, `agents.resume`, `agents.invoke`, `agent.sessions.create`, `agent.sessions.list`, `agent.sessions.send`, `agent.sessions.close`
- **Система и состояние**: `activity.read`, `activity.log.write`, `plugin.state.read`, `plugin.state.write`, `database.namespace.read`, `database.namespace.write`, `secrets.read-ref`

---

## Возможности работы с вложениями задач

Плагины автоматизации часто создают артефакты, отчёты и диагностические файлы. Работу с вложениями регулируют две возможности:

| Capability | Область | Методы хоста | Назначение |
|---|---|---|---|
| `issue.attachments.read` | Чтение | `issues.listAttachments`, `issues.getAttachmentContent` | Чтение метаданных вложений и выгрузка байтового содержимого с ограничением по размеру. |
| `issue.attachments.write` | Запись | `issues.uploadAttachment` | Загрузка ограниченных файлов в задачу через изолированный хост-мост. |

### `issue.attachments.write`

#### Назначение
Позволяет фоновым воркерам плагинов (коннекторам, процессам оркестрации, внешним синхронизаторам) прикреплять ограниченные файлы (дампы логов, тестовые подтверждения, выгрузки отчётов) напрямую к задачам без необходимости передачи в плагин административных ключей доски, токенов авторизации или прямого доступа к базе данных.

Типовой сценарий:
1. Плагин оркестрации создаёт задачу через `ctx.issues.create`.
2. Плагин прикрепляет файл с подтверждением или отчётом через `ctx.issues.uploadAttachment`.
3. Вложение регистрируется в задаче, сохраняется в постоянном хранилище инстанса и фиксируется в журнале аудита.

#### Риски и защитные механизмы

| Риск | Влияние | Защитный механизм / Ограничение |
|---|---|---|
| **Переполнение хранилища** | Неконтролируемый рост диска или S3-бакета | Жёсткий лимит в 10 МБ (`MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024`). Файлы большего размера немедленно отклоняются. |
| **Исполняемые и опасные файлы** | Угроза безопасности от загрузки вредоносного ПО | Строгий белый список MIME-типов: `application/pdf`, `application/json`, `text/plain`, `text/markdown`, `text/csv`, `image/png`, `image/jpeg`. Исполняемые файлы и скрипты отклоняются. |
| **Повреждённые данные** | Нарушение целостности данных | Передаваемое содержимое проверяется на канонический base64. Повреждённые или невалидные строки отклоняются. |
| **Утечка данных между компаниями** | Доступ плагина к задачам других организаций | Обязательная проверка принадлежности задачи компании вызывающего контекста (`companyId`). Доступ вне области компании запрещён. |
| **Подмена авторства** | Неотслеживаемые или поддельные загрузки | Каждая загрузка создаёт запись аудита в `activityLog` (`action: "issue.attachment.uploaded"`) с фиксацией плагина, ID вложения, размера, типа и действующего актора (агента или пользователя). |

#### Порядок включения и согласование оператором

1. **Декларация в манифесте**: Разработчик плагина указывает `"issue.attachments.write"` в списке `capabilities` манифеста (`manifest.ts`):
   ```ts
   capabilities: [
     "issues.read",
     "issues.create",
     "issue.attachments.write",
   ],
   ```
2. **Проверка и утверждение оператором**:
   - При установке или обновлении плагина оператор видит список всех запрашиваемых прав.
   - Добавление `issue.attachments.write` переводит обновлённую версию в статус `upgrade_pending` до явного одобрения оператором.
   - Без одобрения оператора вызовы `uploadAttachment` отклоняются с ошибкой `CapabilityDeniedError`.

#### Пример использования в SDK

```ts
// В воркере плагина или обработчике действий:
const issue = await ctx.issues.create({
  companyId,
  projectId,
  title: "Результаты автоматической проверки",
  status: "todo",
  priority: "medium",
});

const attachment = await ctx.issues.uploadAttachment({
  issueId: issue.id,
  companyId,
  filename: "scan-summary.json",
  contentType: "application/json",
  contentBase64: Buffer.from(JSON.stringify({ status: "passed", findings: 0 })).toString("base64"),
  actor: {
    actorAgentId: agentId,
  },
});

console.log(`Загружено вложение ${attachment.id} (${attachment.byteSize} байт)`);
```
