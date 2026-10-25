import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { i18n, useTranslation } from "@/i18n";
import { nextCronFires, parseCronExpression } from "../lib/cron-fires";

export type SchedulePreset = "every_minute" | "every_hour" | "every_day" | "weekdays" | "weekly" | "monthly" | "custom";

const PRESETS = (): { value: SchedulePreset; label: string }[] => [
  { value: "every_minute", label: i18n.t("area.routines-2.schedule-editor.presetEveryMinute") },
  { value: "every_hour", label: i18n.t("area.routines-2.schedule-editor.presetEveryHour") },
  { value: "every_day", label: i18n.t("area.routines-2.schedule-editor.presetEveryDay") },
  { value: "weekdays", label: i18n.t("area.routines-2.schedule-editor.presetWeekdays") },
  { value: "weekly", label: i18n.t("area.routines-2.schedule-editor.presetWeekly") },
  { value: "monthly", label: i18n.t("area.routines-2.schedule-editor.presetMonthly") },
  { value: "custom", label: i18n.t("area.routines-2.schedule-editor.presetCustom") },
];

const HOURS = Array.from({ length: 24 }, (_, i) => ({ value: String(i) }));

function hourParts(hour: number): { hour: string; pm: boolean } {
  // The catalog decides the clock: "12" shows 12 AM / 1 PM, "24" shows 13:00.
  const twelveHour = i18n.t("area.routines-2.schedule-editor.hourCycle") === "12";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return { hour: twelveHour ? String(h12) : String(hour).padStart(2, "0"), pm: hour >= 12 };
}

function hourLabel(value: string): string {
  const { hour, pm } = hourParts(Number(value));
  return i18n.t(
    pm ? "area.routines-2.schedule-editor.hourPm" : "area.routines-2.schedule-editor.hourAm",
    { hour },
  );
}

function timeLabel(value: string, minute: string): string {
  const { hour, pm } = hourParts(Number(value));
  return i18n.t(
    pm ? "area.routines-2.schedule-editor.timePm" : "area.routines-2.schedule-editor.timeAm",
    { hour, minute: minute.padStart(2, "0") },
  );
}

const MINUTES = Array.from({ length: 12 }, (_, i) => ({
  value: String(i * 5),
  label: String(i * 5).padStart(2, "0"),
}));

const DAYS_OF_WEEK = [
  { value: "1", labelKey: "area.routines-2.schedule-editor.dayMon" },
  { value: "2", labelKey: "area.routines-2.schedule-editor.dayTue" },
  { value: "3", labelKey: "area.routines-2.schedule-editor.dayWed" },
  { value: "4", labelKey: "area.routines-2.schedule-editor.dayThu" },
  { value: "5", labelKey: "area.routines-2.schedule-editor.dayFri" },
  { value: "6", labelKey: "area.routines-2.schedule-editor.daySat" },
  { value: "0", labelKey: "area.routines-2.schedule-editor.daySun" },
];

function dayLabel(value: string): string {
  const day = DAYS_OF_WEEK.find((d) => d.value === value);
  return day ? i18n.t(day.labelKey) : value;
}

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1),
}));

function hasOption(options: Array<{ value: string }>, value: string): boolean {
  return options.some((option) => option.value === value);
}

export function parseCronToPreset(cron: string): {
  preset: SchedulePreset;
  hour: string;
  minute: string;
  dayOfWeek: string;
  dayOfMonth: string;
} {
  const defaults = { hour: "10", minute: "0", dayOfWeek: "1", dayOfMonth: "1" };

  if (!cron || !cron.trim()) {
    return { preset: "every_day", ...defaults };
  }

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { preset: "custom", ...defaults };
  }

  const [min, hr, dom, month, dow] = parts;
  const selectableMinute = hasOption(MINUTES, min);
  const selectableHour = hasOption(HOURS, hr);

  // Every minute: "* * * * *"
  if (min === "*" && hr === "*" && dom === "*" && month === "*" && dow === "*") {
    return { preset: "every_minute", ...defaults };
  }

  // Every hour: "0 * * * *"
  if (hr === "*" && dom === "*" && month === "*" && dow === "*" && selectableMinute) {
    return { preset: "every_hour", ...defaults, minute: min };
  }

  // Every day: "M H * * *"
  if (dom === "*" && month === "*" && dow === "*" && selectableHour && selectableMinute) {
    return { preset: "every_day", ...defaults, hour: hr, minute: min };
  }

  // Weekdays: "M H * * 1-5"
  if (dom === "*" && month === "*" && dow === "1-5" && selectableHour && selectableMinute) {
    return { preset: "weekdays", ...defaults, hour: hr, minute: min };
  }

  // Weekly: "M H * * D" (single day)
  if (dom === "*" && month === "*" && hasOption(DAYS_OF_WEEK, dow) && selectableHour && selectableMinute) {
    return { preset: "weekly", ...defaults, hour: hr, minute: min, dayOfWeek: dow };
  }

  // Monthly: "M H D * *"
  if (month === "*" && hasOption(DAYS_OF_MONTH, dom) && dow === "*" && selectableHour && selectableMinute) {
    return { preset: "monthly", ...defaults, hour: hr, minute: min, dayOfMonth: dom };
  }

  return { preset: "custom", ...defaults };
}

