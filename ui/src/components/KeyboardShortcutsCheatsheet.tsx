import { Trans } from "react-i18next";
import type { TFunction } from "i18next";
import { useTranslation } from "@/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface ShortcutEntry {
  keys: string[];
  label: string;
  /** Render keys as a simultaneous chord (joined with "+") rather than a
   *  "then" sequence. */
  combo?: boolean;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

const buildSections = (t: TFunction): ShortcutSection[] => [
  {
    title: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.sectionInbox"),
    shortcuts: [
      { keys: ["j"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.moveDown") },
      { keys: ["↓"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.moveDown") },
      { keys: ["k"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.moveUp") },
      { keys: ["↑"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.moveUp") },
      { keys: ["←"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.collapseGroup") },
      { keys: ["→"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.expandGroup") },
      { keys: ["Enter"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.openItem") },
      { keys: ["a"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.archiveItem") },
      { keys: ["y"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.archiveItem") },
      { keys: ["r"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.markRead") },
      { keys: ["U"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.markUnread") },
    ],
  },
  {
    title: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.sectionTaskDetail"),
    shortcuts: [
      { keys: ["y"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.quickArchive") },
      { keys: ["g", "i"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.goInbox") },
      { keys: ["g", "c"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.focusComment") },
    ],
  },
  {
    title: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.sectionDecisions"),
    shortcuts: [
      { keys: ["j"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.moveDown") },
      { keys: ["↓"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.moveDown") },
      { keys: ["k"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.moveUp") },
      { keys: ["↑"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.moveUp") },
      { keys: ["Enter"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.toggleDecision") },
      { keys: ["x"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.dismissDecision") },
    ],
  },
  {
    title: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.sectionGlobal"),
    shortcuts: [
      { keys: ["/"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.search") },
      { keys: ["c"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.newTask") },
      { keys: ["["], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.toggleSidebar") },
      { keys: ["]"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.togglePanel") },
      { keys: ["?"], label: t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.showShortcuts") },
    ],
  },
];

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-foreground shadow-(--shadow-extract-10)">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsCheatsheetContent() {
  const { t } = useTranslation();
  const sections = buildSections(t);
  return (
    <>
      <div className="divide-y divide-border border-t border-border">
        {sections.map((section) => (
          <div key={section.title} className="px-5 py-3">
            <h3 className="mb-2 text-(length:--text-micro) font-semibold uppercase tracking-wider text-muted-foreground">
              {section.title}
            </h3>
            <div className="space-y-1.5">
              {section.shortcuts.map((shortcut) => (
                <div
                  key={shortcut.label + shortcut.keys.join()}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="text-sm text-foreground/90">{shortcut.label}</span>
                  <div className="flex items-center gap-1">
                    {shortcut.keys.map((key, i) => (
                      <span key={key} className="flex items-center gap-1">
                        {i > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {shortcut.combo ? "+" : t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.then")}
                          </span>
                        )}
                        <KeyCap>{key}</KeyCap>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-border px-5 py-3">
        <p className="text-xs text-muted-foreground">
          <Trans i18nKey="area.shell-misc-1.keyboard-shortcuts-cheatsheet.footer" components={[<KeyCap key="esc">Esc</KeyCap>]} />
        </p>
      </div>
    </>
  );
}

export function KeyboardShortcutsCheatsheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden" showCloseButton={false}>
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">{t("area.shell-misc-1.keyboard-shortcuts-cheatsheet.title")}</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
