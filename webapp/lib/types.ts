export type DeviceState = {
  id: string;
  name: string;
  room: string;
  online: boolean | null;
  power: boolean;
  color: string;
  brightness: number;
  desiredState?: {
    power: boolean;
    color: string;
    brightness: number;
  };
  lastCommandId?: string;
  appliedCommandId?: string;
};

export type NearbyDevice = {
  id: string;
  name: string | null;
  rssi: number | null;
  serviceUuids: string[];
  model?: string;
  serial?: string;
  protocolVersion?: string;
  provisioningState?: "unregistered" | "bootstrapped" | "registered";
};

export type WifiNetwork = {
  ssid: string;
  rssi: number;
  secure: boolean;
};

export type ProvisioningStage =
  | "idle"
  | "scanning"
  | "connecting"
  | "connected"
  | "wifi"
  | "secure-session"
  | "wifi-connected"
  | "fleet-provisioned"
  | "bootstrapped"
  | "provisioning"
  | "complete"
  | "failed"
  | "cancelled";

export type BleAdapterState =
  | "unknown"
  | "unsupported"
  | "unauthorized"
  | "powered-off"
  | "powered-on";
