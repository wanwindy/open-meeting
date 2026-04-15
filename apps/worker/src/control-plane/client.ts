import type { WorkerRuntime } from "../runtime/worker-runtime.js";
import type { Logger } from "../utils/logger.js";
import { fetchWithTimeout } from "../utils/network.js";

export class ControlPlaneClient {
  private heartbeatTimer?: NodeJS.Timeout;
  private registered = false;

  constructor(
    private readonly baseUrl: string,
    private readonly logger: Logger
  ) {}

  async register(runtime: WorkerRuntime): Promise<void> {
    const nodeInfo = runtime.getNodeInfo();

    const response = await fetchWithTimeout(`${this.baseUrl}/v1/nodes/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        node_id: nodeInfo.nodeId,
        hostname: nodeInfo.hostname,
        grpc_address: nodeInfo.grpcAdvertiseAddress
      }),
      timeoutMs: 5_000
    });

    if (!response.ok) {
      throw new Error(`register failed with status ${response.status}`);
    }

    this.registered = true;
  }

  startHeartbeat(runtime: WorkerRuntime): void {
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat(runtime);
    }, 30_000);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async sendHeartbeat(runtime: WorkerRuntime): Promise<void> {
    const heartbeat = runtime.heartbeat();

    try {
      if (!this.registered) {
        await this.register(runtime);
        return;
      }

      const response = await fetchWithTimeout(`${this.baseUrl}/v1/nodes/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          node_id: heartbeat.nodeId,
          active_sessions: heartbeat.activeSessions,
          status: heartbeat.status
        }),
        timeoutMs: 5_000
      });

      if (response.status === 404) {
        this.registered = false;
        await this.register(runtime);
        return;
      }

      if (!response.ok) {
        throw new Error(`heartbeat failed with status ${response.status}`);
      }
    } catch (error) {
      this.registered = false;
      this.logger.warn("Failed to send heartbeat", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
