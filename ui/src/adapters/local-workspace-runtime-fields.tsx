import { useTranslation } from "@/i18n";
import type { AdapterConfigFieldsProps } from "./types";
import { configFieldsForSection } from "./config-sections";
import { Field, DraftInput, ToggleField } from "../../components/agent-config-primitives";

const inputClass = "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function LocalWorkspaceRuntimeFields({ section, isCreate, values, set, config, mark, eff, managedSandboxOnly }: AdapterConfigFieldsProps) {
  const { t } = useTranslation();
  const read = (key: string, fallback = "") => isCreate ? values?.adapterSchemaValues?.[key] ?? fallback : eff("adapterConfig", key, (config[key] ?? fallback) as string);
  const write = (key: string, value: unknown) => {
    if (isCreate) set?.({ adapterSchemaValues: { ...values?.adapterSchemaValues, [key]: value } });
    else mark("adapterConfig", key, value || undefined);
  };
  const scope = String(read("filesystemScope"));
  const network = String(read("networkScope"));
  return configFieldsForSection(section, (
    <>
      {!managedSandboxOnly && <Field configSection="configuration" label={t("area.adapters-plugins-1.localSandbox.filesystemScopeLabel")} hint={t("area.adapters-plugins-1.localSandbox.filesystemScopeHint")}>
        <select className={inputClass} value={scope} onChange={(e) => write("filesystemScope", e.target.value || undefined)}>
          <option value="">{t("area.adapters-plugins-1.localSandbox.disabled")}</option>
          <option value="workspace">{t("area.adapters-plugins-1.localSandbox.workspace")}</option>
        </select>
      </Field>}
      {!managedSandboxOnly && <Field configSection="configuration" label={t("area.adapters-plugins-1.localSandbox.extraPathsLabel")} hint={t("area.adapters-plugins-1.localSandbox.extraPathsHint")}>
        <DraftInput className={inputClass} value={String(read("filesystemExtraPaths"))} onCommit={(v) => write("filesystemExtraPaths", v ? v.split(",").map((p) => p.trim()).filter(Boolean) : undefined)} immediate placeholder="/absolute/path" />
      </Field>}
      <Field configSection="configuration" label={t("area.adapters-plugins-1.localSandbox.networkScopeLabel")} hint={t("area.adapters-plugins-1.localSandbox.networkScopeHint")}>
        <select className={inputClass} value={network} onChange={(e) => write("networkScope", e.target.value || undefined)}>
          <option value="">{t("area.adapters-plugins-1.localSandbox.disabled")}</option>
          <option value="deny">{t("area.adapters-plugins-1.localSandbox.deny")}</option>
          <option value="allowlist">{t("area.adapters-plugins-1.localSandbox.allowlist")}</option>
        </select>
      </Field>
      {network === "allowlist" && <Field configSection="configuration" label={t("area.adapters-plugins-1.localSandbox.allowlistLabel")} hint={t("area.adapters-plugins-1.localSandbox.allowlistHint")}>
        <DraftInput className={inputClass} value={String(read("networkAllowlist"))} onCommit={(v) => write("networkAllowlist", v ? v.split(",").map((p) => p.trim()).filter(Boolean) : undefined)} immediate placeholder="api.example.com" />
      </Field>}
      <Field configSection="runPolicy" label={t("area.adapters-plugins-1.localSandbox.probeLabel")} hint={t("area.adapters-plugins-1.localSandbox.probeHint")}>
        <ToggleField checked={read("probe", false) === true || read("probe") === "true"} onChange={(v) => write("probe", v)} />
      </Field>
    </>
  ));
}
