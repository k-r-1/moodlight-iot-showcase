import { StatusBar } from "expo-status-bar";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Linking,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewProps, type WebViewMessageEvent } from "react-native-webview";
import { encode } from "base-64";
import SecureProvisioning from "./modules/moodlight-secure-provisioning";
import {
  ApiRequestError,
  bootstrapApiSession,
  createDeviceClaim,
  finalizeDeviceClaim,
  getDeviceClaim,
  listDevices,
  listSchedules,
  patchDeviceState,
  releaseDevice,
  createSchedule,
  updateSchedule,
  scheduleAction,
  type AuthenticatedApiSession,
  type ClaimStatus,
  type CreatedDeviceClaim,
  type ProductRegistration,
} from "./src/api";
import { clearCognitoSession, cognitoAuthConfig, refreshCognitoSession, restoreCognitoSession, signInWithCognito } from "./src/auth";
import { clearPendingClaim, loadPendingClaim, savePendingClaim } from "./src/pendingClaim";
import { AuthenticationExpiredError, createAuthenticatedRequestRunner } from "./src/session";
import { MoodlightBle } from "./src/ble/MoodlightBle";
import {
  DEFAULT_BLE_SERVICE_UUID,
} from "./src/ble/contract";
import { isTrustedEmbeddedWebMessageUrl, isTrustedEmbeddedWebUrl, isTrustedWebUrl, webappOrigin, WEBVIEW_ORIGIN_WHITELIST } from "./src/navigation";
import {
  parseWebMessage,
  type AuthState,
  type NativeToWebMessage,
} from "./src/protocol";

WebBrowser.maybeCompleteAuthSession();

// Handoff builds stay embedded. During local development, use localhost:3210 with adb reverse for
// live debug, or set an exact HTTPS tunnel/Amplify URL and rebuild when that URL changes.
const EMBEDDED_WEBAPP = Platform.OS === "android" && process.env.EXPO_PUBLIC_EMBEDDED_WEBAPP === "true";
const WEBAPP_URL = EMBEDDED_WEBAPP
  ? "file:///android_asset/webapp/index.html"
  : process.env.EXPO_PUBLIC_WEBAPP_URL ?? "http://localhost:3210";
const SERVICE_UUID = process.env.EXPO_PUBLIC_BLE_SERVICE_UUID ?? DEFAULT_BLE_SERVICE_UUID;
const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL?.trim() ?? "";
// Explicit opt-in preserves the five-field QR hardware test without opening it in product builds.
const LOCAL_PROVISIONING_TEST_MODE = process.env.EXPO_PUBLIC_LOCAL_PROVISIONING_TEST_MODE === "true";
// One-run local recovery after a debug session outlives the server Claim TTL.
// The value is injected only into a local Metro process and is never committed.
const LOCAL_RECOVERY_CLAIM_ID = __DEV__ ? process.env.EXPO_PUBLIC_LOCAL_RECOVERY_CLAIM_ID?.trim() ?? "" : "";
type ShouldStartLoadRequest = Parameters<NonNullable<WebViewProps["onShouldStartLoadWithRequest"]>>[0];

function utf8ToBase64(value: string): string {
  return encode(unescape(encodeURIComponent(value)));
}

class NativeBoundaryError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
  }
}

class StaleAuthenticationOperationError extends Error {}

type PendingClaimContext = Omit<CreatedDeviceClaim, "status"> & Readonly<{ status: ClaimStatus }>;

async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const api = Number(Platform.Version);
  if (api >= 31) {
    const result = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(result).every((value) => value === PermissionsAndroid.RESULTS.GRANTED);
  }
  return (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION)) === PermissionsAndroid.RESULTS.GRANTED;
}

