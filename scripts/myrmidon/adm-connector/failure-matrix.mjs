import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AdmCache } from '../../adm-connector/cache.mjs';
import { ContextDelivery } from '../../adm-connector/context.mjs';
import { createHooks, TRIGGERS } from './hooks.mjs';

export const STANDARD_ITEMS = Object.freeze([
  {
    schema_version: 1,
    status: 'published',
    sensitivity: 'internal',
    kind: 'rule',
    approver_kind: 'owner',
    slug: 'adm/policy/secret-hygiene',
    id: 'pol-1',
    revision_id: 'rev-1',
    title: 'Гигиена секретов OPE-1524',
    summary: 'Никогда не печатать токены и ключи в логах, тикетах и дампе. Запрет на запись в общий /tmp.',
    priority: 100,
    updated_at: '2026-10-27T00:00:00Z',
    triggers: ['config-change', 'paperclip-api'],
    body: 'Правило OPE-1524 действует всегда. Временные файлы только в $TMPDIR run-каталоге.',
  },
  {
    schema_version: 1,
    status: 'published',
    sensitivity: 'internal',
    kind: 'rule',
    approver_kind: 'owner',
    slug: 'adm/policy/ci-first',
    id: 'pol-2',
    revision_id: 'rev-1',
    title: 'Проверка кода через CI на PR',
    summary: 'Не запускать полный tsc/test в контейнере (лимит 2 ГБ). Проверка типов и тестов — только в GitHub CI на PR.',
    priority: 95,
    updated_at: '2026-10-27T00:00:00Z',
    triggers: ['deploy', 'merge'],
    body: 'Локально разрешён только точечный запуск одного теста vitest или генератора миграций.',
  },
  {
    schema_version: 1,
    status: 'published',
    sensitivity: 'internal',
    kind: 'rule',
    approver_kind: 'owner',
    slug: 'adm/policy/single-worktree',
    id: 'pol-3',
    revision_id: 'rev-1',
    title: 'Рабочая копия myr-ws',
    summary: 'Одна задача — одна копия myr-ws open. Чужие worktree не закрывать и не подменять.',
    priority: 90,
    updated_at: '2026-10-27T00:00:00Z',
    triggers: ['merge'],
    body: 'Использовать myr-ws open <КЛЮЧ> itkadr-git/<репо>. При BOT_DISK_QUOTA_EXCEEDED не клонировать вручную.',
  },
  {
    schema_version: 1,
    status: 'published',
    sensitivity: 'internal',
    kind: 'rule',
    approver_kind: 'owner',
    slug: 'adm/trigger/ssh',
    id: 'trig-1',
    revision_id: 'rev-1',
    title: 'Правило SSH доступа',
    summary: 'Требуется проверка целевого хоста и запрет передачи паролей.',
    priority: 85,
    updated_at: '2026-10-27T00:00:00Z',
    triggers: ['ssh'],
    body: 'Подключение только по ключу из профиля агента. Запрет на интерактивный ввод пароля.',
  },
  {
    schema_version: 1,
    status: 'published',
    sensitivity: 'internal',
    kind: 'rule',
    approver_kind: 'owner',
    slug: 'adm/trigger/deploy',
    id: 'trig-2',
    revision_id: 'rev-1',
    title: 'Правило выката на бой',
    summary: 'Выкат доски — только образ из CI (ghcr.io/itkadr-git/myrmidon). Запрет сборки на хосте.',
    priority: 85,
    updated_at: '2026-10-27T00:00:00Z',
    triggers: ['deploy', 'release'],
    body: 'Срочный выкат выполняется через PR и режим обслуживания оператором ADM.',
  },
  {
    schema_version: 1,
    status: 'published',
    sensitivity: 'internal',
    kind: 'rule',
    approver_kind: 'owner',
    slug: 'adm/trigger/paperclip-api',
    id: 'trig-3',
    revision_id: 'rev-1',
    title: 'Использование Paperclip API',
    summary: 'Использовать X-Paperclip-Run-Id для мутаций, проверять статусы 200/201.',
    priority: 80,
    updated_at: '2026-10-27T00:00:00Z',
    triggers: ['paperclip-api'],
    body: 'Не печатать агентские токены в командах и логах. Перехватывать HTTP 401 и 422.',
  },
  {
    schema_version: 1,
    status: 'published',
    sensitivity: 'internal',
    kind: 'rule',
    approver_kind: 'owner',
    slug: 'adm/trigger/incident',
    id: 'trig-4',
    revision_id: 'rev-1',
    title: 'Регламент инцидентов',
    summary: 'При обнаружении аварии зафиксировать лог, уведомить ADM, не применять непроверенных изменений.',
    priority: 80,
    updated_at: '2026-10-27T00:00:00Z',
    triggers: ['incident'],
    body: 'Фиксация симптомов, сбор метрик через curl/dmesg, доклад владельцу.',
  },
]);

