import type { ToolConnection } from "@paperclipai/shared";
import { humanizeConnectionDisplayName } from "@paperclipai/shared";
import { Identity } from "@/components/Identity";
import type { CompanyUserProfile } from "@/lib/company-members";
import { i18n, useTranslation } from "@/i18n";

export type ConnectionOwnerProfile = CompanyUserProfile;

export function connectionOwnerProfile(
  connection: Pick<ToolConnection, "createdByUserId">,
  profiles: ReadonlyMap<string, CompanyUserProfile>,
): ConnectionOwnerProfile | null {
  if (!connection.createdByUserId) return null;
  return profiles.get(connection.createdByUserId) ?? {
    label: connection.createdByUserId === "local-board" ? i18n.t("common.board") : i18n.t("area.apps-connections-3.connection-owner.boardMember"),
    image: null,
  };
}

function ownerGivenName(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return i18n.t("common.board");
  const first = trimmed.split(/\s+/)[0] ?? trimmed;
  return first.includes("@") ? first.split("@")[0] || i18n.t("common.board") : first;
}

/**
 * Keep intentionally customized account names, while making the default app
 * name useful in a multi-user company ("Dotta’s Notion", "Sam’s Gmail").
 */
export function connectionDisplayNameForOwner(
  connection: Pick<ToolConnection, "name">,
  applicationName: string,
  owner: ConnectionOwnerProfile | null,
): string {
  const rawName = connection.name.trim();
  // Provider account identifiers are machine values, not prose. Preserve
  // their casing and punctuation so an email address or tenant hostname stays
  // recognizable in the inline account list.
  const connectionName =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawName) ||
    /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(rawName)
      ? rawName
      : humanizeConnectionDisplayName(connection);
  if (!owner) return connectionName;
  if (connectionName.trim().toLocaleLowerCase() !== applicationName.trim().toLocaleLowerCase()) {
    return connectionName;
  }
  const givenName = ownerGivenName(owner.label);
  // English keeps the possessive form ("Sam’s Gmail"); other languages use a
  // neutral "App (Owner)" pattern from the catalog.
  const params = { owner: givenName, app: applicationName };
  return givenName.toLowerCase().endsWith("s")
    ? i18n.t("area.apps-connections-3.connection-owner.ownedAccountEndsWithS", params)
    : i18n.t("area.apps-connections-3.connection-owner.ownedAccount", params);
}

export function ConnectionOwnerIdentity({ owner }: { owner: ConnectionOwnerProfile | null }) {
  const { t } = useTranslation();
  if (!owner) return <span className="text-xs text-muted-foreground">{t("area.apps-connections-3.connection-owner.unknownOwner")}</span>;
  return (
    <Identity
      name={owner.label}
      avatarUrl={owner.image}
      size="sm"
      className="text-muted-foreground"
    />
  );
}
