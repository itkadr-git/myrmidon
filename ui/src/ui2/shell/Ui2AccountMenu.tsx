// myrmidon(OPE-9382): UI2 account menu with interface version switcher
// ("Новая / Прежняя / По настройке экземпляра") and language selection.
import { useContext, useState, type ReactNode } from "react";
import {
  UserRound,
  Check,
  Sparkles,
  LayoutGrid,
  SlidersHorizontal,
  ChevronDown,
  Languages,
  LogOut,
} from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCompany } from "@/context/CompanyContext";
import { useTranslation } from "@/i18n";
import {
  FORK_LANGUAGES,
  forkLanguageLabel,
  useAppLanguage,
  type ForkLanguage,
} from "@/i18n/myrmidon-i18n";
import {
  useMyrmidonUi2PersonalOverride,
  type Ui2PersonalOverride,
} from "@/ui2/useMyrmidonUi2Enabled";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { useSignOut } from "@/hooks/useSignOut";
import { useOwnerActiveChannel, formatOwnerActiveChannelLabel } from "../useOwnerActiveChannel.js";

interface Ui2AccountMenuProps {
  compact?: boolean;
  trigger?: ReactNode;
  className?: string;
}

interface Ui2AccountMenuPresentationalProps extends Ui2AccountMenuProps {
  health?: { deploymentMode?: string } | null;
  onSignOut?: () => void;
  signOutPending?: boolean;
}

