export type EntityType =
  | "person_name" | "phone" | "email" | "passport" | "snils"
  | "bank_account" | "correspondent_account" | "bic" | "payment_card"
  | "inn" | "kpp" | "ogrn" | "ogrnip" | "dictionary";

export interface EntityMatch {
  entity: EntityType;
  value: string;
  score: number;
  start: number;
  end: number;
}

export interface DictionaryMatcher {
  find(text: string): Array<{ value: string; start: number; end: number; score?: number }>;
}

const patterns: Array<{ entity: EntityType; re: RegExp; score: number; valid?: (v: string) => boolean }> = [
  { entity: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, score: 0.88 },
  { entity: "phone", re: /(?<![\w/])\+?\d[\d ()-]{5,18}\d(?![\w])/g, score: 0.55, valid: (v) => { const n = v.replace(/\D/g, "").length; return n >= 10 && n <= 15; } },
  { entity: "payment_card", re: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, score: 0.9, valid: luhn },
  { entity: "inn", re: /(?<!\d)\d{10}(?!\d)|(?<!\d)\d{12}(?!\d)/g, score: 0.92, valid: inn },
  { entity: "snils", re: /(?<!\d)\d{3}-?\d{3}-?\d{3} ?\d{2}(?!\d)/g, score: 0.85, valid: snils },
  { entity: "passport", re: /(?<!\d)\d{4}\s?\d{6}(?!\d)/g, score: 0.62 },
  { entity: "bic", re: /(?<!\d)\d{9}(?!\d)/g, score: 0.5 },
  { entity: "bank_account", re: /(?<!\d)4\d{19}(?!\d)/g, score: 0.62 },
  { entity: "correspondent_account", re: /(?<!\d)3\d{19}(?!\d)/g, score: 0.62 },
  // Numeric KPP values are indistinguishable from BICs without a label.
  { entity: "kpp", re: /(?:(?:КПП|KPP)\s*[:№-]?\s*)(?<!\d)\d{9}(?!\d)|(?:(?:КПП|KPP)\s*[:№-]?\s*)(?<![\dA-ZА-ЯЁ])[0-9]{4}[A-ZА-ЯЁ]{2}[0-9]{3}(?![\dA-ZА-ЯЁ])/giu, score: 0.75 },
  { entity: "ogrn", re: /(?<!\d)\d{13}(?!\d)/g, score: 0.92, valid: ogrn },
  { entity: "ogrnip", re: /(?<!\d)\d{15}(?!\d)/g, score: 0.92, valid: ogrnip },
  { entity: "person_name", re: /\b[А-ЯЁ][а-яё]{1,30}\s+[А-ЯЁ][а-яё]{1,30}(?:\s+[А-ЯЁ][а-яё]{1,30})?\b/g, score: 0.45 },
];

function digits(v: string): string { return v.replace(/\D/g, ""); }
function luhn(v: string): boolean {
  const d = digits(v); if (d.length < 13 || d.length > 19) return false;
  let sum = 0, double = false;
  for (let i = d.length - 1; i >= 0; i--, double = !double) { let n = Number(d[i]); if (double) { n *= 2; if (n > 9) n -= 9; } sum += n; }
  return sum % 10 === 0;
}
function mod11(d: string, weights: number[]): number { return weights.reduce((s, w, i) => s + Number(d[i]) * w, 0) % 11 % 10; }
function inn(v: string): boolean {
  const d = digits(v);
  if (d.length === 10) return mod11(d, [2,4,10,3,5,9,4,6,8]) === Number(d[9]);
  if (d.length === 12) return mod11(d, [7,2,4,10,3,5,9,4,6,8]) === Number(d[10]) && mod11(d, [3,7,2,4,10,3,5,9,4,6,8]) === Number(d[11]);
  return false;
}
function snils(v: string): boolean { const d = digits(v); if (d.length !== 11) return false; const sum = [...d.slice(0,9)].reduce((s,n,i) => s + Number(n)*(9-i),0); const check = sum < 100 ? sum : sum === 100 || sum === 101 ? 0 : sum % 101; return Number(d.slice(9)) === (check < 100 ? check : check % 10); }
function ogrn(v: string): boolean { const d = digits(v); return d.length === 13 && Number(d.slice(0,12)) % 11 % 10 === Number(d[12]); }
function ogrnip(v: string): boolean { const d = digits(v); return d.length === 15 && Number(d.slice(0,14)) % 13 % 10 === Number(d[14]); }

/** Rule-only PII entity recognizer; every emitted match carries an explicit 0..1 score. */
export function detectEntities(text: string, dictionary?: DictionaryMatcher): EntityMatch[] {
  if (!text) return [];
  const result: EntityMatch[] = [];
  for (const rule of patterns) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const value = m[0];
      if (rule.valid && !rule.valid(value)) continue;
      const start = m.index!;
      result.push({ entity: rule.entity, value, score: rule.score, start, end: start + value.length });
    }
  }
  if (dictionary) for (const hit of dictionary.find(text)) {
    if (hit.start >= 0 && hit.end > hit.start && hit.end <= text.length) result.push({ entity: "dictionary", value: text.slice(hit.start, hit.end), score: hit.score ?? 0.5, start: hit.start, end: hit.end });
  }
  return result.sort((a,b) => a.start - b.start || b.score - a.score || b.end - a.end);
}

/** Validate a settlement/correspondent account against a nine-digit BIC. */
export function bankAccountMatchesBic(account: string, bic: string): boolean {
  const a = digits(account), b = digits(bic);
  if (a.length !== 20 || b.length !== 9) return false;
  // Settlement accounts use the BIC's last three digits; correspondent
  // accounts use 0 plus BIC digits 5-6 (1-based), with the same keying rule.
  const prefix = a.startsWith("3") ? `0${b.slice(4, 6)}` : b.slice(-3);
  const check = prefix + a;
  const weights = [7, 1, 3];
  return [...check].reduce((sum, digit, i) => sum + Number(digit) * weights[i % 3], 0) % 10 === 0;
}
