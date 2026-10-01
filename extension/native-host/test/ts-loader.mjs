/**
 * Node strips .ts extensions only with --experimental-strip-types when the
 * import specifier is exactly "./x.ts" — imports written as "./x.js" (needed
 * for tsc "Node16" resolution without emit) are NOT remapped at runtime.
 * This loader bridges that gap for the test run only: it resolves the
 * extensionless/".js" specifiers of this package to the sibling ".ts" source.
 */
import { pathToFileURL } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    if (specifier.endsWith(".js")) {
      const parent = context.parentURL ?? pathToFileURL(process.cwd() + "/").href;
      const resolved = new URL(specifier, parent);
      const target = resolved.href.replace(/\.js$/, ".ts");
      try {
        return await next(target, context);
      } catch {
        // fall through to the default resolution
      }
    }
  }
  return next(specifier, context);
}
