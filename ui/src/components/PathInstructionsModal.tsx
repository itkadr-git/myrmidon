import { useState } from "react";
import { Apple, Monitor, Terminal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Trans } from "react-i18next";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";

type Platform = "mac" | "windows" | "linux";

const platforms: { id: Platform; label: string; icon: typeof Apple }[] = [
  { id: "mac", label: "macOS", icon: Apple },
  { id: "windows", label: "Windows", icon: Monitor },
  { id: "linux", label: "Linux", icon: Terminal },
];

type Translate = ReturnType<typeof useTranslation>["t"];

// Built at render time so the text follows the selected language.
function buildInstructions(t: Translate): Record<Platform, { steps: string[]; tip?: string }> {
  return {
    mac: {
      steps: [
        t("area.documents-artifacts-2.path-instructions-modal.mac.step1"),
        t("area.documents-artifacts-2.path-instructions-modal.mac.step2"),
        t("area.documents-artifacts-2.path-instructions-modal.mac.step3"),
        t("area.documents-artifacts-2.path-instructions-modal.mac.step4"),
      ],
      tip: t("area.documents-artifacts-2.path-instructions-modal.mac.tip"),
    },
    windows: {
      steps: [
        t("area.documents-artifacts-2.path-instructions-modal.windows.step1"),
        t("area.documents-artifacts-2.path-instructions-modal.windows.step2"),
        t("area.documents-artifacts-2.path-instructions-modal.windows.step3"),
      ],
      tip: t("area.documents-artifacts-2.path-instructions-modal.windows.tip"),
    },
    linux: {
      steps: [
        t("area.documents-artifacts-2.path-instructions-modal.linux.step1"),
        t("area.documents-artifacts-2.path-instructions-modal.linux.step2"),
        t("area.documents-artifacts-2.path-instructions-modal.linux.step3"),
      ],
      tip: t("area.documents-artifacts-2.path-instructions-modal.linux.tip"),
    },
  };
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "mac";
  if (ua.includes("win")) return "windows";
  return "linux";
}

interface PathInstructionsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PathInstructionsModal({
  open,
  onOpenChange,
}: PathInstructionsModalProps) {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<Platform>(detectPlatform);

  const current = buildInstructions(t)[platform];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t("area.documents-artifacts-2.path-instructions-modal.title")}</DialogTitle>
          <DialogDescription>
            <Trans
              i18nKey="area.documents-artifacts-2.path-instructions-modal.description"
              components={{ code: <code className="text-xs bg-muted px-1 py-0.5 rounded" /> }}
            />
          </DialogDescription>
        </DialogHeader>

        {/* Platform tabs */}
        <div className="flex gap-1 rounded-md border border-border p-0.5">
          {platforms.map((p) => (
            <button
              key={p.id}
              type="button"
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                platform === p.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
              )}
              onClick={() => setPlatform(p.id)}
            >
              <p.icon className="h-3.5 w-3.5" />
              {p.label}
            </button>
          ))}
        </div>

        {/* Steps */}
        <ol className="space-y-2 text-sm">
          {current.steps.map((step, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-muted-foreground font-mono text-xs mt-0.5 shrink-0">
                {i + 1}.
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        {current.tip && (
          <p className="text-xs text-muted-foreground border-l-2 border-border pl-3">
            {current.tip}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Small "Choose" button that opens the PathInstructionsModal.
 * Drop-in replacement for the old showDirectoryPicker buttons.
 */
export function ChoosePathButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={cn(
          "inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0",
          className,
        )}
        onClick={() => setOpen(true)}
      >
        {t("area.documents-artifacts-2.path-instructions-modal.choose")}
      </button>
      <PathInstructionsModal open={open} onOpenChange={setOpen} />
    </>
  );
}
