// Leader-lease block of the "Processes" panel (myrmidon 1.6.6 PROCS-1.7 B,
// design OPE-5394 §5.1/§7.2): one row per board_leases entry — the lease name,
// its holder (boot id plus the board_processes hostname/pid when that row
// exists), epoch, acquired_at, expires_at and whether this process is the
// leader. Read-only and self-contained: it can be dropped into the "Процессы"
// panel (PROCS-0.1, OPE-6416) with a single line, and it renders its own "no
// data" state instead of taking the panel down when the endpoint is missing
// (part A of OPE-5413 is not in this build yet).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Crown } from "lucide-react";
import { ApiError } from "@/api/client";
import { useCompanyLiveEvent } from "@/context/LiveUpdatesProvider";
import { useTranslation } from "@/i18n";
import {
  BOARD_LEASES_REFETCH_MS,
  boardLeasesApi,
  boardLeasesQueryKey,
  formatLeaseTimestamp,
  isLeaderChangedEvent,
  leaseExpiryState,
  leaseIsSelf,
  shortBootId,
  type BoardLease,
  type BoardLeasesState,
} from "./boardLeasesApi";

// The fork's translator, typed the way the neighbouring myrmidon panels type it
// (BotDiskSettingsPanel): the catalog lives in ui/src/i18n/myrmidon-locales.
type Translate = (key: string, options?: Record<string, unknown>) => string;

// myrmidon(PROCS-1.7 B): visible strings live in the fork i18n catalog
// (ui/src/i18n/myrmidon-locales, `boardLeases.*`; en + ru).
const LEASE_NAME_KEYS: Record<string, string> = {
  scheduler: "boardLeases.leaseScheduler",
  backup: "boardLeases.leaseBackup",
  botops: "boardLeases.leaseBotOps",
};

const EXPIRY_KEYS: Record<string, string> = {
  active: "boardLeases.active",
  expired: "boardLeases.expired",
  unknown: "boardLeases.expiryUnknown",
};

const SELF_KEYS: Record<string, string> = {
  yes: "boardLeases.selfYes",
  no: "boardLeases.selfNo",
  unknown: "boardLeases.selfUnknown",
};

