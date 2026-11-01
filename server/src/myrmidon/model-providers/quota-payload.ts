export function parseResetAfterText(text: unknown, nowMs: number): number | null {
  if (typeof text !== "string") return null;
  const match = text.match(/resets?\s+in\s+(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?)/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith("second")
    ? 1
    : unit.startsWith("minute")
      ? 60
      : unit.startsWith("hour")
        ? 3600
        : 86400;
  return Math.floor(nowMs / 1000 + amount * multiplier);
}

export function latestAccountError(raw: any): string | null {
  const errors = raw?.usage?.recent_errors ?? raw?.usage?.recentErrors ?? raw?.recent_errors ?? raw?.recentErrors;
  if (Array.isArray(errors) && errors.length > 0) {
    const latest = [...errors]
      .filter((entry) => entry && typeof entry.message === "string")
      .sort((a, b) => Number(b.at ?? b.timestamp ?? 0) - Number(a.at ?? a.timestamp ?? 0))[0];
    if (latest?.message) return latest.message.slice(0, 500);
  }
  return typeof raw?.error === "string" ? raw.error.slice(0, 500) : null;
}
