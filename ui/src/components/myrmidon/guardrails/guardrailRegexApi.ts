// ui/src/components/myrmidon/guardrails/guardrailRegexApi.ts
//
// myrmidon(1.7 GUARDRAILS, OPE-10181): API client for the regex rule validator
// and ReDoS safety engine.

import { api } from "@/api/client";
import type {
  GuardrailRegexValidationRequest,
  GuardrailRegexValidationResult,
} from "@myrmidon/shared";

export const guardrailRegexApi = {
  validate: (companyId: string | undefined, input: GuardrailRegexValidationRequest) => {
    const url = companyId
      ? `/myrmidon/companies/${encodeURIComponent(companyId)}/guardrails/validate-regex`
      : `/myrmidon/guardrails/validate-regex`;
    return api.post<GuardrailRegexValidationResult>(url, input);
  },
};
