import { AgentChatPicker } from "@/components/AgentChatPicker";
import { TaskChatProjectCreatedCard } from "@/components/task-chat/TaskChatProjectCreatedCard";
import { AnnouncementCard } from "@/components/AnnouncementCard";
import { announcementPreview, announcementAnimationPreview, announcementAnimationPreviewSrc } from "@/lib/announcement-preview";
import { TaskDetailTasksPanel } from "@/components/task-detail/TaskDetailTasksPanel";
import { AiConnectionDesignExamples } from "@/components/ai-connections/AiConnectionDesignExamples";
import { SavedProviderKeySelect } from "../components/onboarding/SavedProviderKeySelect";
import { RepositoryEditor } from "@/components/RepositoryEditor";
import { TaskChatRunnerActivityGroup } from "@/components/task-chat/TaskChatRunnerActivityGroup";
import { TaskChatMarker } from "@/components/task-chat/TaskChatMarker";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskTreeControlDialog, TaskTreeControlMenuItems } from "@/components/TaskTreeControls";
import { useState } from "react";
import { Trans } from "react-i18next";
import { ServicesList } from "./apps/app-detail/ServicesPanel";
import { ComposioProvenanceChip } from "./apps/ComposioProvenanceChip";
import type { ComposioServiceRow } from "./apps/composio-services";
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  Command as CommandIcon,
  DollarSign,
  Hexagon,
  History,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Mail,
  Plus,
  Search,
  Settings,
  Target,
  Trash2,
  Upload,
  User,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge } from "@/components/ui/badge";
import { InlineBanner } from "@/components/InlineBanner";
import { BuiltInLifecycleChip } from "@/components/BuiltInAgentBadges";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import { AgentCapsule, AGENT_GRADIENT_COUNT } from "@/components/AgentCapsule";
import { AgentRunCard } from "@/components/ActiveAgentsPanel";
import { StatusBadge, IssueStatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { EnforcementBanner } from "@/components/EnforcementBanner";
import { ActionCard, ActionCardMobile, BindingsTable } from "@/components/actions/ActionCard";
import { PriorityIcon } from "@/components/PriorityIcon";
import { SHOW_TASK_PRIORITY_UI } from "@/lib/ui-flags";
import { agentStatusDot, agentStatusDotDefault } from "@/lib/status-colors";
import { EntityRow } from "@/components/EntityRow";
import { EmptyState } from "@/components/EmptyState";
import { MetricCard } from "@/components/MetricCard";
import { FilterBar, type FilterValue } from "@/components/FilterBar";
import { InlineEditor } from "@/components/InlineEditor";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Identity } from "@/components/Identity";
import { AppLogo } from "@/pages/apps/AppLogo";
import { IssueReferencePill } from "@/components/IssueReferencePill";
import { MembershipAction } from "@/components/MembershipAction";
import { IssueOutputSection } from "@/components/issue-output/IssueOutputSection";
import { EnvironmentVariablesEditor } from "@/components/environment-variables-editor";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import {
  connectedConnectionIntentInteraction,
  issueThreadInteractionFixtureMeta,
  pendingConnectionIntentInteraction,
  retryConnectionIntentInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import type { CompanySecret, EnvBinding, Issue } from "@paperclipai/shared";
import { CollectionToolbar } from "@/components/CollectionToolbar";
import { IssueRow } from "@/components/IssueRow";
import {
  EnvInputsList,
  ExternalSourcesList,
  RequiredSkillsList,
  StepSkillPlan,
  StepSourcePolicy,
  TeamCard,
  TeamHierarchyPreview,
  TeamRow,
} from "@/pages/TeamCatalog";
import {
  currentInstalledState,
  onboardingTeams,
  optionalTeam,
  outOfDateInstalledState,
  sampleSkillPreparations,
  sampleTeam,
  warnTeam,
} from "@/pages/TeamCatalog.fixtures";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { useTranslation } from "@/i18n";

/* ------------------------------------------------------------------ */
/*  Sample data for the Issue Output surface showcase                  */
/* ------------------------------------------------------------------ */

function sampleOutput(
  id: string,
  attachmentId: string,
  contentType: string,
  filename: string,
  opts: { byteSize: number; isPrimary?: boolean; createdAt: string },
): IssueWorkProduct {
  const contentPath = `/api/attachments/${attachmentId}/content`;
  return {
    id,
    companyId: "demo-company",
    projectId: null,
    issueId: "demo-issue",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "artifact",
    provider: "paperclip",
    externalId: null,
    title: filename,
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: Boolean(opts.isPrimary),
    healthStatus: "unknown",
    summary: null,
    createdByRunId: null,
    createdAt: new Date(opts.createdAt),
    updatedAt: new Date(opts.createdAt),
    metadata: {
      attachmentId,
      contentType,
      byteSize: opts.byteSize,
      contentPath,
      openPath: contentPath,
      downloadPath: `${contentPath}?download=1`,
      originalFilename: filename,
    },
  } as IssueWorkProduct;
}

const DESIGN_GUIDE_OUTPUTS: IssueWorkProduct[] = [
  sampleOutput("wp-vid", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "video/mp4", "q3-summary.mp4", {
    byteSize: 19_293_798,
    isPrimary: true,
    createdAt: "2026-05-30T12:00:00Z",
  }),
  sampleOutput("wp-pdf", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "application/pdf", "talking-points.pdf", {
    byteSize: 421_888,
    createdAt: "2026-05-30T11:52:00Z",
  }),
];

const DESIGN_GUIDE_DEGRADED_OUTPUTS: IssueWorkProduct[] = [
  {
    ...sampleOutput("wp-broken", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "video/mp4", "corrupt-output.mp4", {
      byteSize: 0,
      isPrimary: true,
      createdAt: "2026-05-30T12:01:00Z",
    }),
    // Strip the path metadata so it fails the shared artifact schema.
    metadata: { attachmentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", contentType: "video/mp4" },
  } as IssueWorkProduct,
];

const DESIGN_GUIDE_TASK = {
  id: "design-guide-task",
  identifier: "PAP-427",
  title: "Reconcile the navigation model across operator surfaces",
  status: "in_progress",
  priority: "medium",
  blockerAttention: false,
} as unknown as Issue;

/* ------------------------------------------------------------------ */
/*  Section wrapper                                                    */
/* ------------------------------------------------------------------ */

/**
 * Composio service rows for the design guide (PAP-17865). One row per state, so
 * a reader can compare all four side by side rather than connecting a real
 * Composio project to see them.
 */
const DESIGN_GUIDE_COMPOSIO_ROWS: ComposioServiceRow[] = [
  {
    toolkitSlug: "github",
    name: "GitHub",
    description: "Issues, pull requests, and repository actions",
    logoUrl: null,
    state: "connected",
    connectedAccountStatus: "ACTIVE",
    childConnectionId: "design-guide-child",
    toolCount: 42,
    noAuth: false,
  },
  {
    toolkitSlug: "hubspot",
    name: "HubSpot",
    description: "CRM contacts and deals",
    logoUrl: null,
    state: "attention",
    connectedAccountStatus: "EXPIRED",
    childConnectionId: "design-guide-child-2",
    toolCount: 18,
    noAuth: false,
  },
  {
    toolkitSlug: "slack",
    name: "Slack",
    description: "Channels and messages",
    logoUrl: null,
    state: "pending",
    connectedAccountStatus: "INITIALIZING",
    childConnectionId: null,
    toolCount: 12,
    noAuth: false,
  },
  {
    toolkitSlug: "gmail",
    name: "Gmail",
    description: "Read and send mail",
    logoUrl: null,
    state: "not_connected",
    connectedAccountStatus: null,
    childConnectionId: null,
    toolCount: 9,
    noAuth: false,
  },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        {title}
      </h3>
      <Separator />
      {children}
    </section>
  );
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">{title}</h4>
      {children}
    </div>
  );
}

// Onboarding seam (design §6 + §12.5): the TeamCard tile in its "Pick a starter
// team" 3-col grid, with the first defaultInstall tile selected.
function TeamCardShowcase() {
  const [selectedId, setSelectedId] = useState(onboardingTeams[0]?.id ?? null);
  return (
    <div className="grid max-w-2xl gap-4 md:grid-cols-2 lg:grid-cols-3">
      {onboardingTeams.map((team) => (
        <TeamCard
          key={team.id}
          team={team}
          selected={team.id === selectedId}
          onSelect={() => setSelectedId(team.id)}
        />
      ))}
    </div>
  );
}

// Reusable environment-variables editor: one shared grid, in-field source
// switch, fuzzy secret picker, sensitive-value detection, inline health.
const DESIGN_GUIDE_SECRETS: CompanySecret[] = [
  {
    id: "dg-github",
    companyId: "dg",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: "github_token",
    name: "GITHUB_TOKEN",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-03-01T10:00:00.000Z"),
    updatedAt: new Date("2026-03-01T10:00:00.000Z"),
  },
  {
    id: "dg-db",
    companyId: "dg",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: "db_connection",
    name: "DB_CONNECTION",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-03-01T10:00:00.000Z"),
    updatedAt: new Date("2026-03-01T10:00:00.000Z"),
  },
];