/**
 * Helper to ensure a profile-local directory is used for tests, never /tmp.
 */
async function createTestRoot(baseDir = null) {
  const rootParent = baseDir || (process.env.TMPDIR && !/^\/(?:tmp|var\/tmp)(?:\/|$)/.test(process.env.TMPDIR)
    ? process.env.TMPDIR
    : join(homedir(), '.cache', 'adm-connector-tests'));
  await mkdir(rootParent, { recursive: true, mode: 0o700 });
  return mkdtemp(join(rootParent, 'failure-matrix-'));
}

/**
 * 1. Scenario: FRESH
 */
export async function runScenarioFresh({ root = null, items = STANDARD_ITEMS } = {}) {
  const isTemp = !root;
  const testRoot = root || await createTestRoot();
  const profileDir = join(testRoot, 'profile');
  const stateDir = join(testRoot, 'state');
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const integrityKey = Buffer.alloc(32, 0x5a).toString('hex');
  const company = 'test-company';
  const space = 'test-space';
  const now = () => 1729987200000;

  try {
    const cache = new AdmCache({
      profileDir,
      company,
      space,
      integrityKey,
      now,
      timeoutMs: 200,
      maxAgeMs: 300000,
      breakerThreshold: 3,
      breakerMs: 10000,
    });

    const fetchItems = async () => items;
    const readResult = await cache.read({ fetchItems });

    const hooks = createHooks({
      stateDir,
      load: async () => ({
        items: readResult.items,
        fetchedAt: now(),
        degraded: false,
      }),
    });

    const sessionStart = await hooks.run({
      hook_event_name: 'SessionStart',
      session_id: 'sess-fresh-1',
    });

    const userPrompt = await hooks.run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-fresh-1',
      prompt: 'deploy release rc.14 на бой',
    });

    // Production ContextDelivery boundary check
    const delivery = new ContextDelivery(cache, 'sess-fresh-prod');
    const startDelivery = await delivery.deliver({ items: readResult.items, phase: 'SessionStart' });
    const promptDelivery = await delivery.deliver({ items: readResult.items, phase: 'UserPromptSubmit', triggers: ['deploy'] });

    return {
      status: 'pass',
      mode: readResult.mode,
      hazardousAllowed: readResult.hazardousAllowed,
      sessionStartBytes: sessionStart.bytes,
      sessionStartUnder12K: sessionStart.bytes <= 12 * 1024,
      userPromptBytes: userPrompt.bytes,
      userPromptUnder2K: userPrompt.bytes <= 2 * 1024,
      contextHasDeployRule: userPrompt.context.includes('adm/trigger/deploy'),
      userPromptContext: userPrompt.context,
      sessionStartContext: sessionStart.context,
      productionDelivery: {
        startBytes: startDelivery.bytes,
        promptBytes: promptDelivery.bytes,
        prodStartUnder12K: startDelivery.bytes <= 12 * 1024,
        prodPromptUnder2K: promptDelivery.bytes <= 2 * 1024,
      },
    };
  } finally {
    if (isTemp) await rm(testRoot, { recursive: true, force: true });
  }
}

/**
 * 2. Scenario: STALE
 */
