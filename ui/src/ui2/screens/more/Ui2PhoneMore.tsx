import {
  Activity,
  Bot,
  ChevronRight,
  LayoutGrid,
  Moon,
  Sun,
  Users,
  Wallet,
} from "lucide-react";
import { useTheme } from "@/context/ThemeContext";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useUi2I18n } from "../../i18n/Ui2I18n";
import { Ui2Page, Ui2Section } from "../../components/ui2Primitives";

export function Ui2PhoneMore() {
  const { t } = useUi2I18n();
  const { theme, setTheme, toggleTheme } = useTheme();

  const links = [
    {
      key: "swarm",
      to: "/swarm-claim",
      label: t("ui2.screens.more.links.swarm" as never),
      icon: Users,
    },
    {
      key: "costs",
      to: "/activity/costs",
      label: t("ui2.screens.more.links.costs" as never),
      icon: Wallet,
    },
    {
      key: "quality",
      to: "/quality",
      label: t("ui2.screens.more.links.quality" as never),
      icon: Activity,
    },
    {
      key: "settings",
      to: "/company/settings",
      label: t("ui2.screens.more.links.settings" as never),
      icon: LayoutGrid,
    },
    {
      key: "agentCard",
      to: "/agents",
      label: t("ui2.screens.more.links.agentCard" as never),
      icon: Bot,
    },
  ];

  return (
    <Ui2Page
      title={t("ui2.screens.more.title" as never)}
      subtitle={t("ui2.screens.more.subtitle" as never)}
      className="p-4"
    >
      <div className="flex flex-col gap-5 max-w-lg mx-auto w-full">
        <Ui2Section title={t("ui2.screens.more.sections.navigation" as never)}>
          <div className="flex flex-col divide-y divide-border -mx-4 -my-2" data-testid="more-links-list">
            {links.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.key}
                  to={item.to}
                  className="flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors"
                  data-testid={`more-link-${item.key}`}
                >
                  <div className="flex items-center gap-3">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">{item.label}</span>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </Link>
              );
            })}
          </div>
        </Ui2Section>

        <Ui2Section title={t("ui2.screens.more.sections.appearance" as never)}>
          <div className="flex items-center justify-between" data-testid="more-theme-switch-row">
            <div className="flex items-center gap-3">
              {theme === "dark" ? (
                <Moon className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Sun className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="text-sm font-medium text-foreground">
                {t("ui2.screens.more.theme" as never)}
              </span>
            </div>

            <div className="flex items-center gap-1 p-1 bg-muted rounded-md" data-testid="more-theme-switch">
              <button
                type="button"
                onClick={() => setTheme("light")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors",
                  theme === "light"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                data-testid="theme-light-btn"
                data-active={theme === "light"}
              >
                <Sun className="h-3.5 w-3.5" />
                <span>{t("ui2.screens.more.themeLight" as never)}</span>
              </button>

              <button
                type="button"
                onClick={() => setTheme("dark")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors",
                  theme === "dark"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                data-testid="theme-dark-btn"
                data-active={theme === "dark"}
              >
                <Moon className="h-3.5 w-3.5" />
                <span>{t("ui2.screens.more.themeDark" as never)}</span>
              </button>

              <button
                type="button"
                onClick={toggleTheme}
                className="sr-only"
                data-testid="theme-toggle-btn"
              >
                {t("ui2.screens.more.theme" as never)}
              </button>
            </div>
          </div>
        </Ui2Section>
      </div>
    </Ui2Page>
  );
}
