import { sql } from 'drizzle-orm';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../../packages/db/src/client'; // Adjust the path as needed
import { heartbeatRuns } from '../../packages/db/src/schema/heartbeat_runs';

// Test script to measure query performance before and after the migration
async function testQueryPerformance() {
  console.log('Testing query performance...');
  
  // Original query pattern from the watchdog service
  const startTime = Date.now();
  
  try {
    // Simulate the original problematic query
    const results = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        runtimeMode: heartbeatRuns.runtimeMode,
        companyId: heartbeatRuns.companyId,
        lastOutputAt: heartbeatRuns.lastOutputAt,
        processStartedAt: heartbeatRuns.processStartedAt,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.status, "running"),
          lt(
            sql`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.processStartedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt})`,
            new Date(Date.now() - 30000) // 30 seconds ago
          )
        )
      )
      .limit(100);
    
    const endTime = Date.now();
    console.log(`Query took: ${endTime - startTime} ms`);
    console.log(`Results returned: ${results.length}`);
    
    return {
      duration: endTime - startTime,
      results: results.length
    };
  } catch (error) {
    console.error('Query failed:', error);
    return null;
  }
}

// Run the test
testQueryPerformance()
  .then(result => {
    if (result) {
      console.log(`Performance test completed: ${result.duration}ms for ${result.results} results`);
      
      if (result.duration < 50) {
        console.log('✅ Query performance is acceptable (< 50ms)');
      } else {
        console.log('⚠️ Query performance needs optimization');
      }
    }
  })
  .catch(error => {
    console.error('Test failed:', error);
  });