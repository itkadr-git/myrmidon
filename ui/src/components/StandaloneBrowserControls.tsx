import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ExternalLink, RefreshCw, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOptionalToastActions } from "../context/ToastContext";
import { isChromelessDisplayMode } from "../lib/pwa-display-mode";

function ControlButton({
  label,
  children,
  onClick,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void | Promise<void>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-8 text-muted-foreground hover:text-foreground"
          aria-label={label}
          onClick={() => void onClick()}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function StandaloneBrowserControls({ mobile }: { mobile: boolean }) {
  const [chromeless, setChromeless] = useState(false);
  const toastActions = useOptionalToastActions();

  useEffect(() => {
    if (!mobile || typeof window === "undefined") {
      setChromeless(false);
      return;
    }

    const update = () => setChromeless(isChromelessDisplayMode());

    update();
    if (typeof window.matchMedia !== "function") return;

    const media = window.matchMedia("(display-mode: standalone)");
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }

    media.addListener(update);
    return () => media.removeListener(update);
  }, [mobile]);

  const refresh = useCallback(() => {
    window.location.reload();
  }, []);

  const share = useCallback(async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: document.title || "Paperclip", url });
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        toastActions?.pushToast({ title: "Link copied", tone: "success" });
        return;
      }
      toastActions?.pushToast({ title: "Sharing is unavailable", body: url, tone: "warn" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toastActions?.pushToast({ title: "Share failed", body: "Try opening the page in your browser.", tone: "error" });
    }
  }, [toastActions]);

  const openInBrowser = useCallback(() => {
    window.open(window.location.href, "_blank", "noopener,noreferrer");
  }, []);

  if (!mobile || !chromeless) return null;

  return (
    <div className="flex h-10 items-center justify-end gap-1 border-b border-border bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
      <ControlButton label="Refresh" onClick={refresh}>
        <RefreshCw className="h-4 w-4" />
      </ControlButton>
      <ControlButton label="Share" onClick={share}>
        <Share2 className="h-4 w-4" />
      </ControlButton>
      <ControlButton label="Open in Browser" onClick={openInBrowser}>
        <ExternalLink className="h-4 w-4" />
      </ControlButton>
    </div>
  );
}
