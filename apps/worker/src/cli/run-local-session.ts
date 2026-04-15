import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { WorkerRuntime } from "../runtime/worker-runtime.js";
import { rootLogger } from "../utils/logger.js";

async function main(): Promise<void> {
  const sessionFile = process.argv[2];

  if (!sessionFile) {
    throw new Error("Usage: npm run local -- <session-json-path>");
  }

  const content = await readFile(resolve(process.cwd(), sessionFile), "utf8");
  const session = JSON.parse(content) as Parameters<WorkerRuntime["startSession"]>[0];
  const runtime = new WorkerRuntime(
    {
      nodeId: process.env.NODE_ID ?? "local-worker",
      hostname: hostname(),
      grpcBindAddress: process.env.WORKER_GRPC_BIND ?? "0.0.0.0:50051",
      grpcAdvertiseAddress: process.env.WORKER_GRPC_ADVERTISE ?? "127.0.0.1:50051"
    },
    rootLogger
  );

  const snapshot = await runtime.startSession(session);
  rootLogger.info("Local session started", snapshot);

  if (session.options?.dryRun) {
    await runtime.stopSession(snapshot.sessionId, "dry_run_complete");
    return;
  }

  process.on("SIGINT", () => {
    void runtime.stopSession(snapshot.sessionId, "manual");
  });

  await new Promise(() => undefined);
}

void main().catch((error) => {
  rootLogger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