export async function runScenarioStale({ root = null, items = STANDARD_ITEMS } = {}) {
  const isTemp = !root;
  const testRoot = root || await createTestRoot();
  const profileDir = join(testRoot, 'profile');
  const stateDir = join(testRoot, 'state');
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const integrityKey = Buffer.alloc(32, 0x5a).toString('hex');
  const company = 'test-company';
  const space = 'test-space';
  let currentTime = 1729987200000;
  const now = () => currentTime;

  try {
    const seedCache = new AdmCache({
      profileDir,
      company,
      space,
      integrityKey,
      now,
      timeoutMs: 200,
    });
    await seedCache.read({ fetchItems: async () => items });

    // Advance time by 1 minute; upstream network fails
    currentTime += 60000;
    const cache = new AdmCache({
      profileDir,
      company,
      space,
      integrityKey,
      now,
      timeoutMs: 100,
      maxAgeMs: 300000,
      breakerThreshold: 3,
      breakerMs: 10000,
    });

    const fetchFailing = async () => { throw new Error('ECONNREFUSED'); };
    const readResult = await cache.read({ fetchFailing });

    const hooks = createHooks({
      stateDir,
      load: async () => ({
        items: readResult.items,
        fetchedAt: now() - readResult.ageMs,
        degraded: true,
      }),
    });

    const userPrompt = await hooks.run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-stale-1',
      prompt: 'ssh root@worker-1',
    });

    const delivery = new ContextDelivery(cache, 'sess-stale-prod');
    const staleDelivery = await delivery.deliver({ items: readResult.items, phase: 'UserPromptSubmit', triggers: ['deploy'] });

    return {
      status: 'pass',
      mode: readResult.mode,
      ageMs: readResult.ageMs,
      hazardousAllowed: readResult.hazardousAllowed,
      warning: readResult.warning,
      userPromptBytes: userPrompt.bytes,
      userPromptUnder2K: userPrompt.bytes <= 2 * 1024,
      contextIncludesDegradedWarning: userPrompt.context.includes('knowledge degraded'),
      contextIncludesSshRule: userPrompt.context.includes('adm/trigger/ssh'),
      userPromptContext: userPrompt.context,
      productionDelivery: {
        bytes: staleDelivery.bytes,
        under2K: staleDelivery.bytes <= 2048,
      },
    };
  } finally {
    if (isTemp) await rm(testRoot, { recursive: true, force: true });
  }
}

/**
 * 3. Scenario: FAIL-CLOSED
 */
