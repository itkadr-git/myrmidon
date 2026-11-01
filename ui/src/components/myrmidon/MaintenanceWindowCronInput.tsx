// Maintenance window cron schedule validator input (1.7 AUTO-UPDATE-SETTINGS, OPE-10185).
// Allows entering or picking a cron schedule for product auto-updates and maintenance windows,
// validates the expression in real time, and previews the next scheduled window dates.

import { useState, useId, useEffect } from "react";
import { AlertCircle, Calendar, CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  validateMaintenanceWindowCronSchedule,
  type MaintenanceWindowCronValidationResult,
} from "@myrmidon/shared";

export interface MaintenanceWindowCronInputProps {
  value: string;
  durationMinutes?: number;
  timezone?: string;
  onChange?: (value: string, durationMinutes: number, valid: boolean) => void;
  disabled?: boolean;
}

export const CRON_PRESETS = [
  { label: "Sundays at 03:00 UTC (Recommended)", cron: "0 3 * * 0", duration: 120 },
  { label: "Daily at 04:00 UTC", cron: "0 4 * * *", duration: 60 },
  { label: "Monday–Friday at 02:00 UTC", cron: "0 2 * * 1-5", duration: 120 },
  { label: "Saturday & Sunday at 05:00 UTC", cron: "0 5 * * 0,6", duration: 180 },
];

export function MaintenanceWindowCronInput({
  value,
  durationMinutes = 120,
  timezone = "UTC",
  onChange,
  disabled = false,
}: MaintenanceWindowCronInputProps) {
  const cronInputId = useId();
  const durationInputId = useId();

  const [cron, setCron] = useState(value);
  const [duration, setDuration] = useState(String(durationMinutes));

  const validationResult: MaintenanceWindowCronValidationResult =
    validateMaintenanceWindowCronSchedule({
      cron,
      durationMinutes: Number(duration),
      timezone,
    });

  useEffect(() => {
    setCron(value);
  }, [value]);

  useEffect(() => {
    setDuration(String(durationMinutes));
  }, [durationMinutes]);

  const handleCronChange = (newCron: string) => {
    setCron(newCron);
    const result = validateMaintenanceWindowCronSchedule({
      cron: newCron,
      durationMinutes: Number(duration),
      timezone,
    });
    onChange?.(newCron, Number(duration) || 120, result.valid);
  };

  const handleDurationChange = (newDuration: string) => {
    setDuration(newDuration);
    const durationNum = Number(newDuration);
    const result = validateMaintenanceWindowCronSchedule({
      cron,
      durationMinutes: durationNum,
      timezone,
    });
    onChange?.(cron, durationNum || 120, result.valid);
  };

  const applyPreset = (preset: (typeof CRON_PRESETS)[number]) => {
    setCron(preset.cron);
    setDuration(String(preset.duration));
    const result = validateMaintenanceWindowCronSchedule({
      cron: preset.cron,
      durationMinutes: preset.duration,
      timezone,
    });
    onChange?.(preset.cron, preset.duration, result.valid);
  };

  return (
    <div className="space-y-4" data-testid="maintenance-window-cron-input">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <Label htmlFor={cronInputId} className="text-sm font-medium">
            Maintenance Window Cron Schedule
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          5-field cron expression (minute hour day-of-month month day-of-week) in {timezone}.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2 space-y-1">
          <Input
            id={cronInputId}
            value={cron}
            disabled={disabled}
            placeholder="0 3 * * 0"
            className="font-mono text-sm"
            onChange={(e) => handleCronChange(e.target.value)}
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Input
              id={durationInputId}
              type="number"
              min={5}
              max={1440}
              value={duration}
              disabled={disabled}
              className="text-sm"
              onChange={(e) => handleDurationChange(e.target.value)}
            />
            <span className="text-xs text-muted-foreground whitespace-nowrap">min</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 items-center">
        <span className="text-xs text-muted-foreground mr-1">Presets:</span>
        {CRON_PRESETS.map((p) => (
          <Button
            key={p.cron}
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="h-7 text-xs px-2"
            onClick={() => applyPreset(p)}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {validationResult.valid ? (
        <div
          data-testid="cron-validation-success"
          className="rounded-md border border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-950/20 p-3 space-y-2 text-xs"
        >
          <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-medium">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{validationResult.description}</span>
          </div>

          {validationResult.nextRuns.length > 0 && (
            <div className="pt-1 border-t border-emerald-500/20 space-y-1 text-muted-foreground">
              <div className="flex items-center gap-1 text-xs font-medium text-foreground">
                <Calendar className="h-3.5 w-3.5" />
                <span>Upcoming maintenance windows:</span>
              </div>
              <ul className="space-y-0.5 font-mono text-xs">
                {validationResult.nextRuns.map((r, i) => (
                  <li key={i} className="flex justify-between items-center">
                    <span>{new Date(r.startsAt).toUTCString()}</span>
                    <span className="text-xs font-sans text-muted-foreground">
                      ({r.durationMinutes} min)
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div
          data-testid="cron-validation-error"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 flex items-start gap-2 text-xs text-destructive"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">Invalid cron schedule: </span>
            <span>{validationResult.error}</span>
          </div>
        </div>
      )}
    </div>
  );
}
