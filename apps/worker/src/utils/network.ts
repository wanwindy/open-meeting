import { isIP } from "node:net";

const privateIpv4Patterns = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./
];

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

export function validateWebhookUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "webhook URL is not a valid URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "webhook URL must use http or https" };
  }

  const hostname = url.hostname.toLowerCase();

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "webhook URL cannot target localhost" };
  }

  if (isIP(hostname)) {
    if (isPrivateIpLiteral(hostname)) {
      return { ok: false, reason: "webhook URL cannot target a private or loopback IP" };
    }
  }

  return { ok: true, url };
}

function isPrivateIpLiteral(hostname: string): boolean {
  const ipVersion = isIP(hostname);

  if (ipVersion === 4) {
    return privateIpv4Patterns.some((pattern) => pattern.test(hostname));
  }

  if (ipVersion === 6) {
    return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:");
  }

  return false;
}