function EnvironmentVariablesEditorShowcase() {
  const [env, setEnv] = useState<Record<string, EnvBinding>>({
    NODE_ENV: { type: "plain", value: "production" },
    GH_TOKEN: { type: "secret_ref", secretId: "dg-github", version: "latest" },
    DB_URL: { type: "secret_ref", secretId: "dg-db", version: 3 },
    STRIPE_API_KEY: { type: "plain", value: "sk-live-51H8xL0aBcDeFgHiJkLmNoPq" },
  });
  return (
    <div className="max-w-(--sz-640px) rounded-md border border-border p-4">
      <EnvironmentVariablesEditor
        value={env}
        secrets={DESIGN_GUIDE_SECRETS}
        onChange={(next) => setEnv(next ?? {})}
        onCreateSecret={async (name) => ({
          ...DESIGN_GUIDE_SECRETS[0]!,
          id: `dg-${name}`,
          key: name,
          name: name.toUpperCase(),
          latestVersion: 1,
        })}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Color swatch                                                       */
/* ------------------------------------------------------------------ */

function Swatch({ name, cssVar }: { name: string; cssVar: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-8 w-8 rounded-md border border-border shrink-0"
        style={{ backgroundColor: `var(${cssVar})` }}
      />
      <div>
        <p className="text-xs font-mono">{cssVar}</p>
        <p className="text-xs text-muted-foreground">{name}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

function TaskExecutionControlsExample() {
  const { t } = useTranslation();
  const [running, setRunning] = useState(true);
  const [dialogMode, setDialogMode] = useState<"resume" | "cancel" | "restore" | null>(null);
  const [wake, setWake] = useState(true);
  return <div className="max-w-xl space-y-4">
    <div className="w-52 rounded-md border border-border p-1">
      <TaskTreeControlMenuItems scope="subtree" canPause={running} canResume={!running} canCancel canRestore={!running}
        onPause={() => setRunning(false)} onResume={() => setDialogMode("resume")}
        onCancel={() => setDialogMode("cancel")} onRestore={() => setDialogMode("restore")} />
    </div>
    <p className="text-sm text-muted-foreground">{running ? t("area.ux-labs.design-guide.taskExecutionControlsExample.runningTypeToSwitch") : t("area.ux-labs.design-guide.taskExecutionControlsExample.pausedResumeFromThe")}</p>
    <TaskChatProjectCreatedCard item={{ id: "design-project", kind: "project_created", projectId: "example-project", name: t("area.ux-labs.design-guide.taskExecutionControlsExample.onboardingImprovements"), description: t("area.ux-labs.design-guide.taskExecutionControlsExample.helpNewTeamsReach"), timestamp: "2026-09-11T00:00:00Z", repositories: [{ id: "1", name: "paperclipai/paperclip", url: "https://github.com/paperclipai/paperclip" }] }} />
    {!running ? <TaskChatMarker item={{ id: "design-cancelled", kind: "marker", variant: "interrupted", tone: "neutral", label: t("area.ux-labs.design-guide.taskExecutionControlsExample.runCancelled"), detail: t("area.ux-labs.design-guide.taskExecutionControlsExample.theRunWasCancelled"), collapsible: true }} /> : null}
    <TaskChatComposer pause={!running ? { scope: "subtree", onResume: () => setDialogMode("resume") } : null} onAdd={async () => {}} workMode="standard" stopScope="subtree" onStop={running ? async () => setRunning(false) : undefined} />
    <TaskTreeControlDialog open={dialogMode !== null} onOpenChange={(open) => { if (!open) setDialogMode(null); }}
      mode={dialogMode ?? "cancel"} scope="subtree" affectedCount={3} affectedAgentCount={2} loading={false} pending={false} valid
      wakeAgents={wake} onWakeAgentsChange={setWake} onRetry={() => {}}
      onApply={() => { setRunning(dialogMode !== "cancel" && wake); setDialogMode(null); }} />
  </div>;
}

function AgentChatPickerExample() {
  const { t } = useTranslation();
  const [state, setState] = useState<"closed" | "empty" | "loading" | "error">("closed");
  return <div className="flex flex-wrap gap-2">
    <Button variant="outline" onClick={() => setState("empty")}>{t("area.ux-labs.design-guide.agentChatPickerExample.emptyPicker")}</Button>
    <Button variant="outline" onClick={() => setState("loading")}>{t("area.ux-labs.design-guide.agentChatPickerExample.loadingPicker")}</Button>
    <Button variant="outline" onClick={() => setState("error")}>{t("area.ux-labs.design-guide.agentChatPickerExample.failedPicker")}</Button>
    <AgentChatPicker agents={[]} open={state !== "closed"} onOpenChange={(open) => { if (!open) setState("closed"); }} onSelect={() => {}}
      loading={state === "loading"} error={state === "error" ? new Error(t("area.ux-labs.design-guide.agentChatPickerExample.unavailable")) : null} onRetry={() => setState("empty")} />
  </div>;
}

export function DesignGuide() {
  const { t } = useTranslation();
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("medium");
  const [selectValue, setSelectValue] = useState("in_progress");
  const [menuChecked, setMenuChecked] = useState(true);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);
  const [inlineText, setInlineText] = useState(t("area.ux-labs.design-guide.clickToEditThis"));
  const [inlineTitle, setInlineTitle] = useState(t("area.ux-labs.design-guide.editableTitle"));
  const [inlineDesc, setInlineDesc] = useState(
    t("area.ux-labs.design-guide.thisIsAnEditable")
  );
  const [filters, setFilters] = useState<FilterValue[]>([
    { key: "status", label: t("area.ux-labs.design-guide.status"), value: t("area.ux-labs.design-guide.active") },
    // PAP-411: priority filter demo row suppressed while SHOW_TASK_PRIORITY_UI is off.
    ...(SHOW_TASK_PRIORITY_UI
      ? [{ key: "priority", label: t("area.ux-labs.design-guide.priority"), value: t("area.ux-labs.design-guide.high") } as FilterValue]
      : []),
  ]);
  const [allowExternal, setAllowExternal] = useState(false);
  const [allowUnpinned, setAllowUnpinned] = useState(false);
  const [allowLocalPath, setAllowLocalPath] = useState(false);

  return (
    <div className="space-y-10 max-w-4xl">
      {/* Page header */}
      <div>
        <h2 className="text-xl font-bold">{t("area.ux-labs.design-guide.designGuide")}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("area.ux-labs.design-guide.pageSubtitle")}
        </p>
      </div>

      {/* ============================================================ */}
      {/*  COVERAGE                                                     */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.componentCoverage")}>
        <p className="text-sm text-muted-foreground">
          {t("area.ux-labs.design-guide.thisPageShouldBe")}
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={t("area.ux-labs.design-guide.uiPrimitives")}>
            <div className="flex flex-wrap gap-2">
              {[
                "avatar", "badge", "breadcrumb", "button", "card", "checkbox", "collapsible",
                "command", "dialog", "dropdown-menu", "input", "label", "popover", "resizable-panels",
                "scroll-area", "select", "separator", "sheet", "skeleton", "tabs", "textarea", "tooltip",
              ].map((name) => (
                <Badge key={name} variant="outline" className="font-mono text-(length:--text-nano)">
                  {name}
                </Badge>
              ))}
            </div>
          </SubSection>
          <SubSection title={t("area.ux-labs.design-guide.appComponents")}>
            <div className="flex flex-wrap gap-2">
              {[
                "StatusBadge", "StatusIcon", "PriorityIcon", "EntityRow", "EmptyState", "MetricCard",
                "FilterBar", "InlineEditor", "PageSkeleton", "Identity", "CommentThread", "MarkdownEditor",
                "PropertiesPanel", "Sidebar", "CommandPalette", "EnvironmentVariablesEditor",
                "InlineBanner", "BuiltInAgentGate", "BuiltInLifecycleChip", "CollectionToolbar",
                "IssueRow", "ContextualSidebarFrame",
              ].map((name) => (
                <Badge key={name} variant="ghost" className="font-mono text-(length:--text-nano)">
                  {name}
                </Badge>
              ))}
            </div>
          </SubSection>
        </div>
      </Section>

      <Section title={t("area.ux-labs.design-guide.announcements")}>
        <div className="grid gap-4 md:grid-cols-2">
          <AnnouncementCard announcement={announcementAnimationPreview} imageSrc="/announcement-preview.svg" animationSrc={announcementAnimationPreviewSrc} onDismiss={() => {}} />
          <AnnouncementCard announcement={announcementPreview} imageSrc="/announcement-preview.svg" onDismiss={() => {}} />
          <AnnouncementCard announcement={{ ...announcementPreview, image: undefined, secondaryLink: undefined }} onDismiss={() => {}} />
        </div>
      </Section>

      <Section title={t("area.ux-labs.design-guide.taskExecutionControls")}>
        <TaskExecutionControlsExample />
      </Section>

      <Section title={t("area.ux-labs.design-guide.taskCollection")}>
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("area.ux-labs.design-guide.collectionNote")}
        </p>
        <CollectionToolbar
          context={<span className="text-sm font-medium">{t("area.ux-labs.design-guide.recentTasks")}</span>}
          search={<Input aria-label={t("area.ux-labs.design-guide.searchTaskCollectionExample")} placeholder={t("area.ux-labs.design-guide.searchTasks")} />}
          controls={<Button variant="outline" size="sm">{t("area.ux-labs.design-guide.filter")}</Button>}
          actions={<Button size="sm">{t("area.ux-labs.design-guide.newTask")}</Button>}
          feedback={<span className="text-xs text-muted-foreground">{t("area.ux-labs.design-guide.taskCollectionFeedback")}</span>}
        />
        <div className="overflow-hidden rounded-lg border border-border">
          <IssueRow
            issue={DESIGN_GUIDE_TASK}
            presentation="task"
            unreadState="visible"
            metadata={<span className="text-xs text-muted-foreground">{t("area.ux-labs.design-guide.updated12mAgo")}</span>}
            actions={<Button variant="ghost" size="xs">{t("area.ux-labs.design-guide.more")}</Button>}
          />
        </div>
      </Section>

      <Section title={t("area.ux-labs.design-guide.themeToggle")}>
        <SubSection title={t("area.ux-labs.design-guide.variants")}>
          <div className="flex max-w-sm flex-col items-start gap-3">
            <ThemeToggle />
            <ThemeToggle variant="menu-action" />
            <ThemeToggle variant="compact-menu-action" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  COLORS                                                       */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.colors")}>
        <SubSection title={t("area.ux-labs.design-guide.core")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Background" cssVar="--background" />
            <Swatch name="Foreground" cssVar="--foreground" />
            <Swatch name="Card" cssVar="--card" />
            <Swatch name="Primary" cssVar="--primary" />
            <Swatch name="Primary foreground" cssVar="--primary-foreground" />
            <Swatch name="Secondary" cssVar="--secondary" />
            <Swatch name="Muted" cssVar="--muted" />
            <Swatch name="Muted foreground" cssVar="--muted-foreground" />
            <Swatch name="Accent" cssVar="--accent" />
            <Swatch name="Destructive" cssVar="--destructive" />
            <Swatch name="Border" cssVar="--border" />
            <Swatch name="Ring" cssVar="--ring" />
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.sidebar")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Sidebar" cssVar="--sidebar" />
            <Swatch name="Sidebar border" cssVar="--sidebar-border" />
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.chart")}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Swatch name="Chart 1" cssVar="--chart-1" />
            <Swatch name="Chart 2" cssVar="--chart-2" />
            <Swatch name="Chart 3" cssVar="--chart-3" />
            <Swatch name="Chart 4" cssVar="--chart-4" />
            <Swatch name="Chart 5" cssVar="--chart-5" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TYPOGRAPHY                                                   */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.runnerActivity")}>
        <TaskChatRunnerActivityGroup item={{ id: "design-runner-activity", kind: "activity_phase", active: true, summary: "", interstitial: { id: "design-runner-commentary", kind: "message", author: "agent", text: t("area.ux-labs.design-guide.iLlInspectThe"), interstitial: true }, items: [
          { id: "design-runner-read", kind: "tool", name: "read", target: "TaskChatRunnerTurn.tsx", status: "completed", detail: t("area.ux-labs.design-guide.foundTheActivityGroups") },
          { id: "design-runner-check", kind: "tool", name: "exec_command", target: "pnpm check:token-gates", status: "in_progress" },
        ] }} />
        <TaskChatRunnerActivityGroup item={{ id: "design-runner-completed", kind: "activity_phase", active: false, summary: "", items: [
          { id: "design-completed-read", kind: "tool", name: "read", target: "TaskChatRunnerTurn.tsx", status: "completed", detail: t("area.ux-labs.design-guide.readTheActivityGroups") },
          { id: "design-completed-check", kind: "tool", name: "exec_command", target: "pnpm check:token-gates", status: "failed", detail: t("area.ux-labs.design-guide.aTokenCheckNeeds") },
        ] }} />
      </Section>

      <Section title={t("area.ux-labs.design-guide.typography")}>
        <div className="space-y-3">
          <h2 className="text-xl font-bold">{t("area.ux-labs.design-guide.pageTitleTextXl")}</h2>
          <h2 className="text-lg font-semibold">{t("area.ux-labs.design-guide.sectionTitleTextLg")}</h2>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            {t("area.ux-labs.design-guide.sectionHeadingTextSm")}
          </h3>
          <p className="text-sm font-medium">{t("area.ux-labs.design-guide.cardTitleTextSm")}</p>
          <p className="text-sm font-semibold">{t("area.ux-labs.design-guide.cardTitleAltText")}</p>
          <p className="text-sm">{t("area.ux-labs.design-guide.bodyTextTextSm")}</p>
          <p className="text-sm text-muted-foreground">
            {t("area.ux-labs.design-guide.mutedDescriptionTextSm")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("area.ux-labs.design-guide.tinyLabelTextXs")}
          </p>
          <p className="text-sm font-mono text-muted-foreground">
            {t("area.ux-labs.design-guide.monoIdentifierTextSm")}
          </p>
          <p className="text-2xl font-bold">{t("area.ux-labs.design-guide.largeStatText2xl")}</p>
          <p className="font-mono text-xs">{t("area.ux-labs.design-guide.logCodeTextFont")}</p>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SPACING & RADIUS                                             */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.radius")}>
        <div className="flex items-end gap-4 flex-wrap">
          {[
            ["sm", "var(--radius-sm)"],
            ["md", "var(--radius-md)"],
            ["lg", "var(--radius-lg)"],
            ["xl", "var(--radius-xl)"],
            ["full", "9999px"],
          ].map(([label, radius]) => (
            <div key={label} className="flex flex-col items-center gap-1">
              <div
                className="h-12 w-12 bg-primary"
                style={{ borderRadius: radius }}
              />
              <span className="text-xs text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BUTTONS                                                      */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.buttons")}>
        <SubSection title={t("area.ux-labs.design-guide.variants")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="default">{t("area.ux-labs.design-guide.default")}</Button>
            <Button variant="secondary">{t("area.ux-labs.design-guide.secondary")}</Button>
            <Button variant="outline">{t("area.ux-labs.design-guide.outline")}</Button>
            <Button variant="ghost">{t("area.ux-labs.design-guide.ghost")}</Button>
            <Button variant="destructive">{t("area.ux-labs.design-guide.destructive")}</Button>
            <Button variant="link">{t("area.ux-labs.design-guide.link")}</Button>
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.sizes")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="xs">{t("area.ux-labs.design-guide.extraSmall")}</Button>
            <Button size="sm">{t("area.ux-labs.design-guide.small")}</Button>
            <Button size="default">{t("area.ux-labs.design-guide.default")}</Button>
            <Button size="lg">{t("area.ux-labs.design-guide.large")}</Button>
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.iconButtons")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" size="icon-xs"><Search /></Button>
            <Button variant="ghost" size="icon-sm"><Search /></Button>
            <Button variant="outline" size="icon"><Search /></Button>
            <Button variant="outline" size="icon-lg"><Search /></Button>
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.withIcons")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button><Plus /> {t("area.ux-labs.design-guide.newIssue")}</Button>
            <Button variant="outline"><Upload /> {t("area.ux-labs.design-guide.upload")}</Button>
            <Button variant="destructive"><Trash2 /> {t("area.ux-labs.design-guide.delete")}</Button>
            <Button size="sm"><Plus /> {t("area.ux-labs.design-guide.add")}</Button>
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.states")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Button disabled>{t("area.ux-labs.design-guide.disabled")}</Button>
            <Button variant="outline" disabled>{t("area.ux-labs.design-guide.disabledOutline")}</Button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  BADGES                                                       */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.badges")}>
        <SubSection title={t("area.ux-labs.design-guide.variants")}>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="default">{t("area.ux-labs.design-guide.default")}</Badge>
            <Badge variant="secondary">{t("area.ux-labs.design-guide.secondary")}</Badge>
            <Badge variant="outline">{t("area.ux-labs.design-guide.outline")}</Badge>
            <Badge variant="destructive">{t("area.ux-labs.design-guide.destructive")}</Badge>
            <Badge variant="ghost">{t("area.ux-labs.design-guide.ghost")}</Badge>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  STATUS BADGES & ICONS                                        */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.statusSystem")}>
        <SubSection title={t("area.ux-labs.design-guide.statusbadgeAllStatuses")}>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              "active", "running", "paused", "idle", "archived", "planned",
              "achieved", "completed", "failed", "timed_out", "succeeded", "error",
              "pending_approval", "backlog", "todo", "in_progress", "in_review", "blocked",
              "done", "terminated", "cancelled", "pending", "revision_requested",
              "approved", "rejected",
            ].map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.issuestatusbadgeBrandChipGlyph")}>
          <div className="flex items-center gap-2 flex-wrap">
            {["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"].map(
              (s) => (
                <IssueStatusBadge key={s} status={s} />
              )
            )}
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.statusiconInteractive")}>
          <div className="flex items-center gap-3 flex-wrap">
            {["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"].map(
              (s) => (
                <div key={s} className="flex items-center gap-1.5">
                  <StatusIcon status={s} />
                  <span className="text-xs text-muted-foreground">{s}</span>
                </div>
              )
            )}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <StatusIcon status={status} onChange={setStatus} />
            <span className="text-sm">Click the icon to change status (current: {status})</span>
          </div>
        </SubSection>

        {/* PAP-411: PriorityIcon showcase gated behind SHOW_TASK_PRIORITY_UI per board decision. */}
        {SHOW_TASK_PRIORITY_UI && (
        <SubSection title={t("area.ux-labs.design-guide.priorityiconInteractive")}>
          <div className="flex items-center gap-3 flex-wrap">
            {["critical", "high", "medium", "low"].map((p) => (
              <div key={p} className="flex items-center gap-1.5">
                <PriorityIcon priority={p} />
                <span className="text-xs text-muted-foreground">{p}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2">
            <PriorityIcon priority={priority} onChange={setPriority} />
            <span className="text-sm">Click the icon to change (current: {priority})</span>
          </div>
        </SubSection>
        )}

        <SubSection title={t("area.ux-labs.design-guide.agentStatusDots")}>
          <div className="flex items-center gap-4 flex-wrap">
            {(["running", "active", "paused", "error", "archived"] as const).map((label) => (
              <div key={label} className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className={`inline-flex h-full w-full rounded-full ${agentStatusDot[label] ?? agentStatusDotDefault}`} />
                </span>
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.runInvocationBadges")}>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              ["timer", "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"],
              ["assignment", "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"],
              ["on_demand", "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300"],
              ["automation", "bg-muted text-muted-foreground"],
            ].map(([label, cls]) => (
              <Badge variant="ghost" key={label} className={`px-1.5 text-(length:--text-nano) ${cls}`}>
                {label}
              </Badge>
            ))}
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.issuereferencepill")}>
          <p className="text-xs text-muted-foreground">
            <Trans
              i18nKey="area.ux-labs.design-guide.issueReferencePillNote"
              components={{
                c: <code className="font-mono" />,
              }}
            />
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <IssueReferencePill issue={{ id: "demo-1", identifier: "PAP-123", title: t("area.ux-labs.design-guide.identifierOnlyNoStatus") }} />
            <IssueReferencePill issue={{ id: "demo-2", identifier: "PAP-456", title: t("area.ux-labs.design-guide.withInProgressStatus"), status: "in_progress" }} />
            <IssueReferencePill issue={{ id: "demo-3", identifier: "PAP-789", title: t("area.ux-labs.design-guide.doneStatus"), status: "done" }} />
            <IssueReferencePill issue={{ id: "demo-4", identifier: "PAP-101", title: t("area.ux-labs.design-guide.blockedStatus"), status: "blocked" }} />
            <IssueReferencePill onRemove={() => window.alert(t("area.ux-labs.design-guide.blockerRemoved"))} issue={{ id: "demo-blocker", identifier: "PAP-303", title: t("area.ux-labs.design-guide.hoverOrFocusTo"), status: "in_review" }} />
            <IssueReferencePill strikethrough issue={{ id: "demo-5", identifier: "PAP-202", title: t("area.ux-labs.design-guide.removedStrikethrough"), status: "todo" }} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  AGENT CAPSULE                                                */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.agentCapsule")}>
        <p className="text-sm text-muted-foreground max-w-prose">
          <Trans
            i18nKey="area.ux-labs.design-guide.agentCapsuleNote"
            components={{
              c: <code className="font-mono" />,
            }}
          />
        </p>
        <SubSection title={t("area.ux-labs.design-guide.states")}>
          <div className="flex items-end gap-10">
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="slot" />
              <span className="text-xs text-muted-foreground">{t("area.ux-labs.design-guide.capsuleSlot")}</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="configured" />
              <span className="text-xs text-muted-foreground">{t("area.ux-labs.design-guide.capsuleConfigured")}</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" gradient={5} />
              <span className="text-xs text-muted-foreground">{t("area.ux-labs.design-guide.capsuleOnline")}</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" gradient={5} glow="blue" />
              <span className="text-xs text-muted-foreground">{t("area.ux-labs.design-guide.onlineBlueGlow")}</span>
            </div>
          </div>
        </SubSection>
        <SubSection title={t("area.ux-labs.design-guide.sizes")}>
          <div className="flex items-end gap-8">
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size="sm" gradient={1} />
              <span className="text-xs text-muted-foreground">sm</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size="md" gradient={4} />
              <span className="text-xs text-muted-foreground">md</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size="lg" gradient={8} />
              <span className="text-xs text-muted-foreground">lg</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <AgentCapsule state="online" size={{ width: 28, height: 96 }} gradient={6} />
              <span className="text-xs text-muted-foreground">{t("area.ux-labs.design-guide.customPx")}</span>
            </div>
          </div>
        </SubSection>
        <SubSection title={t("area.ux-labs.design-guide.gradients")}>
          <div className="flex items-end gap-3 flex-wrap">
            {Array.from({ length: AGENT_GRADIENT_COUNT }, (_, i) => (
              <div key={i} className="flex flex-col items-center gap-1.5">
                <AgentCapsule state="online" size="sm" gradient={i + 1} />
                <span className="text-(length:--text-nano) font-mono text-muted-foreground">{i + 1}</span>
              </div>
            ))}
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  FORM ELEMENTS                                                */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.formElements")}>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={t("area.ux-labs.design-guide.input")}>
            <Input placeholder={t("area.ux-labs.design-guide.defaultInput")} />
            <Input placeholder={t("area.ux-labs.design-guide.disabledInput")} disabled className="mt-2" />
          </SubSection>

          <SubSection title={t("area.ux-labs.design-guide.textarea")}>
            <Textarea placeholder={t("area.ux-labs.design-guide.writeSomething")} />
          </SubSection>

          <SubSection title={t("area.ux-labs.design-guide.checkboxLabel")}>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox id="check1" defaultChecked />
                <Label htmlFor="check1">{t("area.ux-labs.design-guide.checkedItem")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check2" />
                <Label htmlFor="check2">{t("area.ux-labs.design-guide.uncheckedItem")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="check3" disabled />
                <Label htmlFor="check3">{t("area.ux-labs.design-guide.disabledItem")}</Label>
              </div>
            </div>
          </SubSection>

          <SubSection title={t("area.ux-labs.design-guide.inlineEditor")}>
            <div className="space-y-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("area.ux-labs.design-guide.inlineTitleLabel")}</p>
                <InlineEditor
                  value={inlineTitle}
                  onSave={setInlineTitle}
                  as="h2"
                  className="text-xl font-bold"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("area.ux-labs.design-guide.inlineBodyLabel")}</p>
                <InlineEditor
                  value={inlineText}
                  onSave={setInlineText}
                  as="p"
                  className="text-sm"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("area.ux-labs.design-guide.inlineDescriptionLabel")}</p>
                <InlineEditor
                  value={inlineDesc}
                  onSave={setInlineDesc}
                  as="p"
                  className="text-sm text-muted-foreground"
                  placeholder={t("area.ux-labs.design-guide.addADescription")}
                  multiline
                />
              </div>
            </div>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SELECT                                                       */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.select")}>
        <div className="grid gap-6 md:grid-cols-2">
          <SubSection title={t("area.ux-labs.design-guide.defaultSize")}>
            <Select value={selectValue} onValueChange={setSelectValue}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("area.ux-labs.design-guide.selectStatus")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="backlog">{t("area.ux-labs.design-guide.backlog")}</SelectItem>
                <SelectItem value="todo">{t("area.ux-labs.design-guide.todo")}</SelectItem>
                <SelectItem value="in_progress">{t("area.ux-labs.design-guide.inProgress")}</SelectItem>
                <SelectItem value="in_review">{t("area.ux-labs.design-guide.inReview")}</SelectItem>
                <SelectItem value="done">{t("area.ux-labs.design-guide.done")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Current value: {selectValue}</p>
          </SubSection>
          <SubSection title={t("area.ux-labs.design-guide.smallTrigger")}>
            <Select defaultValue="high">
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="critical">{t("area.ux-labs.design-guide.critical")}</SelectItem>
                <SelectItem value="high">{t("area.ux-labs.design-guide.high")}</SelectItem>
                <SelectItem value="medium">{t("area.ux-labs.design-guide.medium")}</SelectItem>
                <SelectItem value="low">{t("area.ux-labs.design-guide.low")}</SelectItem>
              </SelectContent>
            </Select>
          </SubSection>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DROPDOWN MENU                                                */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.dropdownMenu")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t("area.ux-labs.design-guide.quickActions")}
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem>
              <Check className="h-4 w-4" />
              {t("area.ux-labs.design-guide.markAsDone")}
              <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <BookOpen className="h-4 w-4" />
              {t("area.ux-labs.design-guide.openDocs")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={menuChecked}
              onCheckedChange={(value) => setMenuChecked(value === true)}
            >
              {t("area.ux-labs.design-guide.watchIssue")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem variant="destructive">
              <Trash2 className="h-4 w-4" />
              {t("area.ux-labs.design-guide.deleteIssue")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      {/* ============================================================ */}
      {/*  POPOVER                                                      */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.popover")}>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">{t("area.ux-labs.design-guide.openPopover")}</Button>
          </PopoverTrigger>
          <PopoverContent className="space-y-2">
            <p className="text-sm font-medium">{t("area.ux-labs.design-guide.agentHeartbeat")}</p>
            <p className="text-xs text-muted-foreground">
              {t("area.ux-labs.design-guide.lastRunSucceeded24s")}
            </p>
            <Button size="xs">{t("area.ux-labs.design-guide.wakeNow")}</Button>
          </PopoverContent>
        </Popover>
      </Section>

      {/* ============================================================ */}
      {/*  COLLAPSIBLE                                                  */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.collapsible")}>
        <Collapsible open={collapsibleOpen} onOpenChange={setCollapsibleOpen} className="space-y-2">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">
              {collapsibleOpen ? t("area.ux-labs.design-guide.hide") : t("area.ux-labs.design-guide.show")} advanced filters
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="rounded-md border border-border p-3">
            <div className="space-y-2">
              <Label htmlFor="owner-filter">{t("area.ux-labs.design-guide.owner")}</Label>
              <Input id="owner-filter" placeholder={t("area.ux-labs.design-guide.filterByAgentName")} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Section>

      {/* ============================================================ */}
      {/*  SHEET                                                        */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.sheet")}>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm">{t("area.ux-labs.design-guide.openSidePanel")}</Button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>{t("area.ux-labs.design-guide.issueProperties")}</SheetTitle>
              <SheetDescription>{t("area.ux-labs.design-guide.editMetadataWithoutLeaving")}</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4">
              <div className="space-y-1">
                <Label htmlFor="sheet-title">{t("area.ux-labs.design-guide.title")}</Label>
                <Input id="sheet-title" defaultValue={t("area.ux-labs.design-guide.improveOnboardingDocs")} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sheet-description">{t("area.ux-labs.design-guide.description")}</Label>
                <Textarea id="sheet-description" defaultValue={t("area.ux-labs.design-guide.captureSetupPitfallsAnd")} />
              </div>
            </div>
            <SheetFooter>
              <Button variant="outline">{t("area.ux-labs.design-guide.cancel")}</Button>
              <Button>{t("area.ux-labs.design-guide.save")}</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </Section>

      {/* ============================================================ */}
      {/*  SCROLL AREA                                                  */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.scrollArea")}>
        <ScrollArea className="h-36 rounded-md border border-border">
          <div className="space-y-2 p-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-sm">
                Heartbeat run #{i + 1}: completed successfully
              </div>
            ))}
          </div>
        </ScrollArea>
      </Section>

      {/* ============================================================ */}
      {/*  COMMAND                                                      */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.commandCmdk")}>
        <div className="rounded-md border border-border">
          <Command>
            <CommandInput placeholder={t("area.ux-labs.design-guide.typeACommandOr")} />
            <CommandList>
              <CommandEmpty>{t("area.ux-labs.design-guide.noResultsFound")}</CommandEmpty>
              <CommandGroup heading={t("area.ux-labs.design-guide.pages")}>
                <CommandItem>
                  <LayoutDashboard className="h-4 w-4" />
                  {t("area.ux-labs.design-guide.dashboard")}
                </CommandItem>
                <CommandItem>
                  <CircleDot className="h-4 w-4" />
                  {t("area.ux-labs.design-guide.issues")}
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading={t("area.ux-labs.design-guide.actions")}>
                <CommandItem>
                  <CommandIcon className="h-4 w-4" />
                  {t("area.ux-labs.design-guide.openCommandPalette")}
                </CommandItem>
                <CommandItem>
                  <Plus className="h-4 w-4" />
                  {t("area.ux-labs.design-guide.createNewIssue")}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  BREADCRUMB                                                   */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.breadcrumb")}>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{t("area.ux-labs.design-guide.projects")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#">{t("area.ux-labs.design-guide.myrmidonApp")}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{t("area.ux-labs.design-guide.issueList")}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Section>

      {/* ============================================================ */}
      {/*  CARDS                                                        */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.cards")}>
        <SubSection title={t("area.ux-labs.design-guide.dashboardAgentRuns")}>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {["running", "queued", "succeeded", "failed", "timed_out", "cancelled", "interrupted"].map((status) => (
              <AgentRunCard
                key={status}
                companyId="design-guide"
                run={{
                  id: `design-guide-${status}`, agentId: "design-guide-agent", agentName: "CodexCoder",
                  status, adapterType: "codex_local", invocationSource: "on_demand", triggerDetail: "manual",
                  startedAt: null, finishedAt: null, createdAt: "2026-09-11T12:00:00Z", issueId: "design-guide-task",
                }}
                issue={{ identifier: "PAP-559", title: t("area.ux-labs.design-guide.recreateThisWireframeOn"), status: status === "succeeded" ? "done" : "in_progress" }}
              />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("area.ux-labs.design-guide.dashboardRunsNote")}</p>
        </SubSection>
        <SubSection title={t("area.ux-labs.design-guide.standardCard")}>
          <Card>
            <CardHeader>
              <CardTitle>{t("area.ux-labs.design-guide.cardTitle")}</CardTitle>
              <CardDescription>{t("area.ux-labs.design-guide.cardDescriptionWithSupporting")}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{t("area.ux-labs.design-guide.cardContentGoesHere")}</p>
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm">{t("area.ux-labs.design-guide.action")}</Button>
              <Button variant="outline" size="sm">{t("area.ux-labs.design-guide.cancel")}</Button>
            </CardFooter>
          </Card>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.metricCards")}>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
            <MetricCard icon={Bot} value={12} label={t("area.ux-labs.design-guide.activeAgents")} description={t("area.ux-labs.design-guide.n3ThisWeek")} />
            <MetricCard icon={CircleDot} value={48} label={t("area.ux-labs.design-guide.openIssues")} />
            <MetricCard icon={DollarSign} value="$1,234" label={t("area.ux-labs.design-guide.monthlyCost")} description={t("area.ux-labs.design-guide.underBudget")} />
            <MetricCard icon={Zap} value="99.9%" label={t("area.ux-labs.design-guide.uptime")} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TABS                                                         */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.tabs")}>
        <SubSection title={t("area.ux-labs.design-guide.defaultPillVariant")}>
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">{t("area.ux-labs.design-guide.overview")}</TabsTrigger>
              <TabsTrigger value="runs">{t("area.ux-labs.design-guide.runs")}</TabsTrigger>
              <TabsTrigger value="config">{t("area.ux-labs.design-guide.config")}</TabsTrigger>
              <TabsTrigger value="costs">{t("area.ux-labs.design-guide.costs")}</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <p className="text-sm text-muted-foreground py-4">{t("area.ux-labs.design-guide.overviewTabContent")}</p>
            </TabsContent>
            <TabsContent value="runs">
              <p className="text-sm text-muted-foreground py-4">{t("area.ux-labs.design-guide.runsTabContent")}</p>
            </TabsContent>
            <TabsContent value="config">
              <p className="text-sm text-muted-foreground py-4">{t("area.ux-labs.design-guide.configTabContent")}</p>
            </TabsContent>
            <TabsContent value="costs">
              <p className="text-sm text-muted-foreground py-4">{t("area.ux-labs.design-guide.costsTabContent")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.lineVariant")}>
          <Tabs defaultValue="summary">
            <TabsList variant="line">
              <TabsTrigger value="summary">{t("area.ux-labs.design-guide.summary")}</TabsTrigger>
              <TabsTrigger value="details">{t("area.ux-labs.design-guide.details")}</TabsTrigger>
              <TabsTrigger value="comments">{t("area.ux-labs.design-guide.comments")}</TabsTrigger>
            </TabsList>
            <TabsContent value="summary">
              <p className="text-sm text-muted-foreground py-4">{t("area.ux-labs.design-guide.summaryContentWithUnderline")}</p>
            </TabsContent>
            <TabsContent value="details">
              <p className="text-sm text-muted-foreground py-4">{t("area.ux-labs.design-guide.detailsContent")}</p>
            </TabsContent>
            <TabsContent value="comments">
              <p className="text-sm text-muted-foreground py-4">{t("area.ux-labs.design-guide.commentsContent")}</p>
            </TabsContent>
          </Tabs>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  ENTITY ROWS                                                  */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.entityRows")}>
        <div className="border border-border rounded-md">
          <EntityRow
            leading={
              <>
                <StatusIcon status="in_progress" />
                {/* PAP-411: PriorityIcon hidden behind SHOW_TASK_PRIORITY_UI. */}
                {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority="high" />}
              </>
            }
            identifier="PAP-001"
            title={t("area.ux-labs.design-guide.implementAuthenticationFlow")}
            subtitle={t("area.ux-labs.design-guide.responsibleAgentAlpha")}
            trailing={<IssueStatusBadge status="in_progress" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="done" />
                {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority="medium" />}
              </>
            }
            identifier="PAP-002"
            title={t("area.ux-labs.design-guide.setUpCiCd")}
            subtitle={t("area.ux-labs.design-guide.completed2DaysAgo")}
            trailing={<IssueStatusBadge status="done" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="todo" />
                {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority="low" />}
              </>
            }
            identifier="PAP-003"
            title={t("area.ux-labs.design-guide.writeApiDocumentation")}
            trailing={<IssueStatusBadge status="todo" />}
            onClick={() => {}}
          />
          <EntityRow
            leading={
              <>
                <StatusIcon status="blocked" />
                {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority="critical" />}
              </>
            }
            identifier="PAP-004"
            title={t("area.ux-labs.design-guide.deployToProduction")}
            subtitle={t("area.ux-labs.design-guide.blockedByPap001")}
            trailing={<IssueStatusBadge status="blocked" />}
            selected
          />
        </div>
        <SubSection title={t("area.ux-labs.design-guide.membershipAction")}>
          <div className="border border-border rounded-md">
            <EntityRow
              title={t("area.ux-labs.design-guide.joinedResource")}
              subtitle={t("area.ux-labs.design-guide.hoverOrFocusThe")}
              className="group"
              trailing={
                <MembershipAction
                  state="joined"
                  resourceName={t("area.ux-labs.design-guide.joinedResource")}
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title={t("area.ux-labs.design-guide.leftResource")}
              subtitle={t("area.ux-labs.design-guide.persistentActionWithDimmed")}
              className="group text-foreground/55"
              trailing={
                <MembershipAction
                  state="left"
                  resourceName={t("area.ux-labs.design-guide.leftResource")}
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title={t("area.ux-labs.design-guide.leavingResource")}
              subtitle={t("area.ux-labs.design-guide.disabledWhileTheOptimistic")}
              className="group text-foreground/55"
              trailing={
                <MembershipAction
                  state="left"
                  pending
                  pendingState="left"
                  resourceName={t("area.ux-labs.design-guide.leavingResource")}
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
            <EntityRow
              title={t("area.ux-labs.design-guide.joiningResource")}
              subtitle={t("area.ux-labs.design-guide.theTargetStateIs")}
              className="group"
              trailing={
                <MembershipAction
                  state="joined"
                  pending
                  pendingState="joined"
                  resourceName={t("area.ux-labs.design-guide.joiningResource")}
                  onJoin={() => {}}
                  onLeave={() => {}}
                />
              }
            />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  FILTER BAR                                                   */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.filterBar")}>
        <FilterBar
          filters={filters}
          onRemove={(key) => setFilters((f) => f.filter((x) => x.key !== key))}
          onClear={() => setFilters([])}
        />
        {filters.length === 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setFilters([
                { key: "status", label: t("area.ux-labs.design-guide.status"), value: t("area.ux-labs.design-guide.active") },
                // PAP-411: priority filter demo row suppressed while SHOW_TASK_PRIORITY_UI is off.
                ...(SHOW_TASK_PRIORITY_UI
                  ? [{ key: "priority", label: t("area.ux-labs.design-guide.priority"), value: t("area.ux-labs.design-guide.high") } as FilterValue]
                  : []),
              ])
            }
          >
            {t("area.ux-labs.design-guide.resetFilters")}
          </Button>
        )}
      </Section>

      {/* ============================================================ */}
      {/*  AVATARS                                                      */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.avatars")}>
        <SubSection title={t("area.ux-labs.design-guide.sizes")}>
          <div className="flex items-center gap-3">
            <Avatar size="sm"><AvatarFallback>{`SM`}</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>{`DF`}</AvatarFallback></Avatar>
            <Avatar size="lg"><AvatarFallback>{`LG`}</AvatarFallback></Avatar>
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.group")}>
          <AvatarGroup>
            <Avatar><AvatarFallback>A1</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>A2</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>A3</AvatarFallback></Avatar>
            <AvatarGroupCount>+5</AvatarGroupCount>
          </AvatarGroup>
        </SubSection>
      </Section>

      <Section title={t("area.ux-labs.design-guide.appLogos")}>
        <SubSection title={t("area.ux-labs.design-guide.officialMarksAndRuntime")}>
          <div className="flex items-center gap-3">
            <AppLogo
              name="Notion"
              logoUrl="/brands/apps/notion.svg"
              darkLogoUrl="/brands/apps/notion-dark.svg"
              size={36}
            />
            <AppLogo name="Jira" logoUrl="/brands/apps/jira.svg" darkLogoUrl="/brands/apps/jira-dark.svg" size={44} />
            <AppLogo name="Fallback" logoUrl="/brands/apps/does-not-exist.svg" size={36} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  IDENTITY                                                     */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.identity")}>
        <SubSection title={t("area.ux-labs.design-guide.sizes")}>
          <div className="flex items-center gap-6">
            <Identity name="Agent Alpha" size="sm" />
            <Identity name="Agent Alpha" />
            <Identity name="Agent Alpha" size="lg" />
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.initialsDerivation")}>
          <div className="flex flex-col gap-2">
            <Identity name="CEO Agent" size="sm" />
            <Identity name="Alpha" size="sm" />
            <Identity name="Quality Assurance Lead" size="sm" />
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.customInitials")}>
          <Identity name="Backend Service" initials="BS" size="sm" />
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TOOLTIPS                                                     */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.tooltips")}>
        <div className="flex items-center gap-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm">{t("area.ux-labs.design-guide.hoverMe")}</Button>
            </TooltipTrigger>
            <TooltipContent>{t("area.ux-labs.design-guide.thisIsATooltip")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm"><Settings /></Button>
            </TooltipTrigger>
            <TooltipContent>{t("area.ux-labs.design-guide.settings")}</TooltipContent>
          </Tooltip>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  DIALOG                                                       */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.dialog")}>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">{t("area.ux-labs.design-guide.openDialog")}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("area.ux-labs.design-guide.dialogTitle")}</DialogTitle>
              <DialogDescription>
                {t("area.ux-labs.design-guide.dialogSample")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>{t("area.ux-labs.design-guide.name")}</Label>
                <Input placeholder={t("area.ux-labs.design-guide.enterAName")} className="mt-1.5" />
              </div>
              <div>
                <Label>{t("area.ux-labs.design-guide.description")}</Label>
                <Textarea placeholder={t("area.ux-labs.design-guide.describe")} className="mt-1.5" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline">{t("area.ux-labs.design-guide.cancel")}</Button>
              <Button>{t("area.ux-labs.design-guide.save")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Section>

      {/* ============================================================ */}
      {/*  EMPTY STATE                                                  */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.emptyState")}>
        <div className="border border-border rounded-md">
          <EmptyState
            icon={Inbox}
            message={t("area.ux-labs.design-guide.noItemsToShow")}
            action={t("area.ux-labs.design-guide.createItem")}
            onAction={() => {}}
          />
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROGRESS BARS                                                */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.progressBarsBudget")}>
        <div className="space-y-3">
          {[
            { label: t("area.ux-labs.design-guide.underBudget40"), pct: 40, color: "bg-green-400" },
            { label: t("area.ux-labs.design-guide.warning75"), pct: 75, color: "bg-yellow-400" },
            { label: t("area.ux-labs.design-guide.overBudget95"), pct: 95, color: "bg-red-400" },
          ].map(({ label, pct, color }) => (
            <div key={label} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{label}</span>
                <span className="text-xs font-mono">{pct}%</span>
              </div>
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-(--tp-width-background-color) duration-150 ${color}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  LOG VIEWER                                                   */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.logViewer")}>
        <div className="bg-neutral-950 rounded-lg p-3 font-mono text-xs max-h-80 overflow-y-auto">
          <div className="text-foreground">{`[12:00:01] INFO Agent started successfully`}</div>
          <div className="text-foreground">{`[12:00:02] INFO Processing task PAP-001`}</div>
          <div className="text-yellow-400">{`[12:00:05] WARN  Rate limit approaching (80%)`}</div>
          <div className="text-foreground">{`[12:00:08] INFO Task PAP-001 completed`}</div>
          <div className="text-red-400">{`[12:00:12] ERROR Connection timeout to upstream service`}</div>
          <div className="text-blue-300">{`[12:00:12] SYS Retrying connection in 5s...`}</div>
          <div className="text-foreground">{`[12:00:17] INFO Reconnected successfully`}</div>
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 animate-pulse" />
              <span className="inline-flex h-full w-full rounded-full bg-blue-500" />
            </span>
            <span className="text-blue-600 dark:text-blue-400">{t("area.ux-labs.design-guide.live")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  PROPERTY ROW PATTERN                                         */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.propertyRowPattern")}>
        <div className="border border-border rounded-md p-4 space-y-1 max-w-sm">
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{t("area.ux-labs.design-guide.status")}</span>
            <StatusBadge status="active" />
          </div>
          {/* PAP-411: priority metadata row hidden behind SHOW_TASK_PRIORITY_UI. */}
          {SHOW_TASK_PRIORITY_UI && (
            <div className="flex items-center justify-between py-1.5">
              <span className="text-xs text-muted-foreground">{t("area.ux-labs.design-guide.priority")}</span>
              <PriorityIcon priority="high" />
            </div>
          )}
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{t("area.ux-labs.design-guide.responsible")}</span>
            <div className="flex items-center gap-1.5">
              <Avatar size="sm"><AvatarFallback>A</AvatarFallback></Avatar>
              <span className="text-xs">{t("area.ux-labs.design-guide.agentAlpha")}</span>
            </div>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-xs text-muted-foreground">{t("area.ux-labs.design-guide.created")}</span>
            <span className="text-xs">Jan 15, 2025</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  NAVIGATION PATTERNS                                          */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.navigationPatterns")}>
        <SubSection title={t("area.ux-labs.design-guide.agentChatPicker")}>
          <AgentChatPickerExample />
        </SubSection>
        <SubSection title={t("area.ux-labs.design-guide.sidebarNavItems")}>
          <p className="text-sm text-muted-foreground">
            {t("area.ux-labs.design-guide.sidebarNavNote")}
          </p>
          <Card className="block w-60 p-3 space-y-0.5">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-accent text-accent-foreground">
              <LayoutDashboard className="h-4 w-4" />
              {t("area.ux-labs.design-guide.dashboard")}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <CircleDot className="h-4 w-4" />
              {t("area.ux-labs.design-guide.issues")}
              <Badge variant="ghost" className="ml-auto bg-primary text-primary-foreground px-1.5">
                12
              </Badge>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Bot className="h-4 w-4" />
              {t("area.ux-labs.design-guide.agents")}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground cursor-pointer">
              <Hexagon className="h-4 w-4" />
              {t("area.ux-labs.design-guide.projects")}
            </div>
          </Card>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.viewToggle")}>
          <div className="flex items-center border border-border rounded-md w-fit">
            <button className="px-3 py-1.5 text-xs font-medium bg-accent text-foreground rounded-l-md">
              <ListTodo className="h-3.5 w-3.5 inline mr-1" />
              {t("area.ux-labs.design-guide.list")}
            </button>
            <button className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50 rounded-r-md">
              <Target className="h-3.5 w-3.5 inline mr-1" />
              {t("area.ux-labs.design-guide.org")}
            </button>
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  GROUPED LIST (Issues pattern)                                */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.groupedListIssuesPattern")}>
        <div>
          <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 rounded-t-md">
            <StatusIcon status="in_progress" />
            <span className="text-sm font-medium">{t("area.ux-labs.design-guide.inProgress")}</span>
            <span className="text-xs text-muted-foreground ml-1">2</span>
          </div>
          <div className="border border-border rounded-b-md">
            {/* PAP-411: leading PriorityIcon hidden behind SHOW_TASK_PRIORITY_UI. */}
            <EntityRow
              leading={SHOW_TASK_PRIORITY_UI ? <PriorityIcon priority="high" /> : undefined}
              identifier="PAP-101"
              title={t("area.ux-labs.design-guide.buildAgentHeartbeatSystem")}
              onClick={() => {}}
            />
            <EntityRow
              leading={SHOW_TASK_PRIORITY_UI ? <PriorityIcon priority="medium" /> : undefined}
              identifier="PAP-102"
              title={t("area.ux-labs.design-guide.addCostTrackingDashboard")}
              onClick={() => {}}
            />
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COMMENT THREAD PATTERN                                       */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.commentThreadPattern")}>
        <div className="space-y-3 max-w-2xl">
          <h3 className="text-sm font-semibold">{t("area.ux-labs.design-guide.commentsCount")}</h3>
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{t("area.ux-labs.design-guide.agent")}</span>
                <span className="text-xs text-muted-foreground">Jan 15, 2025</span>
              </div>
              <p className="text-sm">{t("area.ux-labs.design-guide.startedWorkingOnThe")}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-muted-foreground">{t("area.ux-labs.design-guide.human")}</span>
                <span className="text-xs text-muted-foreground">Jan 16, 2025</span>
              </div>
              <p className="text-sm">{t("area.ux-labs.design-guide.apiKeysHaveBeen")}</p>
            </div>
          </div>
          <div className="space-y-2">
            <Textarea placeholder={t("area.ux-labs.design-guide.leaveAComment")} rows={3} />
            <Button size="sm">{t("area.ux-labs.design-guide.comment")}</Button>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  COST TABLE PATTERN                                           */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.costTablePattern")}>
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-accent/20">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t("area.ux-labs.design-guide.model")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t("area.ux-labs.design-guide.tokens")}</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t("area.ux-labs.design-guide.cost")}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className="px-3 py-2">{`claude-sonnet-4-20250514`}</td>
                <td className="px-3 py-2 font-mono">1.2M</td>
                <td className="px-3 py-2 font-mono">$18.00</td>
              </tr>
              <tr className="border-b border-border">
                <td className="px-3 py-2">{`claude-haiku-4-20250506`}</td>
                <td className="px-3 py-2 font-mono">500k</td>
                <td className="px-3 py-2 font-mono">$1.25</td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-medium">{t("area.ux-labs.design-guide.total")}</td>
                <td className="px-3 py-2 font-mono">1.7M</td>
                <td className="px-3 py-2 font-mono font-medium">$19.25</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  SKELETONS                                                    */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.skeletons")}>
        <SubSection title={t("area.ux-labs.design-guide.individual")}>
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-8 w-full max-w-sm" />
            <Skeleton className="h-20 w-full" />
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.pageSkeletonList")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="list" />
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.pageSkeletonDetail")}>
          <div className="border border-border rounded-md p-4">
            <PageSkeleton variant="detail" />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  SEPARATOR                                                    */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.separator")}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("area.ux-labs.design-guide.horizontal")}</p>
          <Separator />
          <div className="flex items-center gap-4 h-8">
            <span className="text-sm">{t("area.ux-labs.design-guide.left")}</span>
            <Separator orientation="vertical" />
            <span className="text-sm">{t("area.ux-labs.design-guide.right")}</span>
          </div>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  ICON REFERENCE                                               */}
      {/* ============================================================ */}
      {/*  TEAM CATALOG                                                 */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.teamCatalog")}>
        <p className="text-sm text-muted-foreground">
          <Trans
            i18nKey="area.ux-labs.design-guide.teamCatalogNote"
            components={{
              c: <code className="font-mono text-xs" />,
            }}
          />
        </p>

        <SubSection title={t("area.ux-labs.design-guide.teamrowBrowseList")}>
          <div className="w-(--sz-28rem) rounded-md border border-border">
            <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
              {t("area.ux-labs.design-guide.bundled1")}
            </div>
            <TeamRow team={sampleTeam} selected onSelect={() => {}} />
            <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
              {t("area.ux-labs.design-guide.optional2")}
            </div>
            <TeamRow team={optionalTeam} selected={false} onSelect={() => {}} />
            <div className="px-3 py-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
              {t("area.ux-labs.design-guide.installed2")}
            </div>
            <TeamRow team={sampleTeam} selected={false} onSelect={() => {}} installed={outOfDateInstalledState} />
            <TeamRow team={warnTeam} selected={false} onSelect={() => {}} installed={currentInstalledState} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            <Trans
              i18nKey="area.ux-labs.design-guide.teamRowNote"
              components={{
                c: <code className="font-mono" />,
              }}
            />
          </p>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.teamcardOnboardingGrid")}>
          <p className="text-xs text-muted-foreground">
            <Trans
              i18nKey="area.ux-labs.design-guide.teamCardNote"
              components={{
                c: <code className="font-mono" />,
              }}
            />
          </p>
          <TeamCardShowcase />
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.teamhierarchypreview")}>
          <div className="max-w-md">
            <TeamHierarchyPreview team={sampleTeam} />
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.requiredskillslist")}>
          <div className="max-w-xl">
            <RequiredSkillsList skills={sampleTeam.requiredSkills} />
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.envinputslist")}>
          <div className="max-w-xl">
            <EnvInputsList inputs={sampleTeam.envInputs} />
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.externalsourceslist")}>
          <div className="max-w-xl">
            <ExternalSourcesList sources={sampleTeam.sourceRefs} />
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.sourcePolicyStepStepsourcepolicy")}>
          <div className="max-w-xl rounded-md border border-border p-4">
            <StepSourcePolicy
              team={warnTeam}
              allowExternalSources={allowExternal}
              allowUnpinnedOptionalSources={allowUnpinned}
              allowLocalPathSources={allowLocalPath}
              onChange={(key, value) => {
                if (key === "external") setAllowExternal(value);
                if (key === "unpinned") setAllowUnpinned(value);
                if (key === "localPath") setAllowLocalPath(value);
              }}
            />
          </div>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.skillPlanStepStepskillplan")}>
          <div className="max-w-xl rounded-md border border-border p-4">
            <StepSkillPlan team={sampleTeam} preparations={sampleSkillPreparations} />
          </div>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.commonIconsLucide")}>
        <div className="grid grid-cols-4 md:grid-cols-6 gap-4">
          {[
            ["Inbox", Inbox],
            ["ListTodo", ListTodo],
            ["CircleDot", CircleDot],
            ["Hexagon", Hexagon],
            ["Target", Target],
            ["LayoutDashboard", LayoutDashboard],
            ["Bot", Bot],
            ["DollarSign", DollarSign],
            ["History", History],
            ["Search", Search],
            ["Plus", Plus],
            ["Trash2", Trash2],
            ["Settings", Settings],
            ["User", User],
            ["Mail", Mail],
            ["Upload", Upload],
            ["Zap", Zap],
          ].map(([name, Icon]) => {
            const LucideIcon = Icon as React.FC<{ className?: string }>;
            return (
              <div key={name as string} className="flex flex-col items-center gap-1.5 p-2">
                <LucideIcon className="h-4 w-4 text-muted-foreground" />
                <span className="text-(length:--text-nano) text-muted-foreground font-mono">{name as string}</span>
              </div>
            );
          })}
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  KEYBOARD SHORTCUTS                                           */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.keyboardShortcuts")}>
        <div className="border border-border rounded-md divide-y divide-border text-sm">
          {[
            ["Cmd+K / Ctrl+K", t("area.ux-labs.design-guide.openCommandPalette2")],
            ["C", t("area.ux-labs.design-guide.newIssueOutsideInputs")],
            ["[", t("area.ux-labs.design-guide.toggleSidebar")],
            ["]", t("area.ux-labs.design-guide.togglePropertiesPanel")],

            ["Cmd+Enter / Ctrl+Enter", t("area.ux-labs.design-guide.submitMarkdownComment")],
          ].map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between px-4 py-2">
              <span className="text-muted-foreground">{desc}</span>
              <kbd className="px-2 py-0.5 text-xs font-mono bg-muted rounded border border-border">
                {key}
              </kbd>
            </div>
          ))}
        </div>
      </Section>

      <Section title={t("area.ux-labs.design-guide.issueOutputSurface")}>
        <SubSection title={t("area.ux-labs.design-guide.multipleOutputsPrimaryVideo")}>
          <IssueOutputSection workProducts={DESIGN_GUIDE_OUTPUTS} />
        </SubSection>
        <SubSection title={t("area.ux-labs.design-guide.degradedOutputInvalidFailed")}>
          <IssueOutputSection workProducts={DESIGN_GUIDE_DEGRADED_OUTPUTS} />
        </SubSection>
        <SubSection title={t("area.ux-labs.design-guide.emptyState2")}>
          <p className="text-xs text-muted-foreground">
            {t("area.ux-labs.design-guide.outputEmptyNote")}
          </p>
        </SubSection>
      </Section>

      {/* ============================================================ */}
      {/*  TOOLS & ACCESS (PAP-10389)                                   */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.toolsAccess")}>
        <SubSection title={t("area.ux-labs.design-guide.enforcementbannerDefaultDeniedDetected")}>
          <div className="space-y-3">
            <EnforcementBanner companyId="" forceVariant="default" recentDenialCount={0} />
            <EnforcementBanner companyId="" forceVariant="denied-detected" recentDenialCount={3} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            <Trans
              i18nKey="area.ux-labs.design-guide.enforcementBannerNote"
              components={{
                c: <code />,
              }}
            />
          </p>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.enforcementbannerPresentationalTonesInfo")}>
          <div className="space-y-3">
            <EnforcementBanner
              tone="info"
              title={t("area.ux-labs.design-guide.effectiveAccessServerResolved")}
              body={t("area.ux-labs.design-guide.thisIsExactlyWhat")}
            />
            <EnforcementBanner
              tone="warning"
              title={t("area.ux-labs.design-guide.localStdioIsLocal")}
              body={t("area.ux-labs.design-guide.aLocalStdioSlot")}
            />
            <EnforcementBanner
              tone="error"
              title={t("area.ux-labs.design-guide.runtimeFailedClosed")}
              body={t("area.ux-labs.design-guide.theSupervisorIsRestarting")}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            <Trans
              i18nKey="area.ux-labs.design-guide.enforcementBanner.presentationalNote"
              components={{
                c: <code />,
              }}
            />
          </p>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.actionApprovalCardPending")}>
          <div className="grid gap-4 lg:grid-cols-2">
            <ActionCard
              toolName="slack.post_message"
              risk="medium"
              isWrite
              binding={{
                application: "Slack",
                manifestVersion: "2.4.1",
                connection: "https://slack.com/api · acme-workspace",
                catalogSha256: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                payloadSha256: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
              }}
              input={{ channel: "#launch", text: t("area.ux-labs.design-guide.deployV2IsLive"), unfurl_links: false }}
              reason={t("area.ux-labs.design-guide.thisToolCanWrite")}
              policyNumber={7}
              expiresInLabel={t("area.ux-labs.design-guide.expiresIn23h")}
            />
            <ActionCard
              variant="stale"
              toolName="slack.post_message"
              risk="medium"
              isWrite
              binding={{
                application: "Slack",
                manifestVersion: "2.4.1",
                connection: "https://slack.com/api · acme-workspace",
                catalogSha256: "sha256:7d793037a0760186574b0282f2f435e7a4b1b2b0b822cd15d6c15b0f00a0e3f1",
                previousCatalogSha256: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                payloadSha256: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
              }}
              input={{ channel: "#launch", text: t("area.ux-labs.design-guide.deployV2IsLive"), unfurl_links: false }}
              reason={t("area.ux-labs.design-guide.thisToolCanWrite")}
              policyNumber={7}
              expiresInLabel={t("area.ux-labs.design-guide.expiresIn18h")}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            <Trans
              i18nKey="area.ux-labs.design-guide.actionCardNote"
              components={{
                c: <code />,
              }}
            />
          </p>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.actionApprovalCardMobile")}>
          <div className="w-(--sz-390px) max-w-full rounded-xl border border-border bg-background p-3">
            <ActionCardMobile
              toolName="slack.post_message"
              risk="medium"
              isWrite
              binding={{
                application: "Slack",
                manifestVersion: "2.4.1",
                connection: "https://slack.com/api · acme-workspace",
                catalogSha256: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                payloadSha256: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
              }}
              input={{ channel: "#launch", text: t("area.ux-labs.design-guide.deployV2IsLive") }}
              reason={t("area.ux-labs.design-guide.thisToolCanWrite")}
              policyNumber={7}
              expiresInLabel={t("area.ux-labs.design-guide.expiresIn23h")}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("area.ux-labs.design-guide.actionCardMobileNote")}
          </p>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.bindingstableReusedInThe")}>
          <BindingsTable
            rows={[
              { label: t("area.ux-labs.design-guide.application"), value: "Slack · manifest v2.4.1" },
              { label: t("area.ux-labs.design-guide.connection"), value: "https://slack.com/api · acme-workspace", mono: true },
              { label: t("area.ux-labs.design-guide.catalog"), value: "sha256:9f86d081…f00a08", mono: true },
              { label: t("area.ux-labs.design-guide.payload"), value: "sha256:2c26b46b…66e7ae", mono: true },
            ]}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            <Trans
              i18nKey="area.ux-labs.design-guide.bindingsTableNote"
              components={{
                c: <code />,
              }}
            />
          </p>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.toolAccessStatusKeys")}>
          <div className="flex flex-wrap items-center gap-2">
            {[
              "allowed", "denied", "block", "require-approval", "redacted", "rate-limit",
              "deferred", "hidden", "quarantined", "healthy", "degraded", "runtime-error", "unchecked",
            ].map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            <Trans
              i18nKey="area.ux-labs.design-guide.toolAccessStatusNote"
              components={{
                c: <code />,
              }}
            />
          </p>
        </SubSection>

        <SubSection title={t("area.ux-labs.design-guide.emptystateCanonicalWithDescription")}>
          <EmptyState
            icon={Inbox}
            message={t("area.ux-labs.design-guide.noConnectionsYet")}
            description={t("area.ux-labs.design-guide.addAConnectionTo")}
            action={t("area.ux-labs.design-guide.newConnection")}
            onAction={() => {}}
          />
        </SubSection>
      </Section>

      <Section title={t("area.ux-labs.design-guide.composioServices")}>
        <p className="text-sm text-muted-foreground">
          <Trans
            i18nKey="area.ux-labs.design-guide.composioNote"
            components={{
              c: <code />,
            }}
          />
        </p>
        <SubSection title={t("area.ux-labs.design-guide.rowStates")}>
          <ServicesList
            rows={DESIGN_GUIDE_COMPOSIO_ROWS}
            busySlug={null}
            onConnect={() => {}}
            onRecheck={() => {}}
            onDisconnect={() => {}}
          />
        </SubSection>
        <SubSection title={t("area.ux-labs.design-guide.busyRow")}>
          <ServicesList
            rows={[DESIGN_GUIDE_COMPOSIO_ROWS[2]!]}
            busySlug={DESIGN_GUIDE_COMPOSIO_ROWS[2]!.toolkitSlug}
            onConnect={() => {}}
            onRecheck={() => {}}
            onDisconnect={() => {}}
          />
        </SubSection>
        <SubSection title={t("area.ux-labs.design-guide.provenanceChip")}>
          <p className="mb-2 text-xs text-muted-foreground">
            {t("area.ux-labs.design-guide.provenanceNote")}
          </p>
          <div className="flex items-center gap-3">
            <ComposioProvenanceChip
              connection={{
                config: { provider: "composio", parentConnectionId: "parent-1", toolkitSlug: "github" },
              }}
            />
            <ComposioProvenanceChip
              connection={{ config: { provider: "composio", toolkitSlug: "gmail" } }}
            />
          </div>
        </SubSection>
      </Section>

      <Section title={t("area.ux-labs.design-guide.sourceRepositories")}>
        <SubSection title={t("area.ux-labs.design-guide.emptyAndDisconnected")}>
          <RepositoryEditor selected={[]} onChange={() => {}} state="disconnected" onConnect={() => {}} onRetry={() => {}} />
        </SubSection>
        <SubSection title={t("area.ux-labs.design-guide.selectedAndSearchable")}>
          <RepositoryEditor selected={[{ id: "1", fullName: "paperclipai/paperclip", url: "https://github.com/paperclipai/paperclip", connections: [t("area.ux-labs.design-guide.yourGithub")] }]}
            available={[{ id: "2", fullName: "paperclipai/docs", url: "https://github.com/paperclipai/docs", connections: [t("area.ux-labs.design-guide.companyGithub")] }]}
            onChange={() => {}} onConnect={() => {}} onRetry={() => {}} />
        </SubSection>
        <p className="text-sm text-muted-foreground">{t("area.ux-labs.design-guide.repositoriesNote")}</p>
      </Section>

      <Section title={t("area.ux-labs.design-guide.environmentVariablesEditor")}>
        <p className="text-sm text-muted-foreground">
          <Trans
            i18nKey="area.ux-labs.design-guide.envEditorNote"
            components={{
              m: <span className="font-mono" />,
            }}
          />
        </p>
        <EnvironmentVariablesEditorShowcase />
      </Section>

      <Section title={t("area.ux-labs.design-guide.tasksCreatedFromA")}>
        <SubSection title={t("area.ux-labs.design-guide.subtasksAndCreatedWork")}>
          <div className="max-w-xl">
            <TaskDetailTasksPanel
              subtasks={[DESIGN_GUIDE_TASK]}
              createdTasks={[
                { ...DESIGN_GUIDE_TASK, projectId: "design-board", project: { id: "design-board", name: t("area.ux-labs.design-guide.boardUi") } as Issue["project"] },
                { ...DESIGN_GUIDE_TASK, id: "design-followup", identifier: "PAP-428", title: t("area.ux-labs.design-guide.writeReleaseNotes"), status: "todo", projectId: null },
              ]}
              projects={[]}
            />
          </div>
        </SubSection>
        <SubSection title={t("area.ux-labs.design-guide.emptyLoadingAndFailed")}>
          <TaskDetailTasksPanel subtasks={[]} createdTasks={[]} projects={[]} />
          <TaskDetailTasksPanel subtasks={[]} createdTasks={[]} projects={[]} isLoading />
          <TaskDetailTasksPanel subtasks={[]} createdTasks={[]} projects={[]} hasError onRetry={() => {}} />
        </SubSection>
      </Section>

      <Section title={t("area.ux-labs.design-guide.executionRecovery")}>
        <p className="text-sm text-muted-foreground">
          {t("area.ux-labs.design-guide.recoveryNote")}
        </p>
      </Section>

      <Section title={t("area.ux-labs.design-guide.savedProviderApiKeys")}>
        <SavedProviderKeySelect options={[{ id: "example", label: t("area.ux-labs.design-guide.claudeApiKeyYour"), binding: { type: "user_secret_ref", key: "ANTHROPIC_API_KEY", version: "latest" } }]} value="example" onChange={() => {}} loading={false} error={false} />
        <SavedProviderKeySelect options={[]} value="" onChange={() => {}} loading error={false} />
        <SavedProviderKeySelect options={[]} value="" onChange={() => {}} loading={false} error />
      </Section>

      <Section title={t("area.ux-labs.design-guide.connectionIntent")}>
        <p className="text-sm text-muted-foreground">
          {t("area.ux-labs.design-guide.connectionIntentNote")}
        </p>
        <div className="grid gap-4 xl:grid-cols-3">
          <IssueThreadInteractionCard
            interaction={pendingConnectionIntentInteraction}
            currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          />
          <IssueThreadInteractionCard
            interaction={retryConnectionIntentInteraction}
            currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          />
          <IssueThreadInteractionCard
            interaction={connectedConnectionIntentInteraction}
            currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          />
        </div>
      </Section>

      <Section title={t("area.ux-labs.design-guide.resizablePanels")}>
        <p className="text-sm text-muted-foreground">
          <Trans
            i18nKey="area.ux-labs.design-guide.resizablePanelsNote"
            components={{
              m: <span className="font-mono" />,
            }}
          />
        </p>
        <div className="h-48 max-w-2xl overflow-hidden rounded-md border border-border">
          <ResizablePanelGroup>
            <ResizablePanel id="a" minSize="120px" className="bg-muted/30">
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t("area.ux-labs.design-guide.panelA")}
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="b" minSize="120px" collapsible collapsedSize="40px" className="bg-muted/10">
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t("area.ux-labs.design-guide.panelB")}
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="c" minSize="120px" className="bg-muted/30">
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t("area.ux-labs.design-guide.panelC")}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </Section>

      {/* ============================================================ */}
      {/*  INLINE BANNER + BUILT-IN AGENTS                              */}
      {/* ============================================================ */}
      <Section title={t("area.ux-labs.design-guide.inlineBanner")}>
        <p className="text-sm text-muted-foreground">
          <Trans
            i18nKey="area.ux-labs.design-guide.inlineBannerNote"
            components={{
              m: <span className="font-mono" />,
            }}
          />
        </p>
        <div className="space-y-3">
          <InlineBanner
            tone="info"
            title={t("area.ux-labs.design-guide.builtInAgent")}
            actions={<Button variant="outline" size="sm">{t("area.ux-labs.design-guide.resetToDefaults")}</Button>}
          >
            <Trans
              i18nKey="area.ux-labs.design-guide.builtInAgentBanner"
              components={{ b: <strong /> }}
            />
          </InlineBanner>
          <InlineBanner
            tone="warning"
            title={t("area.ux-labs.design-guide.briefsIsPaused")}
            actions={
              <>
                <Button variant="ghost" size="sm">{t("area.ux-labs.design-guide.viewAgent")}</Button>
                <Button size="sm">{t("area.ux-labs.design-guide.resumeAgent")}</Button>
              </>
            }
          >
            {t("area.ux-labs.design-guide.briefsPausedBody")}
          </InlineBanner>
          <InlineBanner
            tone="danger"
            title={t("area.ux-labs.design-guide.summaryGenerationFailed")}
            actions={<Button size="sm">{t("area.ux-labs.design-guide.retry")}</Button>}
          >
            {t("area.ux-labs.design-guide.theLinkedIssueReached")}
          </InlineBanner>
          <InlineBanner tone="info" compact>
            {t("area.ux-labs.design-guide.compactVariantForEmbedding")}
          </InlineBanner>
        </div>
      </Section>

      <Section title={t("area.ux-labs.design-guide.aiConnections")}>
        <AiConnectionDesignExamples />
      </Section>

      <Section title={t("area.ux-labs.design-guide.builtInAgentLifecycle")}>
        <p className="text-sm text-muted-foreground">
          <Trans
            i18nKey="area.ux-labs.design-guide.lifecycleChipNote"
            components={{ m: <span className="font-mono" /> }}
          />
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <BuiltInLifecycleChip status="needs_setup" />
          <BuiltInLifecycleChip status="pending_approval" />
          <BuiltInLifecycleChip status="needs_setup" compact />
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          <span className="font-mono">{`<BuiltInAgentGate agentKey>`}</span>{" "}
          <Trans
            i18nKey="area.ux-labs.design-guide.builtInGateNote"
            components={{ m: <span className="font-mono" /> }}
          />
        </p>
      </Section>
    </div>
  );
}
