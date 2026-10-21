// myrmidon(1.6.6 KNOWLEDGE-2.0 K-4): the "Работа" group is shown only when the
// server really serves the knowledge REST (K-2). Until then the rail hides
// the items, so nobody lands on a screen that can only show errors. A failed
// probe, loading and a missing company all resolve to `false`.
import { useQuery } from "@tanstack/react-query";
import { knowledgeApi, knowledgeQueryKeys } from "./screens/knowledge/knowledgeApi";

export function useKnowledgeAvailable(companyId: string | null | undefined): boolean {
  const query = useQuery({
    queryKey: [...knowledgeQueryKeys.items(companyId ?? ""), "probe"],
    queryFn: () => knowledgeApi.items(companyId!, {}),
    enabled: companyId != null,
    retry: false,
    staleTime: 5 * 60_000,
  });
  return companyId != null && query.isSuccess;
}
