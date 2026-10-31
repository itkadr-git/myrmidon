// ui/src/ui2/screens/settings/channels/Ui2ChannelsSettings.tsx
//
// myrmidon(UI2-CHANNELS): Channels settings screen with extensible tabbed shell.
// ia-v2 §2.3 item 13: tabs "Telegram · Voice · Connectors".
// This screen hosts the tabs shell and provides the Voice (STT) tab by default.
// The shell accepts tabs as a list so future tabs (Telegram, Connectors) can be
// injected without modifying unrelated files.
import { useState, type ReactNode } from "react";
import { Ui2Page } from "../../../components/ui2Primitives";
import { useUi2I18n } from "../../../i18n/Ui2I18n";
import { Ui2VoiceSttTab } from "./Ui2VoiceSttTab";

export interface Ui2ChannelTab {
  id: string;
  label: string;
  content: ReactNode;
}

export function getDefaultChannelsTabs(t: (key: any) => string): Ui2ChannelTab[] {
  return [
    {
      id: "voice",
      label: t("ui2.settings.channels.tabs.voice"),
      content: <Ui2VoiceSttTab />,
    },
  ];
}

export interface Ui2ChannelsSettingsProps {
  tabs?: Ui2ChannelTab[];
  defaultTab?: string;
}

export function Ui2ChannelsSettings({
  tabs: customTabs,
  defaultTab,
}: Ui2ChannelsSettingsProps = {}) {
  const { t } = useUi2I18n();
  const tabs = customTabs ?? getDefaultChannelsTabs(t);
  const [activeTabId, setActiveTabId] = useState<string>(
    defaultTab ?? tabs[0]?.id ?? "voice",
  );

  const currentTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  return (
    <Ui2Page
      title={t("ui2.settings.channels.title")}
      subtitle={t("ui2.settings.channels.subtitle")}
    >
      <div
        role="tablist"
        aria-label={t("ui2.settings.channels.title")}
        className="ui2-channels-tablist flex items-center gap-2 border-b border-border pb-2"
        data-testid="ui2-channels-tablist"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === currentTab?.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`ui2-channels-tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`ui2-channels-panel-${tab.id}`}
              data-testid={`ui2-channels-tab-${tab.id}`}
              className={`ui2-channel-tab-button rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
              onClick={() => setActiveTabId(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {currentTab ? (
        <div
          role="tabpanel"
          id={`ui2-channels-panel-${currentTab.id}`}
          aria-labelledby={`ui2-channels-tab-${currentTab.id}`}
          data-testid={`ui2-channels-panel-${currentTab.id}`}
          className="ui2-channels-tabpanel pt-4"
        >
          {currentTab.content}
        </div>
      ) : null}
    </Ui2Page>
  );
}
