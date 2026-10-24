import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatEndpointSetupAction,
} from "@/api/chatEndpoints";
import { sanitizedSetupErrorMessage } from "./chat-setup-error";
import { useTranslation } from "@/i18n";

export function PhotonConnectStep({
  endpoint,
  agentName,
  repairing,
  pending,
  onAction,
}: {
  endpoint: ChatEndpoint;
  agentName: string;
  repairing: boolean;
  pending: boolean;
  onAction(
    action: ChatEndpointSetupAction,
    values?: Record<string, string>,
  ): void;
}) {
  const { t } = useTranslation();
  const [projectId, setProjectId] = useState(endpoint.providerAccountId ?? "");
  const [projectSecret, setProjectSecret] = useState("");
  const [lineId, setLineId] = useState("");
  const inspection = useMutation({
    mutationFn: () =>
      chatEndpointsApi.inspectPhoton(endpoint.id, {
        projectId: projectId.trim(),
        projectSecret,
      }),
    onSuccess: (result) => {
      const eligible = result.lines.filter((line) => line.eligible);
      setLineId(eligible.length === 1 ? eligible[0].lineId : "");
    },
  });
  const resetInspection = () => {
    inspection.reset();
    setLineId("");
  };
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-xl font-bold">{t("area.apps-chat-email.photon-connect-step.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("area.apps-chat-email.photon-connect-step.description", { agent: agentName })}
        </p>
        <p className="text-sm">
          <a
            className="underline"
            href="https://app.photon.codes/"
            target="_blank"
            rel="noreferrer"
          >
            {t("area.apps-chat-email.photon-connect-step.dashboardLink")}
          </a>
          {" · "}
          <a
            className="underline"
            href="https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing"
            target="_blank"
            rel="noreferrer"
          >
            {t("area.apps-chat-email.photon-connect-step.lineSetupLink")}
          </a>
        </p>
      </div>
      {repairing && (
        <p className="text-sm text-muted-foreground">
          {t("area.apps-chat-email.photon-connect-step.reconnectNote", {
            target:
              endpoint.photonAllocation === "shared"
                ? t("area.apps-chat-email.photon-connect-step.allocationShared")
                : endpoint.botExternalId ?? t("area.apps-chat-email.photon-connect-step.allocationDedicated"),
          })}
        </p>
      )}
      <label className="grid gap-2 text-sm font-medium">
        {t("area.apps-chat-email.photon-connect-step.projectId")}
        <Input
          value={projectId}
          autoComplete="off"
          disabled={pending || inspection.isPending || !!endpoint.botExternalId}
          onChange={(event) => {
            setProjectId(event.target.value);
            resetInspection();
          }}
        />
      </label>
      <label className="grid gap-2 text-sm font-medium">
        {t("area.apps-chat-email.photon-connect-step.projectSecret")}
        <Input
          type="password"
          value={projectSecret}
          autoComplete="new-password"
          disabled={pending || inspection.isPending}
          onChange={(event) => {
            setProjectSecret(event.target.value);
            resetInspection();
          }}
        />
      </label>
      <Button
        variant="outline"
        disabled={
          pending || inspection.isPending || !projectId.trim() || !projectSecret
        }
        onClick={() => inspection.mutate()}
      >
        {inspection.isPending
          ? t("area.apps-chat-email.photon-connect-step.inspecting")
          : t("area.apps-chat-email.photon-connect-step.inspect")}
      </Button>
      {inspection.isError && (
        <p role="alert" className="text-sm text-destructive">
          {sanitizedSetupErrorMessage(inspection.error, { projectSecret })}
        </p>
      )}
      {inspection.data && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">
            {t("area.apps-chat-email.photon-connect-step.fieldsetLegend", {
              kind:
                inspection.data.allocation === "shared"
                  ? t("area.apps-chat-email.photon-connect-step.kindShared")
                  : t("area.apps-chat-email.photon-connect-step.kindDedicated"),
              project: inspection.data.projectName,
            })}
          </legend>
          {!inspection.data.eligible && (
            <p role="alert" className="text-sm text-destructive">
              {inspection.data.allocation === "shared"
                ? t("area.apps-chat-email.photon-connect-step.sharedTaken")
                : t("area.apps-chat-email.photon-connect-step.noEligibleNumber")}
            </p>
          )}
          {inspection.data.allocation === "shared" && inspection.data.eligible && (
            <p className="text-sm text-muted-foreground">
              {t("area.apps-chat-email.photon-connect-step.sharedNote")}
            </p>
          )}
          {inspection.data.lines.map((line) => (
            <label
              key={line.lineId}
              className="flex items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="photon-line"
                value={line.lineId}
                checked={lineId === line.lineId}
                disabled={
                  !line.eligible ||
                  pending ||
                  (!!endpoint.botExternalId &&
                    endpoint.botExternalId !== line.phoneNumber)
                }
                onChange={() => setLineId(line.lineId)}
              />
              <span>
                {line.phoneNumber}
                {line.unavailableReason ? ` — ${line.unavailableReason}` : ""}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div>
        <Button
          disabled={
            pending ||
            inspection.isPending ||
            (!(inspection.data?.eligible && (inspection.data.allocation === "shared" || lineId)) && !(repairing && !projectSecret))
          }
          onClick={() =>
            onAction(
              repairing ? "reconnect" : "configure",
              inspection.data?.eligible && inspection.data.allocation === "shared"
                ? { projectId: projectId.trim(), projectSecret, allocation: "shared" }
                : lineId
                ? { projectId: projectId.trim(), projectSecret, lineId, allocation: "dedicated" }
                : undefined,
            )
          }
        >
          {pending
            ? t("area.apps-chat-email.photon-connect-step.connecting")
            : repairing
              ? t("area.apps-chat-email.photon-connect-step.reconnect")
              : inspection.data?.allocation === "shared"
                ? t("area.apps-chat-email.photon-connect-step.connectShared")
                : t("area.apps-chat-email.photon-connect-step.connectSelected")}
        </Button>
      </div>
    </div>
  );
}
