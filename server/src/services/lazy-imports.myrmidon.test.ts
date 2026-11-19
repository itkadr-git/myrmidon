import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(HERE, "..");

const TARGET_FILES = [
  path.join(SERVER_SRC, "routes/assets.ts"),
  path.join(SERVER_SRC, "services/announcement-animation.ts"),
  path.join(SERVER_SRC, "services/chat-github-attachments.ts"),
  path.join(SERVER_SRC, "services/chat-discord.ts"),
];

describe("lazy imports for jsdom and @chat-adapter/discord", () => {
  it("has no top-level value imports of jsdom or @chat-adapter/discord in targeted files", () => {
    // Regex matches any top-level import from jsdom or @chat-adapter/discord that is NOT an 'import type'
    const topLevelValueImportRegex =
      /^import\s+(?!type\b)[^;]*?from\s+["'](?:jsdom|@chat-adapter\/discord)["']/m;

    for (const filePath of TARGET_FILES) {
      expect(fs.existsSync(filePath), `file ${filePath} must exist`).toBe(true);
      const content = fs.readFileSync(filePath, "utf8");
      const match = topLevelValueImportRegex.exec(content);
      expect(
        match,
        `File ${path.relative(SERVER_SRC, filePath)} contains top-level value import: ${match?.[0]}`,
      ).toBeNull();
    }
  });

  it("permits only import type or dynamic import() for jsdom and @chat-adapter/discord", () => {
    for (const filePath of TARGET_FILES) {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (
          line.includes('from "jsdom"') ||
          line.includes("from 'jsdom'") ||
          line.includes('from "@chat-adapter/discord"') ||
          line.includes("from '@chat-adapter/discord'")
        ) {
          expect(line.trim()).toMatch(/^import\s+type\b/);
        }
      }
    }
  });

  it("contains dynamic import() for jsdom or @chat-adapter/discord in the respective files", () => {
    const assetsContent = fs.readFileSync(path.join(SERVER_SRC, "routes/assets.ts"), "utf8");
    expect(assetsContent).toMatch(/await\s+import\(["']jsdom["']\)/);

    const announcementContent = fs.readFileSync(
      path.join(SERVER_SRC, "services/announcement-animation.ts"),
      "utf8",
    );
    expect(announcementContent).toMatch(/await\s+import\(["']jsdom["']\)/);

    const githubAttachmentsContent = fs.readFileSync(
      path.join(SERVER_SRC, "services/chat-github-attachments.ts"),
      "utf8",
    );
    expect(githubAttachmentsContent).toMatch(/await\s+import\(["']jsdom["']\)/);

    const discordContent = fs.readFileSync(
      path.join(SERVER_SRC, "services/chat-discord.ts"),
      "utf8",
    );
    expect(discordContent).toMatch(/await\s+import\(["']@chat-adapter\/discord["']\)/);
  });
});
