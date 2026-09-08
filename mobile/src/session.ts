import { ApiRequestError } from "./api";

export class AuthenticationExpiredError extends Error {
  constructor() {
    super("AUTH_REQUIRED");
  }
}

type RunnerOptions<Session> = Readonly<{
  getSession: () => Session | null;
  refreshSession: () => Promise<Session | null>;
  onAuthenticationExpired: () => Promise<void> | void;
}>;

export function createAuthenticatedRequestRunner<Session>(options: RunnerOptions<Session>) {
  let refreshPromise: Promise<Session | null> | null = null;

  async function expire(): Promise<never> {
    await options.onAuthenticationExpired();
    throw new AuthenticationExpiredError();
  }

  return async function run<T>(request: (session: Session) => Promise<T>): Promise<T> {
    const initial = options.getSession();
    if (!initial) return expire();

    try {
      return await request(initial);
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.status !== 401) throw error;
    }

    let refreshed = options.getSession();
    if (refreshed === initial) {
      if (!refreshPromise) {
        refreshPromise = options.refreshSession().finally(() => {
          refreshPromise = null;
        });
      }
      refreshed = await refreshPromise;
    }
    if (!refreshed) return expire();

    try {
      return await request(refreshed);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) return expire();
      throw error;
    }
  };
}