export const DOCS_URL = "https://github.com/itkadr-git/myrmidon/tree/main/docs";
export const FEEDBACK_URL = "https://github.com/itkadr-git/myrmidon/issues";

// Sharing terms belong to the instance operator, not the upstream vendor.
export function resolveFeedbackTermsUrl(value: string | undefined): string | null {
  return value?.trim() || null;
}

export const FEEDBACK_TERMS_URL = resolveFeedbackTermsUrl(import.meta.env.VITE_FEEDBACK_TERMS_URL);
