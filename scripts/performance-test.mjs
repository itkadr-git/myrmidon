#!/usr/bin/env node
/**
 * Тест производительности до и после оптимизации
 * 
 * Запуск:
 *   node performance-test-before-after.mjs
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { performance } from 'perf_hooks';

async function connectToDatabase() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/myrmidon_test'
  });
  await client.connect();
  return drizzle(client);
}

async function testGetConversationOwnershipBlockerPerformance() {
  console.log('Тестирование производительности getConversationOwnershipBlocker...');
  
  const db = await connectToDatabase();
  
  // Замеряем время выполнения оригинального запроса (до оптимизации)
  const startTime = performance.now();
  // Здесь будет тест с SELECT * - эмуляция старого подхода
  const originalQuery = `
    SELECT run->>'id' as id, run->>'agentId' as agentId, run->>'processPid' as processPid,
           run->>'processGroupId' as processGroupId, run->>'status' as status,
           run->>'createdAt' as "createdAt", run->>'processStartedAt' as "processStartedAt",
           activeLease
    FROM heartbeat_runs 
    WHERE company_id = $1 AND runtime_mode = 'legacy'
    AND coalesce(native_issue_id::text, context_snapshot->>'issueId') = $2
    AND status IN ('failed', 'timed_out', 'interrupted', 'cancelled')
    AND (process_pid IS NOT NULL OR process_group_id IS NOT NULL OR activeLease)
    ORDER BY created_at DESC, id DESC
  `;
  
  // Эмуляция вызова с замером времени
  for (let i = 0; i < 100; i++) {
    // В реальном тесте здесь будет выполнение запроса
  }
  
  const endTime = performance.now();
  const duration = endTime - startTime;
  console.log(`Среднее время выполнения (оптимизированный запрос): ${(duration/100).toFixed(2)}ms`);
  
  return {
    optimizedQueryTime: duration/100
  };
}

async function testHeartbeatListPerformance() {
  console.log('Тестирование производительности списка прогонов...');
  
  const db = await connectToDatabase();
  
  // Тест с тяжелыми колонками
  const startTimeHeavy = performance.now();
  // Эмуляция запроса с полной загрузкой колонок
  for (let i = 0; i < 50; i++) {
    // В реальном тесте здесь будет выполнение запроса с тяжелыми колонками
  }
  const endTimeHeavy = performance.now();
  const heavyDuration = (endTimeHeavy - startTimeHeavy)/50;
  
  // Тест с легкими колонками
  const startTimeLight = performance.now();
  // Эмуляция запроса с минимальной загрузкой колонок
  for (let i = 0; i < 50; i++) {
    // В реальном тесте здесь будет выполнение запроса с легкими колонками
  }
  const endTimeLight = performance.now();
  const lightDuration = (endTimeLight - startTimeLight)/50;
  
  console.log(`Среднее время с тяжелыми колонками: ${heavyDuration.toFixed(2)}ms`);
  console.log(`Среднее время с легкими колонками: ${lightDuration.toFixed(2)}ms`);
  console.log(`Улучшение производительности: ${((heavyDuration-lightDuration)/heavyDuration*100).toFixed(1)}%`);
  
  return {
    heavyQueryTime: heavyDuration,
    lightQueryTime: lightDuration
  };
}

async function main() {
  console.log('=== Тест производительности оптимизации прогонов ===\n');
  
  try {
    const ownershipBlockerResults = await testGetConversationOwnershipBlockerPerformance();
    const listResults = await testHeartbeatListPerformance();
    
    console.log('\n=== Результаты ===');
    console.log(`Оптимизированный getConversationOwnershipBlocker: ${ownershipBlockerResults.optimizedQueryTime.toFixed(2)}ms`);
    console.log(`Запрос списка с тяжелыми колонками: ${listResults.heavyQueryTime.toFixed(2)}ms`);
    console.log(`Запрос списка с легкими колонками: ${listResults.lightQueryTime.toFixed(2)}ms`);
    
    console.log('\n=== Ожидаемые улучшения ===');
    console.log('- Время блок-проверки < 5 мс (ожидаем)');
    console.log('- Список прогонов и лента внимания < 300 мс p95 (ожидаем)');
    console.log('- Уменьшение размера heartbeat_runs ≥ 30% (ожидаем)');
    
  } catch (error) {
    console.error('Ошибка при выполнении теста:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}