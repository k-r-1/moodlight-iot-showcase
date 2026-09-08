"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { isNativeApp, postToNative, type AuthState, type NativeToWebMessage, type WebToNativeMessage } from "@/lib/bridge";
import { parseDeviceList, toDeviceState } from "@/lib/devices";
import { acceptsStateAccepted, commandApplied, desiredFromDraft, desiredMatchesDevice, draftFromDevice, hasPendingDesired, type DeviceControlDraft, type PendingDeviceStateRequest } from "@/lib/device-control";
import { acceptsScheduleResult, newScheduleDraft, parseSchedule, parseScheduleList, scheduleDays, scheduleWritePayload, weekdays, type ApiSchedule, type PendingScheduleMutation, type ScheduleDraft, type ScheduleOperation } from "@/lib/schedules";
import type { DeviceState, NearbyDevice, ProvisioningStage, WifiNetwork } from "@/lib/types";
import { acceptsNativeResponse, bleBlockReason as getBleBlockReason, isCurrentAttempt, wifiFailureKind, type BleBlockReason, type PendingRequests, type RegistrationRequest, type WifiFailureKind } from "@/lib/registration";

type Screen = "login" | "home" | "device" | "add" | "schedules";
type WifiScanState = "idle" | "loading" | "ready";
type DeviceListState = "idle" | "loading" | "ready" | "error";
type DeviceControlStatus = "idle" | "pending" | "accepted" | "confirmed" | "error";
type ScheduleListState = "idle" | "loading" | "ready" | "error";
type ScheduleActionStatus = "idle" | "pending" | "success" | "error";

const initialDevices: DeviceState[] = [
  {
    id: "d-dev-moodlamp-demo01",
    name: "거실 무드등",
    room: "거실",
    online: true,
    power: true,
    color: "#ff9f68",
    brightness: 72,
  },
  {
    id: "d-dev-moodlamp-demo02",
    name: "침실 무드등",
    room: "침실",
    online: false,
    power: false,
    color: "#8d7cff",
    brightness: 38,
  },
];

const presets = [
  { name: "빨강", value: "#ff0000" },
  { name: "초록", value: "#00ff00" },
  { name: "파랑", value: "#0000ff" },
  { name: "노랑", value: "#ffff00" },
  { name: "주황", value: "#ff7a00" },
  { name: "흰색", value: "#ffffff" },
];
const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
const hardwareTestMode = !demoMode && process.env.NEXT_PUBLIC_HARDWARE_TEST_MODE === "true";
const deviceReleaseEnabled = process.env.NEXT_PUBLIC_ENABLE_DEVICE_RELEASE === "true";

function newId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
}

function scheduleStatusLabel(schedule: ApiSchedule): string {
  if (schedule.syncStatus === "PENDING_SYNC") return "동기화 대기";
  if (schedule.syncStatus === "DELETE_PENDING") return "삭제 대기";
  if (schedule.syncStatus === "ERROR") return "동기화 오류";
  return schedule.enabled ? "활성" : "비활성";
}

