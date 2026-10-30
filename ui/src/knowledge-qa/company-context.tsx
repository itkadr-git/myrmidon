// QA harness stub of context/CompanyContext: one fixed company, no network.
import type { ReactNode } from "react";

const company = { id: "company-1", name: "Operations", issuePrefix: "OPE", status: "active" };
const value = {
  companies: [company],
  selectedCompanyId: "company-1",
  selectedCompany: company,
  selectionSource: "manual",
  loading: false,
  error: null,
  setSelectedCompanyId: () => undefined,
  reloadCompanies: async () => undefined,
  createCompany: async () => company,
};

export function CompanyProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
export function useCompany() {
  return value;
}
export function useOptionalCompany() {
  return value;
}
