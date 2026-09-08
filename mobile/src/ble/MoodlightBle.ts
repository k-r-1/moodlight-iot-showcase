import {
  BleManager,
  type Device,
  type Subscription,
  State,
} from "react-native-ble-plx";
import type {
  BleAdapterState,
  NativeToWebMessage,
  NearbyDevice,
  ProvisioningStage,
  WifiNetwork,
} from "../protocol";

type Send = (message: NativeToWebMessage) => void;
type Context = { requestId: string; attemptId: string };

const DISCOVERY_DEVICE_PREFIX = "Moodlight-";

function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function adapterState(state: State): BleAdapterState {
  switch (state) {
    case State.PoweredOn: return "powered-on";
    case State.PoweredOff: return "powered-off";
    case State.Unauthorized: return "unauthorized";
    case State.Unsupported: return "unsupported";
    default: return "unknown";
  }
}

function wifiProvisionFailure(error: unknown): {
  code: string;
  message: string;
} {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  switch (code) {
    case "WIFI_AUTH_FAILED":
      return { code, message: "Wi-Fi 비밀번호를 확인해주세요." };
    case "WIFI_NOT_FOUND":
      return { code, message: "선택한 Wi-Fi를 찾지 못했습니다." };
    case "BLE_DISCONNECTED":
      return { code, message: "Wi-Fi 연결 확인 중 기기 연결이 끊겼습니다." };
    case "WIFI_PROVISION_TIMEOUT":
      return { code, message: "Wi-Fi 연결 확인 시간이 초과되었습니다." };
    case "WIFI_CONFIG_SEND_FAILED":
      return { code, message: "Wi-Fi 정보를 기기에 전달하지 못했습니다." };
    case "WIFI_CONFIG_APPLY_FAILED":
      return { code, message: "기기가 Wi-Fi 설정을 적용하지 못했습니다." };
    case "SECURITY2_FAILED":
      return { code, message: "기기 보안 세션을 사용할 수 없습니다." };
    case "CLAIM_BIND_REQUIRED":
      return { code, message: "기기 등록 정보 확인을 먼저 완료해주세요." };
    default:
      return { code: "WIFI_PROVISION_FAILED", message: "기기가 Wi-Fi에 연결되지 못했습니다." };
  }
}

function claimBindingFailure(error: unknown): { code: string; message: string } {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  switch (code) {
    case "CLAIM_BIND_TIMEOUT":
      return { code, message: "기기 등록 정보 확인 시간이 초과되었습니다." };
    case "CLAIM_BIND_ACK_INVALID":
      return { code, message: "기기의 등록 확인 응답이 올바르지 않습니다." };
    case "CLAIM_BIND_SEND_FAILED":
      return { code, message: "기기에 등록 정보를 전달하지 못했습니다." };
    case "CLAIM_BIND_SESSION_MISMATCH":
      return { code, message: "현재 기기 보안 연결에서 등록을 다시 시작해주세요." };
    case "INVALID_CLAIM_BINDING":
      return { code, message: "서버 기기 등록 정보 형식이 올바르지 않습니다." };
    case "CLAIM_ALREADY_BOUND":
      return { code, message: "현재 기기 연결은 다른 등록 요청에 결속되어 있습니다." };
    case "CLAIM_BIND_BUSY":
      return { code, message: "다른 기기 작업이 진행 중입니다." };
    case "CLAIM_BIND_NOT_REQUIRED":
      return { code, message: "로컬 시험 기기에는 서버 등록을 적용하지 않습니다." };
    case "BLE_DISCONNECTED":
      return { code, message: "기기 등록 정보를 확인하는 중 연결이 끊겼습니다." };
    default:
      return { code: "CLAIM_BIND_FAILED", message: "기기 등록 정보를 확인하지 못했습니다." };
  }
}

function nearby(device: Device): NearbyDevice {
  return {
    id: device.id,
    name: device.localName ?? device.name ?? null,
    rssi: device.rssi ?? null,
    serviceUuids: device.serviceUUIDs ?? [],
  };
}

/**
 * Discovery-only BLE owner.
 *
 * react-native-ble-plx releases scanning before the Espressif native module
 * owns the GATT connection and Security 2 session.
 */
export class MoodlightBle {
  private readonly manager = new BleManager();
  private state: BleAdapterState = "unknown";
  private activeAttemptId: string | null = null;
  private stage: ProvisioningStage = "idle";
  private stateSubscription: Subscription | null = null;
  private operationVersion = 0;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedDevice: NearbyDevice | null = null;
  private readonly discoveredDevices = new Map<string, NearbyDevice>();

  constructor(
    private readonly send: Send,
    private readonly serviceUuid: string,
  ) {}

