// myrmidon(UI-2.0 Wave A part 2, ia-v2 §3): UI-2.0 top bar — nest switcher
// ("All nests" = project scope today, screen-map §5 q1), the honest status
// chips (Colony / Runs / Spend), the "Tell the Commander" entry (opens the
// commander palette) and the "Waiting for me" badge.
//
// Chip contract (owner decision 03.10, ia-v2 §3 + §7.5):
//   - every number comes from its pinned API through useUi2StatusStrip
//     (dashboard.agents, live-runs + runActivity, costs/summary, the
//     approvals+decisions+interactions union);
//   - the Fleet chip is REMOVED until fleet metrics exist (§3: убрать до
//     MONITORING) — it showed a fabricated literal before;
//   - a chip whose source has not resolved renders its empty state ("—"),
//     never a partial or zero-looking number;
//   - spend with budgetCents = 0 renders "$X" with NO "of $0" text;
//   - all copy comes from the ui2 catalog (no defaultValue literals — the
//     no-english-in-ru guard owns the key set in both catalogs).
// Every visual value comes from --myr-* tokens.
import { useState } from "react";
import { CircleAlert, ChevronDown, MessagesSquare, Server, Users, Wallet } from "lucide-react";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { useUi2StatusStrip } from "../useUi2Status";
import { Ui2CommanderPalette } from "./Ui2CommanderPalette";

function StatusChip({
  icon: Icon,
  label,
  tone,
  mono,
}: {
  icon: typeof Users;
  label: string;
  tone: "default" | "attention";
  mono?: boolean;
}) {
  return (
    <span
      className="myr-ui2__chip"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        borderRadius: "var(--myr-radius-sm)",
        border: "1px solid var(--myr-hairline)",
        background: tone === "attention" ? "var(--myr-signal-warn-t)" : "var(--myr-surface-sunk)",
        color: tone === "attention" ? "var(--myr-signal-warn)" : "var(--myr-ink-muted)",
        padding: "4px 8px",
        fontSize: "var(--myr-text-nano)",
        fontWeight: 500,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
      }}
    >
      <Icon aria-hidden="true" style={{ width: 12, height: 12 }} />
      <span
        style={{
          fontFamily: mono ? "var(--myr-font-mono)" : undefined,
          fontSize: mono ? "var(--myr-text-nano)" : undefined,
        }}
      >
        {label}
      </span>
    </span>
  );
}

export function Ui2TopBar() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const strip = useUi2StatusStrip(selectedCompanyId);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const colony = strip?.colony ?? null;
  const runs = strip?.runs ?? null;
  const spend = strip?.spend ?? null;
  const waiting = strip?.waiting ?? null;

  return (
    <header
      className="myr-ui2__topbar"
      style={{
        height: "var(--myr-topbar-height)",
        display: "flex",
        alignItems: "center",
        gap: "var(--myr-space-2)",
        padding: "0 var(--myr-space-2)",
        background: "var(--myr-surface-raised)",
        borderBottom: "1px solid var(--myr-hairline)",
      }}
    >
      {/* Nest switcher. Nests are projects before 2.0 (owner 02.10); the
          switcher is a stub that states the scope rather than a menu until
          the multi-project selector lands. */}
      <button
        type="button"
        className="myr-ui2__nest-switcher"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          borderRadius: "var(--myr-radius-sm)",
          border: "1px solid var(--myr-hairline)",
          background: "transparent",
          color: "var(--myr-ink)",
          padding: "6px 10px",
          fontSize: "var(--myr-text-body)",
          fontWeight: 600,
        }}
      >
        {t("ui2.nests.all")}
        <ChevronDown aria-hidden="true" style={{ width: 14, height: 14, color: "var(--myr-ink-muted)" }} />
      </button>

      <div
        className="myr-ui2__status-strip"
        style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}
      >
        {/* Colony: running of total from dashboard.agents. Empty ("—") while
            the dashboard source has not resolved — never 0 of 0. */}
        <StatusChip
          icon={Users}
          label={
            colony
              ? t("ui2.chip.colony", { active: colony.running, total: colony.total })
              : t("ui2.chip.empty")
          }
          tone={colony?.attention ? "attention" : "default"}
        />
        {/* Runs: live-runs length + today's failed. Attention tone when
            failures happened today (ia-v2 §3). */}
        <StatusChip
          icon={Server}
          label={
            runs
              ? runs.failedToday > 0
                ? t("ui2.chip.runsFailed", { running: runs.running, failed: runs.failedToday })
                : t("ui2.chip.runs", { running: runs.running })
              : t("ui2.chip.empty")
          }
          tone={runs?.attention ? "attention" : "default"}
        />
        {/* Spend: costs/summary. budgetCents = 0 → the raw money value
            only, NO "of $0" (owner rule); the money string is data. */}
        <StatusChip
          icon={Wallet}
          label={
            spend
              ? spend.budget
                ? t("ui2.chip.spend", { spend: spend.spend, budget: spend.budget })
                : spend.spend
              : t("ui2.chip.empty")
          }
          tone="default"
          mono
        />
      </div>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "var(--myr-space-1)" }}>
        {/* Commander entry: opens the palette; the palette's action routes to
            the existing chat surface (screen-map §2.3: CTO-CHAT lands with
            1.6; UI-0 only wires the entry point). */}
        <button
          type="button"
          className="myr-ui2__commander-entry"
          aria-label={t("ui2.commander.aria")}
          onClick={() => setPaletteOpen(true)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            height: 36,
            minWidth: 240,
            borderRadius: "var(--myr-radius-md)",
            border: "1px solid var(--myr-hairline)",
            background: "var(--myr-surface-sunk)",
            color: "var(--myr-ink-muted)",
            padding: "0 12px",
            fontSize: "var(--myr-text-body)",
            textAlign: "left",
          }}
        >
          <MessagesSquare aria-hidden="true" style={{ width: 14, height: 14, flex: "0 0 auto" }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("ui2.commander.placeholder")}
          </span>
          <kbd
            style={{
              marginLeft: "auto",
              fontFamily: "var(--myr-font-mono)",
              fontSize: "var(--myr-text-nano)",
              color: "var(--myr-ink-muted)",
              border: "1px solid var(--myr-hairline)",
              borderRadius: "var(--myr-radius-sm)",
              padding: "1px 6px",
            }}
          >
            Ctrl K
          </kbd>
        </button>
        {/* "Waiting for me": approvals(pending) + decisions(open) +
            interactions(pending) — the union, only while the count is known
            and > 0 (ia-v2 §3). */}
        {waiting && waiting.count > 0 ? (
          <span
            aria-label={t("ui2.decisions.badge", { count: waiting.count })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              background: "var(--myr-inverse-surface)",
              color: "var(--myr-on-navy)",
              borderRadius: "var(--myr-radius-md)",
              padding: "6px 10px",
              fontSize: "var(--myr-text-nano)",
              fontWeight: 700,
            }}
          >
            <CircleAlert aria-hidden="true" style={{ width: 12, height: 12 }} />
            {waiting.count > 99 ? "99+" : waiting.count}
          </span>
        ) : null}
      </div>

      {paletteOpen ? <Ui2CommanderPalette onClose={() => setPaletteOpen(false)} /> : null}
    </header>
  );
}
