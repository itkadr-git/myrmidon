// myrmidon(1.6.6 REMOTE-SITES-T8): remote execution sites in the current UI (company settings, next to the
// server console): the table of sites with their bots and the form that adds a site. The requests are the
// fleet screen's API (server fleet-site-manage-routes.ts); the table itself is RemoteSitesPanel.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fleetApi, type FleetSiteBot, type FleetSiteOverview, type FleetSiteState } from "@/api/fleet";
import { useCompany } from "@/context/CompanyContext";
import { useTranslation } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import { RemoteSiteEnrollForm } from "./RemoteSiteEnrollForm";
import { RemoteSitesPanel, type RemoteBotRow, type RemoteSiteAction, type RemoteSiteRow, type RemoteSiteStatus } from "./RemoteSitesPanel";

const STATUS_OF_STATE: Record<FleetSiteState, RemoteSiteStatus> = {
  unknown: "unknown",
  healthy: "reachable",
  degraded: "degraded",
  unreachable: "unreachable",
  draining: "draining",
  quarantined: "quarantined",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toBotRow(bot: FleetSiteBot): RemoteBotRow {
  return {
    botKey: bot.botKey,
    agent: bot.agentName,
    state: bot.state,
    image: bot.image,
    drift: bot.drift,
    driftFields: bot.driftFields,
    apiBaseUrl: bot.apiBaseUrl,
    pinned: bot.pinned,
  };
}

export function toSiteRow(site: FleetSiteOverview, bots: RemoteBotRow[] | null | undefined): RemoteSiteRow {
  return {
    name: site.name,
    status: site.status === "disabled" ? "disabled" : STATUS_OF_STATE[site.state],
    registryStatus: site.status,
    autoDrained: site.autoDrained,
    lastSeenAt: site.lastSeenAt,
    capacity: site.capacity,
    botCount: site.botCount,
    driftCount: site.driftCount,
    clientCertNotAfter: site.clientCertNotAfter,
    bots,
  };
}

export function RemoteSitesSection() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState<string[]>([]);
  const [logsByBot, setLogsByBot] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<{ site: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [enrolled, setEnrolled] = useState<string | null>(null);

  const sitesQuery = useQuery({
    queryKey: queryKeys.fleetSiteOverview(companyId),
    queryFn: () => fleetApi.sitesOverview(companyId),
    enabled: Boolean(companyId),
    refetchInterval: 30_000,
  });
  const botQueries = useQuery({
    queryKey: [...queryKeys.fleetSites(companyId), "opened-bots", opened],
    queryFn: async () => {
      const entries = await Promise.all(
        opened.map(async (name): Promise<[string, RemoteBotRow[] | null]> => {
          try {
            return [name, (await fleetApi.siteBots(companyId, name)).bots.map(toBotRow)];
          } catch {
            return [name, null];
          }
        }),
      );
      return Object.fromEntries(entries) as Record<string, RemoteBotRow[] | null>;
    },
    enabled: Boolean(companyId) && opened.length > 0,
    placeholderData: (previous) => previous,
    refetchInterval: 30_000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.fleetSites(companyId) });

  const action = useMutation({
    mutationFn: async (input: { action: RemoteSiteAction; site: RemoteSiteRow; bot?: RemoteBotRow; target?: string }) => {
      const { action: kind, site, bot, target } = input;
      if (kind === "drain") await fleetApi.drainSite(companyId, site.name);
      else if (kind === "resume") await fleetApi.resumeSite(companyId, site.name);
      else if (bot && kind === "restart") await fleetApi.restartBot(bot.botKey);
      else if (bot && kind === "stop") await fleetApi.stopBot(bot.botKey);
      else if (bot && kind === "move" && target) {
        const result = await fleetApi.moveBot(bot.botKey, target);
        setNotice(t("remoteSites.moved", { phase: result.move.phase }));
      } else if (bot && kind === "logs") {
        if (logsByBot[bot.botKey] !== undefined) {
          setLogsByBot((current) => {
            const next = { ...current };
            delete next[bot.botKey];
            return next;
          });
        } else {
          const result = await fleetApi.botLogs(bot.botKey);
          setLogsByBot((current) => ({ ...current, [bot.botKey]: result.logs }));
        }
      }
    },
    onSuccess: () => {
      setFailure(null);
      void refresh();
    },
    onError: (error, input) => setFailure({ site: input.site.name, message: errorText(error) }),
  });

  const enroll = useMutation({
    mutationFn: (body: Parameters<typeof fleetApi.enrollSite>[1]) => fleetApi.enrollSite(companyId, body),
    onSuccess: (data) => {
      setEnrolled(data.site.name);
      void refresh();
    },
    onError: () => setEnrolled(null),
  });

  const overview = sitesQuery.data?.sites ?? [];
  const sites = overview.map((site) => toSiteRow(site, opened.includes(site.name) ? botQueries.data?.[site.name] ?? (botQueries.isError ? null : undefined) : undefined));

  return (
    <section className="min-w-0 space-y-3" data-testid="remote-sites-section">
      <h3 className="text-sm font-semibold">{t("remoteSites.title")}</h3>
      <RemoteSitesPanel
        sites={sites}
        loading={sitesQuery.isLoading}
        error={sitesQuery.isError ? errorText(sitesQuery.error) : null}
        busy={action.isPending}
        failure={failure}
        notice={notice}
        logsByBot={logsByBot}
        moveTargets={(site) => [...overview.filter((s) => s.name !== site.name && s.status === "active").map((s) => s.name), "local"]}
        onExpand={(site) => setOpened((current) => (current.includes(site.name) ? current : [...current, site.name]))}
        onAction={(kind, site, bot, target) => {
          setNotice(null);
          action.mutate({ action: kind, site, bot, target });
        }}
      />
      <RemoteSiteEnrollForm
        pending={enroll.isPending}
        error={enroll.isError ? errorText(enroll.error) : null}
        doneName={enrolled}
        onSubmit={(body) => {
          setEnrolled(null);
          enroll.mutate(body);
        }}
      />
    </section>
  );
}
