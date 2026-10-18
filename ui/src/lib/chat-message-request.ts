// myrmidon(DEBRAND-c): persist browser state under the Myrmidon namespace.
/** Retire the legacy body-keyed retry cache; submission receipts now own identity. */
export function clearLegacyChatMessageRequests(scope: string) {
  try {
    localStorage.removeItem(`myrmidon:agent-chat-pending:${scope}`);
  } catch {
    // Browser storage may be disabled.
  }
}