function scheduleColor(schedule: ApiSchedule): string | null {
  const { red, green, blue } = schedule.desiredState;
  if (red === undefined || green === undefined || blue === undefined) return null;
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function LampGlyph({ color, on }: { color: string; on: boolean }) {
  return (
    <div className={`lamp ${on ? "lampOn" : ""}`} style={{ "--lamp-color": color } as React.CSSProperties}>
      <span className="lampShade" />
      <span className="lampStem" />
      <span className="lampBase" />
    </div>
  );
}

export default function HomePage() {
  const [screen, setScreen] = useState<Screen>("login");
  const [devices, setDevices] = useState<DeviceState[]>(demoMode ? initialDevices : []);
  const [selectedId, setSelectedId] = useState(demoMode ? initialDevices[0].id : "");
  const selectedIdRef = useRef(selectedId);
  const [deviceListState, setDeviceListState] = useState<DeviceListState>(demoMode ? "ready" : "idle");
  const [deviceListError, setDeviceListError] = useState("");
  const deviceListRequestRef = useRef<string | null>(null);
  const [controlDraft, setControlDraft] = useState<DeviceControlDraft | null>(null);
  const [controlStatus, setControlStatus] = useState<DeviceControlStatus>("idle");
  const [controlMessage, setControlMessage] = useState("");
  const controlRequestRef = useRef<PendingDeviceStateRequest | null>(null);
  const controlTimeoutRef = useRef<number | null>(null);
  const controlPollTimeoutRef = useRef<number | null>(null);
  const controlPollCountRef = useRef(0);
  const [releaseConfirm, setReleaseConfirm] = useState(false);
  const [releaseStatus, setReleaseStatus] = useState<"idle" | "pending" | "error">("idle");
  const [releaseMessage, setReleaseMessage] = useState("");
  const releaseRequestRef = useRef<{ requestId: string; deviceId: string } | null>(null);
  const [schedules, setSchedules] = useState<ApiSchedule[]>([]);
  const [scheduleListState, setScheduleListState] = useState<ScheduleListState>(demoMode ? "ready" : "idle");
  const [scheduleListError, setScheduleListError] = useState("");
  const scheduleListRequestRef = useRef<string | null>(null);
  const [scheduleFormOpen, setScheduleFormOpen] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => newScheduleDraft(demoMode ? initialDevices[0] : undefined));
  const [scheduleActionStatus, setScheduleActionStatus] = useState<ScheduleActionStatus>("idle");
  const [scheduleActionMessage, setScheduleActionMessage] = useState("");
  const scheduleMutationRef = useRef<PendingScheduleMutation | null>(null);
  const scheduleTimeoutRef = useRef<number | null>(null);
  const scheduleRetryRef = useRef<(() => void) | null>(null);
  const [native, setNative] = useState(false);
  const [authState, setAuthState] = useState<AuthState>(demoMode || hardwareTestMode
    ? { status: "signed-in", tenantId: "local-test", poolId: "default", role: "OWNER" }
    : { status: "signed-out" });
  const authRequestRef = useRef<string | null>(null);
  const authGenerationRef = useRef(0);
  const authenticatedRef = useRef(demoMode || hardwareTestMode);
  const poolIdRef = useRef(demoMode || hardwareTestMode ? "default" : "");
  const claimIdRef = useRef<string | null>(null);
  const claimDeviceRef = useRef<NearbyDevice | null>(null);
  const claimCreateRequestRef = useRef<string | null>(null);
  const claimResumeRequestRef = useRef<string | null>(null);
  const claimStatusRequestRef = useRef<string | null>(null);
  const claimFinalizeRequestRef = useRef<string | null>(null);
  const claimPollTimeoutRef = useRef<number | null>(null);
  const claimPollCountRef = useRef(0);
  const [fleetRetryAvailable, setFleetRetryAvailable] = useState(false);
  const [stage, setStage] = useState<ProvisioningStage>("idle");
  const [nearby, setNearby] = useState<NearbyDevice[]>([]);
  const [bleScanEmpty, setBleScanEmpty] = useState(false);
  const [bleBlockReason, setBleBlockReason] = useState<BleBlockReason>(null);
  const [connected, setConnected] = useState<NearbyDevice | null>(null);
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [wifiScanState, setWifiScanState] = useState<WifiScanState>("idle");
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [progress, setProgress] = useState("");
  const [wifiFailure, setWifiFailure] = useState<WifiFailureKind | null>(null);
  const attemptRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingRequests>(new Map());
  const bleDeviceFoundRef = useRef(false);

  function sendRequest(message: RegistrationRequest): boolean {
    pendingRef.current.set(message.type, message.requestId);
    return postToNative(message);
  }

  const selected = useMemo(
    () => devices.find((device) => device.id === selectedId) ?? devices[0],
    [devices, selectedId],
  );
  const selectedNetwork = useMemo(
    () => networks.find((network) => network.ssid === ssid) ?? null,
    [networks, ssid],
  );
  const shownControl = selected ? (demoMode ? draftFromDevice(selected) : controlDraft ?? draftFromDevice(selected)) : null;
  const controlLocked = !demoMode && (
    controlStatus === "pending"
    || controlStatus === "accepted"
    || selected?.online !== true
  );
  const controlChanged = Boolean(selected && shownControl && !desiredMatchesDevice(desiredFromDraft(shownControl), selected));
  const controlPreview = !demoMode && controlChanged ? shownControl : null;

  function loadDevices() {
    if (demoMode || deviceListRequestRef.current) return;
    const requestId = newId("device-list");
    deviceListRequestRef.current = requestId;
    setDeviceListState("loading");
    setDeviceListError("");
    if (!postToNative({ type: "api.devices.list", requestId })) {
      deviceListRequestRef.current = null;
      setDeviceListState("error");
      setDeviceListError("기기 목록은 무드등 모바일 앱에서 불러올 수 있어요.");
    }
  }

  function loadSchedules() {
    if (demoMode || scheduleListState === "loading") return;
    const requestId = newId("schedule-list");
    scheduleListRequestRef.current = requestId;
    setScheduleListState("loading");
    setScheduleListError("");
    if (!postToNative({ type: "api.schedules.list", requestId })) {
      scheduleListRequestRef.current = null;
      setScheduleListState("error");
      setScheduleListError("예약 목록은 무드등 모바일 앱에서 불러올 수 있어요.");
    }
  }

  function openSchedules() {
    if (!demoMode) {
      loadSchedules();
      if (deviceListState === "idle") loadDevices();
    }
    setScreen("schedules");
  }

  function clearScheduleMutation() {
    scheduleMutationRef.current = null;
    if (scheduleTimeoutRef.current) clearTimeout(scheduleTimeoutRef.current);
    scheduleTimeoutRef.current = null;
  }

  function sendScheduleMutation(pending: PendingScheduleMutation, message: WebToNativeMessage, retry: () => void) {
    if (scheduleMutationRef.current) return;
    clearScheduleMutation();
    scheduleMutationRef.current = pending;
    scheduleRetryRef.current = retry;
    setScheduleActionStatus("pending");
    setScheduleActionMessage("예약 요청을 보내고 있어요.");
    if (!postToNative(message)) {
      scheduleMutationRef.current = null;
      setScheduleActionStatus("error");
      setScheduleActionMessage("예약을 변경하려면 무드등 모바일 앱을 사용해주세요.");
      return;
    }
    scheduleTimeoutRef.current = window.setTimeout(() => {
      if (scheduleMutationRef.current?.requestId !== pending.requestId) return;
      scheduleMutationRef.current = null;
      scheduleTimeoutRef.current = null;
      setScheduleActionStatus("error");
      if (pending.operation === "create") {
        scheduleRetryRef.current = null;
        setScheduleFormOpen(false);
        setScheduleActionMessage("예약 저장 여부를 확인하기 위해 목록을 다시 불러옵니다.");
        loadSchedules();
      } else {
        setScheduleActionMessage("모바일 앱의 예약 응답을 확인하지 못했습니다. 다시 시도해주세요.");
      }
    }, 15_000);
  }

  function createSchedule() {
    let payload;
    try { payload = scheduleWritePayload(scheduleDraft); }
    catch { setScheduleActionStatus("error"); setScheduleActionMessage("예약 이름·기기·시간·요일을 확인해 주세요."); return; }
    const requestId = newId("schedule-create");
    sendScheduleMutation(
      { requestId, operation: "create", scheduleId: null },
      { type: "api.schedules.create", requestId, payload },
      createSchedule,
    );
  }

  function updateScheduleEnabled(schedule: ApiSchedule, enabled: boolean) {
    const requestId = newId("schedule-update");
    const retry = () => updateScheduleEnabled(schedule, enabled);
    sendScheduleMutation(
      { requestId, operation: "update", scheduleId: schedule.scheduleId, expectedRevision: schedule.revision },
      { type: "api.schedules.update", requestId, payload: { scheduleId: schedule.scheduleId, expectedRevision: schedule.revision, patch: { enabled } } },
      retry,
    );
  }

  function deleteSchedule(schedule: ApiSchedule) {
    const requestId = newId("schedule-delete");
    const retry = () => deleteSchedule(schedule);
    sendScheduleMutation(
      { requestId, operation: "delete", scheduleId: schedule.scheduleId, expectedRevision: schedule.revision },
      { type: "api.schedules.delete", requestId, payload: { scheduleId: schedule.scheduleId, expectedRevision: schedule.revision } },
      retry,
    );
  }

  function retrySchedule(schedule: ApiSchedule) {
    const requestId = newId("schedule-retry");
    const retry = () => retrySchedule(schedule);
    sendScheduleMutation(
      { requestId, operation: "retry", scheduleId: schedule.scheduleId, expectedRevision: schedule.revision },
      { type: "api.schedules.retry", requestId, payload: { scheduleId: schedule.scheduleId, expectedRevision: schedule.revision } },
      retry,
    );
  }

  function editScheduleDraft(patch: Partial<ScheduleDraft>) {
    if (scheduleMutationRef.current) return;
    setScheduleActionStatus("idle");
    setScheduleActionMessage("");
    setScheduleDraft((current) => ({ ...current, ...patch }));
  }

  function login() {
    if (demoMode) {
      setScreen("home");
      return;
    }
    if (hardwareTestMode) {
      setScreen("add");
      return;
    }
    const requestId = newId("auth-login");
    authRequestRef.current = requestId;
    setAuthState({ status: "loading", message: "Cognito 로그인 화면을 열고 있어요." });
    if (!postToNative({ type: "auth.login", requestId })) {
      authRequestRef.current = null;
      setAuthState({ status: "error", message: "로그인은 무드등 모바일 앱에서 진행해주세요." });
    }
  }

  function resumePendingClaim() {
    if (demoMode || hardwareTestMode || claimResumeRequestRef.current) return;
    const requestId = newId("claim-resume");
    claimResumeRequestRef.current = requestId;
    if (!postToNative({ type: "api.deviceClaims.resume", requestId })) claimResumeRequestRef.current = null;
  }

  function requestClaimStatus(delayMs = 0) {
    if (claimPollTimeoutRef.current) clearTimeout(claimPollTimeoutRef.current);
    const authGeneration = authGenerationRef.current;
    claimPollTimeoutRef.current = window.setTimeout(() => {
      if (!authenticatedRef.current || authGeneration !== authGenerationRef.current) return;
      const claimId = claimIdRef.current;
      if (!claimId || claimStatusRequestRef.current) return;
      const requestId = newId("claim-status");
      claimStatusRequestRef.current = requestId;
      postToNative({ type: "api.deviceClaims.status", requestId, payload: { claimId } });
    }, delayMs);
  }

  function finalizeClaim(claimId: string) {
    if (claimFinalizeRequestRef.current) return;
    if (claimPollCountRef.current >= 15) {
      setStage("wifi-connected");
      setFleetRetryAvailable(true);
      setProgress("Wi-Fi 연결은 확인됐지만 AWS Fleet 등록 확인이 지연되고 있어요. 잠시 후 새 등록을 시작해주세요.");
      return;
    }
    claimPollCountRef.current += 1;
    const requestId = newId("claim-finalize");
    claimFinalizeRequestRef.current = requestId;
    setStage("wifi-connected");
    setProgress("기기의 AWS Fleet 등록을 확인하고 소유권을 확정하고 있어요.");
    postToNative({ type: "api.deviceClaims.finalize", requestId, payload: { claimId } });
  }

  function retryFleetRegistration() {
    const claimId = claimIdRef.current;
    if (!claimId || claimFinalizeRequestRef.current) return;
    claimPollCountRef.current = 0;
    setFleetRetryAvailable(false);
    finalizeClaim(claimId);
  }

  function completeServerRegistration() {
    if (claimPollTimeoutRef.current) clearTimeout(claimPollTimeoutRef.current);
    claimPollTimeoutRef.current = null;
    claimStatusRequestRef.current = null;
    claimFinalizeRequestRef.current = null;
    setFleetRetryAvailable(false);
    setStage("complete");
    setProgress("서버 소유권 등록이 완료됐어요. 기기 목록에서 상태를 확인해주세요.");
    setDeviceListState("idle");
  }

  function scanWifiNetworks(device: NearbyDevice, attemptId: string) {
    if (pendingRef.current.has("wifi.scan")) return;
    setWifiScanState("loading");
    setNetworks([]);
    setSsid("");
    setPassword("");
    setProgress("");
    setWifiFailure(null);
    const sent = sendRequest({
      type: "wifi.scan",
      requestId: newId("wifi-scan"),
      attemptId,
      payload: { deviceId: device.id },
    });
    if (!sent) {
      pendingRef.current.delete("wifi.scan");
      setWifiScanState("idle");
      setStage("failed");
      setProgress("Wi-Fi를 찾으려면 무드등 모바일 앱을 사용해주세요.");
    }
  }

  useEffect(() => {
    setNative(isNativeApp());
    window.__moodlightBridge = {
      dispatch(message: NativeToWebMessage) {
        if (message.type === "auth.state") {
          if (message.requestId && authRequestRef.current && message.requestId !== authRequestRef.current) return;
          authRequestRef.current = null;
          setAuthState(message.payload);
          if (message.payload.status === "signed-in") {
            authGenerationRef.current += 1;
            authenticatedRef.current = true;
            poolIdRef.current = message.payload.poolId;
            setScreen("home");
            setDeviceListState("idle");
            resumePendingClaim();
          } else if (!demoMode && !hardwareTestMode && message.payload.status === "signed-out") {
            authGenerationRef.current += 1;
            authenticatedRef.current = false;
            poolIdRef.current = "";
            deviceListRequestRef.current = null;
            releaseRequestRef.current = null;
            clearControlRequest();
            scheduleListRequestRef.current = null;
            clearScheduleMutation();
            scheduleRetryRef.current = null;
            cleanupProvisioning();
            setDevices([]);
            setSchedules([]);
            setSelectedId("");
            selectedIdRef.current = "";
            setDeviceListState("idle");
            setScheduleListState("idle");
            setReleaseStatus("idle");
            setScheduleFormOpen(false);
            setScreen("login");
          }
          return;
        }
        if (message.type.startsWith("api.") && !authenticatedRef.current) return;
        if (message.type === "api.deviceClaims.resumed") {
          if (message.requestId !== claimResumeRequestRef.current) return;
          claimResumeRequestRef.current = null;
          const claim = message.payload.claim;
          if (!claim) return;
          claimIdRef.current = claim.claimId;
          if (claim.status === "CLAIM_PENDING") {
            setScreen("add");
            claimPollCountRef.current = 0;
            setFleetRetryAvailable(false);
            setStage("wifi-connected");
            setProgress("진행 중인 기기 등록의 AWS Fleet 상태를 다시 확인하고 있어요.");
            finalizeClaim(claim.claimId);
          } else if (claim.status === "BOOTSTRAPPED") {
            setScreen("add");
            claimPollCountRef.current = 0;
            setStage("wifi-connected");
            setProgress("기기의 Wi-Fi 연결 기록을 복구했습니다. AWS Fleet 등록을 다시 확인하고 있어요.");
            finalizeClaim(claim.claimId);
          } else if (claim.status === "PROVISIONING") {
            setScreen("add");
            claimPollCountRef.current = 0;
            setStage("provisioning");
            setProgress("서버가 기기 등록을 안전하게 마무리하고 있어요.");
            requestClaimStatus(1_500);
          } else if (claim.status === "RUNTIME_AUTHORIZED") {
            setScreen("add");
            setStage("wifi-connected");
            setProgress("등록 권한 확인이 끝났습니다. 무드등 전원을 껐다 켜면 운영 연결을 시작하고 ONLINE을 확인합니다.");
            requestClaimStatus(1_500);
          } else if (claim.status === "ONLINE") {
            claimIdRef.current = null;
            setDeviceListState("idle");
            loadDevices();
          } else {
            claimIdRef.current = null;
          }
          return;
        }
        if (message.type === "api.deviceClaims.created") {
          if (message.requestId !== claimCreateRequestRef.current || message.payload.status !== "CLAIM_PENDING") return;
          claimCreateRequestRef.current = null;
          claimIdRef.current = message.payload.claimId;
          const device = claimDeviceRef.current;
          const attemptId = attemptRef.current;
          if (!device || !attemptId) return;
          setProgress("서버 Claim을 만들었습니다. 무드등이 사용할 Wi-Fi를 불러오고 있어요.");
          scanWifiNetworks(device, attemptId);
          return;
        }
        if (message.type === "api.deviceClaims.status.result") {
          if (message.requestId !== claimStatusRequestRef.current || message.payload.claimId !== claimIdRef.current) return;
          claimStatusRequestRef.current = null;
          if (message.payload.status === "CLAIM_PENDING" || message.payload.status === "BOOTSTRAPPED") {
            finalizeClaim(message.payload.claimId);
          } else if (message.payload.status === "PROVISIONING") {
            setStage("provisioning");
            setProgress("서버가 기기 등록을 안전하게 마무리하고 있어요.");
            requestClaimStatus(1_500);
          } else if (message.payload.status === "RUNTIME_AUTHORIZED") {
            setStage("wifi-connected");
            setProgress("등록 권한 확인이 끝났습니다. 무드등 전원을 껐다 켜면 운영 연결을 시작하고 ONLINE을 확인합니다.");
            requestClaimStatus(1_500);
          } else if (message.payload.status === "ONLINE") {
            completeServerRegistration();
          } else if (message.payload.status === "FAILED" || message.payload.status === "EXPIRED" || message.payload.status === "REVOKED") {
            setStage("failed");
            setProgress(`서버 기기 등록이 ${message.payload.status} 상태입니다. 새 등록을 시작해주세요.`);
          }
          return;
        }
        if (message.type === "api.deviceClaims.finalized") {
          if (message.requestId !== claimFinalizeRequestRef.current || message.payload.claimId !== claimIdRef.current) return;
          claimFinalizeRequestRef.current = null;
          if (message.payload.status === "ONLINE") {
            completeServerRegistration();
          } else if (message.payload.status === "RUNTIME_AUTHORIZED") {
            setStage("wifi-connected");
            setProgress("등록 권한 확인이 끝났습니다. 무드등 전원을 껐다 켜면 운영 연결을 시작하고 ONLINE을 확인합니다.");
            requestClaimStatus(1_500);
          }
          return;
        }
        if (message.type === "bridge.error" && message.requestId === claimResumeRequestRef.current) {
          claimResumeRequestRef.current = null;
          return;
        }
        if (message.type === "bridge.error" && (
          message.requestId === claimCreateRequestRef.current ||
          message.requestId === claimStatusRequestRef.current ||
          message.requestId === claimFinalizeRequestRef.current
        )) {
          const finalizeFailed = message.requestId === claimFinalizeRequestRef.current;
          claimCreateRequestRef.current = null;
          claimStatusRequestRef.current = null;
          claimFinalizeRequestRef.current = null;
          if (finalizeFailed && message.payload.retryable && claimIdRef.current && claimPollCountRef.current < 15) {
            const claimId = claimIdRef.current;
            setStage("wifi-connected");
            setProgress("Wi-Fi 연결은 확인됐습니다. 기기의 AWS Fleet 등록을 다시 확인하고 있어요.");
            if (claimPollTimeoutRef.current) clearTimeout(claimPollTimeoutRef.current);
            const authGeneration = authGenerationRef.current;
            claimPollTimeoutRef.current = window.setTimeout(() => {
              if (authenticatedRef.current && authGeneration === authGenerationRef.current) finalizeClaim(claimId);
            }, 2_000);
            return;
          }
          if (finalizeFailed && message.payload.retryable && claimIdRef.current) {
            setStage("wifi-connected");
            setFleetRetryAvailable(true);
            setProgress("Wi-Fi 연결은 확인됐지만 AWS Fleet 등록 확인이 지연되고 있어요. 잠시 후 등록 상태를 다시 확인해주세요.");
            return;
          }
          setStage("failed");
          setProgress(message.payload.message);
          return;
        }
        if (message.type === "api.schedules.result") {
          if (message.requestId !== scheduleListRequestRef.current) return;
          scheduleListRequestRef.current = null;
          try {
            setSchedules(parseScheduleList(message.payload));
            setScheduleListState("ready");
          } catch {
            setScheduleListState("error");
            setScheduleListError("예약 목록 응답을 확인하지 못했어요.");
          }
          return;
        }
        if (message.type === "api.schedules.mutation.result") {
          const pending = scheduleMutationRef.current;
          let parsedSchedule: ApiSchedule | undefined;
          try {
            if ("schedule" in message.payload) parsedSchedule = parseSchedule(message.payload.schedule);
          } catch {
            return;
          }
          const checked = parsedSchedule ? { ...message, payload: { ...message.payload, schedule: parsedSchedule } } : message;
          if (!acceptsScheduleResult(pending, checked)) return;
          clearScheduleMutation();
          scheduleRetryRef.current = null;
          if ("deleted" in message.payload && message.payload.deleted) {
            const deletedScheduleId = message.payload.scheduleId;
            setSchedules((current) => current.filter((item) => item.scheduleId !== deletedScheduleId));
            setScheduleActionMessage("예약을 삭제했습니다.");
          } else if (parsedSchedule) {
            const next = parsedSchedule;
            setSchedules((current) => current.some((item) => item.scheduleId === next.scheduleId)
              ? current.map((item) => item.scheduleId === next.scheduleId ? next : item)
              : [...current, next]);
            setScheduleActionMessage(pending?.operation === "create" ? "예약을 만들었습니다." : "예약 변경 결과를 받았습니다.");
            if (pending?.operation === "create") setScheduleFormOpen(false);
          }
          setScheduleActionStatus("success");
          return;
        }
        if (message.type === "bridge.error" && message.requestId === scheduleListRequestRef.current) {
          scheduleListRequestRef.current = null;
          setScheduleListState("error");
          setScheduleListError(message.payload.message);
          return;
        }
        if (message.type === "bridge.error" && message.requestId === scheduleMutationRef.current?.requestId) {
          const operation = scheduleMutationRef.current?.operation;
          clearScheduleMutation();
          setScheduleActionStatus("error");
          if (operation === "create") {
            scheduleRetryRef.current = null;
            setScheduleFormOpen(false);
            setScheduleActionMessage("예약 저장 여부를 확인하기 위해 목록을 다시 불러옵니다.");
            loadSchedules();
          } else {
            setScheduleActionMessage(message.payload.message);
          }
          return;
        }
        if (message.type === "api.devices.released") {
          const pending = releaseRequestRef.current;
          if (!pending || message.requestId !== pending.requestId || message.payload.deviceId !== pending.deviceId || message.payload.lifecycleStatus !== "REVOKED") return;
          releaseRequestRef.current = null;
          setDevices((current) => current.filter((device) => device.id !== pending.deviceId));
          setReleaseStatus("idle");
          setReleaseConfirm(false);
          setReleaseMessage("");
          setSelectedId("");
          selectedIdRef.current = "";
          setScreen("home");
          return;
        }
        if (message.type === "bridge.error" && message.requestId === releaseRequestRef.current?.requestId) {
          releaseRequestRef.current = null;
          setReleaseStatus("error");
          setReleaseMessage(message.payload.message);
          return;
        }
        if (message.type === "api.devices.state.accepted") {
          const active = controlRequestRef.current;
          if (!active || !acceptsStateAccepted(active, message)) return;
          if (controlTimeoutRef.current) clearTimeout(controlTimeoutRef.current);
          controlTimeoutRef.current = null;
          controlRequestRef.current = { ...active, accepted: true, commandId: message.payload.commandId };
          controlPollCountRef.current = 0;
          setControlStatus("accepted");
          setControlMessage("서버가 요청을 받았습니다. 기기가 실제로 바꿨는지 자동으로 확인하고 있어요.");
          controlPollTimeoutRef.current = window.setTimeout(loadDevices, 900);
          return;
        }
        if (message.type === "api.devices.result") {
          if (message.requestId !== deviceListRequestRef.current) return;
          deviceListRequestRef.current = null;
          try {
            const next = parseDeviceList(message.payload).map(toDeviceState);
            setDevices(next);
            const chosen = next.find((device) => device.id === selectedIdRef.current) ?? next[0];
            selectedIdRef.current = chosen?.id ?? "";
            setSelectedId(selectedIdRef.current);
            const active = controlRequestRef.current;
            if (active?.accepted) {
              const refreshed = next.find((device) => device.id === active.deviceId);
              if (refreshed && commandApplied(active, refreshed)) {
                controlRequestRef.current = null;
                controlPollCountRef.current = 0;
                if (controlPollTimeoutRef.current) clearTimeout(controlPollTimeoutRef.current);
                controlPollTimeoutRef.current = null;
                setControlDraft(draftFromDevice(refreshed));
                setControlStatus("confirmed");
                setControlMessage("기기가 실제로 변경한 결과를 확인했습니다. 적용 완료예요.");
                } else {
                  controlPollCountRef.current += 1;
                  if (controlPollCountRef.current < 6) {
                    setControlMessage("기기 적용을 확인하고 있어요. 잠시만 기다려주세요.");
                    controlPollTimeoutRef.current = window.setTimeout(loadDevices, 1_200);
                  } else {
                    clearControlRequest();
                    setControlStatus("error");
                    setControlMessage("아직 기기 적용을 확인하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해주세요.");
                  }
              }
            } else if (!active && chosen) {
              setControlDraft(draftFromDevice(chosen));
            }
            setDeviceListState("ready");
          } catch {
            setDeviceListState("error");
            setDeviceListError("기기 목록 응답을 확인하지 못했어요.");
          }
          return;
        }
        if (message.type === "bridge.error" && message.requestId === deviceListRequestRef.current) {
          deviceListRequestRef.current = null;
          setDeviceListState("error");
          setDeviceListError(message.payload.message);
          if (controlRequestRef.current?.accepted) {
            setControlMessage(`기기 state를 새로 받지 못했습니다. ${message.payload.message}`);
          }
          return;
        }
        if (message.type === "bridge.error" && message.requestId === controlRequestRef.current?.requestId) {
          if (controlTimeoutRef.current) clearTimeout(controlTimeoutRef.current);
          controlTimeoutRef.current = null;
          controlRequestRef.current = null;
          setControlStatus("error");
          setControlMessage(message.payload.message);
          return;
        }
        const wifiProvisionRequestId = pendingRef.current.get("wifi.provision");
        const isWifiProvisionError = message.type === "bridge.error" &&
          message.requestId === wifiProvisionRequestId;
        if (!acceptsNativeResponse(message, attemptRef.current, pendingRef.current)) return;
        switch (message.type) {
          case "bridge.hello":
            setNative(true);
            break;
          case "bridge.snapshot":
            // A reloaded WebView no longer owns the old request IDs. Close that session;
            // restoring a server Claim will be implemented with authenticated API polling.
            if (message.payload.activeAttemptId && message.payload.activeAttemptId !== attemptRef.current) {
              postToNative({ type: "ble.disconnect", requestId: newId("ble-disconnect"), attemptId: message.payload.activeAttemptId });
            }
            break;
          case "ble.state":
            if (pendingRef.current.has("ble.scan")) {
              const reason = getBleBlockReason(message.payload.state);
              if (reason) {
                pendingRef.current.delete("ble.scan");
                setBleBlockReason(reason);
                setProgress(reason === "permission"
                  ? "Bluetooth 권한이 꺼져 있습니다. 앱 설정에서 주변 기기 권한을 허용해주세요."
                  : "Bluetooth가 꺼져 있습니다. Bluetooth를 켠 뒤 다시 시도해주세요.");
                setStage("failed");
              }
            }
            break;
          case "ble.scanning":
            setStage(message.payload.active ? "scanning" : "idle");
            if (message.payload.active) {
              bleDeviceFoundRef.current = false;
              setBleScanEmpty(false);
              setBleBlockReason(null);
            } else if (!bleDeviceFoundRef.current) {
              setBleScanEmpty(true);
            }
            break;
          case "ble.deviceFound":
            bleDeviceFoundRef.current = true;
            setBleScanEmpty(false);
            setBleBlockReason(null);
            setNearby((current) =>
              current.some((item) => item.id === message.payload.id)
                ? current
                : [...current, message.payload],
            );
            break;
          case "ble.connected":
            setConnected(message.payload.device);
            claimDeviceRef.current = message.payload.device;
            if (demoMode || hardwareTestMode) {
              setStage("wifi");
              scanWifiNetworks(message.payload.device, message.attemptId);
            } else if (!poolIdRef.current) {
              setStage("failed");
              setProgress("로그인 공간 정보를 확인하지 못했습니다. 다시 로그인해주세요.");
            } else {
              const requestId = newId("claim-create");
              claimCreateRequestRef.current = requestId;
              setStage("provisioning");
              setProgress("제품 QR을 확인했습니다. 서버 기기 등록을 시작하고 있어요.");
              postToNative({ type: "api.deviceClaims.create", requestId, attemptId: message.attemptId, payload: { poolId: poolIdRef.current, deviceId: message.payload.device.id } });
            }
            break;
          case "wifi.networks":
            setWifiScanState("ready");
            setWifiFailure(null);
            setNetworks(message.payload.networks);
            setStage("wifi");
            break;
          case "provision.progress":
            setStage(message.payload.stage === "wifi-connected" ? "wifi-connected" : message.payload.stage === "failed" || message.payload.stage === "cancelled" ? message.payload.stage : "provisioning");
            setProgress(message.payload.message);
            if (message.payload.stage === "wifi-connected" && !demoMode && !hardwareTestMode) {
              claimPollCountRef.current = 0;
              requestClaimStatus(1_500);
            }
            break;
          case "device.bootstrapComplete":
            if (demoMode) {
              finishProvisioning(message.payload.thingName);
            } else {
              setStage("bootstrapped");
              setProgress("기기 등록 준비가 끝났습니다. 서버의 ONLINE 확인을 기다리고 있어요.");
            }
            break;
          case "bridge.error":
            setWifiScanState("idle");
            setProgress(message.payload.message);
            setWifiFailure(isWifiProvisionError ? wifiFailureKind(message.payload.code) : null);
            setStage("failed");
            break;
          default:
            break;
        }
      },
    };
    postToNative({ type: "bridge.ready" });
    return () => {
      attemptRef.current = null;
      pendingRef.current.clear();
      controlRequestRef.current = null;
      if (controlTimeoutRef.current) clearTimeout(controlTimeoutRef.current);
      if (controlPollTimeoutRef.current) clearTimeout(controlPollTimeoutRef.current);
      scheduleListRequestRef.current = null;
      releaseRequestRef.current = null;
      claimResumeRequestRef.current = null;
      if (claimPollTimeoutRef.current) clearTimeout(claimPollTimeoutRef.current);
      clearScheduleMutation();
      delete window.__moodlightBridge;
    };
  }, []);

  useEffect(() => {
    if (demoMode || screen !== "schedules") return;
    const timer = window.setInterval(() => loadDevices(), 10_000);
    return () => window.clearInterval(timer);
  }, [screen]);

  function updateSelected(patch: Partial<DeviceState>) {
    if (!demoMode || !selected) return;
    setDevices((current) =>
      current.map((device) => (device.id === selected.id ? { ...device, ...patch } : device)),
    );
  }

  function clearControlRequest() {
    controlRequestRef.current = null;
    if (controlTimeoutRef.current) clearTimeout(controlTimeoutRef.current);
    controlTimeoutRef.current = null;
    if (controlPollTimeoutRef.current) clearTimeout(controlPollTimeoutRef.current);
    controlPollTimeoutRef.current = null;
    controlPollCountRef.current = 0;
  }

  function openDevice(device: DeviceState) {
    clearControlRequest();
    releaseRequestRef.current = null;
    setReleaseConfirm(false);
    setReleaseStatus("idle");
    setReleaseMessage("");
    selectedIdRef.current = device.id;
    setSelectedId(device.id);
    setControlDraft(draftFromDevice(device));
    setControlStatus("idle");
    setControlMessage("");
    setScreen("device");
  }

  function leaveDevice() {
    clearControlRequest();
    releaseRequestRef.current = null;
    setReleaseConfirm(false);
    setReleaseStatus("idle");
    setReleaseMessage("");
    setControlStatus("idle");
    setControlMessage("");
    setScreen("home");
  }

  function editControl(patch: Partial<DeviceControlDraft>) {
    if (!selected || controlLocked) return;
    clearControlRequest();
    setControlStatus("idle");
    setControlMessage("");
    setControlDraft((current) => ({ ...(current ?? draftFromDevice(selected)), ...patch }));
  }

  function applyControl() {
    if (demoMode || !selected || !shownControl || controlLocked) return;
    const requestId = newId("device-state");
    const active: PendingDeviceStateRequest = {
      requestId, deviceId: selected.id, desired: desiredFromDraft(shownControl), accepted: false,
    };
    clearControlRequest();
    controlRequestRef.current = active;
    setControlStatus("pending");
    setControlMessage("명령을 서버에 보내고 있어요. 아직 기기 상태로 확정하지 않습니다.");
    if (!postToNative({ type: "api.devices.state.patch", requestId, payload: { deviceId: selected.id, desired: active.desired } })) {
      controlRequestRef.current = null;
      setControlStatus("error");
      setControlMessage("기기를 제어하려면 무드등 모바일 앱을 사용해주세요.");
      return;
    }
    controlTimeoutRef.current = window.setTimeout(() => {
      if (controlRequestRef.current?.requestId !== requestId || controlRequestRef.current.accepted) return;
      controlRequestRef.current = null;
      controlTimeoutRef.current = null;
      setControlStatus("error");
      setControlMessage("모바일 앱의 응답을 확인하지 못했습니다. 연결 상태를 확인하고 다시 시도해주세요.");
    }, 15_000);
  }

  function startAnotherControl() {
    clearControlRequest();
    setControlStatus("idle");
    setControlMessage("");
  }

  function releaseSelectedDevice() {
    if (demoMode || !selected || releaseRequestRef.current) return;
    const requestId = newId("device-release");
    releaseRequestRef.current = { requestId, deviceId: selected.id };
    setReleaseStatus("pending");
    setReleaseMessage("기기 인증을 해제하고 소유권을 반납하고 있어요.");
    if (!postToNative({ type: "api.devices.release", requestId, payload: { deviceId: selected.id } })) {
      releaseRequestRef.current = null;
      setReleaseStatus("error");
      setReleaseMessage("소유권 해제는 무드등 모바일 앱에서 진행해주세요.");
    }
  }

  function logout() {
    if (demoMode || hardwareTestMode) {
      setScreen("login");
      return;
    }
    const requestId = newId("auth-logout");
    authRequestRef.current = requestId;
    setAuthState({ status: "loading", message: "로그아웃하고 있어요." });
    if (!postToNative({ type: "auth.logout", requestId })) {
      authRequestRef.current = null;
      setAuthState({ status: "error", message: "로그아웃은 무드등 모바일 앱에서 진행해주세요." });
    }
  }

  function cleanupProvisioning() {
    const attemptId = attemptRef.current;
    attemptRef.current = null;
    pendingRef.current.clear();
    if (attemptId && !demoMode) {
      postToNative({ type: "ble.cancelScan", requestId: newId("ble-cancel"), attemptId });
      postToNative({ type: "ble.disconnect", requestId: newId("ble-disconnect"), attemptId });
    }
    if (claimPollTimeoutRef.current) clearTimeout(claimPollTimeoutRef.current);
    claimPollTimeoutRef.current = null;
    claimPollCountRef.current = 0;
    setFleetRetryAvailable(false);
    claimIdRef.current = null;
    claimDeviceRef.current = null;
    claimCreateRequestRef.current = null;
    claimResumeRequestRef.current = null;
    claimStatusRequestRef.current = null;
    claimFinalizeRequestRef.current = null;
    setPassword("");
    setSsid("");
    setNearby([]);
    bleDeviceFoundRef.current = false;
    setBleScanEmpty(false);
    setBleBlockReason(null);
    setConnected(null);
    setNetworks([]);
    setWifiScanState("idle");
    setWifiFailure(null);
    setProgress("");
    setStage("idle");
  }

  function leaveProvisioning() {
    cleanupProvisioning();
    setScreen("home");
  }

  function startScan() {
    const attemptId = newId("registration");
    attemptRef.current = attemptId;
    pendingRef.current.clear();
    bleDeviceFoundRef.current = false;
    setBleScanEmpty(false);
    setBleBlockReason(null);
    setNearby([]);
    setConnected(null);
    setNetworks([]);
    setSsid("");
    setPassword("");
    setWifiFailure(null);
    setProgress("");
    setStage("scanning");
    if (demoMode) {
      window.setTimeout(() => {
        if (!isCurrentAttempt(attemptRef.current, attemptId)) return;
        setNearby([{
          id: "demo-esp32-s3",
          name: "Moodlight-Setup",
          rssi: -48,
          serviceUuids: ["demo-provisioning-service"],
          model: "moodlamp",
          serial: "demo01",
          protocolVersion: "1",
          provisioningState: "unregistered",
        }]);
        setStage("idle");
      }, 500);
    } else if (!sendRequest({ type: "ble.scan", requestId: newId("ble-scan"), attemptId, payload: { timeoutMs: 20_000 } })) {
      setStage("failed");
      setProgress("기기를 찾으려면 무드등 모바일 앱을 사용해주세요.");
    }
  }

  function connectDevice(device: NearbyDevice) {
    const attemptId = attemptRef.current ?? newId("registration");
    attemptRef.current = attemptId;
    pendingRef.current.delete("ble.scan");
    setConnected(device);
    setStage("connecting");
    setWifiScanState("idle");
    if (demoMode) {
      window.setTimeout(() => {
        if (!isCurrentAttempt(attemptRef.current, attemptId)) return;
        setNetworks([
          { ssid: "Home-WiFi", rssi: -42, secure: true },
          { ssid: "Guest-WiFi", rssi: -67, secure: true },
        ]);
        setWifiScanState("ready");
        setStage("wifi");
      }, 500);
    } else if (!sendRequest({ type: "ble.connect", requestId: newId("ble-connect"), attemptId, payload: { deviceId: device.id } })) {
      setStage("failed");
      setProgress("기기에 연결하려면 무드등 모바일 앱을 사용해주세요.");
    }
  }

  function provision() {
    if (!connected || !ssid || (selectedNetwork?.secure !== false && !password) || pendingRef.current.has("wifi.provision")) return;
    setWifiFailure(null);
    if (demoMode) {
      const attemptId = attemptRef.current;
      setPassword("");
      setStage("provisioning");
      setProgress("데모 등록 흐름을 확인하고 있어요.");
      window.setTimeout(() => {
        if (attemptId && isCurrentAttempt(attemptRef.current, attemptId)) finishProvisioning(`demo-${Date.now()}`);
      }, 900);
      return;
    }
    const attemptId = attemptRef.current;
    if (!attemptId || (!hardwareTestMode && !claimIdRef.current)) {
      setProgress("서버 기기 등록을 먼저 시작해야 합니다.");
      setPassword("");
      return;
    }
    const requestId = newId("wifi-provision");
    const sent = sendRequest({
      type: "wifi.provision",
      requestId,
      attemptId,
      payload: {
        deviceId: connected.id,
        ssid,
        password,
        secure: selectedNetwork?.secure ?? true,
      },
    });
    setPassword("");
    if (!sent) {
      pendingRef.current.delete("wifi.provision");
      setStage("failed");
      setProgress("Wi-Fi 정보를 보내려면 무드등 모바일 앱을 사용해주세요.");
      return;
    }
    setStage("provisioning");
    setProgress("Wi-Fi 정보를 기기에 안전하게 전달하고 있어요.");
  }

  function finishProvisioning(serial: string) {
    if (!demoMode || !attemptRef.current) return;
    const id = serial.startsWith("d-") ? serial : `d-dev-moodlamp-${serial}`;
    setDevices((current) => [
      ...current,
      {
        id,
        name: "새 무드등",
        room: "기본 공간",
        online: true,
        power: false,
        color: "#ffd66b",
        brightness: 50,
      },
    ]);
    selectedIdRef.current = id;
    setSelectedId(id);
    setPassword("");
    setStage("complete");
    setProgress("등록이 완료됐어요.");
  }

  if (screen === "login") {
    const canEnter = demoMode || hardwareTestMode || (native && authState.status !== "loading");
    return (
      <main className="loginPage">
        <section className="loginCard">
          <div className="brandMark"><span /></div>
          <p className="eyebrow">MOODLIGHT</p>
          <h1>빛으로 공간을<br />편안하게 바꿔보세요.</h1>
          <p className="muted">여러 무드등을 한곳에서 등록하고 제어합니다.</p>
          <button
            className="primary"
            disabled={!canEnter}
            onClick={login}
          >
            {demoMode ? "데모로 시작하기" : hardwareTestMode ? "BLE 실기기 테스트" : authState.status === "loading" ? "로그인 확인 중" : "Cognito로 로그인"}
          </button>
          <p className="caption">
            {demoMode
              ? "Cognito 연결 전 화면 흐름을 확인하는 데모 모드입니다."
              : hardwareTestMode
                ? "실제 기기와 Security 2로 연결하고 Wi-Fi 접속까지 확인합니다. AWS 등록은 수행하지 않습니다."
                : ("message" in authState ? authState.message : undefined) ?? "Cognito 로그인은 네이티브 앱에서 열리고 토큰은 WebView에 전달하지 않습니다."}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="appShell">
      <header className="topbar">
        {screen !== "home" ? (
          <button className="iconButton" aria-label="뒤로" onClick={screen === "add" ? leaveProvisioning : screen === "device" ? leaveDevice : () => setScreen("home")}>←</button>
        ) : <div className="brandMini"><span /> mood</div>}
        <p>{screen === "home" ? "나의 공간" : screen === "device" ? selected?.name : screen === "add" ? "기기 등록" : "예약"}</p>
        <span className={`nativeBadge ${native ? "connected" : ""}`}>{native ? "APP" : "WEB"}</span>
      </header>

      {screen === "home" && (
        <section className="content">
          <div className="heroCopy">
            <div>
              <p className="eyebrow">안녕하세요</p>
              <h1>오늘의 빛을 골라보세요.</h1>
            </div>
            <button className="addButton" onClick={() => { setScreen("add"); setStage("idle"); }}>＋</button>
          </div>

          {!demoMode && deviceListState === "idle" && (
            <div className="deviceListState">
              <h2>등록한 기기를 불러오세요.</h2>
              <p>로그인된 계정의 기기만 표시합니다.</p>
              <button className="secondary" onClick={loadDevices}>기기 목록 불러오기</button>
            </div>
          )}
          {!demoMode && deviceListState === "loading" && (
            <div className="deviceListState" role="status"><div className="spinner" /><h2>기기 목록을 불러오고 있어요.</h2></div>
          )}
          {!demoMode && deviceListState === "error" && (
            <div className="deviceListState" role="alert"><h2>기기 목록을 불러오지 못했어요.</h2><p>{deviceListError}</p><button className="secondary" onClick={loadDevices}>다시 시도</button></div>
          )}
          {(demoMode || deviceListState === "ready") && <>
          {demoMode && <div className="roomTabs"><button className="active">전체</button><button>거실</button><button>침실</button></div>}

          {devices.length === 0 ? (
            <div className="deviceListState"><h2>등록된 무드등이 없어요.</h2><p>위의 + 버튼으로 첫 기기를 등록해보세요.</p><button className="secondary" onClick={loadDevices}>새로고침</button></div>
          ) : <div className="deviceGrid">
            {devices.map((device) => (
              <article
                key={device.id}
                className={`deviceCard ${device.power ? "active" : ""}`}
                onClick={() => openDevice(device)}
              >
                <div className="cardHead"><span className={`statusDot ${device.online === true ? "online" : ""}`} />{device.online === true ? "온라인" : device.online === false ? "오프라인" : "상태 확인 전"}</div>
                <LampGlyph color={device.color} on={device.power && device.online === true} />
                <h2>{device.name}</h2>
                <p>{device.room} · 밝기 {device.brightness}%</p>
                {hasPendingDesired(device) && <p className="pendingDesired">미적용 · 온라인에서 다시 전송 필요</p>}
                {demoMode ? <button
                  className={`switch ${device.power ? "on" : ""}`}
                  disabled={device.online !== true}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDevices((current) => current.map((item) => item.id === device.id ? { ...item, power: !item.power } : item));
                  }}
                  aria-label={`${device.name} 전원`}
                ><span /></button> : <button className="cardControlButton" onClick={(event) => { event.stopPropagation(); openDevice(device); }}>제어하기</button>}
              </article>
            ))}
          </div>}
          </>}

          {demoMode && <button className="schedulePreview" onClick={() => setScreen("schedules")}>
            <span className="calendarIcon">◷</span>
            <span><strong>취침 조명</strong><small>매일 오후 11:00 · 침실 무드등</small></span>
            <span>›</span>
          </button>}
        </section>
      )}

      {screen === "device" && selected && (
        <section className="content deviceDetail">
          <div className="detailLamp">
            <LampGlyph
              color={controlPreview?.color ?? selected.color}
              on={controlPreview ? controlPreview.power : selected.power && selected.online === true}
            />
            {controlPreview && <span className="controlPreviewBadge">
              변경 미리보기 · {controlStatus === "idle" ? "아직 전송 전" : controlStatus === "pending" ? "서버 전송 중" : controlStatus === "accepted" ? "기기 적용 확인 중" : controlStatus === "confirmed" ? "적용 완료" : "확인 필요"}
            </span>}
          </div>
          <div className="detailTitle">
            <div><span className={`statusDot ${selected.online === true ? "online" : ""}`} /> {selected.online === true ? "연결됨" : selected.online === false ? "연결 안 됨" : "상태 확인 전"}</div>
            {demoMode && <button
              className={`switch large ${selected.power ? "on" : ""}`}
              disabled={selected.online !== true}
              onClick={() => updateSelected({ power: !selected.power })}
            ><span /></button>}
          </div>

          {!demoMode && selected.online === false && <aside className="offlineHelp" role="status">
            <strong>무드등이 현재 오프라인이에요.</strong>
            <p>보드 전원을 연결하고 등록할 때 사용한 Wi-Fi 또는 핫스팟을 켜주세요. 온라인 표시로 바뀐 뒤 변경 내용을 다시 적용해 주세요.</p>
            <button className="secondary" onClick={loadDevices} disabled={deviceListState === "loading"}>{deviceListState === "loading" ? "연결 확인 중" : "연결 상태 새로고침"}</button>
          </aside>}

          <section className="controlPanel">
            {!demoMode && hasPendingDesired(selected) && selected.desiredState && (
              <div className="controlStatus accepted" role="status">
                <p>기기가 적용하지 않은 요청입니다. 현재는 오프라인 명령을 자동 재전송하지 않으므로 온라인 연결 후 다시 적용해 주세요.</p>
              </div>
            )}
            {!demoMode && shownControl && <div className="draftPower">
              <span><strong>전원 변경안</strong><small>현재 기기 상태: {selected.power ? "켜짐" : "꺼짐"}</small></span>
              <button
                className={`switch large ${shownControl.power ? "on" : ""}`}
                disabled={controlLocked}
                onClick={() => editControl({ power: !shownControl.power })}
                aria-label="전원 변경안"
              ><span /></button>
            </div>}
            <label>색상 {demoMode ? "" : "변경안"}</label>
            <div className="swatches">
              {presets.map((color) => <button key={color.value} aria-label={color.name} title={color.name} className={shownControl?.color.toLowerCase() === color.value ? "selected" : ""} style={{ background: color.value }} onClick={() => demoMode ? updateSelected({ color: color.value, power: true }) : editControl({ color: color.value })} disabled={controlLocked} />)}
            </div>
            <p className="colorChoice">선택한 색: <strong>{presets.find((color) => color.value === shownControl?.color.toLowerCase())?.name ?? "직접 선택"}</strong></p>
            <input className="colorInput" type="color" value={shownControl?.color ?? selected.color} disabled={controlLocked} onChange={(event) => demoMode ? updateSelected({ color: event.target.value, power: true }) : editControl({ color: event.target.value })} />
            <div className="rangeLabel"><label htmlFor="brightness">밝기 {demoMode ? "" : "변경안"}</label><strong>{shownControl?.brightness ?? selected.brightness}%</strong></div>
            <input id="brightness" type="range" min="0" max="100" value={shownControl?.brightness ?? selected.brightness} disabled={controlLocked} onChange={(event) => demoMode ? updateSelected({ brightness: Number(event.target.value) }) : editControl({ brightness: Number(event.target.value) })} />
            {!demoMode && <button className="primary controlApply" disabled={controlLocked || !controlChanged} onClick={applyControl}>
              {controlStatus === "pending" ? "명령 보내는 중" : "변경 내용 적용"}
            </button>}
          </section>
          {!demoMode && <div className={`controlStatus ${controlStatus}`} role={controlStatus === "error" ? "alert" : "status"} aria-live="polite">
            {controlStatus === "idle" && <p>상단 그림은 변경 미리보기입니다. 적용 버튼을 누르기 전까지 기기에는 전송되지 않습니다.</p>}
            {controlStatus !== "idle" && <div className="controlProgress">{(controlStatus === "pending" || controlStatus === "accepted") && <span className="statusSpinner" aria-label="확인 중" />}<p>{controlMessage}</p></div>}
            {controlStatus === "error" && <button className="secondary" onClick={applyControl}>다시 시도</button>}
            {controlStatus === "accepted" && <div className="controlActions">
              <button className="secondary" onClick={loadDevices} disabled={deviceListState === "loading"}>{deviceListState === "loading" ? "확인 중" : "기기가 바뀌었는지 다시 확인"}</button>
              <button className="secondary" onClick={startAnotherControl}>다른 색·밝기 설정</button>
            </div>}
          </div>}

          <button className="secondary" onClick={openSchedules}>이 기기의 예약 보기</button>
          {!demoMode && <section className="releasePanel">
            {!deviceReleaseEnabled ? (
              <div>
                <strong>소유권 해제 · 현재 사용할 수 없음</strong>
                <p>서버의 인증서 비활성화와 소유권 정리 코드는 구현되어 있지만, 실제 기기 재등록까지 종단 시험하기 전에는 안전을 위해 사용할 수 없습니다.</p>
                <button className="deleteButton" disabled>소유권 해제 준비 중</button>
              </div>
            ) : !releaseConfirm ? (
              <button className="deleteButton" onClick={() => setReleaseConfirm(true)}>이 기기 소유권 해제</button>
            ) : (
              <div role="alert">
                <strong>이 계정에서 기기를 제거할까요?</strong>
                <p>기기 인증서와 기존 소유권을 해제합니다. 다른 계정에 등록하려면 보드에서 등록 모드에 다시 들어간 뒤 새 제품 등록 절차를 진행해야 합니다.</p>
                <div className="controlActions">
                  <button className="deleteButton" disabled={releaseStatus === "pending"} onClick={releaseSelectedDevice}>{releaseStatus === "pending" ? "해제 중" : "소유권 해제"}</button>
                  <button className="secondary" disabled={releaseStatus === "pending"} onClick={() => { setReleaseConfirm(false); setReleaseStatus("idle"); setReleaseMessage(""); }}>취소</button>
                </div>
                {releaseMessage && <p className={releaseStatus === "error" ? "errorText" : ""}>{releaseMessage}</p>}
              </div>
            )}
          </section>}
        </section>
      )}

      {screen === "add" && (
        <section className="content onboarding">
          <div className="stepper"><span className="done">1</span><i /><span className={stage !== "idle" && stage !== "scanning" ? "done" : ""}>2</span><i /><span className={stage === "complete" ? "done" : ""}>3</span></div>

          {stage === "idle" && nearby.length === 0 && (
            bleScanEmpty ? (
              <div className="centerBlock">
                <div className="radar"><span /><span /><b>?</b></div>
                <h1>기기가 등록 모드인지 확인해주세요.</h1>
                <p>이미 Wi-Fi가 저장된 기기는 설정용 BLE 광고를 멈추므로 검색되지 않는 것이 정상이에요.</p>
                <p className="caption">개발 보드는 정상 부팅 후 BOOT 버튼을 5초간 눌렀다가 놓고, 재부팅되면 다시 검색하세요. 이 동작은 Wi-Fi 설정만 지우며 기기 소유권은 해제하지 않아요.</p>
                <button className="primary" onClick={startScan}>다시 검색</button>
                {!hardwareTestMode && <button className="secondary" onClick={leaveProvisioning}>등록된 기기 목록 보기</button>}
              </div>
            ) : (
              <div className="centerBlock">
                <div className="radar"><span /><span /><b>✦</b></div>
                <h1>새 무드등을 찾아볼까요?</h1>
                <p>전원을 켜고 휴대폰 가까이에 놓아주세요.</p>
                <button className="primary" onClick={startScan}>기기 찾기</button>
              </div>
            )
          )}

          {(stage === "scanning" || (stage === "idle" && nearby.length > 0)) && (
            <div>
              <p className="eyebrow">BLE 기기 검색</p>
              <h1>{stage === "scanning" ? "주변을 찾고 있어요" : "무드등을 선택하세요"}</h1>
              {stage === "scanning" && (
                <>
                  <div className="spinner" aria-label="검색 중" />
                  <aside className="scanHint" role="note">
                    <strong>이미 등록한 무드등은 검색되지 않아요.</strong>
                    <p>검색은 최대 20초 걸려요. 저장된 Wi-Fi가 있으면 설정용 BLE를 끄는 것이 정상이에요. 다시 등록하려면 정상 부팅 뒤 BOOT 버튼을 5초간 눌렀다가 놓고 재부팅 후 다시 검색하세요.</p>
                  </aside>
                  <button className="secondary scanCancel" onClick={cleanupProvisioning}>검색 취소</button>
                </>
              )}
              <div className="resultList">
                {nearby.map((device) => (
                  <button key={device.id} onClick={() => connectDevice(device)}>
                    <span className="deviceGlyph">✦</span>
                    <span><strong>{device.name ?? "이름 없는 ESP32"}</strong><small>신호 {device.rssi ?? "-"} dBm</small></span>
                    <span>연결</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {stage === "connecting" && <div className="centerBlock"><div className="spinner" /><h1>{connected?.name ?? "무드등"}에 연결 중</h1><p>BLE 연결과 기기 정보를 확인하고 있어요.</p></div>}

          {stage === "connected" && (
            <div className="centerBlock">
              <div className="successIcon">✓</div>
              <h1>실제 기기 연결을 확인했어요.</h1>
              <p>{progress}</p>
              <button className="secondary" onClick={leaveProvisioning}>연결 종료</button>
            </div>
          )}

          {stage === "wifi" && (
            <div>
              <p className="eyebrow">Wi-Fi 설정</p>
              <h1>{selectedNetwork ? "선택한 Wi-Fi에 연결하세요." : "무드등이 사용할 Wi-Fi를 선택하세요."}</h1>
              {wifiScanState === "loading" ? (
                <div className="wifiScanStatus" role="status" aria-live="polite">
                  <div className="spinner" aria-hidden="true" />
                  <h2>주변 Wi-Fi를 찾고 있어요</h2>
                  <p>무드등이 사용할 네트워크를 확인하고 있어요. 잠시만 기다려주세요.</p>
                </div>
              ) : networks.length === 0 ? (
                <div className="wifiScanStatus">
                  <h2>주변 Wi-Fi를 찾지 못했어요.</h2>
                  <p>무드등과 공유기 가까이에서 다시 검색해주세요.</p>
                  <button
                    className="secondary"
                    disabled={!connected}
                    onClick={() => {
                      const attemptId = attemptRef.current;
                      if (connected && attemptId) scanWifiNetworks(connected, attemptId);
                    }}
                  >
                    다시 검색
                  </button>
                </div>
              ) : (
                <>
                  <div className="resultList wifiList">
                    {(selectedNetwork ? [selectedNetwork] : networks).map((network) => <button key={network.ssid} className={ssid === network.ssid ? "selectedRow" : ""} onClick={() => { setSsid(network.ssid); setPassword(""); }}><span>⌁</span><span><strong>{network.ssid}</strong><small>신호 {network.rssi} dBm</small></span><span>{network.secure ? "잠김" : "공개"}</span></button>)}
                  </div>
                  {selectedNetwork && (
                    <>
                      <button className="secondary" onClick={() => { setSsid(""); setPassword(""); }}>다른 Wi-Fi 선택</button>
                      {selectedNetwork.secure && <label className="field"><span>Wi-Fi 비밀번호</span><input type="password" autoComplete="new-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} placeholder="기기에만 전달됩니다" /></label>}
                      <button className="primary" disabled={selectedNetwork.secure && !password} onClick={provision}>{hardwareTestMode ? "Wi-Fi 연결 확인" : "연결하고 등록하기"}</button>
                      <p className="caption">{selectedNetwork.secure ? "비밀번호는 서버나 웹 저장소에 보관하지 않고, Security 2 세션으로 기기에만 전달합니다." : "비밀번호가 없는 공개 Wi-Fi입니다. 중요한 서비스에는 보안 Wi-Fi 사용을 권장합니다."}</p>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {stage === "provisioning" && <div className="centerBlock"><div className="spinner" /><h1>기기를 등록하고 있어요.</h1><p>{progress}</p><div className="progressTrack"><span /></div></div>}

          {stage === "wifi-connected" && <div className="centerBlock">{hardwareTestMode ? <div className="successIcon">✓</div> : fleetRetryAvailable ? null : <div className="spinner" />}<h1>Wi-Fi 연결을 확인했어요.</h1><p>{hardwareTestMode ? `${progress} AWS 기기 등록은 회사에서 이어서 연결합니다.` : progress}</p>{fleetRetryAvailable && <button className="primary" onClick={retryFleetRegistration}>등록 상태 다시 확인</button>}<button className="secondary" onClick={leaveProvisioning}>{hardwareTestMode ? "시험 종료" : "등록 취소"}</button></div>}

          {stage === "complete" && <div className="centerBlock"><div className="successIcon">✓</div><h1>{demoMode ? "데모 등록이 완료됐어요!" : "무드등 등록이 완료됐어요!"}</h1><p>{demoMode ? "가상 무드등으로 제어 흐름을 확인할 수 있습니다." : progress}</p><button className="primary" onClick={() => { cleanupProvisioning(); if (demoMode) setScreen("device"); else { setScreen("home"); loadDevices(); } }}>{demoMode ? "무드등 제어하기" : "기기 목록 보기"}</button></div>}
          {stage === "failed" && wifiFailure && (
            <div className="wifiFailure" role="alert">
              <h2>{wifiFailure === "auth"
                ? "Wi-Fi 비밀번호를 확인해주세요."
                : wifiFailure === "network"
                  ? "선택한 Wi-Fi를 찾지 못했어요."
                  : "Wi-Fi 연결을 확인하지 못했어요."}</h2>
              <p>{wifiFailure === "auth"
                ? "보안을 위해 연결을 종료했어요. 기기를 다시 찾은 뒤 비밀번호를 다시 입력해주세요."
                : "기기를 다시 찾은 뒤 다른 Wi-Fi를 선택하거나 목록을 다시 검색해주세요."}</p>
            </div>
          )}
          {stage !== "provisioning" && stage !== "wifi-connected" && stage !== "complete" && !(stage === "failed" && wifiFailure) && progress && <p role="status">{progress}</p>}
          {(stage === "failed" || stage === "cancelled") && bleBlockReason === "permission" && (
            <div className="recoveryActions">
              <button className="secondary" onClick={() => postToNative({ type: "app.openSettings" })}>앱 설정 열기</button>
              <button className="secondary" onClick={startScan}>권한 허용 후 다시 찾기</button>
            </div>
          )}
          {(stage === "failed" || stage === "cancelled") && bleBlockReason !== "permission" && (
            <button className="secondary" onClick={startScan}>
              {wifiFailure === "auth"
                ? "기기 다시 찾아 비밀번호 입력"
                : wifiFailure === "network"
                  ? "기기 다시 찾아 Wi-Fi 선택"
                  : wifiFailure
                    ? "Wi-Fi 설정 다시 시작"
                    : "다시 찾기"}
            </button>
          )}
        </section>
      )}

      {screen === "schedules" && (
        <section className="content schedulesPage">
          <div className="heroCopy"><div><p className="eyebrow">AUTOMATION</p><h1>빛이 켜질 시간을 정하세요.</h1></div><button className="addButton" onClick={() => { if (!demoMode) { setScheduleDraft(newScheduleDraft(devices[0])); setScheduleFormOpen(true); setScheduleActionStatus("idle"); } }}>＋</button></div>

          {demoMode ? <>
            <article className="scheduleCard"><div><span className="scheduleTime">23:00</span><p>매일 · 침실 무드등</p></div><button className="switch on"><span /></button></article>
            <article className="scheduleCard"><div><span className="scheduleTime">07:30</span><p>평일 · 거실 무드등</p></div><button className="switch"><span /></button></article>
            <p className="caption left">예약 저장 API와 EventBridge Scheduler 연결 전 UI 예시입니다.</p>
          </> : <>
            {scheduleFormOpen && <section className="scheduleForm">
              <div className="scheduleFormHead"><h2>새 예약</h2><button onClick={() => setScheduleFormOpen(false)}>닫기</button></div>
              <label className="field"><span>예약 이름</span><input maxLength={100} value={scheduleDraft.name} onChange={(event) => editScheduleDraft({ name: event.target.value })} placeholder="예: 취침 조명" /></label>
              {!scheduleDraft.name.trim() && <p className="scheduleHint">예약 이름을 입력해 주세요.</p>}
              <label className="field"><span>기기</span><select value={scheduleDraft.targetId} onChange={(event) => editScheduleDraft({ targetId: event.target.value })}>
                <option value="">기기를 선택하세요</option>
                {devices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
              </select></label>
              {devices.length === 0 && <p className="scheduleHint">등록한 기기 목록을 먼저 불러와야 합니다.</p>}
              <div className="scheduleFields">
                <label className="field"><span>시간</span><input type="time" value={scheduleDraft.localTime} onChange={(event) => editScheduleDraft({ localTime: event.target.value })} /></label>
                <label className="field"><span>시간대</span><input value={scheduleDraft.timezone} readOnly /></label>
              </div>
              <fieldset className="weekdayField"><legend>요일</legend><div>{weekdays.map((day, index) => <button key={day} type="button" className={scheduleDraft.daysOfWeek.includes(index) ? "selected" : ""} onClick={() => editScheduleDraft({ daysOfWeek: scheduleDraft.daysOfWeek.includes(index) ? scheduleDraft.daysOfWeek.filter((item) => item !== index) : [...scheduleDraft.daysOfWeek, index] })}>{day}</button>)}</div></fieldset>
              <div className="schedulePower"><span><strong>전원</strong><small>{scheduleDraft.power ? "켜기" : "끄기"}</small></span><button className={`switch large ${scheduleDraft.power ? "on" : ""}`} onClick={() => editScheduleDraft({ power: !scheduleDraft.power })}><span /></button></div>
              <label className="scheduleLabel">색상</label>
              <div className="swatches">{presets.map((color) => <button key={color.value} type="button" aria-label={color.name} title={color.name} className={scheduleDraft.color.toLowerCase() === color.value ? "selected" : ""} style={{ background: color.value }} onClick={() => editScheduleDraft({ color: color.value })} />)}</div>
              <p className="colorChoice">선택한 색: <strong>{presets.find((color) => color.value === scheduleDraft.color.toLowerCase())?.name ?? "직접 선택"}</strong></p>
              <input className="colorInput" type="color" value={scheduleDraft.color} onChange={(event) => editScheduleDraft({ color: event.target.value })} />
              <div className="rangeLabel"><label htmlFor="schedule-brightness">밝기</label><strong>{scheduleDraft.brightness}%</strong></div>
              <input id="schedule-brightness" type="range" min="0" max="100" value={scheduleDraft.brightness} onChange={(event) => editScheduleDraft({ brightness: Number(event.target.value) })} />
              <button className="primary" disabled={scheduleActionStatus === "pending" || devices.length === 0} onClick={createSchedule}>{scheduleActionStatus === "pending" ? "예약 저장 중" : "예약 만들기"}</button>
              <p className="scheduleTimingNote">예약은 설정한 분의 00~59초 사이에 실행될 수 있어요. 이 화면에서는 기기 상태를 10초마다 확인합니다.</p>
              <p className="caption">웹 화면은 로그인 토큰이나 소속 ID를 직접 다루지 않습니다. 앱이 로그인으로 확인된 소속을 API 요청에 붙입니다.</p>
            </section>}

            {scheduleActionStatus !== "idle" && <div className={`scheduleAction ${scheduleActionStatus}`} role={scheduleActionStatus === "error" ? "alert" : "status"}><p>{scheduleActionMessage}</p>{scheduleActionStatus === "error" && scheduleRetryRef.current && <button className="secondary" onClick={() => scheduleRetryRef.current?.()}>다시 시도</button>}</div>}

            {scheduleListState === "idle" && <div className="deviceListState"><h2>예약을 불러오세요.</h2><button className="secondary" onClick={loadSchedules}>예약 목록 불러오기</button></div>}
            {scheduleListState === "loading" && <div className="deviceListState" role="status"><div className="spinner" /><h2>예약을 불러오고 있어요.</h2></div>}
            {scheduleListState === "error" && <div className="deviceListState" role="alert"><h2>예약을 불러오지 못했어요.</h2><p>{scheduleListError}</p><button className="secondary" onClick={loadSchedules}>다시 시도</button></div>}
            {scheduleListState === "ready" && schedules.length === 0 && <div className="deviceListState"><h2>등록된 예약이 없어요.</h2><p>＋ 버튼으로 첫 예약을 만들어보세요.</p><button className="secondary" onClick={loadSchedules}>새로고침</button></div>}
            {scheduleListState === "ready" && schedules.map((schedule) => {
              const target = devices.find((device) => device.id === schedule.targetId);
              const pending = schedule.syncStatus === "PENDING_SYNC" || schedule.syncStatus === "DELETE_PENDING" || scheduleMutationRef.current?.scheduleId === schedule.scheduleId;
              const color = scheduleColor(schedule);
              return <article className={`scheduleCard actual ${schedule.syncStatus.toLowerCase()}`} key={schedule.scheduleId}>
                <div className="scheduleMain"><div className="scheduleCardHead"><span className="scheduleTime">{schedule.localTime}</span></div><strong>{schedule.name}</strong><p>{scheduleDays(schedule.daysOfWeek)} · {target?.name ?? schedule.targetId}</p><p>전원 {schedule.desiredState.power === false ? "끄기" : "켜기"} · 밝기 {schedule.desiredState.brightness ?? "-"}%</p><div className="scheduleSync"><span className="statusDot" />{scheduleStatusLabel(schedule)}{color && <i style={{ background: color }} />}</div>{schedule.syncStatus === "ERROR" && <small>{schedule.failureCode ?? "동기화 실패"}{schedule.retryAt ? ` · 재시도 ${new Date(schedule.retryAt).toLocaleString("ko-KR")}` : ""}</small>}</div>
                <div className="scheduleButtons">
                  {schedule.syncStatus === "ERROR" ? <button className="secondary" disabled={pending} onClick={() => retrySchedule(schedule)}>재시도</button> : <button className={`switch ${schedule.enabled ? "on" : ""}`} disabled={pending} onClick={() => updateScheduleEnabled(schedule, !schedule.enabled)} aria-label={`${schedule.name} 활성 전환`}><span /></button>}
                  <button className="deleteButton" disabled={pending} onClick={() => deleteSchedule(schedule)}>삭제</button>
                </div>
              </article>;
            })}
          </>}
        </section>
      )}

      <nav className="bottomNav">
        <button className={screen === "home" || screen === "device" || screen === "add" ? "active" : ""} onClick={screen === "add" ? leaveProvisioning : screen === "device" ? leaveDevice : () => setScreen("home")}><span>⌂</span>홈</button>
        <button className={screen === "schedules" ? "active" : ""} onClick={() => { if (screen === "add") cleanupProvisioning(); openSchedules(); }}><span>◷</span>예약</button>
        <button onClick={logout}><span>⇥</span>{demoMode || hardwareTestMode ? "처음" : "로그아웃"}</button>
      </nav>
    </main>
  );
}
