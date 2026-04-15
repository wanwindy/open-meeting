import { hostname } from "node:os";

import { ControlPlaneClient } from "./control-plane/client.js";
import { startGrpcServer } from "./grpc/server.js";
import { WorkerRuntime } from "./runtime/worker-runtime.js";
import { rootLogger } from "./utils/logger.js";

async function main(): Promise<void> {
  const grpcBindAddress = process.env.WORKER_GRPC_BIND ?? "127.0.0.1:50051";
  const grpcAdvertiseAddress = process.env.WORKER_GRPC_ADVERTISE ?? "127.0.0.1:50051";
  const grpcToken = process.env.WORKER_GRPC_TOKEN;
  const grpcTlsEnabled = Boolean(process.env.WORKER_GRPC_TLS_CERT_PATH && process.env.WORKER_GRPC_TLS_KEY_PATH);

  if (!isLoopbackBind(grpcBindAddress) && !grpcToken) {
    throw new Error("WORKER_GRPC_TOKEN must be set when WORKER_GRPC_BIND is not loopback");
  }

  const runtime = new WorkerRuntime(
    {
      nodeId: process.env.NODE_ID ?? "worker-local",
      hostname: hostname(),
      grpcBindAddress,
      grpcAdvertiseAddress
    },
    rootLogger
  );

  const server = await startGrpcServer(runtime, runtime.getNodeInfo().grpcBindAddress);
  rootLogger.info("Worker gRPC server started", runtime.getNodeInfo());

  if (!isLoopbackBind(grpcBindAddress) && !grpcTlsEnabled) {
    rootLogger.warn("Worker gRPC server is listening on a non-loopback address without TLS", {
      grpcBindAddress
    });
  }

  const controlPlaneUrl = process.env.CONTROL_PLANE_URL;
  let controlPlaneClient: ControlPlaneClient | undefined;

  if (controlPlaneUrl) {
    controlPlaneClient = new ControlPlaneClient(controlPlaneUrl, rootLogger.child({ scope: "control-plane" }));
    await controlPlaneClient.register(runtime).catch((error) => {
      rootLogger.warn("Initial control-plane registration failed; heartbeat loop will retry", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    controlPlaneClient.startHeartbeat(runtime);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    rootLogger.info("Worker shutdown requested", { signal });
    controlPlaneClient?.stopHeartbeat();
    await runtime.shutdown(signal);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        server.forceShutdown();
        resolve();
      }, 5_000);

      server.tryShutdown(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main().catch((error) => {
  rootLogger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function isLoopbackBind(bindAddress: string): boolean {
  return bindAddress.startsWith("127.0.0.1:") || bindAddress.startsWith("localhost:") || bindAddress.startsWith("[::1]:");
}