function Ui2AccountMenuPresentational({
  compact = false,
  trigger,
  className,
  health,
  onSignOut,
  signOutPending = false,
}: Ui2AccountMenuPresentationalProps) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  const { selectedCompany } = useCompany();
  const { language, setLanguage } = useAppLanguage();
  const { override, setOverride } = useMyrmidonUi2PersonalOverride();
  const activeChannel = useOwnerActiveChannel();

  const handleSignOut = () => {
    setOpen(false);
    onSignOut?.();
  };

  const selectInterface = (choice: Ui2PersonalOverride) => {
    setOverride(choice);
    setOpen(false);
  };

  const selectLanguage = (code: ForkLanguage) => {
    setLanguage(code);
    setOpen(false);
  };

  const defaultTrigger = compact ? (
    <button
      type="button"
      className="myr-ui2-account-menu__trigger"
      aria-label={t("ui2.owner", { defaultValue: "Owner account menu" })}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: 28,
        padding: "0 var(--myr-space-1)",
        gap: "var(--myr-space-1)",
        borderRadius: "var(--myr-radius-sm)",
        border: "1px solid var(--myr-hairline)",
        background: "var(--myr-surface-raised)",
        color: "var(--myr-ink)",
        fontSize: "var(--myr-text-nano)",
        cursor: "pointer",
      }}
      data-testid="ui2-account-menu-trigger-compact"
    >
      <UserRound style={{ width: 14, height: 14, color: "var(--myr-ink-muted)" }} />
      <span
        style={{
          maxWidth: 96,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontWeight: 500,
        }}
      >
        {selectedCompany?.name ?? t("ui2.owner")}
      </span>
      <ChevronDown style={{ width: 12, height: 12, color: "var(--myr-ink-muted)" }} />
    </button>
  ) : (
    <button
      type="button"
      className="myr-ui2-account-menu__trigger"
      aria-label={t("ui2.owner", { defaultValue: "Owner account menu" })}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        padding: "var(--myr-space-1) var(--myr-space-2)",
        borderRadius: "var(--myr-radius-sm)",
        border: "none",
        background: "transparent",
        color: "inherit",
        textAlign: "left",
        cursor: "pointer",
      }}
      data-testid="ui2-account-menu-trigger-full"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontSize: "var(--myr-text-nano)",
            color: "var(--myr-ink)",
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {selectedCompany?.name ?? t("ui2.owner")}
        </span>
        <span
          style={{ fontSize: "var(--myr-text-nano)", color: "var(--myr-ink-muted)" }}
          data-testid="ui2-owner-active-channel"
        >
          {formatOwnerActiveChannelLabel(activeChannel, t, { locale: language })}
        </span>
      </div>
      <ChevronDown style={{ width: 12, height: 12, color: "var(--myr-ink-muted)", flexShrink: 0 }} />
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild className={className}>
        {trigger ? <span style={{ cursor: "pointer", width: "100%" }}>{trigger}</span> : defaultTrigger}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        style={{
          width: 256,
          padding: "var(--myr-space-2)",
          background: "var(--myr-surface-raised)",
          border: "1px solid var(--myr-hairline)",
          borderRadius: "var(--myr-radius-md)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--myr-space-2)",
        }}
        data-testid="ui2-account-menu-content"
      >
        {/* Profile info header */}
        <div
          style={{
            paddingBottom: "var(--myr-space-1)",
            borderBottom: "1px solid var(--myr-hairline)",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <span
            style={{
              fontSize: "var(--myr-text-body)",
              fontWeight: 600,
              color: "var(--myr-ink)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {selectedCompany?.name ?? t("ui2.owner")}
          </span>
          <span style={{ fontSize: "var(--myr-text-nano)", color: "var(--myr-ink-muted)" }}>
            {formatOwnerActiveChannelLabel(activeChannel, t, { locale: language })}
          </span>
        </div>

        {/* Interface Switch section (ADM 30.10, OPE-9382) */}
        <div
          role="group"
          aria-label={t("uiSwitch.label", { defaultValue: "Интерфейс" })}
          style={{ display: "flex", flexDirection: "column", gap: 2 }}
          data-testid="ui2-interface-toggle-section"
        >
          <span
            style={{
              fontSize: "var(--myr-text-nano)",
              fontWeight: 600,
              color: "var(--myr-ink-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              padding: "0 var(--myr-space-1)",
            }}
          >
            {t("uiSwitch.label", { defaultValue: "Интерфейс" })}
          </span>

          <button
            type="button"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--myr-space-1)",
              padding: "var(--myr-space-1)",
              borderRadius: "var(--myr-radius-sm)",
              border: "none",
              background: override === "2" ? "var(--myr-surface-sunk)" : "transparent",
              color: override === "2" ? "var(--myr-ink)" : "var(--myr-ink-muted)",
              fontWeight: override === "2" ? 600 : 400,
              fontSize: "var(--myr-text-nano)",
              textAlign: "left",
              cursor: "pointer",
            }}
            onClick={() => selectInterface("2")}
            aria-pressed={override === "2"}
            data-testid="ui2-switch-option-new"
          >
            <span style={{ width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {override === "2" ? (
                <Check style={{ width: 14, height: 14, color: "var(--myr-ink)" }} />
              ) : (
                <Sparkles style={{ width: 14, height: 14, color: "var(--myr-ink-muted)" }} />
              )}
            </span>
            <span style={{ flex: 1 }}>{t("uiSwitch.new", { defaultValue: "Новая" })}</span>
          </button>

          <button
            type="button"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--myr-space-1)",
              padding: "var(--myr-space-1)",
              borderRadius: "var(--myr-radius-sm)",
              border: "none",
              background: override === "1" ? "var(--myr-surface-sunk)" : "transparent",
              color: override === "1" ? "var(--myr-ink)" : "var(--myr-ink-muted)",
              fontWeight: override === "1" ? 600 : 400,
              fontSize: "var(--myr-text-nano)",
              textAlign: "left",
              cursor: "pointer",
            }}
            onClick={() => selectInterface("1")}
            aria-pressed={override === "1"}
            data-testid="ui2-switch-option-legacy"
          >
            <span style={{ width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {override === "1" ? (
                <Check style={{ width: 14, height: 14, color: "var(--myr-ink)" }} />
              ) : (
                <LayoutGrid style={{ width: 14, height: 14, color: "var(--myr-ink-muted)" }} />
              )}
            </span>
            <span style={{ flex: 1 }}>{t("uiSwitch.legacy", { defaultValue: "Прежняя" })}</span>
          </button>

          <button
            type="button"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--myr-space-1)",
              padding: "var(--myr-space-1)",
              borderRadius: "var(--myr-radius-sm)",
              border: "none",
              background: override === null ? "var(--myr-surface-sunk)" : "transparent",
              color: override === null ? "var(--myr-ink)" : "var(--myr-ink-muted)",
              fontWeight: override === null ? 600 : 400,
              fontSize: "var(--myr-text-nano)",
              textAlign: "left",
              cursor: "pointer",
            }}
            onClick={() => selectInterface(null)}
            aria-pressed={override === null}
            data-testid="ui2-switch-option-instance"
          >
            <span style={{ width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {override === null ? (
                <Check style={{ width: 14, height: 14, color: "var(--myr-ink)" }} />
              ) : (
                <SlidersHorizontal style={{ width: 14, height: 14, color: "var(--myr-ink-muted)" }} />
              )}
            </span>
            <span style={{ flex: 1 }}>{t("uiSwitch.instanceDefault", { defaultValue: "По настройке экземпляра" })}</span>
          </button>
        </div>

        {/* Language section (PR 1823 parity) */}
        <div
          role="group"
          aria-label={t("language.label", { defaultValue: "Язык" })}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            borderTop: "1px solid var(--myr-hairline)",
            paddingTop: "var(--myr-space-1)",
          }}
          data-testid="ui2-language-section"
        >
          <span
            style={{
              fontSize: "var(--myr-text-nano)",
              fontWeight: 600,
              color: "var(--myr-ink-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              padding: "0 var(--myr-space-1)",
            }}
          >
            {t("language.label", { defaultValue: "Язык" })}
          </span>
          <div style={{ display: "flex", gap: "var(--myr-space-1)" }}>
            {FORK_LANGUAGES.map((code) => {
              const active = language === code;
              return (
                <button
                  key={code}
                  type="button"
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 4,
                    height: 26,
                    borderRadius: "var(--myr-radius-sm)",
                    border: "1px solid var(--myr-hairline)",
                    background: active ? "var(--myr-surface-sunk)" : "transparent",
                    color: active ? "var(--myr-ink)" : "var(--myr-ink-muted)",
                    fontWeight: active ? 600 : 400,
                    fontSize: "var(--myr-text-nano)",
                    cursor: "pointer",
                  }}
                  onClick={() => selectLanguage(code)}
                  aria-pressed={active}
                  data-testid={`ui2-language-${code}`}
                >
                  <Languages style={{ width: 12, height: 12 }} />
                  <span>{forkLanguageLabel(code)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Sign out (if authenticated) */}
        {health?.deploymentMode === "authenticated" ? (
          <div style={{ borderTop: "1px solid var(--myr-hairline)", paddingTop: "var(--myr-space-1)" }}>
            <button
              type="button"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--myr-space-1)",
                width: "100%",
                padding: "var(--myr-space-1)",
                borderRadius: "var(--myr-radius-sm)",
                border: "none",
                background: "transparent",
                color: "var(--myr-ink-muted)",
                fontSize: "var(--myr-text-nano)",
                textAlign: "left",
                cursor: signOutPending ? "not-allowed" : "pointer",
                opacity: signOutPending ? 0.6 : 1,
              }}
              onClick={handleSignOut}
              disabled={signOutPending}
            >
              <LogOut style={{ width: 14, height: 14 }} />
              <span>
                {signOutPending
                  ? t("area.shell-sidebar-layout-1.sidebar-account-menu.signingOut", { defaultValue: "Выход…" })
                  : t("area.shell-sidebar-layout-1.sidebar-account-menu.signOut", { defaultValue: "Выйти" })}
              </span>
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function Ui2AccountMenuWithQuery(props: Ui2AccountMenuProps) {
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
  });
  const signOutMutation = useSignOut();

  return (
    <Ui2AccountMenuPresentational
      {...props}
      health={health}
      onSignOut={() => signOutMutation.mutate()}
      signOutPending={signOutMutation.isPending}
    />
  );
}

function Ui2AccountMenuStandalone(props: Ui2AccountMenuProps) {
  return <Ui2AccountMenuPresentational {...props} />;
}

export function Ui2AccountMenu(props: Ui2AccountMenuProps) {
  const hasQueryClient = useContext(QueryClientContext) != null;
  if (!hasQueryClient) {
    return <Ui2AccountMenuStandalone {...props} />;
  }
  return <Ui2AccountMenuWithQuery {...props} />;
}