  start(): void {
    this.stateSubscription = this.manager.onStateChange((state) => {
      this.state = adapterState(state);
      this.send({ type: "ble.state", payload: { state: this.state } });
    }, true);
  }

  snapshot(): NativeToWebMessage {
    return {
      type: "bridge.snapshot",
      payload: {
        bleState: this.state,
        connectedDevice: this.connectedDevice,
        activeAttemptId: this.activeAttemptId,
        stage: this.stage,
      },
    };
  }

  async scan(ctx: Context, timeoutMs: number): Promise<void> {
    this.requireConfig(ctx);
    const version = ++this.operationVersion;
    this.stopScan();
    this.activeAttemptId = ctx.attemptId;
    this.stage = "scanning";
    this.discoveredDevices.clear();
    this.send({ ...ctx, type: "ble.scanning", payload: { active: true } });

    // Android BLE advertisements can omit the service UUID. Scan broadly,
    // but expose only the agreed service or exact setup name to the WebView.
    const scanStart = this.manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (version !== this.operationVersion || this.activeAttemptId !== ctx.attemptId || this.stage !== "scanning") return;
      if (error) {
        this.stopScan();
        this.stage = "failed";
        this.error(ctx, "BLE_SCAN_FAILED", "기기 검색을 시작하지 못했습니다.", true);
        return;
      }
      if (!device) return;
      const advertisesService = (device.serviceUUIDs ?? []).some((uuid) => sameUuid(uuid, this.serviceUuid));
      const hasDiscoveryName = (device.localName ?? device.name)?.startsWith(DISCOVERY_DEVICE_PREFIX) === true;
      if ((advertisesService || hasDiscoveryName) && !this.discoveredDevices.has(device.id)) {
        const found = nearby(device);
        this.discoveredDevices.set(device.id, found);
        this.send({ ...ctx, type: "ble.deviceFound", payload: found });
      }
    });

    this.scanTimer = setTimeout(() => {
      if (version !== this.operationVersion || this.activeAttemptId !== ctx.attemptId || this.stage !== "scanning") return;
      this.stopScan();
      this.stage = "idle";
      this.send({ ...ctx, type: "ble.scanning", payload: { active: false } });
    }, timeoutMs);

    // Some Android stacks keep this promise pending until the scan stops.
    void scanStart.catch(() => {
      if (version !== this.operationVersion || this.activeAttemptId !== ctx.attemptId || this.stage !== "scanning") return;
      this.stopScan();
      this.stage = "failed";
      this.error(ctx, "BLE_SCAN_FAILED", "기기 검색을 시작하지 못했습니다.", true);
    });
  }

  cancelScan(ctx: Context): void {
    if (this.activeAttemptId !== ctx.attemptId || this.stage !== "scanning") return;
    ++this.operationVersion;
    this.stopScan();
    this.stage = "cancelled";
    this.send({ ...ctx, type: "ble.scanning", payload: { active: false } });
  }

  async connect(ctx: Context, deviceId: string): Promise<NearbyDevice | null> {
    const found = this.discoveredDevices.get(deviceId);
    if (
      this.activeAttemptId !== ctx.attemptId ||
      !found ||
      (this.stage !== "scanning" && this.stage !== "idle")
    ) {
      this.error(ctx, "BLE_DEVICE_NOT_FOUND", "현재 검색에서 찾은 기기만 연결할 수 있습니다.", true);
      return null;
    }
    ++this.operationVersion;
    this.stopScan();
    this.discoveredDevices.clear();
    this.activeAttemptId = ctx.attemptId;
    this.stage = "connecting";
    this.send({ ...ctx, type: "ble.connecting", payload: { deviceId } });
    return found;
  }

  secureConnectionSucceeded(ctx: Context, device: NearbyDevice): void {
    if (this.activeAttemptId !== ctx.attemptId) return;
    this.connectedDevice = device;
    this.stage = "secure-session";
    this.send({ ...ctx, type: "ble.connected", payload: { device } });
  }

  secureConnectionFailed(ctx: Context): void {
    if (this.activeAttemptId !== ctx.attemptId) return;
    this.stage = "failed";
    this.error(ctx, "SECURITY2_FAILED", "QR 확인 또는 기기 보안 연결을 완료하지 못했습니다.", true);
  }

  async bindClaim(
    ctx: Context,
    deviceId: string,
    bind: () => Promise<void>,
  ): Promise<boolean> {
    if (
      this.activeAttemptId !== ctx.attemptId ||
      this.stage !== "secure-session" ||
      this.connectedDevice?.id !== deviceId
    ) {
      this.error(ctx, "CLAIM_BIND_SESSION_MISMATCH", "현재 기기 보안 연결에서 등록을 다시 시작해주세요.", false);
      return false;
    }

    const version = ++this.operationVersion;
    this.stage = "provisioning";
    try {
      await bind();
      if (version !== this.operationVersion || this.activeAttemptId !== ctx.attemptId || this.connectedDevice?.id !== deviceId || this.stage !== "provisioning") return false;
      this.stage = "secure-session";
      return true;
    } catch (error) {
      if (version !== this.operationVersion || this.activeAttemptId !== ctx.attemptId || this.connectedDevice?.id !== deviceId || this.stage !== "provisioning") return false;
      const failure = claimBindingFailure(error);
      this.connectedDevice = null;
      this.stage = "failed";
      this.error(ctx, failure.code, failure.message, true);
      return false;
    }
  }

  disconnect(ctx: Context, _deviceId?: string): boolean {
    if (this.activeAttemptId !== ctx.attemptId) return false;
    ++this.operationVersion;
    this.stopScan();
    this.discoveredDevices.clear();
    this.connectedDevice = null;
    this.activeAttemptId = null;
    this.stage = "idle";
    this.send({ ...ctx, type: "ble.disconnected" });
    return true;
  }

  async scanWifi(
    ctx: Context,
    deviceId: string,
    scan: () => Promise<WifiNetwork[]>,
  ): Promise<void> {
    if (
      this.activeAttemptId !== ctx.attemptId ||
      this.stage !== "secure-session" ||
      this.connectedDevice?.id !== deviceId
    ) {
      this.error(ctx, "SECURE_SESSION_REQUIRED", "먼저 기기 보안 연결을 완료해주세요.", false);
      return;
    }

    const version = ++this.operationVersion;
    this.stage = "wifi";
    try {
      const networks = await scan();
      if (version !== this.operationVersion || this.activeAttemptId !== ctx.attemptId || this.stage !== "wifi") return;
      this.stage = "secure-session";
      this.send({ ...ctx, type: "wifi.networks", payload: { networks } });
    } catch {
      if (version !== this.operationVersion || this.activeAttemptId !== ctx.attemptId || this.stage !== "wifi") return;
      this.stage = "failed";
      this.error(ctx, "WIFI_SCAN_FAILED", "기기에서 Wi-Fi 목록을 가져오지 못했습니다.", true);
    }
  }

  async provision(
    ctx: Context,
    payload: {
      deviceId: string;
      ssid: string;
      password: string;
      secure: boolean;
    },
    provisionWifi: () => Promise<void>,
  ): Promise<void> {
    if (
      this.activeAttemptId !== ctx.attemptId ||
      this.stage !== "secure-session" ||
      this.connectedDevice?.id !== payload.deviceId
    ) {
      this.error(ctx, "SECURE_SESSION_REQUIRED", "먼저 현재 기기의 보안 연결을 완료해주세요.", false);
      return;
    }

    const version = ++this.operationVersion;
    this.stage = "provisioning";
    this.send({ ...ctx, type: "provision.progress", payload: { stage: "provisioning", message: "Wi-Fi 정보를 기기에 안전하게 전달하고 있어요." } });
    try {
      await provisionWifi();
      if (version !== this.operationVersion || this.activeAttemptId !== ctx.attemptId || this.stage !== "provisioning") return;
      this.connectedDevice = null;
      this.stage = "wifi-connected";
      this.send({ ...ctx, type: "provision.progress", payload: { stage: "wifi-connected", message: "무드등의 Wi-Fi 연결을 확인했습니다." } });
    } catch (error) {
      if (version !== this.operationVersion || this.activeAttemptId !== ctx.attemptId || this.stage !== "provisioning") return;
      const failure = wifiProvisionFailure(error);
      this.connectedDevice = null;
      this.stage = "failed";
      this.error(ctx, failure.code, failure.message, true);
    }
  }

  destroy(): void {
    ++this.operationVersion;
    this.stopScan();
    this.stateSubscription?.remove();
    this.discoveredDevices.clear();
    this.connectedDevice = null;
    try {
      void Promise.resolve(this.manager.destroy()).catch(() => {});
    } catch { /* already destroyed */ }
  }

  private requireConfig(ctx: Context): void {
    if (!this.serviceUuid) {
      this.error(ctx, "BLE_CONFIG_MISSING", "펌웨어와 합의한 BLE UUID 설정이 필요합니다.", false);
      throw new Error("BLE_CONFIG_MISSING");
    }
  }

  private stopScan(): void {
    if (this.scanTimer !== null) clearTimeout(this.scanTimer);
    this.scanTimer = null;
    try {
      void Promise.resolve(this.manager.stopDeviceScan()).catch(() => {});
    } catch { /* scan not started or already stopped */ }
  }

  private error(ctx: Partial<Context>, code: string, message: string, retryable: boolean): void {
    this.send({ ...ctx, type: "bridge.error", payload: { code, message, retryable } });
  }
}
