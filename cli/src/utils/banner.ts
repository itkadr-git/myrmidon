import pc from "picocolors";

import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../myrmidon-product.js";

// myrmidon(B1b): Myrmidon wordmark replaces the vendor ASCII art. The helper
// keeps its vendor export name (printPaperclipCliBanner) so callers stay
// vendor-merge-compatible; only the visible output changed.
const MYRMIDON_ART = [
  "███╗   ███╗██╗   ██╗██████╗ ██╗██╗  ██╗███████╗██████╗ ",
  "████╗ ████║██║   ██║██╔══██╗██║╚██╗██╔╝██╔════╝██╔══██╗",
  "██╔████╔██║██║   ██║██████╔╝██║ ╚█████╔╝ █████╗  ██████╔╝",
  "██║╚██╔╝██║██║   ██║██╔══██╗██║  ╚██╔╝  ██╔══╝  ██╔══██╗",
  "██║ ╚═╝ ██║╚██╗ ██╔╝██║  ██║██║   ██║   ███████╗██║  ██║",
  "╚═╝     ╚═╝ ╚████╔╝ ██║  ██║╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝",
] as const;

export function printPaperclipCliBanner(): void {
  const lines = [
    "",
    ...MYRMIDON_ART.map((line) => pc.cyan(line)),
    pc.blue("  ───────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${PRODUCT_NAME} — ${PRODUCT_TAGLINE}`)),
    "",
  ];

  console.log(lines.join("\n"));
}
