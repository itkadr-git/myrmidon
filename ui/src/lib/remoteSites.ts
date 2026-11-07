// myrmidon(1.6.6 REMOTE-SITES-T8): the rules the two fleet screens (current UI and UI2) share:
// how long the board's client key for a site still lives, and the enroll form's body.

export const CERT_WARN_DAYS = 14;
const DAY_MS = 86_400_000;

export type SiteCertState = "unknown" | "ok" | "soon" | "expired";

/** The key TTL: expired, expiring within CERT_WARN_DAYS, fine, or not known (enrolled without a readable certificate). */
export function siteCertState(notAfter: string | null | undefined, nowMs: number): { state: SiteCertState; days: number | null } {
  if (!notAfter) return { state: "unknown", days: null };
  const end = Date.parse(notAfter);
  if (!Number.isFinite(end)) return { state: "unknown", days: null };
  if (end <= nowMs) return { state: "expired", days: 0 };
  const days = Math.ceil((end - nowMs) / DAY_MS);
  return { state: days <= CERT_WARN_DAYS ? "soon" : "ok", days };
}

export interface EnrollFormValues {
  name: string;
  url: string;
  tokenSecret: string;
  maxCpus: string;
  maxMemoryMb: string;
  maxBots: string;
  gatewayPortStart: string;
  gatewayPortEnd: string;
}

export const EMPTY_ENROLL_FORM: EnrollFormValues = {
  name: "",
  url: "",
  tokenSecret: "",
  maxCpus: "",
  maxMemoryMb: "",
  maxBots: "",
  gatewayPortStart: "18700",
  gatewayPortEnd: "18759",
};

export type EnrollProblem = "required" | "number" | "ports" | "url" | "name";

export interface EnrollBody {
  name: string;
  url: string;
  tokenSecret: string;
  capacity: { maxCpus: number; maxMemoryMb: number; maxBots?: number };
  gatewayPortStart: number;
  gatewayPortEnd: number;
}

function positiveNumber(raw: string): number | null {
  if (!raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function positiveInt(raw: string): number | null {
  const value = positiveNumber(raw);
  return value !== null && Number.isInteger(value) ? value : null;
}

/** Checks the form the way the server does, so a typo is told in the form and not after a round trip. */
export function buildEnrollBody(
  form: EnrollFormValues,
): { ok: true; body: EnrollBody } | { ok: false; field: keyof EnrollFormValues; problem: EnrollProblem } {
  const name = form.name.trim();
  if (!name) return { ok: false, field: "name", problem: "required" };
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) return { ok: false, field: "name", problem: "name" };
  const url = form.url.trim();
  if (!url) return { ok: false, field: "url", problem: "required" };
  if (!/^https:\/\/[^/\s]+\/?$/i.test(url)) return { ok: false, field: "url", problem: "url" };
  if (!form.tokenSecret.trim()) return { ok: false, field: "tokenSecret", problem: "required" };

  const maxCpus = positiveNumber(form.maxCpus);
  if (maxCpus === null) return { ok: false, field: "maxCpus", problem: form.maxCpus.trim() ? "number" : "required" };
  const maxMemoryMb = positiveInt(form.maxMemoryMb);
  if (maxMemoryMb === null) return { ok: false, field: "maxMemoryMb", problem: form.maxMemoryMb.trim() ? "number" : "required" };
  let maxBots: number | undefined;
  if (form.maxBots.trim()) {
    const parsed = positiveInt(form.maxBots);
    if (parsed === null) return { ok: false, field: "maxBots", problem: "number" };
    maxBots = parsed;
  }
  const start = positiveInt(form.gatewayPortStart);
  if (start === null || start < 1024 || start > 65535) return { ok: false, field: "gatewayPortStart", problem: "number" };
  const end = positiveInt(form.gatewayPortEnd);
  if (end === null || end < 1024 || end > 65535) return { ok: false, field: "gatewayPortEnd", problem: "number" };
  if (end < start || (maxBots !== undefined && maxBots > end - start + 1)) return { ok: false, field: "gatewayPortEnd", problem: "ports" };
  return {
    ok: true,
    body: {
      name,
      url: url.replace(/\/+$/, ""),
      tokenSecret: form.tokenSecret.trim(),
      capacity: { maxCpus, maxMemoryMb, ...(maxBots !== undefined ? { maxBots } : {}) },
      gatewayPortStart: start,
      gatewayPortEnd: end,
    },
  };
}
