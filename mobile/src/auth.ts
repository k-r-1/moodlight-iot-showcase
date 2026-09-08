import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";

const REFRESH_TOKEN_KEY = "moodlight.cognito.refresh-token.v1";
const REDIRECT_URI = AuthSession.makeRedirectUri({ scheme: "openiot-moodlight", path: "auth/callback" });

export type AuthTokens = Readonly<{ accessToken: string; refreshToken?: string }>;
type CommitGuard = () => boolean;

let refreshTokenMutation = Promise.resolve();

export type CognitoAuthConfig = Readonly<{
  clientId: string;
  discovery: AuthSession.DiscoveryDocument;
  redirectUri: string;
}>;

export function cognitoAuthConfig(): CognitoAuthConfig | null {
  const clientId = process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID?.trim();
  const rawDomain = process.env.EXPO_PUBLIC_COGNITO_DOMAIN?.trim();
  if (!clientId || !rawDomain) return null;
  const domain = new URL(rawDomain);
  if (domain.protocol !== "https:" || domain.username || domain.password || domain.search || domain.hash || (domain.pathname !== "/" && domain.pathname !== "")) {
    throw new Error("INVALID_COGNITO_CONFIG");
  }
  const base = domain.origin;
  return {
    clientId,
    redirectUri: REDIRECT_URI,
    discovery: {
      authorizationEndpoint: `${base}/oauth2/authorize`,
      tokenEndpoint: `${base}/oauth2/token`,
      revocationEndpoint: `${base}/oauth2/revoke`,
    },
  };
}

export async function signInWithCognito(config: CognitoAuthConfig, shouldCommit: CommitGuard = () => true): Promise<AuthTokens | null> {
  const request = new AuthSession.AuthRequest({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    responseType: AuthSession.ResponseType.Code,
    scopes: ["openid", "email"],
    usePKCE: true,
  });
  const result = await request.promptAsync(config.discovery);
  if (result.type !== "success" || typeof result.params.code !== "string" || !request.codeVerifier) {
    throw new Error(result.type === "cancel" || result.type === "dismiss" ? "AUTH_CANCELLED" : "AUTH_FAILED");
  }
  const response = await AuthSession.exchangeCodeAsync({
    clientId: config.clientId,
    code: result.params.code,
    redirectUri: config.redirectUri,
    extraParams: { code_verifier: request.codeVerifier },
  }, config.discovery);
  if (!response.accessToken) throw new Error("AUTH_FAILED");
  if (!shouldCommit()) return null;
  if (response.refreshToken && !(await saveRefreshToken(response.refreshToken, shouldCommit))) return null;
  return { accessToken: response.accessToken, ...(response.refreshToken ? { refreshToken: response.refreshToken } : {}) };
}

export async function restoreCognitoSession(config: CognitoAuthConfig, shouldCommit: CommitGuard = () => true): Promise<AuthTokens | null> {
  return refreshCognitoSession(config, shouldCommit);
}

export async function refreshCognitoSession(config: CognitoAuthConfig, shouldCommit: CommitGuard = () => true): Promise<AuthTokens | null> {
  const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  if (!refreshToken || !shouldCommit()) return null;
  try {
    const response = await AuthSession.refreshAsync({ clientId: config.clientId, refreshToken }, config.discovery);
    if (!response.accessToken || !shouldCommit()) return null;
    const nextRefreshToken = response.refreshToken ?? refreshToken;
    if (nextRefreshToken !== refreshToken && !(await saveRefreshToken(nextRefreshToken, shouldCommit))) return null;
    return { accessToken: response.accessToken, refreshToken: nextRefreshToken };
  } catch (error) {
    if (error instanceof AuthSession.TokenError && error.code === "invalid_grant") {
      await clearCognitoSession(shouldCommit);
      return null;
    }
    throw error;
  }
}
export async function clearCognitoSession(shouldCommit: CommitGuard = () => true): Promise<void> {
  await mutateRefreshToken(shouldCommit, () => SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY));
}

async function saveRefreshToken(refreshToken: string, shouldCommit: CommitGuard): Promise<boolean> {
  return mutateRefreshToken(shouldCommit, () => SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }));
}

async function mutateRefreshToken(shouldCommit: CommitGuard, mutation: () => Promise<void>): Promise<boolean> {
  let committed = false;
  const current = refreshTokenMutation.then(async () => {
    if (!shouldCommit()) return;
    await mutation();
    committed = true;
  });
  refreshTokenMutation = current.catch(() => {});
  await current;
  return committed;
}