export function buildCron(preset: SchedulePreset, hour: string, minute: string, dayOfWeek: string, dayOfMonth: string): string {
  switch (preset) {
    case "every_minute":
      return "* * * * *";
    case "every_hour":
      return `${minute} * * * *`;
    case "every_day":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${dayOfWeek}`;
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    case "custom":
      return "";
  }
}

function describeSchedule(cron: string): string {
  const { preset, hour, minute, dayOfWeek, dayOfMonth } = parseCronToPreset(cron);
  const timeStr = timeLabel(hour, minute);

  switch (preset) {
    case "every_minute":
      return i18n.t("area.routines-2.schedule-editor.describeEveryMinute");
    case "every_hour":
      return i18n.t("area.routines-2.schedule-editor.describeEveryHour", { minute: minute.padStart(2, "0") });
    case "every_day":
      return i18n.t("area.routines-2.schedule-editor.describeEveryDay", { time: timeStr });
    case "weekdays":
      return i18n.t("area.routines-2.schedule-editor.describeWeekdays", { time: timeStr });
    case "weekly":
      return i18n.t("area.routines-2.schedule-editor.describeWeekly", { day: dayLabel(dayOfWeek), time: timeStr });
    case "monthly":
      return i18n.t("area.routines-2.schedule-editor.describeMonthly", {
        day: `${dayOfMonth}${i18n.t(ordinalSuffixKey(Number(dayOfMonth)))}`,
        time: timeStr,
      });
    case "custom":
      return cron || i18n.t("area.routines-2.schedule-editor.describeNone");
  }
}

function ordinalSuffixKey(n: number): string {
  const s = ["Th", "St", "Nd", "Rd"];
  const v = n % 100;
  return "area.routines-2.schedule-editor.ordinal" + (s[(v - 20) % 10] || s[v] || s[0]);
}

export { describeSchedule };

export function getScheduleCronValidation(cron: string): {
  valid: boolean;
  message: string;
  nextFires: Date[];
} {
  const trimmed = cron.trim();
  if (!trimmed) {
    return {
      valid: false,
      message: i18n.t("area.routines-2.schedule-editor.cronEmpty"),
      nextFires: [],
    };
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return {
      valid: false,
      message: i18n.t("area.routines-2.schedule-editor.cronFieldCount", { found: fields.length }),
      nextFires: [],
    };
  }

  if (!parseCronExpression(trimmed)) {
    return {
      valid: false,
      message: i18n.t("area.routines-2.schedule-editor.cronInvalid"),
      nextFires: [],
    };
  }

  const nextFires = nextCronFires(trimmed, 3, { timeZone: "UTC" });
  return {
    valid: true,
    message:
      nextFires.length > 0
        ? i18n.t("area.routines-2.schedule-editor.cronValid")
        : i18n.t("area.routines-2.schedule-editor.cronValidNoFires"),
    nextFires,
  };
}

export function ScheduleEditor({
  value,
  onChange,
  onValidityChange,
}: {
  value: string;
  onChange: (cron: string) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const { t, i18n: i18nInstance } = useTranslation();
  const presets = PRESETS();
  const parsed = useMemo(() => parseCronToPreset(value), [value]);
  const [preset, setPreset] = useState<SchedulePreset>(parsed.preset);
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [dayOfWeek, setDayOfWeek] = useState(parsed.dayOfWeek);
  const [dayOfMonth, setDayOfMonth] = useState(parsed.dayOfMonth);
  const [customCron, setCustomCron] = useState(preset === "custom" ? value : "");
  const customValidation = useMemo(() => getScheduleCronValidation(customCron), [customCron]);

  useEffect(() => {
    onValidityChange?.(preset !== "custom" || customValidation.valid);
  }, [customValidation.valid, onValidityChange, preset]);

  // Sync from external value changes
  useEffect(() => {
    const p = parseCronToPreset(value);
    setPreset(p.preset);
    setHour(p.hour);
    setMinute(p.minute);
    setDayOfWeek(p.dayOfWeek);
    setDayOfMonth(p.dayOfMonth);
    if (p.preset === "custom") setCustomCron(value);
  }, [value]);

  const emitChange = useCallback(
    (p: SchedulePreset, h: string, m: string, dow: string, dom: string, custom: string) => {
      if (p === "custom") {
        onChange(custom);
      } else {
        onChange(buildCron(p, h, m, dow, dom));
      }
    },
    [onChange],
  );

  const handlePresetChange = (newPreset: SchedulePreset) => {
    setPreset(newPreset);
    if (newPreset === "custom") {
      setCustomCron(value);
    } else {
      emitChange(newPreset, hour, minute, dayOfWeek, dayOfMonth, customCron);
    }
  };

  return (
    <div className="space-y-3">
      <Select value={preset} onValueChange={(v) => handlePresetChange(v as SchedulePreset)}>
        <SelectTrigger className="w-full" aria-label={t("area.routines-2.schedule-editor.frequencyAria")}>
          <SelectValue placeholder={t("area.routines-2.schedule-editor.frequencyPlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          {presets.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {preset === "custom" ? (
        <div className="space-y-1.5">
          <Input
            value={customCron}
            onChange={(e) => {
              const nextCron = e.target.value;
              setCustomCron(nextCron);
              // Report validity synchronously with the keystroke so consumers can gate
              // their submit affordance in the same render. Relying solely on the
              // effect below leaves a one-tick window where an invalid draft still
              // reads as valid to the parent.
              const nextValidation = getScheduleCronValidation(nextCron);
              onValidityChange?.(nextValidation.valid);
              if (nextValidation.valid) {
                emitChange("custom", hour, minute, dayOfWeek, dayOfMonth, nextCron);
              }
            }}
            placeholder="0 10 * * *"
            aria-label={t("area.routines-2.schedule-editor.cronAria")}
            aria-invalid={!customValidation.valid}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t("area.routines-2.schedule-editor.cronHint")}
          </p>
          <p
            className={customValidation.valid ? "text-xs text-muted-foreground" : "text-xs text-destructive"}
            aria-live="polite"
          >
            {customValidation.message}
            {customValidation.valid && customValidation.nextFires.length > 0
              ? ` ${t("area.routines-2.schedule-editor.cronNext", {
                  fires: customValidation.nextFires.map((fire) => fire.toLocaleString(i18nInstance.language)).join(", "),
                })}`
              : null}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {preset !== "every_minute" && preset !== "every_hour" && (
            <>
              <span className="text-sm text-muted-foreground">{t("area.routines-2.schedule-editor.at")}</span>
              <Select
                value={hour}
                onValueChange={(h) => {
                  setHour(h);
                  emitChange(preset, h, minute, dayOfWeek, dayOfMonth, customCron);
                }}
              >
                <SelectTrigger className="w-(--sz-120px)">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h.value} value={h.value}>
                      {hourLabel(h.value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-sm text-muted-foreground">:</span>
              <Select
                value={minute}
                onValueChange={(m) => {
                  setMinute(m);
                  emitChange(preset, hour, m, dayOfWeek, dayOfMonth, customCron);
                }}
              >
                <SelectTrigger className="w-(--sz-80px)">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MINUTES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}

          {preset === "every_hour" && (
            <>
              <span className="text-sm text-muted-foreground">{t("area.routines-2.schedule-editor.atMinute")}</span>
              <Select
                value={minute}
                onValueChange={(m) => {
                  setMinute(m);
                  emitChange(preset, hour, m, dayOfWeek, dayOfMonth, customCron);
                }}
              >
                <SelectTrigger className="w-(--sz-80px)">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MINUTES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      :{m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}

          {preset === "weekly" && (
            <>
              <span className="text-sm text-muted-foreground">{t("area.routines-2.schedule-editor.on")}</span>
              <div className="flex gap-1">
                {DAYS_OF_WEEK.map((d) => (
                  <Button
                    key={d.value}
                    type="button"
                    variant={dayOfWeek === d.value ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    aria-pressed={dayOfWeek === d.value}
                    onClick={() => {
                      setDayOfWeek(d.value);
                      emitChange(preset, hour, minute, d.value, dayOfMonth, customCron);
                    }}
                  >
                    {t(d.labelKey)}
                  </Button>
                ))}
              </div>
            </>
          )}

          {preset === "monthly" && (
            <>
              <span className="text-sm text-muted-foreground">{t("area.routines-2.schedule-editor.onDay")}</span>
              <Select
                value={dayOfMonth}
                onValueChange={(dom) => {
                  setDayOfMonth(dom);
                  emitChange(preset, hour, minute, dayOfWeek, dom, customCron);
                }}
              >
                <SelectTrigger className="w-(--sz-80px)">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAYS_OF_MONTH.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
        </div>
      )}
    </div>
  );
}