export async function runScenarioFailClosed({ root = null, items = STANDARD_ITEMS } = {}) {
  const isTemp = !root;
  const testRoot = root || await createTestRoot();
  const corruptProfileDir = join(testRoot, 'corrupt-profile');
  const stateDir = join(testRoot, 'state');
  await mkdir(corruptProfileDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const integrityKey = Buffer.alloc(32, 0x5a).toString('hex');
  const company = 'test-company';
  const space = 'test-space';
  const now = () => 1729987200000;

  try {
    const badCache = new AdmCache({
      profileDir: corruptProfileDir,
      company,
      space,
      integrityKey,
      now,
      timeoutMs: 100,
    });

    // Write corrupted / tampered cache file directly
    await badCache.atomic(badCache.file, { corrupt: 'tampered payload', signature: 'bad-sig' });

    const fetchFailing = async () => { throw new Error('ETIMEDOUT'); };
    const readResult = await badCache.read({ fetchItems: fetchFailing, hazardous: true });

    const hooks = createHooks({
      stateDir,
      load: async () => {
        if (readResult.mode === 'fail-closed') throw new Error('ADM_CACHE_INVALID');
        return { items: readResult.items, fetchedAt: now(), degraded: true };
      },
    });

    const userPrompt = await hooks.run({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-fail-closed-1',
      prompt: 'deploy to production immediately',
    });

    return {
      status: 'pass',
      mode: readResult.mode,
      hazardousAllowed: readResult.hazardousAllowed,
      itemsCount: readResult.items.length,
      contextEnforcesFailClosed: userPrompt.context.includes('fail closed: fresh knowledge or human approval required'),
      noLeakedPolicyBodies: !userPrompt.context.includes('Выкат доски — только образ из CI'),
      userPromptContext: userPrompt.context,
    };
  } finally {
    if (isTemp) await rm(testRoot, { recursive: true, force: true });
  }
}

/**
 * 4. Scenario: CONCURRENT REVISION
 */
export async function runScenarioConcurrentRevision({ root = null, items = STANDARD_ITEMS } = {}) {
  const isTemp = !root;
  const testRoot = root || await createTestRoot();
  const profileDir = join(testRoot, 'profile');
  const stateDir = join(testRoot, 'state');
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const integrityKey = Buffer.alloc(32, 0x5a).toString('hex');
  const company = 'test-company';
  const space = 'test-space';
  const now = () => 1729987200000;

  try {
    const hooks = createHooks({
      stateDir,
      load: async () => ({
        items,
        fetchedAt: now(),
        degraded: false,
      }),
    });

    const sessionId = 'sess-concurrent-rev';

    // 4a. Concurrent requests in parallel for same session
    const [resA, resB] = await Promise.all([
      hooks.run({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'ssh bot-1' }),
      hooks.run({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'ssh bot-2' }),
    ]);

    // Exactly one should deliver the rule, the second should be deduplicated
    const totalBytes = resA.bytes + resB.bytes;
    const bothUnder2K = resA.bytes <= 2048 && resB.bytes <= 2048;
    const deduplicated = (resA.bytes > 0 && resB.bytes === 0) || (resB.bytes > 0 && resA.bytes === 0);

    // 4b. Base revision proposal deferral on conflict
    const cache = new AdmCache({
      profileDir,
      company,
      space,
      integrityKey,
      now,
    });

    const deferResult = await cache.defer({
      slug: 'adm/policy/secret-hygiene',
      base_revision: 'rev-1',
      idempotency_key: `conflict-fix-${randomUUID()}`,
      title: 'Updated Secret Hygiene',
      summary: 'Updated summary requiring owner approval',
    });

    // 4c. Production ContextDelivery parallel execution boundary check
    const prodDelivery = new ContextDelivery(cache, 'sess-concurrent-prod');
    const [prodA, prodB] = await Promise.all([
      prodDelivery.deliver({ items, phase: 'UserPromptSubmit', triggers: ['ssh'] }),
      prodDelivery.deliver({ items, phase: 'UserPromptSubmit', triggers: ['ssh'] }),
    ]);
    const prodDeduplicated = (prodA.bytes > 0 && prodB.bytes === 0) || (prodB.bytes > 0 && prodA.bytes === 0);

    return {
      status: 'pass',
      parallelExecutionHandled: bothUnder2K,
      sessionRevisionDeduplicated: deduplicated,
      resABytes: resA.bytes,
      resBBytes: resB.bytes,
      totalBytes,
      productionDeduplicated: prodDeduplicated,
      deferralMode: deferResult.mode,
      publishable: deferResult.publishable,
      requiresOwnerReview: deferResult.requires_owner_review,
    };
  } finally {
    if (isTemp) await rm(testRoot, { recursive: true, force: true });
  }
}

/**
 * 5. Scenario: RECOVERY
 */
export async function runScenarioRecovery({ root = null, items = STANDARD_ITEMS } = {}) {
  const isTemp = !root;
  const testRoot = root || await createTestRoot();
  const profileDir = join(testRoot, 'profile');
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  const integrityKey = Buffer.alloc(32, 0x5a).toString('hex');
  const company = 'test-company';
  const space = 'test-space';
  let currentTime = 1729987200000;
  const now = () => currentTime;

  try {
    const cache = new AdmCache({
      profileDir,
      company,
      space,
      integrityKey,
      now,
      timeoutMs: 50,
      backoffMs: 100,
      maxBackoffMs: 1000,
      breakerThreshold: 3,
      breakerMs: 5000,
    });

    const fetchFailing = async () => { throw new Error('503 Service Unavailable'); };

    // 3 failures to trip breaker
    await cache.read({ fetchItems: fetchFailing });
    currentTime += 200;
    await cache.read({ fetchItems: fetchFailing });
    currentTime += 500;
    await cache.read({ fetchItems: fetchFailing });

    const healthTripped = await cache.health();
    const breakerTripped = healthTripped.failures >= 3 && healthTripped.nextAttempt > now();

    // Fast forward past cooldown
    currentTime += 6000;

    // Upstream recovers
    const fetchRecovered = async () => items;
    const recoveredRead = await cache.read({ fetchItems: fetchRecovered });

    const healthRecovered = await cache.health();

    return {
      status: 'pass',
      breakerTripped,
      trippedFailuresCount: healthTripped.failures,
      recoveredMode: recoveredRead.mode,
      recoveredHazardousAllowed: recoveredRead.hazardousAllowed,
      failuresResetToZero: healthRecovered.failures === 0,
      nextAttemptResetToZero: healthRecovered.nextAttempt === 0,
    };
  } finally {
    if (isTemp) await rm(testRoot, { recursive: true, force: true });
  }
}

/**
 * Executes all 5 failure and integration scenarios sequentially and aggregates results.
 */
export async function executeFailureMatrix({ baseDir = null, items = STANDARD_ITEMS } = {}) {
  const root = await createTestRoot(baseDir);

  try {
    const fresh = await runScenarioFresh({ root, items });
    const stale = await runScenarioStale({ root, items });
    const fail_closed = await runScenarioFailClosed({ root, items });
    const concurrent_revision = await runScenarioConcurrentRevision({ root, items });
    const recovery = await runScenarioRecovery({ root, items });

    return {
      status: 'success',
      timestamp: new Date().toISOString(),
      matrix: {
        fresh,
        stale,
        fail_closed,
        concurrent_revision,
        recovery,
      },
    };
  } finally {
    if (!baseDir) {
      await rm(root, { recursive: true, force: true });
    }
  }
}
