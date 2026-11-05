import type { UIAdapterModule, AdapterConfigFieldsProps } from "../types";
import { createElement, Fragment } from "react";
import { parseHermesStdoutLine, buildHermesConfig } from "@myrmidon/hermes-paperclip-adapter/ui";
import { SchemaConfigFields } from "../schema-config-fields";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

function HermesLocalConfigFields(props: AdapterConfigFieldsProps) {
  return createElement(Fragment, null,
    createElement(SchemaConfigFields, { ...props, hideSandboxFields: true }),
    createElement(LocalWorkspaceRuntimeFields, props),
  );
}

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes",
  parseStdoutLine: parseHermesStdoutLine,
  ConfigFields: HermesLocalConfigFields,
  buildAdapterConfig: (values) => {
    const config = buildHermesConfig(values);
    if (values.filesystemScope) config.filesystemScope = values.filesystemScope;
    if (values.networkScope) config.networkScope = values.networkScope;
    if (values.networkScope === "allowlist") config.networkAllowlist = (values.networkAllowlist ?? "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    return config;
  },
};
