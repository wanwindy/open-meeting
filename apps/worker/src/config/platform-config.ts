import platforms from "../../config/platforms.json" with { type: "json" };

import type { PlatformConfig, PlatformType } from "../types.js";

const configs = platforms as Record<string, PlatformConfig>;

export function getPlatformConfig(platform: PlatformType): PlatformConfig {
  const config = configs[platform];

  if (!config) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  return config;
}

export function resolveJoinUrl(platform: PlatformType, meetingId: string, explicitUrl?: string): string {
  if (explicitUrl) {
    return explicitUrl;
  }

  return getPlatformConfig(platform).joinUrlTemplate.replace("{meetingId}", meetingId);
}

