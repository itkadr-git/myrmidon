import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import type { ToolMcpGatewayWithTokens } from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/context/ToastContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useTranslation } from "@/i18n";
import { gatewaysQueryKey } from "../NewGatewayDialog";

/**
 * Advanced tab — raw protocol/transport details, config JSON and the archive
 * (destructive) action live here, out of the default prosumer view per the
 * PAP-11174 contract's default-vs-Advanced split.
 */
export function GatewayAdvancedPanel({
  companyId,
  gateway,
}: {
  companyId: string;
  gateway: ToolMcpGatewayWithTokens;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [confirmName, setConfirmName] = useState("");

  const endpoint = `${typeof window !== "undefined" ? window.location.origin : ""}${gateway.endpointPath}`;
  const rawConfig = JSON.stringify(
    {
      gatewayPublicId: gateway.gatewayPublicId,
      displaySlug: gateway.displaySlug,
      status: gateway.status,
      profileId: gateway.profileId,
      defaultProfileMode: gateway.defaultProfileMode,
      contextScopeType: gateway.contextScopeType,
      contextScopeId: gateway.contextScopeId,
      endpointPath: gateway.endpointPath,
      authConfig: gateway.authConfig,
      headerPolicy: gateway.headerPolicy,
      metadataPolicy: gateway.metadataPolicy,
      onDemandToolsConfig: gateway.onDemandToolsConfig,
    },
    null,
    2,
  );

  const archiveMutation = useMutation({
    mutationFn: () => toolsApi.updateGateway(companyId, gateway.id, { status: "archived" }),
    onSuccess: async () => {
      pushToast({
        title: t("area.apps-gateways-2.gateway-advanced-panel.archivedTitle"),
        body: t("area.apps-gateways-2.gateway-advanced-panel.archivedBody", { name: gateway.name }),
        tone: "success",
      });
      await queryClient.invalidateQueries({ queryKey: gatewaysQueryKey(companyId) });
      navigate("/apps/gateways");
    },
    onError: (error) =>
      pushToast({
        title: t("area.apps-gateways-2.gateway-advanced-panel.archiveFailed"),
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      }),
  });

  async function copy(value: string, label: string) {
    try {
      await copyTextToClipboard(value);
      pushToast({ title: t("area.apps-gateways-2.gateway-advanced-panel.copied"), body: label, tone: "success" });
    } catch {
      pushToast({ title: t("area.apps-gateways-2.gateway-advanced-panel.copyFailed"), body: t("area.apps-gateways-2.gateway-advanced-panel.clipboardUnavailable"), tone: "error" });
    }
  }

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">{t("area.apps-gateways-2.gateway-advanced-panel.transport")}</h3>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row label={t("area.apps-gateways-2.gateway-advanced-panel.transport")} value="streamable_http" />
          <Row label={t("area.apps-gateways-2.gateway-advanced-panel.authentication")} value="bearer" />
          <Row label={t("area.apps-gateways-2.gateway-advanced-panel.protocolVersion")} value="2025-03-26" />
          <Row label={t("area.apps-gateways-2.gateway-advanced-panel.publicId")} value={gateway.gatewayPublicId} mono />
        </dl>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            {endpoint}
          </code>
          <Button variant="outline" size="sm" onClick={() => void copy(endpoint, t("area.apps-gateways-2.gateway-advanced-panel.endpointUrl"))}>
            <Copy className="mr-1 h-3.5 w-3.5" />
            {t("area.apps-gateways-2.gateway-advanced-panel.copy")}
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">{t("area.apps-gateways-2.gateway-advanced-panel.rawConfiguration")}</h3>
          <Button variant="outline" size="sm" onClick={() => void copy(rawConfig, t("area.apps-gateways-2.gateway-advanced-panel.gatewayConfigJson"))}>
            <Copy className="mr-1 h-3.5 w-3.5" />
            {t("area.apps-gateways-2.gateway-advanced-panel.copyJson")}
          </Button>
        </div>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
          {rawConfig}
        </pre>
      </section>

      <section className="space-y-2 rounded-lg border border-destructive/40 p-4">
        <h3 className="text-sm font-semibold text-destructive">{t("area.apps-gateways-2.gateway-advanced-panel.dangerZone")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("area.apps-gateways-2.gateway-advanced-panel.dangerDescription")}
        </p>
        {confirming ? (
          <div className="space-y-2">
            <Input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={gateway.name}
              aria-label={t("area.apps-gateways-2.gateway-advanced-panel.confirmAriaLabel")}
            />
            <div className="flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                disabled={confirmName.trim() !== gateway.name || archiveMutation.isPending}
                onClick={() => archiveMutation.mutate()}
              >
                {archiveMutation.isPending ? t("area.apps-gateways-2.gateway-advanced-panel.archiving") : t("area.apps-gateways-2.gateway-advanced-panel.archiveButton")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setConfirming(false); setConfirmName(""); }}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="text-destructive" onClick={() => setConfirming(true)}>
            {t("area.apps-gateways-2.gateway-advanced-panel.archiveButton")}
          </Button>
        )}
      </section>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={mono ? "mt-0.5 font-mono text-foreground" : "mt-0.5 text-foreground"}>{value}</dd>
    </div>
  );
}
