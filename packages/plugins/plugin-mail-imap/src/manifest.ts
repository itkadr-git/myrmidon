import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-mail-imap";
export const PLUGIN_VERSION = "0.1.0";
export const MAIL_SYNC_JOB_KEY = "mail-sync";
export const SYNC_NOW_ACTION_KEY = "sync-now";
export const TEST_CONNECTION_ACTION_KEY = "test-connection";
export const MAILBOX_STATE_NAMESPACE = "mailbox";
export const LAST_UID_STATE_KEY = "last-uid";

export const DEFAULT_SOURCE_FOLDER = "INBOX";
export const DEFAULT_MAX_MESSAGES_PER_RUN = 50;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Mail (IMAP)",
  description:
    "Reads new messages from a company IMAP mailbox and sorts them into folders by configurable rules (from/subject/attachment match).",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "jobs.schedule",
    "secrets.read-ref",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "plugin.state.read",
    "plugin.state.write",
    "metrics.write",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["imapHost", "username", "passwordSecretRef"],
    properties: {
      imapHost: {
        type: "string",
        title: "IMAP host",
        description: "Hostname of the IMAP server, e.g. imap.example.com.",
      },
      imapPort: {
        type: "number",
        title: "IMAP port",
        description: "IMAP port. 993 for TLS (default), 143 for plain/STARTTLS.",
        default: 993,
      },
      imapTls: {
        type: "boolean",
        title: "Use TLS",
        description: "Connect with implicit TLS (port 993). Turn off for plain/STARTTLS servers.",
        default: true,
      },
      username: {
        type: "string",
        title: "Mailbox login",
        description: "IMAP username (usually the mailbox address).",
      },
      passwordSecretRef: {
        type: "object",
        title: "Mailbox password (secret ref)",
        description:
          "Reference to the company secret holding the IMAP password: { \"type\": \"secret_ref\", \"secretId\": \"<secret-uuid>\" }. The value is resolved at run time and never stored by the plugin.",
        properties: {
          type: { type: "string", enum: ["secret_ref"] },
          secretId: { type: "string" },
          version: { type: "number" },
        },
        required: ["type", "secretId"],
      },
      sourceFolder: {
        type: "string",
        title: "Source folder",
        description: "Folder new messages are read from.",
        default: DEFAULT_SOURCE_FOLDER,
      },
      sortRules: {
        type: "array",
        title: "Sort rules",
        description:
          "Rules applied in order; the first match wins. A message matching nothing stays in the source folder unless defaultTargetFolder is set.",
        items: {
          type: "object",
          required: ["targetFolder"],
          properties: {
            name: { type: "string", title: "Rule name" },
            fromContains: {
              type: "string",
              title: "From contains",
              description: "Case-insensitive substring match on the From header.",
            },
            subjectContains: {
              type: "string",
              title: "Subject contains",
              description: "Case-insensitive substring match on the Subject header.",
            },
            hasAttachment: {
              type: "boolean",
              title: "Has attachment",
              description: "Match messages with (true) or without (false) attachments.",
            },
            targetFolder: {
              type: "string",
              title: "Target folder",
              description: "IMAP folder the message is moved to. Created when missing.",
            },
          },
        },
        default: [],
      },
      defaultTargetFolder: {
        type: "string",
        title: "Default target folder",
        description:
          "Optional folder for messages that matched no rule. Leave empty to keep unmatched messages in the source folder.",
      },
      maxMessagesPerRun: {
        type: "number",
        title: "Max messages per run",
        description: "Upper bound of messages processed in one sync run.",
        default: DEFAULT_MAX_MESSAGES_PER_RUN,
      },
    },
  },
  jobs: [
    {
      jobKey: MAIL_SYNC_JOB_KEY,
      displayName: "Mail sync",
      description: "Fetch new messages from the source folder and sort them by the configured rules.",
      schedule: "*/5 * * * *",
    },
  ],
  database: {
    namespaceSlug: "mail_imap",
    migrationsDir: "migrations",
  },
};

export default manifest;

export const COMPANIES_STATE_NAMESPACE = "enabled-companies";
export const ENABLED_COMPANIES_STATE_KEY = "company-ids";
