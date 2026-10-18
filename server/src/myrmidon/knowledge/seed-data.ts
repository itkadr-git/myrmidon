// server/src/myrmidon/knowledge/seed-data.ts
//
// K-8 (OPE-5961, release 1.6.6): seed corpus for the knowledge base.
// Populates the `decisions/` and `product/` folders of a nest.
//
// Sources (arch §5.4, §6 K-8):
//   - decisions: owner decisions imported from the OPE-401 registry
//     ("Реестр решений ADM (DECISIONS)"), one `decision` item per decision
//     with decided_by, date, verbatim quote and a source reference back to
//     the registry entry.
//   - product/vision: the owner's "Концепция Myrmidon 2.0" text verbatim
//     (OPE-2913 document `vision-2-0`, Alex 29.09 — not edited, per
//     memory dont_revise_owners_existing_texts).
//   - product/principles: the P1–P14 product principles (OPE-2913 document
//     `roadmap-v1`).
//
// The data below is intentionally prose-heavy: each decision carries the
// owner's verbatim quote ("Alex: «…»") so agents read decisions as dated
// records, not as a 204 KB document (arch §6 K-8 goal).

export interface SeedDecision {
  slug: string;
  title: string;
  /** Decision date, ISO (YYYY-MM-DD). */
  date: string;
  /** Who decided. */
  decidedBy: string;
  /** Verbatim quote of the decision. */
  quote: string;
  /** Consequences / details (markdown body, may be multi-line). */
  body?: string;
  /** slug of the decision this one supersedes, if any. */
  supersedes?: string;
  tags?: string[];
}

export interface SeedPage {
  slug: string;
  title: string;
  summary: string;
  kind: string;
  folderPath: string;
  tags: string[];
  content: string;
}

const OWNER = "Alex";

// ---------------------------------------------------------------------------
// decisions/ — one item per owner decision, chronologically ordered.
// Supersede chains reference the slug of the superseded decision.
// ---------------------------------------------------------------------------

