import { requireNativeModule } from "expo-modules-core";

type PingResult =
  | { reply: "pong"; mode: "test" }
  | { reply: "pong"; mode: "product"; serial: string; registrationCode: string };
type ClaimBindingResult = { status: "acknowledged" };
type WifiProvisionResult = { status: "connected" };
type WifiNetwork = { ssid: string; rssi: number; secure: boolean };

type MoodlightSecureProvisioningModule = {
  scanQrAndConnectAndPing(
    deviceId: string,
    expectedDeviceName: string,
    primaryServiceUuid: string,
  ): Promise<PingResult>;
  bindDeviceClaim(deviceId: string, claimId: string, registrationNonce: string): Promise<ClaimBindingResult>;
  scanWifiNetworks(): Promise<WifiNetwork[]>;
  provisionWifi(deviceId: string, ssid: string, password: string): Promise<WifiProvisionResult>;
  disconnect(): Promise<void>;
};

export default requireNativeModule<MoodlightSecureProvisioningModule>(
  "MoodlightSecureProvisioning",
);
