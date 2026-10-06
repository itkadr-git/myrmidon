// myrmidon(1.7 FAVICON, OPE-4160): build-time guard for the shipped tab and
// home-screen icons. The browser tab must show the Myrmidon ant mark (the bare
// mark, adaptive to the colour scheme) and the phone home screen the app icon
// (the white ant on the navy plate); the vendor paperclip artwork must not
// ship. This test pins: index.html links the full tab icon set; the PWA
// manifest carries the 192/512 home-screen icons including a maskable 512;
// every shipped root-level icon file is byte-identical to its design-system
// counterpart in ui/public/brand/myrmidon/; and a built ui/dist, when present,
// ships the same files with no paperclip artwork.
// Geometry/colour of the mark itself is guarded by
// myrmidon-ant-mark.myrmidon.test.ts; textual branding by
// myrmidon-branding-guard.myrmidon.test.ts. This file guards the *set*.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC = path.join(UI_ROOT, "public");
const BRAND = path.join(PUBLIC, "brand", "myrmidon");
const DIST = path.join(UI_ROOT, "dist");

const read = (p: string) => readFileSync(p, "utf-8");

// The brand counterpart of a root-level icon file is named by size, not by
// the root file name (android-chrome-192x192.png ↔ icon-192.png).
const BRAND_BY_ROOT_NAME: Record<string, string> = {
  "favicon.ico": "favicon.ico",
  "favicon-16x16.png": "icon-16.png",
  "favicon-32x32.png": "icon-32.png",
  "apple-touch-icon.png": "icon-180.png",
  "android-chrome-192x192.png": "icon-192.png",
  "android-chrome-512x512.png": "icon-512.png",
};

function bytesEqual(a: string, b: string): boolean {
  return readFileSync(a).equals(readFileSync(b));
}

describe("myrmidon favicon build guard (OPE-4160)", () => {
  it("index.html links the full tab icon set and the manifest", () => {
    const html = read(path.join(UI_ROOT, "index.html"));
    expect(html).toContain('<link rel="icon" href="/favicon.ico"');
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml"');
    expect(html).toContain('sizes="32x32" href="/favicon-32x32.png"');
    expect(html).toContain('sizes="16x16" href="/favicon-16x16.png"');
    expect(html).toContain('href="/apple-touch-icon.png"');
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest"');
  });

  it("favicon.svg is the brand favicon mark, adaptive to the colour scheme, without a plate", () => {
    const svg = read(path.join(PUBLIC, "favicon.svg"));
    const brand = read(path.join(BRAND, "myrmidon-favicon.svg"));
    const pathsOf = (s: string) =>
      [...s.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1].replace(/[\s,]+/g, " ").trim());
    expect(pathsOf(svg)).toEqual(pathsOf(brand));
    expect(svg).toContain("prefers-color-scheme:dark");
    expect(svg).not.toContain("<rect");
  });

  it("every shipped icon file is byte-identical to its brand counterpart", () => {
    for (const [root, brand] of Object.entries(BRAND_BY_ROOT_NAME)) {
      const rootFile = path.join(PUBLIC, root);
      expect(existsSync(rootFile), root).toBe(true);
      expect(bytesEqual(rootFile, path.join(BRAND, brand)), root).toBe(true);
    }
  });

  it("the web manifest carries the 192/512 home-screen icons including a maskable 512", () => {
    const man = JSON.parse(read(path.join(PUBLIC, "site.webmanifest")));
    const bySizes = new Map<string, Array<{ src?: string; purpose?: string }>>();
    for (const icon of man.icons ?? []) {
      const list = bySizes.get(icon.sizes) ?? [];
      list.push(icon);
      bySizes.set(icon.sizes, list);
    }
    expect(bySizes.get("192x192")).toHaveLength(1);
    expect((bySizes.get("512x512") ?? []).length).toBeGreaterThanOrEqual(2);
    expect((bySizes.get("512x512") ?? []).some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("every manifest icon exists and matches its brand counterpart", () => {
    const man = JSON.parse(read(path.join(PUBLIC, "site.webmanifest")));
    for (const icon of man.icons ?? []) {
      expect(icon.src.startsWith("/"), icon.src).toBe(true);
      const file = path.join(PUBLIC, icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      const brandName = BRAND_BY_ROOT_NAME[path.basename(icon.src)];
      expect(brandName, `brand counterpart for ${icon.src}`).toBeDefined();
      expect(bytesEqual(file, path.join(BRAND, brandName)), icon.src).toBe(true);
    }
  });

  it("no paperclip artwork ships in ui/public", () => {
    expect(existsSync(path.join(PUBLIC, "paperclip-thinking.svg"))).toBe(false);
    for (const f of ["favicon.svg", "site.webmanifest"]) {
      expect(read(path.join(PUBLIC, f))).not.toMatch(/paperclip/i);
    }
    for (const f of readdirSync(PUBLIC)) {
      expect(f).not.toMatch(/paperclip/i);
    }
  });

  it("a built ui/dist, when present, ships the same ant files and no old icon", () => {
    if (!existsSync(DIST)) return; // source-tree run; the build-time run covers dist
    for (const root of Object.keys(BRAND_BY_ROOT_NAME)) {
      const built = path.join(DIST, root);
      expect(existsSync(built), `dist/${root}`).toBe(true);
      expect(bytesEqual(built, path.join(PUBLIC, root)), `dist/${root}`).toBe(true);
    }
    expect(existsSync(path.join(DIST, "site.webmanifest"))).toBe(true);
    expect(read(path.join(DIST, "index.html"))).toContain("/favicon.svg");
  });
});
