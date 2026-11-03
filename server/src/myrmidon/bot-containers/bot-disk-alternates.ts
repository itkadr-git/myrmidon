// bot-disk-alternates.ts (myrmidon 1.6.6 DISK, OPE-9673)
// Fast filesystem check for git alternates without pulling in server or express dependencies.
import fs from "node:fs";
import path from "node:path";

/**
 * Checks whether any repository on the bot's volume contains an alternates file
 * pointing to /cache/git. Used to protect running/dependent bots from unmounting /cache/git.
 */
export async function botHasGitAlternates(volumeRoot: string, botKey: string): Promise<boolean> {
  const botDir = path.join(volumeRoot, botKey);
  const candidates = [
    path.join(botDir, "workspace"),
    path.join(botDir, "hermes", ".myrmidon", "git-base"),
  ];
  for (const root of candidates) {
    try {
      const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sub = path.join(root, entry.name);
        const altPaths = [
          path.join(sub, "objects", "info", "alternates"),
          path.join(sub, ".git", "objects", "info", "alternates"),
          path.join(sub, "repo", ".git", "objects", "info", "alternates"),
        ];
        for (const altPath of altPaths) {
          try {
            const content = await fs.promises.readFile(altPath, "utf8");
            if (content.includes("/cache/git")) {
              return true;
            }
          } catch {
            // continue
          }
        }
      }
    } catch {
      // continue
    }
  }
  return false;
}