function badgeClass(tone: "ok" | "warn" | "muted"): string {
  if (tone === "ok") return "rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs";
  if (tone === "warn") return "rounded-full border border-destructive/40 bg-destructive/5 px-2 py-0.5 text-xs";
  return "rounded-full border px-2 py-0.5 text-xs text-muted-foreground";
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function holderText(lease: BoardLease, t: Translate): string {
  const holder = lease.holder;
  const parts: string[] = [];
  if (holder?.hostname) parts.push(holder.hostname);
  if (holder?.pid !== null && holder?.pid !== undefined) {
    parts.push(`${t("boardLeases.holderPid")} ${holder.pid}`);
  }
  const boot = shortBootId(holder?.bootId ?? lease.holderBootId);
  if (boot) parts.push(`${t("boardLeases.holderBoot")} ${boot}`);
  if (holder?.role) parts.push(`${t("boardLeases.holderRole")} ${holder.role}`);
  if (holder?.lastSeenAt) {
    const seen = formatLeaseTimestamp(holder.lastSeenAt);
    if (seen) parts.push(`${t("boardLeases.holderLastSeen")} ${seen}`);
  }
  // No board_processes row for the holder: the lease is real, the process row
  // is gone (a process that died between two pulses). Say so instead of
  // printing an empty cell.
  if (!holder) parts.push(t("boardLeases.holderMissing"));
  return parts.length > 0 ? parts.join(" · ") : t("boardLeases.holderMissing");
}

function LeaseRow({
  lease,
  selfBootId,
  nowMs,
}: {
  lease: BoardLease;
  selfBootId: string | null;
  nowMs: number;
}) {
  const { t } = useTranslation() as { t: Translate };
  const expiry = leaseExpiryState(lease, nowMs);
  const isSelf = leaseIsSelf(lease, selfBootId);
  const selfState = isSelf === true ? "yes" : isSelf === false ? "no" : "unknown";
  const nameKey = LEASE_NAME_KEYS[lease.name];
  const expires = formatLeaseTimestamp(lease.expiresAt);

  return (
    <div className="rounded-md border px-3 py-2" data-testid={`myrmidon-board-lease-${lease.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{nameKey ? t(nameKey) : lease.name}</span>
        <span
          className={badgeClass(expiry === "expired" ? "warn" : expiry === "active" ? "ok" : "muted")}
          data-testid="myrmidon-board-lease-expiry"
          data-state={expiry}
        >
          {t(EXPIRY_KEYS[expiry])}
        </span>
        <span className={badgeClass("muted")} data-testid="myrmidon-board-lease-self" data-state={selfState}>
          {t(SELF_KEYS[selfState])}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <Cell label={t("boardLeases.columnHolder")} value={holderText(lease, t)} />
        <Cell
          label={t("boardLeases.columnEpoch")}
          value={lease.epoch === null ? t("boardLeases.noEpoch") : String(lease.epoch)}
        />
        <Cell
          label={t("boardLeases.columnAcquired")}
          value={formatLeaseTimestamp(lease.acquiredAt) ?? t("boardLeases.noAcquired")}
        />
        <Cell label={t("boardLeases.columnExpires")} value={expires ?? t("boardLeases.noExpires")} />
      </dl>
    </div>
  );
}

export interface BoardLeasesViewProps {
  data: BoardLeasesState | null;
  loading: boolean;
  error: unknown;
  /** Fixed clock for tests; production uses the browser clock. */
  now?: number;
}

export function BoardLeasesView({ data, loading, error, now }: BoardLeasesViewProps) {
  const { t } = useTranslation() as { t: Translate };
  const clock = now ?? Date.now();
  const leases = data?.leases ?? [];
  // A dead endpoint is a state, not a failure: the endpoint (part A) may simply
  // not be in this build, so the block reports "no data" and the panel around
  // it keeps working.
  const failed = error !== null && error !== undefined;
  const status = error instanceof ApiError ? error.status : null;
  const refreshedAt =
    formatLeaseTimestamp(data?.serverTime ?? null) ?? formatLeaseTimestamp(new Date(clock).toISOString());

  return (
    <section className="space-y-4" data-testid="myrmidon-board-leases">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Crown className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("boardLeases.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("boardLeases.description")}</p>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-board-leases-loading">
          {t("boardLeases.loading")}
        </p>
      ) : failed || !data ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
          data-testid="myrmidon-board-leases-nodata"
        >
          <p className="font-medium">
            {t("boardLeases.noData")}
            {status === null ? null : (
              <span className="text-xs text-muted-foreground" data-testid="myrmidon-board-leases-nodata-status">
                {" "}
                {status}
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">{t("boardLeases.noDataHint")}</p>
        </div>
      ) : leases.length === 0 ? (
        <div className="space-y-1" data-testid="myrmidon-board-leases-empty">
          <p className="text-sm">{t("boardLeases.empty")}</p>
          <p className="text-xs text-muted-foreground">{t("boardLeases.emptyHint")}</p>
        </div>
      ) : (
        <div className="space-y-3" data-testid="myrmidon-board-leases-rows">
          {leases.map((lease) => (
            <LeaseRow
              key={lease.name}
              lease={lease}
              selfBootId={data.selfBootId}
              nowMs={clock}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground" data-testid="myrmidon-board-leases-updated">
        {t("boardLeases.updatedAt", { time: refreshedAt })}
      </p>
    </section>
  );
}

/** Polls the lease read model every 10 s and invalidates early when the API
 *  publishes a handover, so a lease change is visible without a restart. */
export function BoardLeasesPanel({ now }: { now?: number } = {}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: boardLeasesQueryKey,
    queryFn: boardLeasesApi.get,
    refetchInterval: BOARD_LEASES_REFETCH_MS,
    retry: false,
  });

  useCompanyLiveEvent((event) => {
    if (isLeaderChangedEvent(event)) {
      void queryClient.invalidateQueries({ queryKey: boardLeasesQueryKey });
    }
  });

  return (
    <BoardLeasesView
      data={query.data ?? null}
      loading={query.isPending}
      error={query.error}
      now={now}
    />
  );
}