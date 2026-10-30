// QA harness stub of context/BreadcrumbContext.
import type { ReactNode } from "react";

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
export function useBreadcrumbs() {
  return { breadcrumbs: [], setBreadcrumbs: () => undefined, setPanelControls: () => undefined };
}
export function buildDocumentTitle() {
  return "";
}
