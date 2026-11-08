import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { useTranslation } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import { buildAgentOnboardingPrompt } from "@/lib/agent-onboarding-prompt";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

/** Preserve the existing agent-only invitation path beside the setup wizard. */
export function ExternalAgentInviteDialog({ companyId, onClose, onBack }: {
  companyId: string;
  onClose: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [message, setMessage] = useState("");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  async function copy(value: string) {
    try {
      await copyTextToClipboard(value);
      if (mounted.current) { setCopied(true); setCopyError(false); }
    } catch {
      if (mounted.current) setCopyError(true);
    }
  }
  const createInvite = useMutation({
    mutationFn: async () => {
      const invite = await accessApi.createCompanyInvite(companyId, {
        allowedJoinTypes: "agent",
        humanRole: null,
        agentMessage: message.trim() || null,
      });
      void cache.invalidateQueries({ queryKey: queryKeys.access.invites(companyId, "all", 5) });
      const path = invite.onboardingTextUrl ?? invite.onboardingTextPath ?? `/api/invites/${invite.token}/onboarding.txt`;
      const onboardingTextUrl = new URL(path, window.location.origin).href;
      const manifest = await accessApi.getInviteOnboarding(invite.token).catch(() => null);
      return buildAgentOnboardingPrompt({
        onboardingTextUrl,
        connectionCandidates: manifest?.onboarding.connectivity?.connectionCandidates ?? null,
        testResolutionUrl: manifest?.onboarding.connectivity?.testResolutionEndpoint?.url ?? null,
      });
    },
    onSuccess: async (value) => {
      if (!mounted.current) return;
      setPrompt(value);
      await copy(value);
    },
  });
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-(--sz-calc-16) overflow-y-auto sm:max-w-2xl">
      <DialogTitle>{prompt ? t("area.agents-2.external-agent-invite-dialog.titlePrompt") : t("area.agents-2.external-agent-invite-dialog.titleInvite")}</DialogTitle>
      <DialogDescription>
        {prompt ? t("area.agents-2.external-agent-invite-dialog.descriptionPrompt")
          : t("area.agents-2.external-agent-invite-dialog.descriptionInvite")}
      </DialogDescription>
      {prompt ? <>
        <Textarea aria-label={t("area.agents-2.external-agent-invite-dialog.promptAriaLabel")} readOnly value={prompt} className="min-h-64 font-mono text-xs" />
        {copyError && <p role="alert" className="text-sm text-muted-foreground">{t("area.agents-2.external-agent-invite-dialog.clipboardUnavailable")}</p>}
        <div className="flex justify-between gap-4">
          <Button variant="ghost" onClick={onClose}>{t("area.agents-2.external-agent-invite-dialog.done")}</Button>
          <Button variant="outline" onClick={() => void copy(prompt)}>{copied ? t("area.agents-2.external-agent-invite-dialog.copied") : t("area.agents-2.external-agent-invite-dialog.copy")}</Button>
        </div>
      </> : <>
        <label className="space-y-2 text-sm">
          <span>{t("area.agents-2.external-agent-invite-dialog.messageLabel")}</span>
          <Textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={4000} className="min-h-24" />
        </label>
        {createInvite.error && <p role="alert" className="text-sm text-destructive">{createInvite.error.message}</p>}
        <div className="flex justify-between gap-4">
          <Button variant="ghost" onClick={onBack}>{t("area.agents-2.external-agent-invite-dialog.back")}</Button>
          <Button disabled={createInvite.isPending} onClick={() => createInvite.mutate()}>
            {createInvite.isPending ? t("area.agents-2.external-agent-invite-dialog.generating") : t("area.agents-2.external-agent-invite-dialog.generate")}
          </Button>
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}
