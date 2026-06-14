export interface CommonResp {
  code: number;
  message: string;
  data?: unknown;
  timestamp: number;
}

export interface BuildInfo {
  version: string;
  build: string;
  commit: string;
  arch: string;
}

export interface AppConfig {
  urlPrefix: string;
  basicAuthUser?: string;
  basicAuthPassword?: string;
  maxBatchPushCount: number;
  maxRequestBodyBytes: number;
  mcpSessionSecret?: string;
  closeRegister: boolean;
}

export interface BarkBindings {
  DEVICE_REGISTRY: KVNamespace;
  URL_PREFIX?: string;
  BASIC_AUTH_USER?: string;
  BASIC_AUTH_PASSWORD?: string;
  MAX_BATCH_PUSH_COUNT?: string;
  MAX_REQUEST_BODY_BYTES?: string;
  MCP_SESSION_SECRET?: string;
  CLOSE_REGISTER?: string | boolean;
  APP_VERSION?: string;
  APP_BUILD?: string;
  APP_COMMIT?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
}

export type ParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ParamMap
  | ParamValue[];

export type ParamMap = Record<string, unknown>;

export interface DeviceRegistry {
  countAll(): Promise<number>;
  deviceTokenByKey(key: string): Promise<string>;
  saveDeviceTokenByKey(key: string, token: string): Promise<string>;
  deleteDeviceByKey(key: string): Promise<void>;
}

export interface PushMessage {
  id?: string;
  deviceKey: string;
  deviceToken: string;
  title: string;
  subtitle: string;
  body: string;
  sound: string;
  extParams: Record<string, unknown>;
}

export interface ApnsSendError extends Error {
  statusCode?: number;
  reason?: string;
}

export interface PushSender {
  send(message: PushMessage): Promise<void>;
}

export interface RuntimeDeps {
  registry: DeviceRegistry;
  pushSender: PushSender;
  now(): number;
  buildInfo: BuildInfo;
}
