import { Server, ServerCredentials, loadPackageDefinition, status, type Metadata } from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { WorkerRuntime } from "../runtime/worker-runtime.js";

const protoPath = fileURLToPath(new URL("../../../../proto/worker.proto", import.meta.url));

type Callback<T> = (error: Error | null, value?: T) => void;

interface LoadedProto {
  openmeeting: {
    worker: {
      v1: {
        WorkerService: {
          service: object;
        };
      };
    };
  };
}

export async function startGrpcServer(runtime: WorkerRuntime, bindAddress: string): Promise<Server> {
  const requiredToken = process.env.WORKER_GRPC_TOKEN;
  const packageDefinition = protoLoader.loadSync(protoPath, {
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  });
  const loaded = loadPackageDefinition(packageDefinition) as unknown as LoadedProto;
  const workerService = loaded.openmeeting.worker.v1.WorkerService;

  const server = new Server();
  const credentials = await loadServerCredentials();

  server.addService(workerService.service as never, {
    StartSession: async (
      call: { request: Record<string, unknown>; metadata: Metadata },
      callback: Callback<Record<string, unknown>>
    ) => {
      try {
        assertAuthorized(call.metadata, requiredToken);
        const request = call.request;
        const snapshot = await runtime.startSession({
          id: String(request.session_id),
          source: normalizeEndpoint(request.source as Record<string, unknown>),
          target: normalizeEndpoint(request.target as Record<string, unknown>),
          options: normalizeOptions(request.options as Record<string, unknown> | undefined)
        });

        callback(null, {
          session_id: snapshot.sessionId,
          status: snapshot.status,
          trace_id: snapshot.traceId
        });
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    StopSession: async (
      call: { request: Record<string, unknown>; metadata: Metadata },
      callback: Callback<Record<string, unknown>>
    ) => {
      try {
        assertAuthorized(call.metadata, requiredToken);
        const snapshot = await runtime.stopSession(String(call.request.session_id), String(call.request.reason || "manual"));
        callback(null, {
          session_id: snapshot.sessionId,
          status: snapshot.status
        });
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    GetSessionStatus: (
      call: { request: Record<string, unknown>; metadata: Metadata },
      callback: Callback<Record<string, unknown>>
    ) => {
      try {
        assertAuthorized(call.metadata, requiredToken);
        const snapshot = runtime.getSessionStatus(String(call.request.session_id));
        callback(null, {
          session_id: snapshot.sessionId,
          status: snapshot.status,
          trace_id: snapshot.traceId,
          message: snapshot.message ?? ""
        });
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    Heartbeat: (call: { metadata: Metadata }, callback: Callback<Record<string, unknown>>) => {
      try {
        assertAuthorized(call.metadata, requiredToken);
      } catch (error) {
        callback(error as Error);
        return;
      }

      const heartbeat = runtime.heartbeat();
      callback(null, {
        node_id: heartbeat.nodeId,
        status: heartbeat.status,
        active_sessions: heartbeat.activeSessions
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.bindAsync(bindAddress, credentials, (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
  });

  return server;
}

function normalizeEndpoint(endpoint: Record<string, unknown>) {
  return {
    platform: String(endpoint.platform) as
      | "tencent"
      | "dingtalk"
      | "feishu"
      | "lark"
      | "zhumu"
      | "huawei"
      | "welink",
    meetingId: String(endpoint.meeting_id),
    password: endpoint.password ? String(endpoint.password) : undefined,
    displayName: endpoint.display_name ? String(endpoint.display_name) : "Open Meeting Bridge",
    meetingUrl: endpoint.meeting_url ? String(endpoint.meeting_url) : undefined
  };
}

async function loadServerCredentials(): Promise<ServerCredentials> {
  const certPath = process.env.WORKER_GRPC_TLS_CERT_PATH;
  const keyPath = process.env.WORKER_GRPC_TLS_KEY_PATH;
  const caPath = process.env.WORKER_GRPC_TLS_CA_PATH;
  const requireClientCert = isTruthy(process.env.WORKER_GRPC_TLS_REQUIRE_CLIENT_CERT);

  if (!certPath && !keyPath && !caPath) {
    return ServerCredentials.createInsecure();
  }

  if (!certPath || !keyPath) {
    throw new Error("WORKER_GRPC_TLS_CERT_PATH and WORKER_GRPC_TLS_KEY_PATH must be set together");
  }

  if (requireClientCert && !caPath) {
    throw new Error("WORKER_GRPC_TLS_CA_PATH is required when WORKER_GRPC_TLS_REQUIRE_CLIENT_CERT is enabled");
  }

  const [certificate, privateKey, certificateAuthority] = await Promise.all([
    readFile(certPath),
    readFile(keyPath),
    caPath ? readFile(caPath) : Promise.resolve<Buffer | null>(null)
  ]);

  return ServerCredentials.createSsl(
    certificateAuthority,
    [
      {
        cert_chain: certificate,
        private_key: privateKey
      }
    ],
    requireClientCert
  );
}

function isTruthy(rawValue: string | undefined): boolean {
  if (!rawValue) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(rawValue.toLowerCase());
}

function assertAuthorized(metadata: Metadata, requiredToken?: string): void {
  if (!requiredToken) {
    return;
  }

  const authorization = String(metadata.get("authorization")[0] ?? "");
  const workerToken = String(metadata.get("x-worker-token")[0] ?? "");
  const candidate = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : workerToken;

  if (candidate !== requiredToken) {
    const error = Object.assign(new Error("unauthorized"), {
      code: status.UNAUTHENTICATED
    });
    throw error;
  }
}

function normalizeOptions(options: Record<string, unknown> | undefined) {
  return {
    enableAudio: Boolean(options?.enable_audio ?? true),
    enableVideo: Boolean(options?.enable_video ?? true),
    enableAec: Boolean(options?.enable_aec ?? false),
    dryRun: Boolean(options?.dry_run ?? false),
    traceId: options?.trace_id ? String(options.trace_id) : undefined,
    webhookUrl: options?.webhook_url ? String(options.webhook_url) : undefined,
    maxReconnectAttempts: options?.max_reconnect_attempts ? Number(options.max_reconnect_attempts) : undefined
  };
}
