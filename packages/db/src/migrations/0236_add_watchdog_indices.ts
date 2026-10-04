import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

// This migration adds indices to optimize the watchdog query performance
export async function up(db) {
  // Add index for active run watchdog queries: runtime_mode and status filtering with timestamps
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS heartbeat_runs_watchdog_candidate_idx 
    ON heartbeat_runs (company_id, status, runtime_mode, created_at) 
    WHERE status = 'running'
  `);

  // Add index for efficient timestamp-based filtering for watchdog scans
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS heartbeat_runs_watchdog_timestamps_idx 
    ON heartbeat_runs (
      company_id, 
      status, 
      coalesce(last_output_at, process_started_at, started_at, created_at)
    ) WHERE status = 'running'
  `);

  // Add partial index for running runs to speed up watchdog scans
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS heartbeat_runs_running_status_idx 
    ON heartbeat_runs (company_id, created_at) 
    WHERE status = 'running'
  `);

  // Add index for runtime mode filtering combined with status
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS heartbeat_runs_runtime_status_idx 
    ON heartbeat_runs (company_id, runtime_mode, status) 
    WHERE status = 'running'
  `);
}

export async function down(db) {
  // Drop the indices in reverse order
  await db.execute(sql`DROP INDEX IF EXISTS heartbeat_runs_runtime_status_idx`);
  await db.execute(sql`DROP INDEX IF EXISTS heartbeat_runs_running_status_idx`);
  await db.execute(sql`DROP INDEX IF EXISTS heartbeat_runs_watchdog_timestamps_idx`);
  await db.execute(sql`DROP INDEX IF EXISTS heartbeat_runs_watchdog_candidate_idx`);
}