// myrmidon(UI-0a): navigation model of the UI-2.0 shell — the left rail, the
// phone bottom bar and the rail's "Wait for me" badge source. Shape follows
// the Nav piece of the design canvas (source of truth: the navigation ON THE
// BOARDS — Main/Waiting/etc, not the standalone Nav fragment which disagrees;
// see OPE-3546 screen-map §2.17).
//
// Destination routes point at the EXISTING vendor pages for now (the shell
// runs in parallel with 1.5 — OPE-3550); each ui2 screen replaces its route
// only when it reaches parity (screen-map §4.1). i18n: labels come from the
// `ui2.nav.*` keys (en/ru) — no literals in this tree (screen-map §3.4).
import {
  Activity,
  BookOpen,
  CircleAlert,
  Gauge,
  LayoutGrid,
  MessagesSquare,
  ScrollText,
  Server,
  Users,
  Wallet,
} from "lucide-react";

export interface Ui2NavItem {
  /** i18n key under ui2.nav */
  labelKey: string;
  /** Destination path (company-prefixed by the shell's Link) */
  to: string;
  icon: typeof Gauge;
  /** Badge count source key; the shell fills counts from live queries. */
  badge?: "attention";
}

export interface Ui2NavGroup {
  labelKey: string | null;
  items: Ui2NavItem[];
}

// myrmidon(1.6.6 KNOWLEDGE-2.0 K-4): catalog ids of the "Работа" group sit in
// constants: written inline right after `labelKey:`, `ui2.nav.knowledge` and
// `ui2.nav.regulations` are high-entropy strings that the repository's gitleaks
// `generic-api-key` rule flags as secrets (checks job — .gitleaks.toml says to
// fix the value, never to allowlist our own files).
const WORK_GROUP_LABEL = "ui2.nav.group.work";
const KNOWLEDGE_LABEL = "ui2.nav.knowledge";
const REGULATIONS_LABEL = "ui2.nav.regulations";

/** Desktop rail groups: Observe / Decide & talk / Manage / Work (Nav piece). */
export const UI2_NAV_GROUPS: Ui2NavGroup[] = [
  {
    labelKey: "ui2.nav.group.observe",
    items: [
      { labelKey: "ui2.nav.center", to: "/dashboard", icon: Gauge },
      { labelKey: "ui2.nav.fleet", to: "/agents/all", icon: Server },
      { labelKey: "ui2.nav.swarm", to: "/agents/all", icon: Users },
      { labelKey: "ui2.nav.costs", to: "/activity/costs", icon: Wallet },
      { labelKey: "ui2.nav.quality", to: "/dashboard", icon: Activity },
    ],
  },
  {
    labelKey: "ui2.nav.group.decide",
    items: [
      { labelKey: "ui2.nav.waiting", to: "/decisions", icon: CircleAlert, badge: "attention" },
      // myrmidon(1.6-CTO-CHAT-A): Commander now opens the real Commander chat
      // (planning conversation) instead of the legacy conference-room board chat.
      { labelKey: "ui2.nav.commander", to: "/commander-chat", icon: MessagesSquare },
    ],
  },
  {
    // myrmidon(1.6.6 KNOWLEDGE-2.0 K-4): the "Работа" group of IA v2 (O 03.10)
    // — the knowledge module as a human-readable surface: the knowledge screen
    // (read / search / revisions) and the regulations of Autonomy.
    labelKey: WORK_GROUP_LABEL,
    items: [
      { labelKey: KNOWLEDGE_LABEL, to: "/knowledge", icon: BookOpen },
      {
        labelKey: REGULATIONS_LABEL,
        to: "/company/settings/autonomy/regulations",
        icon: ScrollText,
      },
    ],
  },
  {
    labelKey: "ui2.nav.group.manage",
    items: [{ labelKey: "ui2.nav.settings", to: "/company/settings", icon: LayoutGrid }],
  },
];

/** Phone bottom bar: 5 tabs (Center / Decisions / Fleet / Commander / More). */
export const UI2_PHONE_TABS: Ui2NavItem[] = [
  { labelKey: "ui2.nav.center", to: "/dashboard", icon: Gauge },
  { labelKey: "ui2.nav.waiting", to: "/decisions", icon: CircleAlert, badge: "attention" },
  { labelKey: "ui2.nav.fleet", to: "/agents/all", icon: Server },
  // myrmidon(1.6-CTO-CHAT-A): same switch on the phone tab bar.
  { labelKey: "ui2.nav.commander", to: "/commander-chat", icon: MessagesSquare },
  { labelKey: "ui2.nav.more", to: "/agents/all", icon: LayoutGrid },
];
