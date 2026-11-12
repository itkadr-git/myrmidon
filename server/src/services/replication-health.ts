import { sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import type {
  ReplicationHealthQuery,
  ReplicationHealthResponse,
  ReplicationHealthStatus,
  ReplicationHealthWarning,
  ReplicationLagInfo,
  ReplicationReceiverInfo,
  ReplicationRole,
  ReplicationStandbyInfo,
} from "@myrmidon/shared";

function extractRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows?: unknown[] }).rows)
  ) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

export async function inspectReplicationHealth(
  db: Db,
  query?: ReplicationHealthQuery,
): Promise<ReplicationHealthResponse> {
  const recoveryRes = await db.execute(sql`SELECT pg_is_in_recovery() AS in_recovery`);
  const recoveryRows = extractRows(recoveryRes);
  const inRecovery = Boolean(recoveryRows[0]?.in_recovery);
  const role: ReplicationRole = inRecovery ? "standby" : "primary";

  let standbys: ReplicationStandbyInfo[] | undefined;
  let receiver: ReplicationReceiverInfo | null = null;
  let lag: ReplicationLagInfo = {
    seconds: 0,
    bytes: null,
    lastReplayTimestamp: null,
    currentWalLsn: null,
    lastReceiveLsn: null,
    lastReplayLsn: null,
  };

  if (inRecovery) {
    try {
      const receiverRes = await db.execute(sql`
        SELECT
          status,
          receive_start_lsn::text AS receive_start_lsn,
          received_lsn::text AS received_lsn,
          last_msg_send_time::text AS last_msg_send_time,
          last_msg_receipt_time::text AS last_msg_receipt_time,
          latest_end_lsn::text AS latest_end_lsn,
          latest_end_time::text AS latest_end_time,
          slot_name,
          sender_host,
          sender_port
        FROM pg_stat_wal_receiver
      `);
      const receiverRows = extractRows(receiverRes);
      if (receiverRows.length > 0 && receiverRows[0]) {
        const row = receiverRows[0];
        receiver = {
          status: String(row.status ?? "unknown"),
          receiveStartLsn: row.receive_start_lsn ? String(row.receive_start_lsn) : null,
          receivedLsn: row.received_lsn ? String(row.received_lsn) : null,
          lastMsgSendTime: row.last_msg_send_time ? String(row.last_msg_send_time) : null,
          lastMsgReceiptTime: row.last_msg_receipt_time ? String(row.last_msg_receipt_time) : null,
          latestEndLsn: row.latest_end_lsn ? String(row.latest_end_lsn) : null,
          latestEndTime: row.latest_end_time ? String(row.latest_end_time) : null,
          slotName: row.slot_name ? String(row.slot_name) : null,
          senderHost: row.sender_host ? String(row.sender_host) : null,
          senderPort:
            row.sender_port !== null && row.sender_port !== undefined
              ? Number(row.sender_port)
              : null,
        };
      }
    } catch {
      // Receiver status unavailable
    }

    try {
      const lagRes = await db.execute(sql`
        SELECT
          COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - pg_last_xact_replay_timestamp())), 0) AS replay_lag_seconds,
          pg_last_xact_replay_timestamp()::text AS last_replay_timestamp,
          pg_last_wal_receive_lsn()::text AS last_receive_lsn,
          pg_last_wal_replay_lsn()::text AS last_replay_lsn,
          CASE
            WHEN pg_last_wal_receive_lsn() IS NOT NULL AND pg_last_wal_replay_lsn() IS NOT NULL
            THEN pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())
            ELSE NULL
          END AS byte_lag
      `);
      const lagRows = extractRows(lagRes);
      if (lagRows.length > 0 && lagRows[0]) {
        const row = lagRows[0];
        const rawSeconds =
          row.replay_lag_seconds !== null && row.replay_lag_seconds !== undefined
            ? Number(row.replay_lag_seconds)
            : null;
        const rawBytes =
          row.byte_lag !== null && row.byte_lag !== undefined
            ? Number(row.byte_lag)
            : null;

        lag = {
          seconds: rawSeconds !== null ? Math.round(rawSeconds * 100) / 100 : null,
          bytes: rawBytes,
          lastReplayTimestamp: row.last_replay_timestamp ? String(row.last_replay_timestamp) : null,
          currentWalLsn: null,
          lastReceiveLsn: row.last_receive_lsn ? String(row.last_receive_lsn) : null,
          lastReplayLsn: row.last_replay_lsn ? String(row.last_replay_lsn) : null,
        };
      }
    } catch {
      // Lag query unavailable
    }
  } else {
    // Primary node
    let currentWalLsn: string | null = null;
    try {
      const walRes = await db.execute(sql`SELECT pg_current_wal_lsn()::text AS current_wal_lsn`);
      const walRows = extractRows(walRes);
      currentWalLsn = walRows[0]?.current_wal_lsn ? String(walRows[0].current_wal_lsn) : null;
    } catch {
      // Current WAL LSN unavailable
    }

    const standbyList: ReplicationStandbyInfo[] = [];
    try {
      const replRes = await db.execute(sql`
        SELECT
          application_name,
          client_addr::text AS client_addr,
          state,
          sync_state,
          sync_priority,
          sent_lsn::text AS sent_lsn,
          write_lsn::text AS write_lsn,
          flush_lsn::text AS flush_lsn,
          replay_lsn::text AS replay_lsn,
          COALESCE(EXTRACT(EPOCH FROM write_lag), 0) AS write_lag_seconds,
          COALESCE(EXTRACT(EPOCH FROM flush_lag), 0) AS flush_lag_seconds,
          COALESCE(EXTRACT(EPOCH FROM replay_lag), 0) AS replay_lag_seconds,
          CASE
            WHEN replay_lsn IS NOT NULL AND pg_current_wal_lsn() IS NOT NULL
            THEN pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)
            ELSE NULL
          END AS byte_lag
        FROM pg_stat_replication
      `);
      const replRows = extractRows(replRes);
      for (const row of replRows) {
        const rawReplayLag =
          row.replay_lag_seconds !== null && row.replay_lag_seconds !== undefined
            ? Number(row.replay_lag_seconds)
            : null;
        const rawWriteLag =
          row.write_lag_seconds !== null && row.write_lag_seconds !== undefined
            ? Number(row.write_lag_seconds)
            : null;
        const rawFlushLag =
          row.flush_lag_seconds !== null && row.flush_lag_seconds !== undefined
            ? Number(row.flush_lag_seconds)
            : null;
        const rawByteLag =
          row.byte_lag !== null && row.byte_lag !== undefined
            ? Number(row.byte_lag)
            : null;

        standbyList.push({
          applicationName: row.application_name ? String(row.application_name) : null,
          clientAddr: row.client_addr ? String(row.client_addr) : null,
          state: String(row.state ?? "unknown"),
          syncState: String(row.sync_state ?? "async"),
          syncPriority: Number(row.sync_priority ?? 0),
          sentLsn: row.sent_lsn ? String(row.sent_lsn) : null,
          writeLsn: row.write_lsn ? String(row.write_lsn) : null,
          flushLsn: row.flush_lsn ? String(row.flush_lsn) : null,
          replayLsn: row.replay_lsn ? String(row.replay_lsn) : null,
          writeLagSeconds: rawWriteLag !== null ? Math.round(rawWriteLag * 100) / 100 : null,
          flushLagSeconds: rawFlushLag !== null ? Math.round(rawFlushLag * 100) / 100 : null,
          replayLagSeconds: rawReplayLag !== null ? Math.round(rawReplayLag * 100) / 100 : null,
          byteLag: rawByteLag,
        });
      }
    } catch {
      // Stat replication unavailable
    }

    standbys = standbyList;

    if (standbyList.length > 0) {
      const replayLags = standbyList
        .map((s) => s.replayLagSeconds)
        .filter((l): l is number => l !== null);
      const byteLags = standbyList
        .map((s) => s.byteLag)
        .filter((b): b is number => b !== null);

      const maxReplayLag = replayLags.length > 0 ? Math.max(...replayLags) : 0;
      const maxByteLag = byteLags.length > 0 ? Math.max(...byteLags) : 0;

      lag = {
        seconds: maxReplayLag,
        bytes: maxByteLag,
        lastReplayTimestamp: null,
        currentWalLsn,
        lastReceiveLsn: null,
        lastReplayLsn: null,
      };
    } else {
      lag = {
        seconds: 0,
        bytes: 0,
        lastReplayTimestamp: null,
        currentWalLsn,
        lastReceiveLsn: null,
        lastReplayLsn: null,
      };
    }
  }

  const warnings: ReplicationHealthWarning[] = [];
  let status: ReplicationHealthStatus = "ok";

  const escalateStatus = (next: ReplicationHealthStatus) => {
    const priority: Record<ReplicationHealthStatus, number> = {
      ok: 0,
      warning: 1,
      critical: 2,
      unknown: 3,
    };
    if (priority[next] > priority[status]) {
      status = next;
    }
  };

  if (query?.role && query.role !== "any" && query.role !== role) {
    warnings.push({
      code: "replication_role_mismatch",
      message: `Expected replication role '${query.role}', but instance is running as '${role}'.`,
    });
    escalateStatus("warning");
  }

  if (inRecovery) {
    if (!receiver || receiver.status !== "streaming") {
      warnings.push({
        code: "standby_not_streaming",
        message: `Standby WAL receiver is not streaming (current status: '${receiver?.status ?? "inactive"}').`,
      });
      escalateStatus("warning");
    }
  }

  if (lag.seconds !== null) {
    if (query?.maxLagSeconds !== undefined && lag.seconds > query.maxLagSeconds) {
      warnings.push({
        code: "replication_lag_exceeded",
        message: `Replication lag (${lag.seconds}s) exceeds maximum threshold (${query.maxLagSeconds}s).`,
      });
      escalateStatus("critical");
    } else if (query?.warnLagSeconds !== undefined && lag.seconds > query.warnLagSeconds) {
      warnings.push({
        code: "replication_lag_warning",
        message: `Replication lag (${lag.seconds}s) exceeds warning threshold (${query.warnLagSeconds}s).`,
      });
      escalateStatus("warning");
    }
  }

  return {
    status,
    role,
    inRecovery,
    connectedStandbys: standbys ? standbys.length : 0,
    ...(standbys ? { standbys } : {}),
    ...(inRecovery ? { receiver } : {}),
    lag,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}
