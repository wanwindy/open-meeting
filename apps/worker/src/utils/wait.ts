export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  options: {
    timeoutMs: number;
    intervalMs?: number;
  }
): Promise<void> {
  const startedAt = Date.now();
  const intervalMs = options.intervalMs ?? 1000;

  while (Date.now() - startedAt < options.timeoutMs) {
    if (await predicate()) {
      return;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out after ${options.timeoutMs}ms`);
}

