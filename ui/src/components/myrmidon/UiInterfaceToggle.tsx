// myrmidon(OPE-9382): interface version toggle for account menus.
// Allows switching between UI2, legacy shell, and following instance settings.
import { Check, Sparkles, LayoutGrid, SlidersHorizontal } from "lucide-react";

import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  useMyrmidonUi2PersonalOverride,
  type Ui2PersonalOverride,
} from "@/lib/myrmidonUi2PersonalOverride";

interface UiInterfaceToggleProps {
  className?: string;
  /** Dismiss the surrounding menu once the user has acted. */
  onAfterChange?: () => void;
}

interface UiChoice {
  value: Ui2PersonalOverride;
  labelKey: string;
  defaultLabel: string;
  icon: typeof Sparkles;
}

const UI_CHOICES: readonly UiChoice[] = [
  {
    value: "2",
    labelKey: "uiSwitch.new",
    defaultLabel: "Новая",
    icon: Sparkles,
  },
  {
    value: "1",
    labelKey: "uiSwitch.legacy",
    defaultLabel: "Прежняя",
    icon: LayoutGrid,
  },
  {
    value: null,
    labelKey: "uiSwitch.instanceDefault",
    defaultLabel: "По настройке экземпляра",
    icon: SlidersHorizontal,
  },
] as const;

export function UiInterfaceToggle({ className, onAfterChange }: UiInterfaceToggleProps) {
  const { t } = useTranslation();
  const { override, setOverride } = useMyrmidonUi2PersonalOverride();

  function select(choice: Ui2PersonalOverride) {
    setOverride(choice);
    onAfterChange?.();
  }

  return (
    <div
      className={cn("flex flex-col gap-0.5 px-2.5 py-1", className)}
      role="group"
      aria-label={t("uiSwitch.label", { defaultValue: "Интерфейс" })}
      data-testid="ui-interface-toggle"
    >
      <div className="px-2.5 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {t("uiSwitch.label", { defaultValue: "Интерфейс" })}
      </div>
      {UI_CHOICES.map(({ value, labelKey, defaultLabel, icon: Icon }) => {
        const isSelected = override === value;
        return (
          <button
            key={value ?? "instance-default"}
            type="button"
            className={cn(
              "flex h-(--profile-popover-row-height) w-full items-center gap-(--profile-popover-row-gap) rounded-lg px-2.5 text-left text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height) transition-colors hover:bg-accent",
              isSelected ? "text-foreground font-semibold" : "text-muted-foreground",
            )}
            onClick={() => select(value)}
            aria-pressed={isSelected}
            data-testid={`ui-switch-option-${value ?? "instance"}`}
          >
            <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
              {isSelected ? <Check className="size-4 text-foreground" /> : <Icon className="size-4" />}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {t(labelKey, { defaultValue: defaultLabel })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
