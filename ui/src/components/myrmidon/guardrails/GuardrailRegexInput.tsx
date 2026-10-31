// myrmidon(1.7 GUARDRAILS, OPE-10181): regex rule validator input.
// Lets an operator type a guardrail regex pattern, validates it client-side
// through the shared engine, flags ReDoS risk, and shows sample match results.

import { useId, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  validateGuardrailRegex,
  type GuardrailRegexValidationResult,
} from "@myrmidon/shared";
import { guardrailRegexApi } from "./guardrailRegexApi";

export interface GuardrailRegexInputProps {
  companyId?: string;
  value?: string;
  onChange?: (pattern: string, result: GuardrailRegexValidationResult) => void;
  disabled?: boolean;
}

export function GuardrailRegexInput({
  companyId,
  value = "",
  onChange,
  disabled = false,
}: GuardrailRegexInputProps) {
  const patternInputId = useId();
  const samplesInputId = useId();

  const [pattern, setPattern] = useState(value);
  const [flags, setFlags] = useState("");
  const [sampleText, setSampleText] = useState("");
  const [serverResult, setServerResult] = useState<GuardrailRegexValidationResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const localResult = useMemo(() => {
    if (!pattern.trim()) return null;
    return validateGuardrailRegex({ pattern, flags });
  }, [pattern, flags]);

  async function checkOnServer() {
    setChecking(true);
    setServerError(null);
    setServerResult(null);
    try {
      const testInputs = sampleText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 50);
      const result = await guardrailRegexApi.validate(companyId, {
        pattern,
        flags,
        ...(testInputs.length > 0 ? { testInputs } : {}),
      });
      setServerResult(result);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  function emitChange(nextPattern: string, nextFlags: string) {
    if (!onChange) return;
    if (!nextPattern.trim()) return;
    onChange(nextPattern, validateGuardrailRegex({ pattern: nextPattern, flags: nextFlags }));
  }

  const status = localResult
    ? localResult.valid
      ? localResult.redosRisk
        ? "risk"
        : "ok"
      : "invalid"
    : "empty";

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={patternInputId}>Regex pattern</Label>
        <Input
          id={patternInputId}
          value={pattern}
          onChange={(e) => {
            setPattern(e.target.value);
            emitChange(e.target.value, flags);
          }}
          placeholder="e.g. sk-ant-[A-Za-z0-9_-]{20,}"
          disabled={disabled}
          className="font-mono"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${patternInputId}-flags`}>Flags</Label>
        <Input
          id={`${patternInputId}-flags`}
          value={flags}
          onChange={(e) => {
            setFlags(e.target.value);
            emitChange(pattern, e.target.value);
          }}
          placeholder="e.g. i"
          disabled={disabled}
          className="font-mono"
        />
      </div>

      {status === "ok" && localResult && (
        <p className="flex items-center gap-2 text-sm text-status-success">
          <CheckCircle2 className="size-4 text-green-500" aria-hidden />
          Valid pattern — complexity {localResult.complexity}
        </p>
      )}

      {status === "risk" && localResult && (
        <p className="flex items-start gap-2 text-sm text-amber-400">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            ReDoS risk detected — {localResult.riskReason ?? "pattern is potentially catastrophic"}.
            Consider rewriting nested or overlapping quantifiers before saving.
          </span>
        </p>
      )}

      {status === "invalid" && localResult && (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Invalid regex: {localResult.error}</span>
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor={samplesInputId}>Sample inputs (one per line)</Label>
        <textarea
          id={samplesInputId}
          value={sampleText}
          onChange={(e) => setSampleText(e.target.value)}
          placeholder={"line with a token\nline without a token"}
          disabled={disabled}
          rows={3}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={checkOnServer}
          disabled={disabled || checking || !pattern.trim()}
        >
          {checking ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Validate on server
        </Button>
      </div>

      {serverError && (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="size-4" aria-hidden />
          {serverError}
        </p>
      )}

      {serverResult && (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
          <p className="font-medium">
            {serverResult.valid
              ? serverResult.redosRisk
                ? "Server check: ReDoS risk"
                : `Server check: valid (complexity ${serverResult.complexity})`
              : "Server check: invalid regex"}
          </p>
          {serverResult.riskReason && (
            <p className="mt-1 text-amber-400">{serverResult.riskReason}</p>
          )}
          {serverResult.error && <p className="mt-1 text-destructive">{serverResult.error}</p>}
          {serverResult.sampleMatches && serverResult.sampleMatches.length > 0 && (
            <ul className="mt-2 space-y-1">
              {serverResult.sampleMatches.map((match) => (
                <li key={match.input} className="flex items-center gap-2">
                  <span className="font-mono text-xs">{match.input.slice(0, 80)}</span>
                  <span className={match.matched ? "text-green-500" : "text-muted-foreground"}>
                    {match.matched ? "match" : "no match"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
