import { configFieldsForSection } from "../config-sections";
import { useTranslation } from "@/i18n";
import type { AdapterConfigFieldsProps } from "../types";
import {
  DraftNumberInput,
  DraftInput,
  Field,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function GeminiLocalConfigFields({
  section,
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
  managedSandboxOnly,
}: AdapterConfigFieldsProps) {
  const { t } = useTranslation();
  const rawEngine = isCreate
    ? values!.geminiEngine ?? "auto"
    : eff("adapterConfig", "engine", String(config.engine ?? "auto"));
  const engine = rawEngine === "acp" || rawEngine === "cli" ? rawEngine : "auto";
  const acpSelected = engine === "acp";

  return configFieldsForSection(section, (
    <>
      {/*
        The execution engine picks which binary runs on the execution host, and
        the ACP sub-fields below name host paths. The platform-managed
        environment owns both, so the managed-sandbox-only policy hides them.
      */}
      {!managedSandboxOnly && <Field label={t("area.adapters-plugins-1.gemini-local.engineLabel")} hint={t("area.adapters-plugins-1.gemini-local.engineHint")}>
        <select
          className={inputClass}
          value={engine}
          onChange={(e) => {
            const value = e.target.value === "acp" ? "acp" : e.target.value === "cli" ? "cli" : "auto";
            isCreate
              ? set!({ geminiEngine: value })
              : mark("adapterConfig", "engine", value === "auto" ? undefined : value);
          }}
        >
          <option value="auto">{t("area.adapters-plugins-1.gemini-local.engineOptionDefault")}</option>
          <option value="cli">{t("area.adapters-plugins-1.gemini-local.engineOptionCli")}</option>
          <option value="acp">{t("area.adapters-plugins-1.gemini-local.engineOptionAcp")}</option>
        </select>
      </Field>}
      {acpSelected && (
        <>
          {!managedSandboxOnly && (
            <Field configSection="advanced"
              label={t("area.adapters-plugins-1.gemini-local.acpCommandLabel")}
              hint={t("area.adapters-plugins-1.gemini-local.acpCommandHint")}
            >
              <DraftInput
                value={
                  isCreate
                    ? values!.geminiAcpAgentCommand ?? ""
                    : eff("adapterConfig", "agentCommand", String(config.agentCommand ?? ""))
                }
                onCommit={(v) =>
                  isCreate
                    ? set!({ geminiAcpAgentCommand: v })
                    : mark("adapterConfig", "agentCommand", v || undefined)
                }
                immediate
                className={inputClass}
                placeholder={t("area.adapters-plugins-1.gemini-local.acpCommandPlaceholder")}
              />
            </Field>
          )}
          <Field configSection="runPolicy" label={t("area.adapters-plugins-1.gemini-local.acpModeLabel")} hint={t("area.adapters-plugins-1.gemini-local.acpModeHint")}>
            <select
              className={inputClass}
              value={
                isCreate
                  ? values!.geminiAcpMode ?? "persistent"
                  : eff("adapterConfig", "mode", String(config.mode ?? "persistent"))
              }
              onChange={(e) => {
                const value = e.target.value === "oneshot" ? "oneshot" : "persistent";
                isCreate
                  ? set!({ geminiAcpMode: value })
                  : mark("adapterConfig", "mode", value);
              }}
            >
              <option value="persistent">{t("area.adapters-plugins-1.gemini-local.acpModePersistent")}</option>
              <option value="oneshot">{t("area.adapters-plugins-1.gemini-local.acpModeOneShot")}</option>
            </select>
          </Field>
          <Field
            label={t("area.adapters-plugins-1.gemini-local.acpPermissionsLabel")}
            hint={t("area.adapters-plugins-1.gemini-local.acpPermissionsHint")}
          >
            <select
              className={inputClass}
              value={
                isCreate
                  ? values!.geminiAcpNonInteractivePermissions ?? "deny"
                  : eff("adapterConfig", "nonInteractivePermissions", String(config.nonInteractivePermissions ?? "deny"))
              }
              onChange={(e) => {
                const value = e.target.value === "fail" ? "fail" : "deny";
                isCreate
                  ? set!({ geminiAcpNonInteractivePermissions: value })
                  : mark("adapterConfig", "nonInteractivePermissions", value);
              }}
            >
              <option value="deny">{t("area.adapters-plugins-1.gemini-local.acpPermissionsDeny")}</option>
              <option value="fail">{t("area.adapters-plugins-1.gemini-local.acpPermissionsFail")}</option>
            </select>
          </Field>
          {!managedSandboxOnly && (
            <Field
              label={t("area.adapters-plugins-1.gemini-local.acpStateDirLabel")}
              hint={t("area.adapters-plugins-1.gemini-local.acpStateDirHint")}
            >
              <div className="flex items-center gap-2">
                <DraftInput
                  value={
                    isCreate
                      ? values!.geminiAcpStateDir ?? ""
                      : eff("adapterConfig", "stateDir", String(config.stateDir ?? ""))
                  }
                  onCommit={(v) =>
                    isCreate
                      ? set!({ geminiAcpStateDir: v })
                      : mark("adapterConfig", "stateDir", v || undefined)
                  }
                  immediate
                  className={inputClass}
                  placeholder={t("area.adapters-plugins-1.gemini-local.acpStateDirPlaceholder")}
                />
                <ChoosePathButton />
              </div>
            </Field>
          )}
          <Field configSection="runPolicy"
            label={t("area.adapters-plugins-1.gemini-local.acpWarmIdleLabel")}
            hint={t("area.adapters-plugins-1.gemini-local.acpWarmIdleHint")}
          >
            {isCreate ? (
              <input
                type="number"
                className={inputClass}
                value={values!.geminiAcpWarmHandleIdleMs ?? 0}
                onChange={(e) => set!({ geminiAcpWarmHandleIdleMs: Number(e.target.value) })}
              />
            ) : (
              <DraftNumberInput
                value={eff(
                  "adapterConfig",
                  "warmHandleIdleMs",
                  Number(config.warmHandleIdleMs ?? 0),
                )}
                onCommit={(v) => mark("adapterConfig", "warmHandleIdleMs", v || 0)}
                immediate
                className={inputClass}
              />
            )}
          </Field>
        </>
      )}
      {!hideInstructionsFile && (
        <Field label={t("area.adapters-plugins-1.gemini-local.instructionsFileLabel")} hint={t("area.adapters-plugins-1.gemini-local.instructionsFileHint")}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder={t("area.adapters-plugins-1.gemini-local.instructionsFilePlaceholder")}
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
    </>
  ));
}
