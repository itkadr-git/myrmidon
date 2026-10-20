// myrmidon(LICENSING): banner in the common layout while a closed module
// installed into this board has no working license. Instance admins only
// (the only role that can fix it); everyone else never calls the API. Links
// to Settings → Instance → Licenses.
import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Link } from "@/lib/router";
import { LICENSES_PATH, licensingApi, licensingStatusQueryKey, useIsInstanceAdmin } from "./licensingApi";

export function LicenseAttentionBanner() {
  const { t } = useTranslation();
  const isInstanceAdmin = useIsInstanceAdmin();
  const { data } = useQuery({
    queryKey: [...licensingStatusQueryKey, ""],
    queryFn: () => licensingApi.status(),
    enabled: isInstanceAdmin === true,
    retry: false,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  if (!isInstanceAdmin || !data?.attention) return null;
  const modules = data.modules
    .filter((m) => m.installed && m.state !== "valid" && m.state !== "expiring")
    .map((m) => m.module);

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm"
      data-testid="license-attention-banner"
    >
      <KeyRound className="size-4 shrink-0 text-destructive" />
      <span>{t("licensing.banner", { modules: modules.join(", ") })}</span>
      <Link to={LICENSES_PATH} className="font-medium underline underline-offset-2" data-testid="license-attention-link">
        {t("licensing.bannerLink")}
      </Link>
    </div>
  );
}
