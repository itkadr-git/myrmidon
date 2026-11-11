// myrmidon(1.6.7 SETTINGS-GENERAL-CRASH): one place that turns a settings
// request error into the text a panel shows. The server answers a non-admin
// instance-settings request with 403 "Instance admin access required"; the
// panels used to show that English sentence raw, or nothing at all. A 403 of
// that kind is shown as the i18n string `settings.instanceAdminRequired`
// (ru/en); every other error keeps the server's message, and an error without
// one falls back to the panel's own key. The module has no imports so it runs
// in any test without the UI aliases.

/** Catalog key of the "needs instance administrator" message. */
export const INSTANCE_ADMIN_REQUIRED_KEY = "settings.instanceAdminRequired";

type Translate = (key: string) => unknown;

function readStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return "";
}

/** True for the 403 the server sends when the caller is not an instance admin. */
export function isInstanceAdminRequiredError(err: unknown): boolean {
  return readStatus(err) === 403 && /instance admin/i.test(readMessage(err));
}

/**
 * The text to show for a failed settings request: the translated
 * "instance admin required" message for that 403, otherwise the server's
 * message, otherwise the translation of `fallbackKey`.
 */
export function describeSettingsError(err: unknown, t: Translate, fallbackKey: string): string {
  if (isInstanceAdminRequiredError(err)) return String(t(INSTANCE_ADMIN_REQUIRED_KEY));
  const message = readMessage(err).trim();
  return message !== "" ? message : String(t(fallbackKey));
}
