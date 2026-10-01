/**
 * PIN storage strategies. The PIN is a secret of the client PC: it is stored
 * either in the Windows Credential Store (via the CredRead/CredWrite API, not
 * in a file) or inside the token middleware itself (CryptoPro-style middleware
 * keeps its own PIN). In both modes the PIN never crosses the native
 * messaging bridge and never reaches our servers or the model.
 */
import type { SignMiddleware, SignDocumentInput } from "./middleware.ts";

/** Minimal surface of the Windows Credential Store API we use. */
export interface CredentialStore {
  /** Reads the PIN blob; null when the credential does not exist. */
  readPin(target: string): Promise<Buffer | null>;
  /** Writes the PIN blob. */
  writePin(target: string, pin: Buffer): Promise<void>;
  /** Deletes the credential. */
  deletePin(target: string): Promise<void>;
}

/** Credential target name, e.g. "Myrmidon/SignHelper/<keyAlias>". */
export function credentialTarget(keyAlias: string): string {
  return `Myrmidon/SignHelper/${keyAlias}`;
}

/**
 * Mode "middleware": the middleware stores the PIN itself; the host asks for
 * the secret through an injection interface the real integration will bind to
 * the middleware's own prompt/keystore. The mock never needs a PIN.
 */
export interface PinProvider {
  /** Returns the PIN bytes, or null when unavailable (host fails closed). */
  getPin(): Promise<Buffer | null>;
}

export function middlewareOwnedPin(): PinProvider {
  // The real integration binds this to the middleware's own keystore prompt.
  return {
    async getPin() {
      return null;
    },
  };
}

/**
 * Mode "credential store": PIN lives in the Windows Credential Store under a
 * per-key target. The host passes it to the middleware secret interface only
 * in-memory for the duration of one sign call.
 */
export function credentialStorePin(store: CredentialStore, keyAlias: string): PinProvider {
  const target = credentialTarget(keyAlias);
  return {
    async getPin() {
      return store.readPin(target);
    },
  };
}

/**
 * Wraps a middleware with a PIN provider: the PIN is fetched (if the
 * middleware mode requires one), handed to the middleware's secret interface,
 * and zeroed afterwards. If the PIN is unavailable the call fails closed with
 * "pin_unavailable" — the helper never falls back to a file or a prompt of
 * its own.
 */
export function withPin<T extends SignMiddleware & { withPinSecret?(pin: Buffer): T }>(
  middleware: T,
  pin: PinProvider | null,
): T {
  if (!pin || typeof middleware.withPinSecret !== "function") return middleware;
  const wrapped = Object.create(middleware) as T;
  const origSign = middleware.sign.bind(middleware);
  (wrapped as unknown as SignMiddleware).sign = async (input: SignDocumentInput) => {
    const secret = await pin.getPin();
    if (!secret) {
      const err = new Error("PIN unavailable") as Error & { code?: string };
      err.code = "pin_unavailable";
      throw err;
    }
    try {
      return await middleware.withPinSecret!(secret).sign(input);
    } finally {
      secret.fill(0);
    }
  };
  return wrapped;
}
