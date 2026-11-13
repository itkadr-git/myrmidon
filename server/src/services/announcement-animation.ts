import { createRequire } from "node:module";

import { ANNOUNCEMENT_ANIMATION_MAX_BYTES } from "@myrmidon/shared";
import type DOMPurify from "dompurify";
import type { JSDOM as JSDOMClass } from "jsdom";

// jsdom + dompurify sit at the front of the server's import graph but serve
// only announcement animation validation. Resolve them on first use so a cold
// board start does not pay their module load (~1 s, see OPE-12179).
let domPurifyModule: typeof DOMPurify | null = null;
let jsdomModule: { JSDOM: typeof JSDOMClass } | null = null;
function lazyDomModules(): { createDOMPurify: typeof DOMPurify; JSDOM: typeof JSDOMClass } {
  const require = createRequire(import.meta.url);
  // dompurify's CJS entry exports the createDOMPurify factory directly; the
  // ESM "default" export is an identical wrapper. Require gives the factory.
  domPurifyModule ??= require("dompurify") as typeof DOMPurify;
  jsdomModule ??= require("jsdom") as { JSDOM: typeof JSDOMClass };
  return { createDOMPurify: domPurifyModule, JSDOM: jsdomModule.JSDOM };
}

// A visual HTML/CSS document, never an application. JSDOM does not execute
// scripts or load resources. DOMPurify handles HTML parsing/normalization;
// CSP on delivery also blocks all network requests, including CSS URLs.
export function validateAnnouncementAnimation(bytes: Uint8Array): string {
  if (!bytes.length || bytes.byteLength > ANNOUNCEMENT_ANIMATION_MAX_BYTES) {
    throw new Error("Invalid or oversized announcement animation");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const { createDOMPurify, JSDOM } = lazyDomModules();
  const dom = new JSDOM("");
  try {
    const purifier = createDOMPurify(dom.window as unknown as Parameters<typeof createDOMPurify>[0]);
    const html = purifier.sanitize(source, {
      WHOLE_DOCUMENT: true,
      ALLOWED_TAGS: ["html", "head", "body", "style", "div", "span", "p", "br", "strong", "em", "b", "i",
        "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "tspan", "title", "desc"],
      ALLOWED_ATTR: ["class", "id", "style", "viewBox", "xmlns", "width", "height", "x", "y", "x1", "x2", "y1", "y2",
        "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "stroke", "stroke-width", "stroke-linecap",
        "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "opacity", "transform", "text-anchor"],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    });
    if (purifier.removed.length) {
      throw new Error("Animation must contain only visual HTML/CSS or inline SVG; scripts, navigation, resources and interactive elements are not supported");
    }
    return html;
  } finally {
    dom.window.close();
  }
}
