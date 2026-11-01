import type { AccessKind } from "./accessHubApi";

const KIND_KEYS: Record<AccessKind, string> = {
  ssh_key: "area.access-hub.kinds.sshKey",
  password: "area.access-hub.kinds.password",
  token: "area.access-hub.kinds.token",
  oauth: "area.access-hub.kinds.oauth",
};

/** Localized label of an access kind; resolved at render time, not at import. */
export function accessKindLabel(t: (key: string) => string, kind: AccessKind): string {
  return t(KIND_KEYS[kind]);
}
