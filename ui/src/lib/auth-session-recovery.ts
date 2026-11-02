export function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  if (candidate.status === 401 || candidate.statusCode === 401) return true;
  return false;
}

const PUBLIC_AUTH_PATHS = [
  "/auth",
  "/board-claim",
  "/cli-auth",
  "/invite",
  "/password-set",
  "/oauth-handoff",
];

export function isPublicAuthPath(pathname: string): boolean {
  return PUBLIC_AUTH_PATHS.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function pollInterval(
  interval: number | false,
): ((query: { state: { error: unknown } }) => number | false) | false {
  if (interval === false) return false;
  return (query) => (isUnauthorizedError(query?.state?.error) ? false : interval);
}

export interface AuthSessionRecoveryLocation {
  pathname: string;
  search: string;
  hash: string;
}

export interface AuthSessionRecoveryOptions {
  redirectToLogin?: (target: string) => void;
  getLocation?: () => AuthSessionRecoveryLocation;
}

export interface AuthSessionRecoveryCoordinator {
  handleUnauthorized(status: number, body?: unknown): boolean;
  isSessionExpired(): boolean;
  onUnauthorized(listener: () => void): () => void;
  reset(): void;
}

export function createAuthSessionRecoveryCoordinator(
  options: AuthSessionRecoveryOptions = {},
): AuthSessionRecoveryCoordinator {
  let isExpired = false;
  const listeners = new Set<() => void>();

  const getLocation =
    options.getLocation ??
    (() => {
      const top = typeof window !== "undefined" ? (window.top ?? window) : null;
      return {
        pathname: top?.location?.pathname ?? "/",
        search: top?.location?.search ?? "",
        hash: top?.location?.hash ?? "",
      };
    });

  const redirectToLogin =
    options.redirectToLogin ??
    ((target: string) => {
      const top = typeof window !== "undefined" ? (window.top ?? window) : null;
      top?.location?.replace(target);
    });

  return {
    handleUnauthorized(status: number, _body?: unknown): boolean {
      if (status !== 401) return false;
      if (isExpired) return true;

      const loc = getLocation();
      if (isPublicAuthPath(loc.pathname)) {
        return false;
      }

      isExpired = true;

      for (const listener of listeners) {
        try {
          listener();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[auth-session-recovery] listener threw:", err);
        }
      }

      const returnUrl = `${loc.pathname}${loc.search}${loc.hash}`;
      const target = `/auth?next=${encodeURIComponent(returnUrl)}`;
      try {
        redirectToLogin(target);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[auth-session-recovery] redirectToLogin failed:", err);
      }

      return true;
    },

    isSessionExpired(): boolean {
      return isExpired;
    },

    onUnauthorized(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    reset(): void {
      isExpired = false;
    },
  };
}

export const authSessionRecovery = createAuthSessionRecoveryCoordinator();
