import { useTranslation } from "../i18n";
import { cn } from "../lib/utils";

interface OpenCodeLogoIconProps {
  className?: string;
}

export function OpenCodeLogoIcon({ className }: OpenCodeLogoIconProps) {
  const { t } = useTranslation();
  return (
    <>
      <img
        src="/brands/opencode-logo-light-square.svg"
        alt={t("area.ux-labs.open-code-logo-icon.alt")}
        className={cn("dark:hidden", className)}
      />
      <img
        src="/brands/opencode-logo-dark-square.svg"
        alt={t("area.ux-labs.open-code-logo-icon.alt")}
        className={cn("hidden dark:block", className)}
      />
    </>
  );
}