export default function App() {
  const webRef = useRef<WebView<object>>(null);
  // Cognito PKCE will populate this Native-only session. Never send it to WebView.
  const apiSessionRef = useRef<AuthenticatedApiSession | null>(null);
  const productRegistrationRef = useRef<ProductRegistration | null>(null);
  const testQrSessionRef = useRef(false);
  const pendingClaimRef = useRef<PendingClaimContext | null>(null);
  const pendingClaimSerialRef = useRef<string | null>(null);
  const pendingClaimTenantRef = useRef<string | null>(null);
  const authStateRef = useRef<AuthState>({ status: "signed-out" });
  const authOperationRef = useRef(0);
  const allowedOrigin = useMemo(() => EMBEDDED_WEBAPP ? null : webappOrigin(WEBAPP_URL, __DEV__), []);
  const isAllowedWebUrl = useCallback((url: string) => (
    EMBEDDED_WEBAPP ? isTrustedEmbeddedWebUrl(url) : isTrustedWebUrl(url, allowedOrigin)
  ), [allowedOrigin]);
  const isAllowedWebMessageUrl = useCallback((url: unknown) => (
    EMBEDDED_WEBAPP ? isTrustedEmbeddedWebMessageUrl(url) : typeof url === "string" && isTrustedWebUrl(url, allowedOrigin)
  ), [allowedOrigin]);

  const sendToWeb = useCallback((message: NativeToWebMessage) => {
    const payload = utf8ToBase64(JSON.stringify(message));
    const script = `try{window.__moodlightBridge?.dispatch(JSON.parse(decodeURIComponent(escape(atob('${payload}')))))}catch(_e){};true;`;
    webRef.current?.injectJavaScript(script);
  }, []);

  const publishAuthState = useCallback((state: AuthState, requestId?: string) => {
    authStateRef.current = state;
    sendToWeb({ type: "auth.state", ...(requestId ? { requestId } : {}), payload: state });
  }, [sendToWeb]);

  const establishAuthenticatedSession = useCallback(async (accessToken: string, requestId?: string, notifyWeb = true, expectedOperation = authOperationRef.current): Promise<AuthenticatedApiSession> => {
    const isCurrent = () => expectedOperation === authOperationRef.current;
    if (!isCurrent()) throw new StaleAuthenticationOperationError();
    if (!API_BASE_URL) throw new NativeBoundaryError("AUTH_NOT_CONFIGURED", "AWS API 주소 설정이 필요합니다.", false);
    const bootstrap = await bootstrapApiSession(API_BASE_URL, accessToken);
    if (!isCurrent()) throw new StaleAuthenticationOperationError();
    const session = { apiBaseUrl: API_BASE_URL, accessToken, tenantId: bootstrap.tenantId };
    apiSessionRef.current = session;
    try {
      const stored = await loadPendingClaim(Date.now(), isCurrent);
      if (!isCurrent()) throw new StaleAuthenticationOperationError();
      if (stored?.tenantId === session.tenantId) {
        pendingClaimRef.current = {
          claimId: stored.claimId,
          status: "CLAIM_PENDING",
          expiresAt: stored.expiresAt,
          registrationNonce: stored.registrationNonce,
        };
        pendingClaimSerialRef.current = stored.serial;
        pendingClaimTenantRef.current = stored.tenantId;
      } else {
        pendingClaimRef.current = null;
        pendingClaimSerialRef.current = null;
        pendingClaimTenantRef.current = null;
        if (stored) {
          await clearPendingClaim(isCurrent);
          if (!isCurrent()) throw new StaleAuthenticationOperationError();
        }
      }
    } catch (error) {
      if (!isCurrent() || error instanceof StaleAuthenticationOperationError) throw new StaleAuthenticationOperationError();
      pendingClaimRef.current = null;
      pendingClaimSerialRef.current = null;
      pendingClaimTenantRef.current = null;
    }
    if (isCurrent() && !pendingClaimRef.current && LOCAL_RECOVERY_CLAIM_ID) {
      const claim = await getDeviceClaim(session, LOCAL_RECOVERY_CLAIM_ID);
      if (!isCurrent()) throw new StaleAuthenticationOperationError();
      if (claim.status === "CLAIM_PENDING" || claim.status === "BOOTSTRAPPED" || claim.status === "PROVISIONING" || claim.status === "RUNTIME_AUTHORIZED") {
        pendingClaimRef.current = {
          claimId: claim.claimId,
          status: claim.status,
          expiresAt: claim.expiresAt,
          registrationNonce: "local-recovery-only",
        };
        pendingClaimTenantRef.current = session.tenantId;
      }
    }
    if (!isCurrent()) throw new StaleAuthenticationOperationError();
    if (notifyWeb) {
      publishAuthState({
        status: "signed-in",
        tenantId: bootstrap.tenantId,
        poolId: bootstrap.poolId,
        role: bootstrap.role,
      }, requestId);
    }
    return session;
  }, [publishAuthState]);

  const expireAuthenticatedSession = useCallback(async () => {
    const operation = ++authOperationRef.current;
    const isCurrent = () => operation === authOperationRef.current;
    apiSessionRef.current = null;
    productRegistrationRef.current = null;
    pendingClaimRef.current = null;
    pendingClaimSerialRef.current = null;
    pendingClaimTenantRef.current = null;
    await Promise.all([clearCognitoSession(isCurrent), clearPendingClaim(isCurrent)]);
    if (!isCurrent()) return;
    publishAuthState({ status: "signed-out", message: "로그인이 만료되었습니다. 다시 로그인해주세요." });
  }, [publishAuthState]);

  const refreshAuthenticatedSession = useCallback(async (): Promise<AuthenticatedApiSession | null> => {
    const operation = authOperationRef.current;
    const isCurrent = () => operation === authOperationRef.current;
    const config = cognitoAuthConfig();
    if (!config || !API_BASE_URL) return null;
    const tokens = await refreshCognitoSession(config, isCurrent);
    if (!tokens || !isCurrent()) return null;
    try {
      return await establishAuthenticatedSession(tokens.accessToken, undefined, false, operation);
    } catch (error) {
      if (error instanceof StaleAuthenticationOperationError) return null;
      if (error instanceof ApiRequestError && error.status === 401) return null;
      throw error;
    }
  }, [establishAuthenticatedSession]);

  const runAuthenticatedRequest = useMemo(() => createAuthenticatedRequestRunner<AuthenticatedApiSession>({
    getSession: () => apiSessionRef.current,
    refreshSession: refreshAuthenticatedSession,
    onAuthenticationExpired: expireAuthenticatedSession,
  }), [expireAuthenticatedSession, refreshAuthenticatedSession]);

  const clearPendingClaimContext = useCallback(async (expectedOperation = authOperationRef.current) => {
    const isCurrent = () => expectedOperation === authOperationRef.current;
    if (!isCurrent()) throw new StaleAuthenticationOperationError();
    pendingClaimRef.current = null;
    pendingClaimSerialRef.current = null;
    pendingClaimTenantRef.current = null;
    await clearPendingClaim(isCurrent);
    if (!isCurrent()) throw new StaleAuthenticationOperationError();
  }, []);
  useEffect(() => {
    const operation = ++authOperationRef.current;
    void (async () => {
      let config;
      try {
        config = cognitoAuthConfig();
      } catch {
        publishAuthState({ status: "error", message: "Cognito 주소 설정이 올바르지 않습니다." });
        return;
      }
      if (!config || !API_BASE_URL) {
        publishAuthState({ status: "signed-out", message: "AWS Cognito와 API 설정을 연결하면 로그인할 수 있어요." });
        return;
      }
      publishAuthState({ status: "loading", message: "저장된 로그인을 확인하고 있어요." });
      try {
        const tokens = await restoreCognitoSession(config, () => operation === authOperationRef.current);
        if (operation !== authOperationRef.current) return;
        if (!tokens) {
          publishAuthState({ status: "signed-out" });
          return;
        }
        await establishAuthenticatedSession(tokens.accessToken, undefined, true, operation);
      } catch {
        if (operation !== authOperationRef.current) return;
        apiSessionRef.current = null;
        publishAuthState({ status: "signed-out", message: "로그인이 만료되었습니다. 다시 로그인해주세요." });
      }
    })();
  }, [establishAuthenticatedSession, publishAuthState]);

  const bleRef = useRef<MoodlightBle | null>(null);

  useEffect(() => {
    const ble = new MoodlightBle(sendToWeb, SERVICE_UUID);
    bleRef.current = ble;
    ble.start();
    return () => {
      if (bleRef.current === ble) bleRef.current = null;
      ble.destroy();
      if (Platform.OS === "android") void SecureProvisioning.disconnect().catch(() => {});
    };
  }, [sendToWeb]);

  const onMessage = useCallback(async (event: WebViewMessageEvent) => {
    if (!isAllowedWebMessageUrl(event.nativeEvent.url)) {
      sendToWeb({ type: "bridge.error", payload: { code: "UNTRUSTED_ORIGIN", message: "허용되지 않은 화면의 요청을 차단했습니다.", retryable: false } });
      return;
    }

    let message;
    try {
      message = parseWebMessage(event.nativeEvent.data);
    } catch {
      sendToWeb({ type: "bridge.error", payload: { code: "INVALID_MESSAGE", message: "앱 요청 형식이 올바르지 않습니다.", retryable: false } });
      return;
    }

    if (message.type === "auth.status") {
      sendToWeb({ type: "auth.state", requestId: message.requestId, payload: authStateRef.current });
      return;
    }
    if (message.type === "auth.logout") {
      const operation = ++authOperationRef.current;
      const isCurrent = () => operation === authOperationRef.current;
      apiSessionRef.current = null;
      productRegistrationRef.current = null;
      pendingClaimRef.current = null;
      pendingClaimSerialRef.current = null;
      pendingClaimTenantRef.current = null;
      await clearCognitoSession(isCurrent);
      await clearPendingClaim(isCurrent);
      if (!isCurrent()) return;
      publishAuthState({ status: "signed-out" }, message.requestId);
      return;
    }
    if (message.type === "auth.login") {
      const operation = ++authOperationRef.current;
      publishAuthState({ status: "loading", message: "Cognito 로그인 화면을 열고 있어요." }, message.requestId);
      try {
        const config = cognitoAuthConfig();
        if (!config || !API_BASE_URL) throw new NativeBoundaryError("AUTH_NOT_CONFIGURED", "AWS Cognito와 API 설정이 필요합니다.", false);
        const tokens = await signInWithCognito(config, () => operation === authOperationRef.current);
        if (!tokens || operation !== authOperationRef.current) return;
        await establishAuthenticatedSession(tokens.accessToken, message.requestId, true, operation);
      } catch (error) {
        if (operation !== authOperationRef.current) return;
        apiSessionRef.current = null;
        const boundary = error instanceof NativeBoundaryError || error instanceof ApiRequestError ? error : null;
        const cancelled = error instanceof Error && error.message === "AUTH_CANCELLED";
        const state: AuthState = cancelled
          ? { status: "signed-out", message: "로그인을 취소했습니다." }
          : { status: "error", message: boundary?.message ?? "로그인을 완료하지 못했습니다. 다시 시도해주세요." };
        publishAuthState(state, message.requestId);
      }
      return;
    }

    if (
      message.type === "api.devices.list" ||
      message.type === "api.devices.state.patch" ||
      message.type === "api.devices.release" ||
      message.type === "api.deviceClaims.create" ||
      message.type === "api.deviceClaims.resume" ||
      message.type === "api.deviceClaims.status" ||
      message.type === "api.deviceClaims.finalize" ||
      message.type === "api.schedules.list" ||
      message.type === "api.schedules.create" ||
      message.type === "api.schedules.update" ||
      message.type === "api.schedules.delete" ||
      message.type === "api.schedules.retry"
    ) {
      if (!apiSessionRef.current) {
        sendToWeb({
          type: "bridge.error", requestId: message.requestId,
          payload: { code: "AUTH_REQUIRED", message: "로그인 후 이용할 수 있어요.", retryable: false },
        });
        return;
      }
      const authenticatedOperation = authOperationRef.current;
      try {
        await runAuthenticatedRequest(async (session) => {
          const ensureCurrent = () => {
            if (authenticatedOperation !== authOperationRef.current || apiSessionRef.current !== session) {
              throw new StaleAuthenticationOperationError();
            }
          };
          const current = async <T,>(operation: Promise<T>): Promise<T> => {
            const result = await operation;
            ensureCurrent();
            return result;
          };
          ensureCurrent();
          switch (message.type) {
            case "api.devices.list": {
              const devices = await current(listDevices(session));
              sendToWeb({ type: "api.devices.result", requestId: message.requestId, payload: { devices } });
              break;
            }
            case "api.devices.release": {
              const released = await current(releaseDevice(session, message.payload.deviceId));
              sendToWeb({ type: "api.devices.released", requestId: message.requestId, payload: released });
              break;
            }
            case "api.devices.state.patch": {
              const accepted = await current(patchDeviceState(session, message.payload.deviceId, message.requestId, message.payload.desired));
              sendToWeb({
                type: "api.devices.state.accepted",
                requestId: message.requestId,
                payload: { deviceId: message.payload.deviceId, ...accepted },
              });
              break;
            }
            case "api.schedules.list": {
              const schedules = await current(listSchedules(session));
              sendToWeb({ type: "api.schedules.result", requestId: message.requestId, payload: { schedules } });
              break;
            }
            case "api.schedules.create": {
              const schedule = await current(createSchedule(session, message.payload));
              sendToWeb({ type: "api.schedules.mutation.result", requestId: message.requestId, payload: { operation: "create", schedule } });
              break;
            }
            case "api.schedules.update": {
              const schedule = await current(updateSchedule(session, message.payload.scheduleId, message.payload.expectedRevision, message.payload.patch));
              sendToWeb({ type: "api.schedules.mutation.result", requestId: message.requestId, payload: { operation: "update", schedule } });
              break;
            }
            case "api.schedules.delete": {
              const result = await current(scheduleAction(session, "delete", message.payload.scheduleId, message.payload.expectedRevision));
              if (!("deleted" in result)) throw new Error("invalid-schedule-delete-response");
              sendToWeb({ type: "api.schedules.mutation.result", requestId: message.requestId, payload: { operation: "delete", scheduleId: message.payload.scheduleId, ...result } });
              break;
            }
            case "api.schedules.retry": {
              const schedule = await current(scheduleAction(session, "retry", message.payload.scheduleId, message.payload.expectedRevision));
              if ("deleted" in schedule) throw new Error("invalid-schedule-retry-response");
              sendToWeb({ type: "api.schedules.mutation.result", requestId: message.requestId, payload: { operation: "retry", schedule } });
              break;
            }
            case "api.deviceClaims.create": {
              const registration = productRegistrationRef.current;
              if (!registration) throw new NativeBoundaryError("PRODUCT_QR_REQUIRED", "제품 등록 정보가 포함된 QR을 먼저 확인해주세요.", false);
              let claim = pendingClaimRef.current;
              const expiresAt = claim ? Date.parse(claim.expiresAt) : Number.NaN;
              const reusable = claim !== null &&
                pendingClaimSerialRef.current === registration.serial &&
                pendingClaimTenantRef.current === session.tenantId &&
                claim.status === "CLAIM_PENDING" &&
                Number.isFinite(expiresAt) &&
                expiresAt > Date.now();
              if (!reusable) {
                if (claim) await current(clearPendingClaimContext(authenticatedOperation));
                claim = await current(createDeviceClaim(session, message.payload.poolId, registration));
                pendingClaimRef.current = claim;
                pendingClaimSerialRef.current = registration.serial;
                pendingClaimTenantRef.current = session.tenantId;
              }
              if (!claim) throw new Error("invalid-claim-context");
              const saved = await current(savePendingClaim({
                tenantId: session.tenantId,
                serial: registration.serial,
                claimId: claim.claimId,
                expiresAt: claim.expiresAt,
                registrationNonce: claim.registrationNonce,
              }, () => authenticatedOperation === authOperationRef.current && apiSessionRef.current === session));
              if (!saved) throw new StaleAuthenticationOperationError();
              const ble = bleRef.current;
              if (!ble) throw new NativeBoundaryError("BLE_UNAVAILABLE", "기기 보안 연결을 사용할 수 없습니다.", true);
              const bound = await current(ble.bindClaim(
                message,
                message.payload.deviceId,
                () => SecureProvisioning.bindDeviceClaim(
                  message.payload.deviceId,
                  claim.claimId,
                  claim.registrationNonce,
                ).then(() => undefined),
              ));
              if (!bound) break;
              productRegistrationRef.current = null;
              sendToWeb({
                type: "api.deviceClaims.created",
                requestId: message.requestId,
                payload: { claimId: claim.claimId, status: claim.status },
              });
              break;
            }
            case "api.deviceClaims.resume": {
              const pending = pendingClaimRef.current;
              if (!pending) {
                sendToWeb({ type: "api.deviceClaims.resumed", requestId: message.requestId, payload: { claim: null } });
                break;
              }
              try {
                const claim = await current(getDeviceClaim(session, pending.claimId));
                if (pendingClaimRef.current?.claimId === claim.claimId) {
                  pendingClaimRef.current = { ...pendingClaimRef.current, status: claim.status };
                }
                if (claim.status === "ONLINE" || claim.status === "FAILED" || claim.status === "EXPIRED" || claim.status === "REVOKED") {
                  await current(clearPendingClaimContext(authenticatedOperation));
                }
                sendToWeb({
                  type: "api.deviceClaims.resumed", requestId: message.requestId,
                  payload: { claim: { claimId: claim.claimId, status: claim.status } },
                });
              } catch (error) {
                ensureCurrent();
                if (error instanceof ApiRequestError && error.status === 404) {
                  await current(clearPendingClaimContext(authenticatedOperation));
                  sendToWeb({ type: "api.deviceClaims.resumed", requestId: message.requestId, payload: { claim: null } });
                  break;
                }
                throw error;
              }
              break;
            }
            case "api.deviceClaims.status": {
              const claim = await current(getDeviceClaim(session, message.payload.claimId));
              if (pendingClaimRef.current?.claimId === claim.claimId) {
                pendingClaimRef.current = { ...pendingClaimRef.current, status: claim.status };
              }
              if (claim.status === "ONLINE" || claim.status === "FAILED" || claim.status === "EXPIRED" || claim.status === "REVOKED") {
                await current(clearPendingClaimContext(authenticatedOperation));
              }
              sendToWeb({
                type: "api.deviceClaims.status.result", requestId: message.requestId,
                payload: { claimId: claim.claimId, status: claim.status },
              });
              break;
            }
            case "api.deviceClaims.finalize": {
              if (pendingClaimRef.current?.claimId !== message.payload.claimId) {
                throw new NativeBoundaryError("CLAIM_CONTEXT_REQUIRED", "현재 앱에서 시작한 등록만 완료할 수 있어요.", false);
              }
              const claim = await current(finalizeDeviceClaim(session, message.payload.claimId));
              if (pendingClaimRef.current?.claimId === claim.claimId) {
                pendingClaimRef.current = { ...pendingClaimRef.current, status: claim.status };
              }
              if (claim.status === "ONLINE") {
                await current(clearPendingClaimContext(authenticatedOperation));
              }
              sendToWeb({
                type: "api.deviceClaims.finalized", requestId: message.requestId,
                payload: { claimId: claim.claimId, status: claim.status },
              });
              break;
            }
          }
        });
      } catch (error) {
        if (error instanceof StaleAuthenticationOperationError || authenticatedOperation !== authOperationRef.current) return;
        const boundary = error instanceof NativeBoundaryError || error instanceof ApiRequestError
          ? error
          : error instanceof AuthenticationExpiredError
            ? new NativeBoundaryError("AUTH_REQUIRED", "로그인이 만료되었습니다. 다시 로그인해주세요.", false)
            : null;
        sendToWeb({
          type: "bridge.error", requestId: message.requestId,
          payload: {
            code: boundary?.code ?? "API_REQUEST_FAILED",
            message: boundary?.message ?? "서버 요청을 완료하지 못했어요.",
            retryable: boundary?.retryable ?? true,
          },
        });
      }
      return;
    }
    const ble = bleRef.current;
    if (!ble) return;

    try {
      switch (message.type) {
        case "bridge.ready":
          sendToWeb({ type: "bridge.hello", payload: { platform: Platform.OS === "ios" ? "ios" : "android", bleAvailable: true } });
          sendToWeb({ type: "auth.state", payload: authStateRef.current });
          sendToWeb(ble.snapshot());
          return;
        case "app.openSettings":
          await Linking.openSettings();
          return;
        case "ble.scan":
          productRegistrationRef.current = null;
          testQrSessionRef.current = false;
          if (!(await requestBlePermissions())) {
            sendToWeb({ type: "ble.state", payload: { state: "unauthorized" } });
            return;
          }
          await ble.scan(message, message.payload?.timeoutMs ?? 20_000);
          return;
        case "ble.cancelScan":
          ble.cancelScan(message);
          return;
        case "ble.connect":
          {
            const device = await ble.connect(message, message.payload.deviceId);
            if (!device) return;
            if (Platform.OS !== "android") {
              ble.secureConnectionFailed(message);
              return;
            }
            try {
              const qr = await SecureProvisioning.scanQrAndConnectAndPing(
                message.payload.deviceId,
                device.name ?? "",
                SERVICE_UUID,
              );
              productRegistrationRef.current = qr.mode === "product"
                ? { serial: qr.serial, registrationCode: qr.registrationCode }
                : null;
              testQrSessionRef.current = qr.mode === "test";
            } catch {
              // QR 등록 비밀이나 네이티브 예외 원문을 JS/WebView로 전달하지 않는다.
              ble.secureConnectionFailed(message);
              return;
            }
            ble.secureConnectionSucceeded(message, device);
          }
          return;
        case "ble.disconnect":
          if (!ble.disconnect(message, message.payload?.deviceId)) return;
          if (Platform.OS === "android") await SecureProvisioning.disconnect();
          return;
        case "wifi.scan":
          await ble.scanWifi(
            message,
            message.payload.deviceId,
            () => SecureProvisioning.scanWifiNetworks(),
          );
          return;
        case "wifi.provision": {
          const claim = pendingClaimRef.current;
          if (!claim && !(LOCAL_PROVISIONING_TEST_MODE && testQrSessionRef.current)) {
            message.payload.password = "";
            sendToWeb({
              type: "bridge.error", requestId: message.requestId, attemptId: message.attemptId,
              payload: { code: "CLAIM_REQUIRED", message: "서버 기기 등록을 먼저 시작해주세요.", retryable: false },
            });
            return;
          }
          try {
            await ble.provision(
              message,
              message.payload,
              () => SecureProvisioning.provisionWifi(
                message.payload.deviceId,
                message.payload.ssid,
                message.payload.password,
              ).then(() => undefined),
            );
          } finally {
            // WebView에서 받은 비밀번호 참조를 네이티브 호출이 끝난 즉시 비운다.
            message.payload.password = "";
            testQrSessionRef.current = false;
          }
          return;
        }
      }
    } catch {
      // 원본 메시지에는 Wi-Fi 비밀번호와 nonce가 있을 수 있으므로 로그에 출력하지 않는다.
      sendToWeb({
        type: "bridge.error",
        ...(message.type === "bridge.ready" || message.type === "app.openSettings" ? {} : { requestId: message.requestId, attemptId: message.attemptId }),
        payload: { code: "NATIVE_OPERATION_FAILED", message: "기기 작업을 완료하지 못했습니다.", retryable: true },
      });
    }
  }, [clearPendingClaimContext, establishAuthenticatedSession, isAllowedWebMessageUrl, publishAuthState, runAuthenticatedRequest, sendToWeb]);

  const allowNavigation = useCallback((request: ShouldStartLoadRequest) => {
    return isAllowedWebUrl(request.url);
  }, [isAllowedWebUrl]);

  if (!EMBEDDED_WEBAPP && !allowedOrigin) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.errorPage}>
          <Text style={styles.errorTitle}>웹앱 주소 설정이 필요합니다.</Text>
          <Text style={styles.errorText}>배포 앱은 HTTPS의 EXPO_PUBLIC_WEBAPP_URL만 사용할 수 있습니다.</Text>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <StatusBar style="dark" />
        <WebView<object>
          ref={webRef}
          source={{ uri: WEBAPP_URL }}
          originWhitelist={WEBVIEW_ORIGIN_WHITELIST}
          onShouldStartLoadWithRequest={allowNavigation}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="never"
          allowFileAccess={EMBEDDED_WEBAPP}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          style={styles.webview}
        />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fcfbfd" },
  webview: { flex: 1, backgroundColor: "#fcfbfd" },
  errorPage: { flex: 1, justifyContent: "center", padding: 28, backgroundColor: "#fcfbfd" },
  errorTitle: { color: "#17151d", fontSize: 22, fontWeight: "800", marginBottom: 10 },
  errorText: { color: "#77717f", fontSize: 15, lineHeight: 23 },
});