export const SEED_DECISIONS: SeedDecision[] = [
  {
    slug: "decisions/2026-09-27-myrmidon-fork",
    title: "Делаем свой форк Paperclip (Myrmidon)",
    date: "2026-09-27",
    decidedBy: OWNER,
    quote: "Мы все таки будем делать форк, но сейчас ролик",
    body: "Готового форка с нашими доработками нет. Нужно: изоляция агентов, отдельные модели зрения/слуха/текста в карточке, навыки в профиль, доделанный шлюз. Меняет решения 19.09 («образ доски — вендорский») и 21.09 («оверлеи — только с согласия») в части форка.",
    tags: ["myrmidon", "fork"],
  },
  {
    slug: "decisions/2026-09-27-mit-license",
    title: "Лицензия Myrmidon — MIT с сохранением копирайта вендора",
    date: "2026-09-27",
    decidedBy: OWNER,
    quote: "ок",
    body: "Лицензия Myrmidon — MIT с сохранением копирайта вендора (Paperclip). GitHub владельца: `itkadr-git` → `github.com/itkadr-git/myrmidon`, образ `ghcr.io/itkadr-git/myrmidon`. Закрытый репозиторий развёртывания рядом — «ок».",
    tags: ["myrmidon", "license"],
  },
  {
    slug: "decisions/2026-09-27-no-upstream",
    title: "В апстрим Paperclip не отправляем",
    date: "2026-09-27",
    decidedBy: OWNER,
    quote: "мы же свой продукт развиваем, рано или поздно своей веткой можем пойти",
    tags: ["myrmidon", "fork"],
  },
  {
    slug: "decisions/2026-09-27-memory-hindsight",
    title: "Память ботов остаётся на Hindsight",
    date: "2026-09-27",
    decidedBy: OWNER,
    quote: "я бы оставил",
    body: "X10 (перенос памяти) — снят: память остаётся Hindsight.",
    tags: ["memory", "hindsight"],
  },
  {
    slug: "decisions/2026-09-28-own-branch",
    title: "Myrmidon: своя ветка, без постоянной миграции",
    date: "2026-09-28",
    decidedBy: OWNER,
    quote: "Сузить запрещаю, возможно мы просто будем вести свою ветку и собственную разработку, а на его продукт только посматривать без постоянной миграции",
    body: "Форк развиваем как свой продукт. Еженедельный автоматический перенос релизов вендора отменяется; вместо него — обзор релизов вендора и выборочный перенос нужного по решению.",
    tags: ["myrmidon", "fork"],
  },
  {
    slug: "decisions/2026-09-28-brand-first",
    title: "1.1.0: первым — свой бренд",
    date: "2026-09-28",
    decidedBy: OWNER,
    quote: "продукт у нас новый и наш, а название и логотип везде paperclip!",
    body: "B1 — имя и логотип Myrmidon везде, где видит человек (интерфейс, системные комментарии, письма, Telegram); атрибуция MIT «основано на Paperclip» остаётся; идентификаторы и переменные PAPERCLIP_* не трогаем.",
    tags: ["myrmidon", "brand"],
  },
  {
    slug: "decisions/2026-09-28-gateway-first",
    title: "Агенты через шлюз hermes — первый приоритет",
    date: "2026-09-28",
    decidedBy: OWNER,
    quote: "в первом приоритете перенос всех наработок в hermes_gateway, он должен поддерживать всё, что сейчас есть в hermes_local, тогда песочница и изоляция просто будут не обязательны",
    body: "Основной путь агентов — hermes_gateway, свой контейнер на проект или бота; hermes_local — только на время перехода.",
    tags: ["myrmidon", "gateway"],
  },
  {
    slug: "decisions/2026-09-28-board-manages-containers",
    title: "Доска сама поднимает контейнеры (вариант Б)",
    date: "2026-09-28",
    decidedBy: OWNER,
    quote: "это первый приоритет",
    body: "Причина — OOM доски 28.09 08:10 UTC: около 35 процессов hermes внутри контейнера доски (8 ГБ), все прогоны умерли. Доска сама управляет контейнерами ботов.",
    tags: ["myrmidon", "containers"],
  },
  {
    slug: "decisions/2026-09-28-money-only-owner",
    title: "Деньги — только через владельца",
    date: "2026-09-28",
    decidedBy: OWNER,
    quote: "если не ответил, то да, идёт по рекомендации. Деньги только через меня",
    body: "Нет ответа к сроку — выпуск идёт по рекомендации. Цены, скидки, акции, рекламный бюджет и любые траты — только после явного «да» владельца.",
    tags: ["process", "money"],
  },
  {
    slug: "decisions/2026-09-29-autonomy-matrix",
    title: "Матрица автономии",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "если это падает на меня когда я не должен это решать, значит нужно настроить так чтобы решалось без меня",
    body: "Матрица целиком заменяет любые прежние правила, по которым владельцу уходили решения не его уровня. Исполнитель решает сам любое обратимое действие в рамках утверждённого плана и бюджета; остановка того, что измеримо не работает; выбор формулировок и внутренних инструментов. Владельцу — строка отчёта. См. запись 19 в decisions-addendum-2026-09-08.",
    tags: ["autonomy", "process"],
  },
  {
    slug: "decisions/2026-09-29-centralize-memory",
    title: "Централизовать память ботов",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "память нужно централизовать",
    body: "Цель — память не привязана к месту запуска бота: долговременная память — в Hindsight; история разговоров — в центральном хранилище, а не в локальном state.db; навыки — с доски; настройки — из карточки агента.",
    tags: ["memory", "hindsight"],
  },
  {
    slug: "decisions/2026-09-29-ci-image-only",
    title: "На бой только образ, собранный CI",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "да, вводи правило: только образ из CI",
    body: "Доска (Myrmidon) на бою запускается только из образа `ghcr.io/itkadr-git/myrmidon@sha256:…`, который собрал GitHub Actions из main или тега `myr-v*`. Локальные сборки и `docker build` на хосте для боя запрещены — и ботам, и оператору. Срочное исправление — только через PR, слияние, сборка CI, выкат через режим обслуживания.",
    tags: ["myrmidon", "ci", "release"],
  },
  {
    slug: "decisions/2026-09-29-update-plan",
    title: "Всё через план обновлений",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "И нам бы все вести через план обновлений. Т.е. есть баг или хотелка и должна быть согласована очередность внедрения и важно, чтобы случайно пароли туда не улетели",
    body: "Любой баг или хотелка по доске и флоту сначала попадает в план. Очередность внедрения согласует Alex. Секреты в план и в публичный GitHub попасть не должны.",
    tags: ["process", "security"],
  },
  {
    slug: "decisions/2026-09-29-dev-roles",
    title: "Роли в разработке Myrmidon: ADM — архитектор, команда пишет код",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "дальше ты будешь выступать в качестве архитектора, а его команда пусть пишет код. я думаю можно ему и план до версии 1.3 выкатить",
    body: "Оператор доски (ADM) — архитектор: проекты и спецификации, постановка задач с критериями приёмки, ревью ключевых файлов, выпуск и выкат через режим обслуживания, связь с Alex. Команда adm-dev-lead пишет код; исполнителей-субагентов на разработку форка оператор больше не запускает.",
    tags: ["myrmidon", "process", "team"],
  },
  {
    slug: "decisions/2026-09-29-tools-a2",
    title: "Инструменты доски для контейнеров: этап А2 вместо Б",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "делаем А2, Б только если понадобится",
    body: "А2 (выпуск после 1.1.1): вызов инструмента через шлюз бота доска сама привязывает к текущему прогону агента — задача, проект, ответственный, GitHub от лица прогона. Только сервер, hermes не трогаем. Отменяет запись «сначала А, потом Б» в части второго этапа.",
    supersedes: "decisions/2026-09-28-board-manages-containers",
    tags: ["myrmidon", "tools"],
  },
  {
    slug: "decisions/2026-09-29-junior-models",
    title: "Исполнители в конвейерах — Sonnet 5.5",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "быстрее и дешевле, чем Sonnet 5",
    body: "Реализацию ведут младшие модели параллельно; ревью горячих файлов, стенд и выкат — ADM («все что можно отдавай младшим моделям», «максимальная параллельность»).",
    tags: ["models", "process"],
  },
  {
    slug: "decisions/2026-09-29-litellm-key-per-bot",
    title: "Ключ LiteLLM на каждого бота",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "ты сам можешь создать отдельный ключ на каждого бота",
    body: "Бот в контейнере получает свой виртуальный ключ LiteLLM `bot-<имя>`: без лимита трат, набор моделей как у прежнего ключа. Первый ключ — `bot-life` (29.09); до этого life ходила под ключом `bbq`, расход смешивался.",
    tags: ["security", "litellm"],
  },
  {
    slug: "decisions/2026-09-30-knowledge-rollback",
    title: "Автооткат знания при падении > 5 пунктов",
    date: "2026-09-30",
    decidedBy: OWNER,
    quote: "знание откатывается при падении > 5 пунктов, подтверждённом повтором; галлюцинации — 0",
    body: "Измерение раньше самообучения (принцип П7): снимок базовой линии сохраняется до включения роя; каждое новое знание проходит эталоны роли; при подтверждённом падении — автоматический откат.",
    tags: ["knowledge", "evals"],
  },
  {
    slug: "decisions/2026-09-30-no-budget-cap",
    title: "Лимиты — сигнал, не блок; кап не ставить",
    date: "2026-09-30",
    decidedBy: OWNER,
    quote: "кап не ставить",
    body: "Жёсткий отказ — только явно согласованный уровень; глобальный «только сигнал» действует до BUDGET-CONFIG. Боевой конвейер никогда не останавливается молча; инцидент бюджета = карточка владельцу «расширить на $N / остановить».",
    tags: ["budget", "process"],
  },
  {
    slug: "decisions/2026-10-02-clean-room",
    title: "Чистая комната: переписываем от спецификации",
    date: "2026-10-02",
    decidedBy: OWNER,
    quote: "переписываем от спецификации, не портируя файлы вендора",
    body: "Доля vendor-derived измеряется каждым релизом; на бой — только образ CI; main — не прод; ревью горячих файлов ядра. CI публикует долю vendor-derived; тег ставится только на образ CI.",
    tags: ["myrmidon", "clean-room"],
  },
  {
    slug: "decisions/2026-10-03-find-root-cause",
    title: "Искать причину и править причину, а не писать костыли",
    date: "2026-10-03",
    decidedBy: OWNER,
    quote: "запиши в правило",
    body: "Инцидент закрывается PR в продукт; новых хостовых сторожей не заводим, существующие выводим в продукт (принцип П3).",
    tags: ["process", "principles"],
  },
  {
    slug: "decisions/2026-10-03-foraging-variant-2",
    title: "FORAGING (OPE-3589) выходит в 1.6 выключенным",
    date: "2026-10-03",
    decidedBy: OWNER,
    quote: "вариант 2",
    body: "FORAGING включается после базового слоя GUARDRAILS (OPE-3792), который ставится в 1.6.1.",
    tags: ["foraging", "release"],
  },
  {
    slug: "decisions/2026-10-03-foraging-enable-now",
    title: "Обучение (FORAGING) включаем сейчас",
    date: "2026-10-03",
    decidedBy: OWNER,
    quote: "нужно, да и обучение бы уже включить",
    body: "Обучение (FORAGING) включаем сейчас, не дожидаясь GUARDRAILS. Лимиты на обучение — в 1.6.1 (OPE-3964).",
    supersedes: "decisions/2026-10-03-foraging-variant-2",
    tags: ["foraging", "release"],
  },
  {
    slug: "decisions/2026-10-04-wiki-own",
    title: "Вики: делаем своё, проектируем от видения 2.0",
    date: "2026-10-04",
    decidedBy: OWNER,
    quote: "По вики делаем своё и проектируем сами, исходя из видения 2.0; отсюда точно пишем своё и планируем новую архитектуру",
    body: "Плагин `plugin-llm-wiki` выводится; архитектура знаний (вики, регламенты, слои памяти, навыки) проектируется заново под 2.0 — документ `knowledge-architecture-2.0`. Публикация: внутреннее знание публикуют агенты сами, владелец одобряет только то, что уходит наружу.",
    tags: ["knowledge", "wiki"],
  },
  {
    slug: "decisions/2026-10-04-perf-diet",
    title: "PERF-DIET v2 (OPE-4124): память, RAGFlow, Langfuse",
    date: "2026-10-04",
    decidedBy: OWNER,
    quote: "D1: команде разработки свой банк памяти `fleet-dev` + запись в память раз за прогон. D2: RAGFlow — снять ночное окно и барьер. D3: Langfuse — полные трассы только для пилотной касты, судьи EVALS и Hindsight.",
    body: "D5: языковые серверы TypeScript у инженеров — ограниченный режим, не-кодовым ролям выключить. D4 (эмбеддинги Hindsight) — оставить локально, измерить после разгрузки. Ollama — остановить только после переключения эмбеддингов RAGFlow.",
    tags: ["performance", "memory"],
  },
  {
    slug: "decisions/2026-10-04-embeddings-reindex",
    title: "Эмбеддинги при смене системы корпуса — переиндексация",
    date: "2026-10-04",
    decidedBy: OWNER,
    quote: "при переходе все равно переиндексация!",
    body: "Решение 01.10 «bge-m3 не менять» действует только пока корпус живёт в нынешнем RAGFlow без переиндексации. При переходе на другую систему модель эмбеддингов выбирается заново.",
    tags: ["rag", "embeddings"],
  },
  {
    slug: "decisions/2026-10-04-own-rag-module",
    title: "Свой RAG на TypeScript — модулем продукта, открытый",
    date: "2026-10-04",
    decidedBy: OWNER,
    quote: "свой RAG на TypeScript внутри продукта делаем, но может модулем?",
    body: "Принято: свой RAG на TS, оформляется модулем продукта (отдельный пакет за портами ядра CorpusStore/SearchIndex/WorkQueue/BlobStore, включается/настраивается в UI). Модуль открытый (открытое ядро MIT) — ответ владельца «Открытый». Haystack и Mastra как основа — нет. RAGFlow 0.27 держать до переключения, на 1.0 не обновлять.",
    tags: ["rag", "architecture"],
  },
  {
    slug: "decisions/2026-10-06-corpus-2-steps",
    title: "CORPUS-2.0 (замена RAGFlow): первые три шага — в 1.6.5",
    date: "2026-10-06",
    decidedBy: OWNER,
    quote: "замеры текущего RAGFlow, пилот разбора документов, пилот индекса; нужно делать в ближайшее время и уже на 1.6.5 возможно на rc4… это может оптимизировать нагрузку на сервер",
    body: "Эпик OPE-4998; шаги 1–3 — OPE-5002/5003/5004 (1.6.5 rc.4). Код модуля, теневой режим, переключение и снятие RAGFlow — выпуск не назначен, ждёт владельца.",
    tags: ["rag", "release"],
  },
  {
    slug: "decisions/2026-10-08-plugin-as-bridge",
    title: "Плагин LLM Wiki включён как мост до своего модуля",
    date: "2026-10-08",
    decidedBy: OWNER,
    quote: "включён как мост до своего модуля знаний",
    body: "Плагин LLM Wiki включён как мост до своего модуля знаний (был выключен оператором 04.10); знание из него переносится частью K-6. Свой модуль знаний: первая часть (§6.2, модуль в ядре, читаемый агентами) — 1.6.6, остальное (§6.3) — 1.7 (Alex: «а»).",
    supersedes: "decisions/2026-10-04-wiki-own",
    tags: ["knowledge", "wiki", "release"],
  },
  {
    slug: "decisions/2026-10-08-litellm-langfuse-pg",
    title: "LiteLLM и Langfuse на общий PostgreSQL 18",
    date: "2026-10-08",
    decidedBy: OWNER,
    quote: "LiteLLM и Langfuse нужно перевести на общий PostgreSQL и старые удалить. RAGFlow до переезда не трогай",
    body: "Уточнение Alex 08.10: RAGFlow не трогать только ДО ввода своей замены (свой RAG на PostgreSQL); после ввода замены RAGFlow выводится и удаляется. Задачи: OPE-6163.",
    tags: ["infrastructure", "rag"],
  },
  {
    slug: "decisions/2026-09-27-free-models-default",
    title: "Бесплатные модели по умолчанию (DashScope — приоритет)",
    date: "2026-09-27",
    decidedBy: OWNER,
    quote: "платный канал — только по слову владельца; судья эталонов — другого семейства, чем автор",
    body: "Новые агенты и помощники — на бесплатной модели; умолчания карточек и помощников = бесплатная модель; в фолбэках нет платных без решения (02.10: openai-gpt-5.6-sol убрана). Принцип П5.",
    tags: ["models", "budget"],
  },
  {
    slug: "decisions/2026-09-27-ui-no-restart",
    title: "Все настройки — в интерфейсе, без перезапуска",
    date: "2026-09-27",
    decidedBy: OWNER,
    quote: "Это должно задаваться в интерфейсе!",
    body: "Env — только принудительное переопределение (инфра-адреса, сокеты). Функция не принимается без экрана настроек; к 2.0 число переключателей «только env» → 0. Принципы П1, П2.",
    tags: ["ui", "principles"],
  },
  {
    slug: "decisions/2026-09-27-international",
    title: "Международный продукт: EN по умолчанию",
    date: "2026-09-27",
    decidedBy: OWNER,
    quote: "EN по умолчанию, локаль у каждого пользователя, свои файлы локализации; документация EN основной, RU отдельными файлами",
    body: "Ключи схем и идентификаторы латиницей; тест «нет английских строк в RU»; каждый PR — описание EN + RU-файл. Принцип П10.",
    tags: ["i18n", "principles"],
  },
  {
    slug: "decisions/2026-09-26-security-within-owner-terms",
    title: "Безопасность — внутри условий владельца",
    date: "2026-09-26",
    decidedBy: OWNER,
    quote: "каждой свой ключ",
    body: "Права по потребности (ключ на роль, свой секрет на каждую), секреты только в хранилище и никогда в задачах/PR, прокси исходящего трафика до общения ботов с внешними людьми; root ADM и hermes_local под управлением доски неприкосновенны, пока нужны. Принцип П11.",
    tags: ["security", "principles"],
  },
  {
    slug: "decisions/2026-09-29-release-on-readiness",
    title: "Релизы по готовности",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "Вводи все!",
    body: "Зелёный main тегируется, как только есть ценное; минор = главные пункты доехали; на ревью только зелёное; тесты на новую логику обязательны, стенды — нет. Тег в день готовности; красный PR возвращается без ревью. Принцип П12.",
    tags: ["release", "principles"],
  },
  {
    slug: "decisions/2026-09-29-orchestrator-lifecycle",
    title: "Оркестратор — единственный владелец жизненного цикла",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "тревога становится задачей, а не kill",
    body: "Zabbix диагност; гибернация вместо scale-to-zero; хостовые скрипты не трогают флот в обход доски; хостовых скриптов, меняющих статусы агентов/задач, — 0 к 1.7. Принцип П13.",
    tags: ["orchestration", "principles"],
  },
  {
    slug: "decisions/2026-09-27-owner-ready-whole",
    title: "Владельцу — готовое и целиком",
    date: "2026-09-27",
    decidedBy: OWNER,
    quote: "опять от моего имени",
    body: "Вопросы развёрнутые: факты, варианты, одна рекомендация; не действовать от имени владельца; пакет подтверждений ≤ 10; визуалы без брака. Принцип П14.",
    tags: ["process", "principles"],
  },
  {
    slug: "decisions/2026-09-28-myrymidon-1-0-live",
    title: "Myrmidon 1.0.0 на живой доске",
    date: "2026-09-28",
    decidedBy: OWNER,
    quote: "наша версия 1.0.0 (Paperclip 2026.916.1 — только основа)",
    body: "Откат — старый набор compose. Ход — OPE-2913.",
    tags: ["myrmidon", "release"],
  },
  {
    slug: "decisions/2026-09-29-merge-approval-lock",
    title: "Замок на слияние: обязательное одобрение сопровождающего",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "Замок на слияние — делать",
    body: "Обязательная проверка «одобрение сопровождающего»: подписанное оператором одобрение последнего коммита PR. Команда пишет от имени itkadr-git, поэтому GitHub сам их не различает.",
    tags: ["myrmidon", "process", "ci"],
  },
  {
    slug: "decisions/2026-09-29-memory-banks-per-direction",
    title: "Банки памяти — разнести по направлениям",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "Банки памяти — разнести по направлениям (adm, work, bbq, life, магазин) и продумать, как каждому сохранить своё",
    body: "Пункт 1.1.1 MEMORY-ISOLATION разблокирован.",
    tags: ["memory", "isolation"],
  },
  {
    slug: "decisions/2026-09-29-1-1-0-one-release",
    title: "1.1.0 одним выпуском",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "держим одним",
    tags: ["myrmidon", "release"],
  },
  {
    slug: "decisions/2026-09-29-1-1-0-no-staging",
    title: "1.1.0 без стенда, сразу на бой",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "Этот релиз на стенде тестировать не будем. Сразу выкатываем на бой. Потом создадим отдельный стенд на отдельной машине для тестов.",
    body: "Отменяет пункт «проверка на стенде с Docker» из записи «1.1.0 одним выпуском».",
    supersedes: "decisions/2026-09-29-1-1-0-one-release",
    tags: ["myrmidon", "release"],
  },
  {
    slug: "decisions/2026-09-29-users-via-ui",
    title: "Пользователи и администраторы — через интерфейс, саморегистрация запрещена",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "у меня должна быть возможность создавать админов и пользователей через интерфейс, а не как сейчас ссылками-приглашениями с почтой, но при этом саморегистрация должна быть запрещена",
    body: "Сейчас `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`, вход только по приглашению. Доработка идёт в план обновлений Myrmidon.",
    tags: ["myrmidon", "auth"],
  },
  {
    slug: "decisions/2026-09-28-run-cap-min-3",
    title: "Потолок прогонов на бота — не меньше 3",
    date: "2026-09-28",
    decidedBy: OWNER,
    quote: "задаётся в доске и подстраивается под нагрузку сервера",
    body: "Поле карточки `heartbeat.maxConcurrentRuns`, общие лимиты и запас памяти — 1.0.1 (C0).",
    tags: ["myrmidon", "runtime"],
  },
  {
    slug: "decisions/2026-09-28-locks-first-release",
    title: "Убрать замки в первом же новом выпуске вместе со шлюзом hermes",
    date: "2026-09-28",
    decidedBy: OWNER,
    quote: "убирание замков нужно в первом же новом релизе вместе с hermes шлюзом",
    body: "Выпуск 1.1.0 = контейнеры ботов со шлюзом hermes (вариант Б) + разбор замков и удержаний. Типовые обрывы (выкат, рестарт, OOM, успешный прогон без статуса) должны разрешаться по правилу, без красных карточек у владельца.",
    tags: ["myrmidon", "release"],
  },
  {
    slug: "decisions/2026-09-29-standby-checks-muted",
    title: "4 заглушенные проверки vm-core: оставить заглушки",
    date: "2026-09-29",
    decidedBy: OWNER,
    quote: "Оставить заглушки",
    body: "Заглушки 28.09 (monitor-mcp-hub.sh, consult-watch.py, model-health.py, gateway-alert.py) остаются как есть. Возврат возможен только новым словом владельца. Карточка b6f04160 (OPE-3133).",
    tags: ["infrastructure", "monitoring"],
  },
];
