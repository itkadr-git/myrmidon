// myrmidon(LICENSING): per-module no-license banner shown on closed module screens.
//
// Shows "Идентификатор сервера: <install-id>" and a "Скопировать запрос лицензии"
// button that copies a preselected one-line license request:
//   MYR-LICENSE-REQUEST v1 install_id=<myr-...> modules=<module> board=<version>
//
// Visibility is restricted strictly to instance administrators (rule B4).
// If the user is not an instance admin or the module is licensed, this renders null.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { accessApi } from "@/api/access";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useTranslation } from "@/i18n";
import {
  buildLicenseRequestOneLiner,
  isClosedLicenseModule,
  LICENSE_MODULES,
  licensingApi,
  licensingStatusQueryKey,
  type LicenseModule,
} from "./licensingApi";

export { isClosedLicenseModule, LICENSE_MODULES, type LicenseModule };

export interface ModuleLicenseBannerProps {
  module: LicenseModule;
  moduleName?: string;
  isLicensed?: boolean;
}

export function ModuleLicenseBanner({ module, moduleName, isLicensed = false }: ModuleLicenseBannerProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });

  const isInstanceAdmin = Boolean(
    boardAccessQuery.data?.isInstanceAdmin || boardAccessQuery.data?.source === "local_implicit",
  );

  const statusQuery = useQuery({
    queryKey: [...licensingStatusQueryKey, module],
    queryFn: () => licensingApi.status([module]),
    retry: false,
    enabled: isInstanceAdmin && !isLicensed,
  });

  if (!isInstanceAdmin || isLicensed) return null;
  if (statusQuery.isError || !statusQuery.data) return null;

  const status = statusQuery.data;
  const moduleDisplayName = moduleName ?? module;
  const requestText = buildLicenseRequestOneLiner(status.installId, [module], status.board);

  async function handleCopy() {
    try {
      await copyTextToClipboard(requestText);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section
      role="alert"
      className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-foreground mb-4"
      data-testid="module-license-banner"
      data-module={module}
    >
      <div className="flex items-center gap-2 font-medium text-sm">
        <KeyRound className="size-4 text-destructive shrink-0" />
        <span>{t("licensing.moduleNotLicensed", { module: moduleDisplayName })}</span>
      </div>
      <p className="text-xs text-muted-foreground">{t("licensing.moduleLicenseInvalid")}</p>
      <div className="text-sm">
        <span className="font-medium">{t("licensing.serverIdentifier")}</span>{" "}
        <span className="font-mono" data-testid="module-license-install-id">
          {status.installId}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={handleCopy}
          data-testid="module-license-copy-request"
        >
          {t("licensing.moduleCopyRequest")}
        </Button>
        {copied && (
          <span className="text-xs text-muted-foreground" data-testid="module-license-copied">
            {t("licensing.copied")}
          </span>
        )}
      </div>
    </section>
  );
}
