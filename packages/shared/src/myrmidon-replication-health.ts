import { z } from "zod";

export type ReplicationRole = "primary" | "standby";

export type ReplicationHealthStatus = "ok" | "warning" | "critical" | "unknown";

export interface ReplicationStandbyInfo {
  applicationName: string | null;
  clientAddr: string | null;
  state: string;
  syncState: string;
  syncPriority: number;
  sentLsn: string | null;
  writeLsn: string | null;
  flushLsn: string | null;
  replayLsn: string | null;
  writeLagSeconds: number | null;
  flushLagSeconds: number | null;
  replayLagSeconds: number | null;
  byteLag: number | null;
}

export interface ReplicationReceiverInfo {
  status: string;
  receiveStartLsn: string | null;
  receivedLsn: string | null;
  lastMsgSendTime: string | null;
  lastMsgReceiptTime: string | null;
  latestEndLsn: string | null;
  latestEndTime: string | null;
  slotName: string | null;
  senderHost: string | null;
  senderPort: number | null;
}

export interface ReplicationLagInfo {
  seconds: number | null;
  bytes: number | null;
  lastReplayTimestamp: string | null;
  currentWalLsn: string | null;
  lastReceiveLsn: string | null;
  lastReplayLsn: string | null;
}

export interface ReplicationHealthWarning {
  code: string;
  message: string;
}

export interface ReplicationHealthResponse {
  status: ReplicationHealthStatus;
  role: ReplicationRole;
  inRecovery: boolean;
  connectedStandbys: number;
  standbys?: ReplicationStandbyInfo[];
  receiver?: ReplicationReceiverInfo | null;
  lag: ReplicationLagInfo;
  warnings: ReplicationHealthWarning[];
  checkedAt: string;
}

export const replicationHealthQuerySchema = z.object({
  maxLagSeconds: z.coerce.number().nonnegative().optional(),
  warnLagSeconds: z.coerce.number().nonnegative().optional(),
  role: z.enum(["primary", "standby", "any"]).optional(),
});

export type ReplicationHealthQuery = z.infer<typeof replicationHealthQuerySchema>;
