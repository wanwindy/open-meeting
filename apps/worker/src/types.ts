export type PlatformType =
  | "tencent"
  | "dingtalk"
  | "feishu"
  | "lark"
  | "zhumu"
  | "huawei"
  | "welink";

export type SessionStatus =
  | "CREATED"
  | "INITIALIZING"
  | "JOINING_A"
  | "JOINING_B"
  | "BRIDGING"
  | "RECONNECTING"
  | "TERMINATING"
  | "TERMINATED"
  | "FAILED";

export interface MeetingEndpoint {
  platform: PlatformType;
  meetingId: string;
  password?: string;
  displayName: string;
  meetingUrl?: string;
}

export interface SessionOptions {
  enableAudio: boolean;
  enableVideo: boolean;
  enableAec: boolean;
  dryRun: boolean;
  traceId?: string;
  webhookUrl?: string;
  maxReconnectAttempts?: number;
}

export interface BridgeSession {
  id: string;
  source: MeetingEndpoint;
  target: MeetingEndpoint;
  options: SessionOptions;
}

export interface JoinParams {
  endpoint: MeetingEndpoint;
  devices: PlatformDeviceAssignment;
  session: BridgeSession;
}

export interface FingerprintProfile {
  id: string;
  userAgent: string;
  locale: string;
  timezone: string;
  viewport: {
    width: number;
    height: number;
  };
}

export interface ProxyEntry {
  enabled: boolean;
  server?: string;
  username?: string;
  password?: string;
}

export interface PlatformBrowserConfig {
  windowWidth: number;
  windowHeight: number;
}

export interface PlatformSelectors {
  browserEntryButton?: string;
  displayNameInput?: string;
  meetingPasswordInput?: string;
  joinButton: string;
  muteButton?: string;
  cameraButton?: string;
  participantCount?: string;
  meetingEndedBanner?: string;
  leaveButton?: string;
  cameraDeviceLabel?: string;
  microphoneDeviceLabel?: string;
}

export interface PlatformConfig {
  joinUrlTemplate: string;
  browser: PlatformBrowserConfig;
  selectors: PlatformSelectors;
}

export interface PlatformDeviceAssignment {
  display: string;
  pulseSink: string;
  pulseSource: string;
  videoDevice?: string;
}

export interface SessionResourceAssignment {
  source: PlatformDeviceAssignment;
  target: PlatformDeviceAssignment;
}

export interface AudioRoutingAssignment {
  platformA: PlatformDeviceAssignment;
  platformB: PlatformDeviceAssignment;
  moduleIds: number[];
}

export interface VideoRoutingAssignment {
  ffmpegProcessIds: number[];
  platformA: PlatformDeviceAssignment;
  platformB: PlatformDeviceAssignment;
}

export interface SessionStatusSnapshot {
  sessionId: string;
  traceId: string;
  status: SessionStatus;
  message?: string;
}

export interface WorkerNodeInfo {
  nodeId: string;
  hostname: string;
  grpcBindAddress: string;
  grpcAdvertiseAddress: string;
}
