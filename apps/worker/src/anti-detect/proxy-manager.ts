import type { ProxyEntry } from "../types.js";

export class ProxyManager {
  pick(): ProxyEntry {
    const candidates = (process.env.WORKER_PROXY_URLS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (candidates.length > 0) {
      const selected = new URL(candidates[Math.floor(Math.random() * candidates.length)]!);

      return {
        enabled: true,
        server: `${selected.protocol}//${selected.host}`,
        username: selected.username || undefined,
        password: selected.password || undefined
      };
    }

    return {
      enabled: false
    };
  }
}
