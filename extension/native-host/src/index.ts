/**
 * Host entry point. Reads configuration from the environment:
 *   MYRMIDON_SIGN_HELPER_MODE  = mock | middleware   (middleware = real client integration)
 *   MYRMIDON_SIGN_MW_NAME      = token middleware name (mock: "mock")
 * The host never reads a PIN from the environment: PINs live in the Windows
 * Credential Store or in the middleware itself.
 */
import { runHost } from "./host.ts";
import { createMockMiddleware } from "./middleware.ts";

const mode = process.env.MYRMIDON_SIGN_HELPER_MODE ?? "mock";
const middleware = mode === "mock" ? createMockMiddleware() : undefined;
if (!middleware) {
  // The real middleware binding is registered when the client connects; the
  // host refuses to start rather than silently falling back to the mock.
  process.stderr.write(`sign helper: no middleware registered for mode "${mode}"\n`);
  process.exit(1);
}

runHost({ input: process.stdin, output: process.stdout }, { middleware });
