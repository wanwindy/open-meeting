import type { Page } from "playwright-core";

import { sleep } from "../utils/wait.js";

export async function humanDelay(meanMs = 500, varianceMs = 200): Promise<void> {
  const jitter = Math.floor((Math.random() - 0.5) * varianceMs * 2);
  await sleep(Math.max(100, meanMs + jitter));
}

export async function moveMouseSlightly(page: Page): Promise<void> {
  const x = 400 + Math.floor(Math.random() * 200);
  const y = 300 + Math.floor(Math.random() * 200);

  await page.mouse.move(x, y, { steps: 12 });
}

