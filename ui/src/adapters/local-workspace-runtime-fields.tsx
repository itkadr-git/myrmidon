import { useTranslation } from "@/i18n";
import type { AdapterConfigFieldsProps } from "./types";
import { Field, DraftInput, DraftNumberInput } from "@/components/agent-config-primitives";

const inputClass = "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

type SandboxPath = string | { path: string; access: "rw" };

const WRITABLE_SUFFIX = /\s*\(rw\)$/;

/** Path list as shown in the form: object entries keep their access mode as a "(rw)" suffix. */
function formatPaths(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string") {
        const { path, access } = entry as { path: string; access?: unknown };
        return access === "rw" ? `${path} (rw)` : path;
      }
      return "";
    })
    .filter(Boolean)
    .join(", ");
}

function parsePaths(text: string): SandboxPath[] | undefined {
  const entries = text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item): SandboxPath =>
      WRITABLE_SUFFIX.test(item) ? { path: item.replace(WRITABLE_SUFFIX, ""), access: "rw" } : item,
    );
  return entries.length > 0 ? entries : undefined;
}

function formatList(value: unknown): string {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string").join(", ");
  return typeof value === "string" ? value : "";
}

function parseList(text: string): string[] | undefined {
  const entries = text.split(",").map((item) => item.trim()).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

/**
 * Sandbox and timeout settings of the local CLI adapters (claude_local, codex_local).
 * Every key here is read by the adapter at run time; the server validates the sandbox
 * keys on save and lets only an instance admin change them.
 */
export function LocalWorkspaceRuntimeFields({
  isCreate,
  values,
  set,
  config,
  mark,
  eff,
  managedSandboxOnly,
  adapterType,
}: AdapterConfigFieldsProps) {
  const { t } = useTranslation();
  if (adapterType !== "claude_local" && adapterType !== "codex_local") return null;

  const read = (key: string): unknown =>
    isCreate ? values?.adapterSchemaValues?.[key] : eff("adapterConfig", key, config[key]);
  const write = (key: string, value: unknown) => {
    if (isCreate) set?.({ adapterSchemaValues: { ...values?.adapterSchemaValues, [key]: value } });
    else mark("adapterConfig", key, value);
  };

  const network = String(read("networkScope") ?? "");
  const numberFields = adapterType === "claude_local"
    ? [
        {
          key: "helloProbeTimeoutSec",
          label: t("area.adapters-plugins-1.localSandbox.helloProbeTimeoutLabel"),
          hint: t("area.adapters-plugins-1.localSandbox.helloProbeTimeoutHint"),
        },
        {
          key: "terminalResultCleanupGraceMs",
          label: t("area.adapters-plugins-1.localSandbox.terminalCleanupGraceLabel"),
          hint: t("area.adapters-plugins-1.localSandbox.terminalCleanupGraceHint"),
        },
      ]
    : [
        {
          key: "outputInactivityTimeoutMs",
          label: t("area.adapters-plugins-1.localSandbox.outputInactivityLabel"),
          hint: t("area.adapters-plugins-1.localSandbox.outputInactivityHint"),
        },
      ];

  return (
    <>
      {!managedSandboxOnly && (
        <Field
          label={t("area.adapters-plugins-1.localSandbox.filesystemScopeLabel")}
          hint={t("area.adapters-plugins-1.localSandbox.filesystemScopeHint")}
        >
          <select
            className={inputClass}
            value={String(read("filesystemScope") ?? "")}
            onChange={(e) => write("filesystemScope", e.target.value || undefined)}
          >
            <option value="">{t("area.adapters-plugins-1.localSandbox.disabled")}</option>
            <option value="workspace">{t("area.adapters-plugins-1.localSandbox.workspace")}</option>
          </select>
        </Field>
      )}
      {!managedSandboxOnly && (
        <Field
          label={t("area.adapters-plugins-1.localSandbox.extraPathsLabel")}
          hint={t("area.adapters-plugins-1.localSandbox.extraPathsHint")}
        >
          <DraftInput
            className={inputClass}
            value={formatPaths(read("filesystemExtraPaths"))}
            onCommit={(v) => write("filesystemExtraPaths", parsePaths(v))}
            immediate
            placeholder="/srv/shared"
          />
        </Field>
      )}
      <Field
        label={t("area.adapters-plugins-1.localSandbox.networkScopeLabel")}
        hint={t("area.adapters-plugins-1.localSandbox.networkScopeHint")}
      >
        <select
          className={inputClass}
          value={network}
          onChange={(e) => write("networkScope", e.target.value || undefined)}
        >
          <option value="">{t("area.adapters-plugins-1.localSandbox.disabled")}</option>
          <option value="deny">{t("area.adapters-plugins-1.localSandbox.deny")}</option>
          <option value="allowlist">{t("area.adapters-plugins-1.localSandbox.allowlist")}</option>
        </select>
      </Field>
      {network === "allowlist" && (
        <Field
          label={t("area.adapters-plugins-1.localSandbox.allowlistLabel")}
          hint={t("area.adapters-plugins-1.localSandbox.allowlistHint")}
        >
          <DraftInput
            className={inputClass}
            value={formatList(read("networkAllowlist"))}
            onCommit={(v) => write("networkAllowlist", parseList(v))}
            immediate
            placeholder="https://api.example.com"
          />
        </Field>
      )}
      {numberFields.map((field) => (
        <Field key={field.key} label={field.label} hint={field.hint}>
          <DraftNumberInput
            className={inputClass}
            value={Number(read(field.key) ?? 0) || 0}
            onCommit={(v) => write(field.key, v > 0 ? v : undefined)}
            immediate
            min={0}
          />
        </Field>
      ))}
    </>
  );
}
