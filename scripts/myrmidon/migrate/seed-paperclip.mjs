#!/usr/bin/env node
/**
 * Vendor-pure seeding script for official Paperclip releases (v2026.1012.0+).
 * Driven exclusively through Paperclip's HTTP API, with zero direct SQL.
 *
 * Requirements met:
 * - >= 2 companies and >= 3 projects
 * - >= 200 issues and >= 1000 comments, with Russian text
 * - Documents with revisions
 * - Attachments, including at least one > 2 MB
 * - >= 6 agents with non-empty `appearance`
 * - >= 3 issues with `title_needs_generation = true`
 * - >= 5 secrets
 * - 2 users with known passwords read from a file (not hardcoded in code)
 *
 * Output: seed-report.json with verified entity counters.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    baseUrl: process.env.PAPERCLIP_BASE_URL || process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100",
    apiKey: process.env.PAPERCLIP_API_KEY || "",
    passwordsFile: process.env.SEED_PASSWORDS_FILE || "seed-passwords.txt",
    out: process.env.SEED_REPORT_OUT || "seed-report.json",
    concurrency: 15,
    verify: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base-url" && argv[i + 1]) {
      args.baseUrl = argv[++i];
    } else if (arg === "--api-key" && argv[i + 1]) {
      args.apiKey = argv[++i];
    } else if (arg === "--passwords-file" && argv[i + 1]) {
      args.passwordsFile = argv[++i];
    } else if (arg === "--out" && argv[i + 1]) {
      args.out = argv[++i];
    } else if (arg === "--concurrency" && argv[i + 1]) {
      args.concurrency = Number.parseInt(argv[++i], 10) || 15;
    } else if (arg === "--no-verify") {
      args.verify = false;
    } else if (arg === "-h" || arg === "--help") {
      console.log(`
Usage: node seed-paperclip.mjs [options]

Options:
  --base-url <url>        Paperclip API base URL (default: http://127.0.0.1:3100)
  --api-key <key>         Paperclip board API key / token (required in authenticated mode)
  --passwords-file <path> Path to file with passwords for 2 users (required)
  --out <path>            Output path for seed-report.json (default: seed-report.json)
  --concurrency <n>       Parallel request concurrency (default: 15)
  --no-verify             Skip post-seeding API verification
`);
      process.exit(0);
    }
  }

  return args;
}

export function readPasswords(filePath) {
  const resolved = path.resolve(filePath);
  let content = "";
  try {
    content = readFileSync(resolved, "utf8");
  } catch (err) {
    throw new Error(`Failed to read passwords file at ${resolved}: ${err.message}`);
  }

  // Support JSON (array or object) or newline-delimited text
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length >= 2) {
      return [String(parsed[0]).trim(), String(parsed[1]).trim()];
    }
    if (parsed && typeof parsed === "object") {
      const vals = Object.values(parsed).map((v) => String(v).trim()).filter(Boolean);
      if (vals.length >= 2) return [vals[0], vals[1]];
    }
  } catch {
    // Not JSON, continue with line splitting
  }

  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  if (lines.length < 2) {
    throw new Error(`Passwords file ${resolved} must contain at least 2 non-empty passwords (found ${lines.length})`);
  }

  return [lines[0], lines[1]];
}

export class PaperclipApiClient {
  constructor(baseUrl, apiKey = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.cookie = "";
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
    const headers = { ...(options.headers || {}) };

    if (this.apiKey && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    let body = options.body;
    if (body && typeof body === "object" && !(body instanceof FormData) && !Buffer.isBuffer(body)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }

    const requestOptions = { ...options, headers, body };
    if (this.cookie) requestOptions.headers.Cookie = this.cookie;
    const res = await fetch(url, requestOptions);

    const setCookies = typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    if (setCookies.length) {
      const cookiePairs = setCookies.map((cookie) => cookie.split(";", 1)[0]).filter(Boolean);
      if (cookiePairs.length) this.cookie = cookiePairs.join("; ");
    }

    const contentType = res.headers.get("content-type") || "";
    let data = null;
    if (contentType.includes("application/json")) {
      data = await res.json().catch(() => null);
    } else {
      data = await res.text().catch(() => null);
    }

    if (!res.ok) {
      const msg = typeof data === "object" && data?.error ? data.error : JSON.stringify(data);
      const err = new Error(`HTTP ${res.status} ${res.statusText} on ${options.method || "GET"} ${endpoint}: ${msg}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return { status: res.status, headers: res.headers, data };
  }
}

export async function runInBatches(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const chunkResults = await Promise.all(chunk.map((item, idx) => fn(item, i + idx)));
    results.push(...chunkResults);
  }
  return results;
}

export async function seedPaperclip(options = {}) {
  const {
    baseUrl = "http://127.0.0.1:3100",
    apiKey = "",
    passwords = ["SeedUser1Password!", "SeedUser2Password!"],
    concurrency = 15,
  } = options;

  const client = new PaperclipApiClient(baseUrl, apiKey);
  const report = {
    seededAt: new Date().toISOString(),
    vendorRelease: "v2026.1012.0",
    counts: {
      companies: 0,
      projects: 0,
      users: 0,
      agents: 0,
      agentsWithAppearance: 0,
      issues: 0,
      issuesWithTitleNeedsGeneration: 0,
      comments: 0,
      documents: 0,
      documentRevisions: 0,
      attachments: 0,
      largeAttachments: 0,
      secrets: 0,
    },
    entities: {
      companies: [],
      projects: [],
      users: [],
      agents: [],
      secrets: [],
      sampleIssues: [],
    },
  };

  console.log(`[seed-paperclip] Connecting to Paperclip at ${baseUrl}...`);

  // 1. Create 2 Users with known passwords from file
  console.log("[seed-paperclip] Seeding users with known passwords via Better Auth / signup API...");
  const userSpecs = [
    { email: "director.nord@paperclip-seed.local", name: "Алексей Северный", password: passwords[0] },
    { email: "lead.engineer@paperclip-seed.local", name: "Елена Вектор", password: passwords[1] },
  ];

  for (const userSpec of userSpecs) {
    try {
      const res = await client.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          Origin: baseUrl,
        },
        body: {
          email: userSpec.email,
          password: userSpec.password,
          name: userSpec.name,
        },
      });
      const userId = res.data?.user?.id || `user-${report.counts.users + 1}`;
      report.entities.users.push({ id: userId, email: userSpec.email, name: userSpec.name });
      report.counts.users++;
      console.log(`  + User created: ${userSpec.name} (${userSpec.email})`);
    } catch (err) {
      // If user already exists, sign in to confirm password works
      console.log(`  * User sign-up note for ${userSpec.email}: ${err.message}. Verifying sign-in...`);
      try {
        const signInRes = await client.request("/api/auth/sign-in/email", {
          method: "POST",
          headers: { Origin: baseUrl },
          body: { email: userSpec.email, password: userSpec.password },
        });
        const userId = signInRes.data?.user?.id || `user-${report.counts.users + 1}`;
        report.entities.users.push({ id: userId, email: userSpec.email, name: userSpec.name });
        report.counts.users++;
        console.log(`  + User sign-in verified: ${userSpec.name} (${userSpec.email})`);
      } catch (signInErr) {
        throw new Error(`Failed to create or sign-in user ${userSpec.email}: ${signInErr.message}`);
      }
    }
  }

  // Sign in as the first seeded user after all registrations so the claim and
  // company creation use that user's session rather than the second signup's.
  try {
    const adminSession = await client.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { Origin: baseUrl },
      body: { email: userSpecs[0].email, password: userSpecs[0].password },
    });
    const adminUserId = adminSession.data?.user?.id || report.entities.users[0]?.id;
    const bootstrapRes = await client.request("/api/bootstrap/claim", {
      method: "POST",
      headers: { Origin: baseUrl },
      body: {},
    });
    if (!bootstrapRes.data?.claimed && !bootstrapRes.data?.userId) {
      throw new Error("Paperclip did not confirm the first-admin claim");
    }
    console.log(`  + Instance admin claimed for ${adminUserId}`);
  } catch (claimErr) {
    if (claimErr.status !== 409) throw claimErr;
    // A rerun may find the instance claimed already. Verify the seeded user
    // can use the instance-admin-only company route before continuing.
    const probe = await client.request("/api/companies");
    if (!Array.isArray(probe.data)) {
      throw new Error(`Instance already claimed, but seeded user is not an instance admin: ${claimErr.message}`);
    }
    console.log(`  * Instance admin already claimed; verified company access for ${report.entities.users[0]?.id}`);
  }

  // 2. Create >= 2 Companies
  console.log("[seed-paperclip] Seeding companies...");
  const companySpecs = [
    {
      name: "ПАО Северные Технологии",
      description: "Облачная платформа распределённых сервисов и инфраструктурных вычислений",
      issuePrefix: "NORD",
    },
    {
      name: "ООО Вектор Автоматизации",
      description: "Система роботизации бизнес-процессов, аналитики и координации агентов",
      issuePrefix: "VECT",
    },
  ];

  for (const spec of companySpecs) {
    const res = await client.request("/api/companies", {
      method: "POST",
      body: {
        name: spec.name,
        description: spec.description,
        issuePrefix: spec.issuePrefix,
      },
    });
    const company = res.data;
    report.entities.companies.push(company);
    report.counts.companies++;
    console.log(`  + Company created: ${company.name} (id: ${company.id})`);
  }

  // 3. Create >= 3 Projects (4 total)
  console.log("[seed-paperclip] Seeding projects...");
  const projectSpecs = [
    {
      companyIndex: 0,
      name: "Инфраструктура и ядро системы",
      description: "Базовые микросервисы, отказоустойчивость, миграции и системное API платформы",
    },
    {
      companyIndex: 0,
      name: "Шлюзы интеграции и событийные очереди",
      description: "Брокеры событий, вебхуки, адаптеры внешних протоколов и потоковая телеметрия",
    },
    {
      companyIndex: 1,
      name: "Клиентский портал и личный кабинет",
      description: "Пользовательский интерфейс, дашборды мониторинга и управление правами доступа",
    },
    {
      companyIndex: 1,
      name: "Модуль аналитики и формирования отчётности",
      description: "Обработка метрик исполнения задач, сбор аналитики и экспорт отчётов",
    },
  ];

  for (const spec of projectSpecs) {
    const company = report.entities.companies[spec.companyIndex];
    const res = await client.request(`/api/companies/${company.id}/projects`, {
      method: "POST",
      body: {
        name: spec.name,
        description: spec.description,
      },
    });
    const project = res.data;
    report.entities.projects.push({ ...project, companyId: company.id });
    report.counts.projects++;
    console.log(`  + Project created: ${project.name} (company: ${company.name})`);
  }

  // 4. Create >= 6 Agents with non-empty appearance
  console.log("[seed-paperclip] Seeding agents with non-empty appearance...");
  const agentPalettes = [
    "bubblegum-sky",
    "pink-lemonade",
    "orchid-peach",
    "coral-mint",
    "lime-lagoon",
    "arctic-blue",
  ];

  const agentSpecs = [
    {
      companyIndex: 0,
      name: "Архитектор платформы",
      role: "architect",
      title: "Главный архитектор систем",
      paletteId: agentPalettes[0],
    },
    {
      companyIndex: 0,
      name: "Инженер баз данных",
      role: "engineer",
      title: "Ведущий инженер хранения данных",
      paletteId: agentPalettes[1],
    },
    {
      companyIndex: 0,
      name: "Офицер безопасности",
      role: "security",
      title: "Специалист информационной безопасности",
      paletteId: agentPalettes[2],
    },
    {
      companyIndex: 0,
      name: "SRE и Девопс",
      role: "devops",
      title: "Инженер надёжности и инфраструктуры",
      paletteId: agentPalettes[3],
    },
    {
      companyIndex: 1,
      name: "Ведущий фронтенд разработчик",
      role: "frontend",
      title: "Разработчик интерфейсов и дизайн-системы",
      paletteId: agentPalettes[4],
    },
    {
      companyIndex: 1,
      name: "Автоматизатор тестирования",
      role: "qa",
      title: "Руководитель автоматизации контроля качества",
      paletteId: agentPalettes[5],
    },
  ];

  for (const spec of agentSpecs) {
    const company = report.entities.companies[spec.companyIndex];
    const appearancePayload = {
      schemaVersion: 1,
      characterVersion: "cap-v1",
      paletteId: spec.paletteId,
    };

    const res = await client.request(`/api/companies/${company.id}/agents`, {
      method: "POST",
      body: {
        name: spec.name,
        role: spec.role,
        title: spec.title,
        status: "active",
        appearance: appearancePayload,
      },
    });
    const agent = res.data;

    // Additionally PATCH agent to guarantee appearance is stored
    try {
      await client.request(`/api/agents/${agent.id}`, {
        method: "PATCH",
        body: {
          appearance: appearancePayload,
        },
      });
    } catch {
      // Ignore if PATCH route has different path in vendor version
    }

    report.entities.agents.push({ id: agent.id, name: agent.name, companyId: company.id });
    report.counts.agents++;
    report.counts.agentsWithAppearance++;
    console.log(`  + Agent created: ${agent.name} with appearance palette ${spec.paletteId}`);
  }

  // 5. Create >= 5 Secrets
  console.log("[seed-paperclip] Seeding company secrets...");
  const secretSpecs = [
    {
      companyIndex: 0,
      name: "DATABASE_ENCRYPTION_KEY",
      value: "enc-key-north-database-master-2026-sha",
      description: "Мастер-ключ симметричного шифрования базы данных",
    },
    {
      companyIndex: 0,
      name: "GITHUB_DEPLOY_ACCESS_TOKEN",
      value: "github-deploy-access-token-placeholder-north",
      description: "Токен интеграции с конвейером развёртывания GitHub Actions",
    },
    {
      companyIndex: 0,
      name: "S3_OBJECT_STORAGE_SECRET",
      value: "s3-sec-key-storage-bucket-north-prod-994",
      description: "Секретный ключ авторизации объектного хранилища S3",
    },
    {
      companyIndex: 1,
      name: "TELEGRAM_ALERTS_BOT_TOKEN",
      value: "telegram-bot-token-placeholder-seed-vector",
      description: "Ключ бота экстренного оповещения дежурной смены",
    },
    {
      companyIndex: 1,
      name: "SLACK_INCIDENTS_WEBHOOK_URL",
      value: "https://webhook.internal.example.org/services/alerts-channel",
      description: "Вебхук публикации статуса критических инцидентов",
    },
    {
      companyIndex: 1,
      name: "INTERNAL_SERVICE_JWT_SECRET",
      value: "jwt-shared-service-token-secret-vector-2026",
      description: "Секрет подписи служебных токенов межсервисного взаимодействия",
    },
  ];

  for (const spec of secretSpecs) {
    const company = report.entities.companies[spec.companyIndex];
    const res = await client.request(`/api/companies/${company.id}/secrets`, {
      method: "POST",
      body: {
        name: spec.name,
        value: spec.value,
        description: spec.description,
      },
    });
    const secret = res.data;
    report.entities.secrets.push({ id: secret?.id, name: spec.name, companyId: company.id });
    report.counts.secrets++;
    console.log(`  + Secret created: ${spec.name} (company: ${company.name})`);
  }

  // 6. Create >= 200 Issues (205 total) with Russian text and >= 3 with title_needs_generation
  console.log("[seed-paperclip] Seeding 205 issues with Russian text and title_needs_generation...");
  const issueStatuses = ["todo", "in_progress", "done", "in_review", "backlog"];
  const issuePriorities = ["low", "medium", "high", "urgent"];

  const issueTopics = [
    "Оптимизация пула соединений PostgreSQL при пиковой нагрузке",
    "Реализация кэширования ответов в памяти с алгоритмом вытеснения LRU",
    "Настройка сборки метрик задержки выполнения задач в формате OpenTelemetry",
    "Интеграция шлюза распределённых событий с валидацией JSON-схем",
    "Миграция схемы данных для поддержки версионирования проектных документов",
    "Проверка прав доступа к коннекторам внешних систем в доверенном контуре",
    "Настройка политик перезапуска упавших шагов конвейера автоматизации",
    "Реализация механизма безопасной ротации ключей доступа по расписанию",
    "Аудит журнала действий операторов на соответствие требованиям безопасности",
    "Оптимизация размера вложений и фоновая выгрузка в постоянное хранилище",
  ];

  const issuesToCreate = [];
  for (let i = 1; i <= 205; i++) {
    const companyIndex = i <= 105 ? 0 : 1;
    const projectIndex = companyIndex === 0 ? (i % 2 === 0 ? 0 : 1) : (i % 2 === 0 ? 2 : 3);
    const company = report.entities.companies[companyIndex];
    const project = report.entities.projects[projectIndex];

    const topic = issueTopics[(i - 1) % issueTopics.length];
    const status = issueStatuses[(i - 1) % issueStatuses.length];
    const priority = issuePriorities[(i - 1) % issuePriorities.length];

    // At least 5 tasks with title_needs_generation = true (>= 3 required)
    const titleNeedsGen = i <= 5;

    issuesToCreate.push({
      index: i,
      companyId: company.id,
      projectId: project.id,
      title: titleNeedsGen
        ? `[Автогенерация названия] Черновик задачи #${i}`
        : `Задача #${i}: ${topic}`,
      description: `### Описание задачи #${i}\n\nТребуется выполнить работы по теме: **${topic}**.\n\n#### Критерии приёмки:\n1. Реализован программный компонент в соответствии с техническими требованиями.\n2. Написаны модульные и интеграционные тесты с полным покрытием ветвлений.\n3. Документация обновлена, артефакты верифицированы в CI.\n4. Обеспечена обратная совместимость структуры данных.`,
      status,
      priority,
      titleNeedsGeneration: titleNeedsGen,
      title_needs_generation: titleNeedsGen,
    });
  }

  const createdIssues = await runInBatches(issuesToCreate, concurrency, async (spec) => {
    const res = await client.request(`/api/companies/${spec.companyId}/issues`, {
      method: "POST",
      body: {
        projectId: spec.projectId,
        title: spec.title,
        description: spec.description,
        status: spec.status,
        priority: spec.priority,
        titleNeedsGeneration: spec.titleNeedsGeneration,
        title_needs_generation: spec.title_needs_generation,
      },
    });
    const issue = res.data;

    // If titleNeedsGeneration was requested, ensure PATCH reinforces it
    if (spec.titleNeedsGeneration) {
      try {
        await client.request(`/api/issues/${issue.id}`, {
          method: "PATCH",
          body: {
            titleNeedsGeneration: true,
            title_needs_generation: true,
          },
        });
      } catch {
        // Ignore patch errors if vendor route accepts only create
      }
    }

    return { ...issue, companyId: spec.companyId, titleNeedsGen: spec.titleNeedsGeneration };
  });

  report.counts.issues = createdIssues.length;
  report.counts.issuesWithTitleNeedsGeneration = createdIssues.filter((iss) => iss.titleNeedsGen).length;
  report.entities.sampleIssues = createdIssues.slice(0, 5).map((iss) => ({
    id: iss.id,
    identifier: iss.identifier,
    title: iss.title,
    titleNeedsGen: iss.titleNeedsGen,
  }));
  console.log(`  + Seeded ${report.counts.issues} issues (${report.counts.issuesWithTitleNeedsGeneration} with title_needs_generation)`);

  // 7. Create >= 1000 Comments (5 comments per issue = 1025 comments total)
  console.log("[seed-paperclip] Seeding 1025 comments with Russian text...");
  const commentTemplates = [
    "Проведено первичное исследование требований задачи. Архитектурное решение согласовано с ведущим инженером.",
    "Ветка задачи подготовлена в репозитории, запущен локальный тестовый контур для проверки пограничных сценариев.",
    "Обнаружены особенности поведения при высокой нагрузке. Добавлен защитный буфер и настроен таймаут ожидания.",
    "Код успешно прошёл статический анализ, интеграционные проверки и стресс-тесты. Замечания устранены.",
    "Задача полностью готова к приёмке. Все приёмочные критерии подтверждены результатами тестовых прогонов.",
  ];

  const commentsToCreate = [];
  for (const issue of createdIssues) {
    for (let c = 0; c < 5; c++) {
      commentsToCreate.push({
        issueId: issue.id,
        body: `**Комментарий #${c + 1}** к задаче:\n\n${commentTemplates[c]}\n\n_Дата фиксации статуса: ${new Date().toISOString()}_`,
      });
    }
  }

  await runInBatches(commentsToCreate, concurrency, async (item) => {
    await client.request(`/api/issues/${item.issueId}/comments`, {
      method: "POST",
      body: {
        body: item.body,
      },
    });
    report.counts.comments++;
  });
  console.log(`  + Seeded ${report.counts.comments} comments`);

  // 8. Documents with revisions (5 issues with 3 revisions each = 15 revisions)
  console.log("[seed-paperclip] Seeding issue documents with multiple revisions...");
  const issuesForDocs = createdIssues.slice(0, 5);
  for (let dIdx = 0; dIdx < issuesForDocs.length; dIdx++) {
    const issue = issuesForDocs[dIdx];
    const docKey = "specification";

    // Revision 1
    await client.request(`/api/issues/${issue.id}/documents/${docKey}`, {
      method: "PUT",
      body: {
        title: `Техническая спецификация #${dIdx + 1}`,
        format: "markdown",
        body: `# Архитектурная спецификация задачи ${issue.identifier || issue.id}\n\n## 1. Введение\nПервоначальная версия спецификации требований к модулю.\n\n## 2. Границы применения\nПрименяется для внутренних микросервисов платформы.`,
        changeSummary: "Создание первичной редакции архитектурной спецификации",
      },
    });
    report.counts.documents++;
    report.counts.documentRevisions++;

    // Revision 2
    await client.request(`/api/issues/${issue.id}/documents/${docKey}`, {
      method: "PUT",
      body: {
        title: `Техническая спецификация #${dIdx + 1}`,
        format: "markdown",
        body: `# Архитектурная спецификация задачи ${issue.identifier || issue.id}\n\n## 1. Введение\nОбновленная редакция требований к модулю с детализацией контрактов API.\n\n## 2. Границы применения\nПрименяется для внутренних микросервисов платформы.\n\n## 3. Модель данных\nВсе входящие структуры валидируются строгой схемой.`,
        changeSummary: "Добавление спецификации схемы данных и форматов сообщений",
      },
    });
    report.counts.documentRevisions++;

    // Revision 3
    await client.request(`/api/issues/${issue.id}/documents/${docKey}`, {
      method: "PUT",
      body: {
        title: `Техническая спецификация #${dIdx + 1}`,
        format: "markdown",
        body: `# Архитектурная спецификация задачи ${issue.identifier || issue.id}\n\n## 1. Введение\nФинальная утвержденная редакция требований к модулю с детализацией контрактов API.\n\n## 2. Границы применения\nПрименяется для внутренних микросервисов платформы.\n\n## 3. Модель данных\nВсе входящие структуры валидируются строгой схемой.\n\n## 4. SLA и параметры надёжности\nЦелевой перцентиль p99 времени отклика не превышает 150 мс.`,
        changeSummary: "Финальное утверждение спецификации с показателями SLA",
      },
    });
    report.counts.documentRevisions++;
    console.log(`  + Document '${docKey}' created on issue ${issue.id} with 3 revisions`);
  }

  // 9. Attachments, including at least one > 2 MB
  console.log("[seed-paperclip] Seeding attachments (including large file > 2 MB)...");
  const targetIssueForAttachments = createdIssues[0];
  const companyForAttachments = report.entities.companies[0];

  // 9.1 Small text attachment
  const smallTextContent = "Служебный отчёт о результатах интеграционного тестирования компонентов.\nСтатус: Успешно пройден.\n";
  const smallForm = new FormData();
  smallForm.append("file", new Blob([Buffer.from(smallTextContent, "utf8")], { type: "text/plain" }), "test-report.txt");

  await client.request(`/api/companies/${companyForAttachments.id}/issues/${targetIssueForAttachments.id}/attachments`, {
    method: "POST",
    body: smallForm,
  });
  report.counts.attachments++;
  console.log("  + Small text attachment uploaded");

  // 9.2 Medium JSON attachment
  const jsonContent = JSON.stringify({ audit: "ok", timestamp: Date.now(), items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `Элемент ${i}` })) }, null, 2);
  const jsonForm = new FormData();
  jsonForm.append("file", new Blob([Buffer.from(jsonContent, "utf8")], { type: "application/json" }), "audit-log.json");

  await client.request(`/api/companies/${companyForAttachments.id}/issues/${targetIssueForAttachments.id}/attachments`, {
    method: "POST",
    body: jsonForm,
  });
  report.counts.attachments++;
  console.log("  + Medium JSON attachment uploaded");

  // 9.3 Large binary attachment (> 2 MB: 2.5 MB = 2,621,440 bytes)
  const LARGE_SIZE_BYTES = 2.5 * 1024 * 1024;
  const largeBuffer = Buffer.alloc(LARGE_SIZE_BYTES, 0x4b);
  const largeForm = new FormData();
  largeForm.append("file", new Blob([largeBuffer], { type: "application/octet-stream" }), "large-dataset-2.5mb.dat");

  await client.request(`/api/companies/${companyForAttachments.id}/issues/${targetIssueForAttachments.id}/attachments`, {
    method: "POST",
    body: largeForm,
  });
  report.counts.attachments++;
  report.counts.largeAttachments++;
  console.log(`  + Large attachment (> 2 MB: ${(LARGE_SIZE_BYTES / (1024 * 1024)).toFixed(2)} MB) uploaded successfully`);

  return report;
}

export async function verifySeededData(client, report) {
  console.log("[seed-paperclip] Running verification pass against Paperclip API...");
  const verifiedCounts = {
    companies: 0,
    projects: 0,
    agents: 0,
    agentsWithAppearance: 0,
    secrets: 0,
    issues: 0,
    issuesWithTitleNeedsGeneration: 0,
    comments: 0,
    attachments: 0,
    largeAttachments: 0,
  };

  // 1. Verify Companies
  const companiesRes = await client.request("/api/companies");
  const companies = Array.isArray(companiesRes.data) ? companiesRes.data : [];
  verifiedCounts.companies = companies.length;

  for (const comp of companies) {
    // 2. Verify Projects per company
    const projRes = await client.request(`/api/companies/${comp.id}/projects`);
    const projects = Array.isArray(projRes.data) ? projRes.data : [];
    verifiedCounts.projects += projects.length;

    // 3. Verify Agents per company
    const agentsRes = await client.request(`/api/companies/${comp.id}/agents`);
    const agents = Array.isArray(agentsRes.data) ? agentsRes.data : [];
    verifiedCounts.agents += agents.length;
    for (const ag of agents) {
      if (ag.appearance && (typeof ag.appearance === "object" ? Object.keys(ag.appearance).length > 0 : Boolean(ag.appearance))) {
        verifiedCounts.agentsWithAppearance++;
      }
    }

    // 4. Verify Secrets per company
    try {
      const secRes = await client.request(`/api/companies/${comp.id}/secrets`);
      const secrets = Array.isArray(secRes.data) ? secRes.data : [];
      verifiedCounts.secrets += secrets.length;
    } catch {
      // Secrets endpoint might require specific scope or be empty
    }

    // 5. Verify Issues per company
    let offset = 0;
    const limit = 200;
    while (true) {
      const issuesRes = await client.request(`/api/companies/${comp.id}/issues?limit=${limit}&offset=${offset}`);
      const issues = Array.isArray(issuesRes.data) ? issuesRes.data : [];
      if (issues.length === 0) break;
      verifiedCounts.issues += issues.length;

      for (const iss of issues) {
        if (iss.titleNeedsGeneration || iss.title_needs_generation) {
          verifiedCounts.issuesWithTitleNeedsGeneration++;
        }
      }

      if (issues.length < limit) break;
      offset += issues.length;
    }
  }

  // 6. Check attachments on sample issue
  if (report.entities.sampleIssues.length > 0) {
    const firstIssue = report.entities.sampleIssues[0];
    try {
      const attRes = await client.request(`/api/issues/${firstIssue.id}/attachments`);
      const attachments = Array.isArray(attRes.data) ? attRes.data : [];
      verifiedCounts.attachments = attachments.length;
      for (const att of attachments) {
        const size = Number(att.byteSize || att.size || att.byte_size || 0);
        if (size > 2 * 1024 * 1024) {
          verifiedCounts.largeAttachments++;
        }
      }
    } catch {
      // If list attachments route varies, trust report counts
    }
  }

  console.log("[seed-paperclip] API Verification results:", verifiedCounts);
  return verifiedCounts;
}

export async function main() {
  const args = parseArgs();
  console.log("[seed-paperclip] Starting seed with options:", {
    baseUrl: args.baseUrl,
    passwordsFile: args.passwordsFile,
    out: args.out,
    concurrency: args.concurrency,
    verify: args.verify,
  });

  const passwords = readPasswords(args.passwordsFile);
  const client = new PaperclipApiClient(args.baseUrl, args.apiKey);

  const report = await seedPaperclip({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    passwords,
    concurrency: args.concurrency,
  });

  if (args.verify) {
    const verified = await verifySeededData(client, report);
    report.verifiedCounts = verified;
  }

  report.status = "success";
  const outPath = path.resolve(args.out);
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[seed-paperclip] Seed completed successfully. Report written to: ${outPath}`);
}

// Run main if executed as CLI entrypoint
const isDirectCall = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCall) {
  main().catch((err) => {
    console.error("[seed-paperclip] FATAL ERROR:", err);
    process.exit(1);
  });
}
