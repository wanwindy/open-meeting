import { randomUUID } from "node:crypto";

import { createAgent } from "../agents/index.js";
import { FingerprintPool } from "../anti-detect/fingerprint-pool.js";
import { ProxyManager } from "../anti-detect/proxy-manager.js";
import { SessionHealthMonitor } from "../health-monitor/session-health-monitor.js";
import { AudioManager } from "../pipeline/audio-manager.js";
import { VideoManager } from "../pipeline/video-manager.js";
import { SessionResourceManager } from "../resources/session-resource-manager.js";
import type {
  BridgeSession,
  SessionStatus,
  SessionStatusSnapshot
} from "../types.js";
import type { Logger } from "../utils/logger.js";
import { fetchWithTimeout, validateWebhookUrl } from "../utils/network.js";
import { sleep } from "../utils/wait.js";

interface SessionOrchestratorOptions {
  onTerminal?: (snapshot: SessionStatusSnapshot) => void;
}

export class SessionOrchestrator {
  private readonly fingerprintPool = new FingerprintPool();
  private readonly proxyManager = new ProxyManager();
  private readonly audioManager;
  private readonly videoManager;
  private readonly sourceAgent;
  private readonly targetAgent;
  private healthMonitor?: SessionHealthMonitor;
  private snapshot: SessionStatusSnapshot;
  private stopped = false;
  private reconnectInFlight?: Promise<void>;
  private terminalNotified = false;

  constructor(
    private readonly session: BridgeSession,
    private readonly logger: Logger,
    private readonly resourceManager: SessionResourceManager,
    private readonly options: SessionOrchestratorOptions = {}
  ) {
    this.audioManager = new AudioManager(logger.child({ scope: "audio" }));
    this.videoManager = new VideoManager(logger.child({ scope: "video" }));
    this.sourceAgent = createAgent(session.source.platform, logger.child({ scope: "agent.source" }));
    this.targetAgent = createAgent(session.target.platform, logger.child({ scope: "agent.target" }));
    this.snapshot = {
      sessionId: session.id,
      traceId: session.options.traceId ?? randomUUID(),
      status: "CREATED"
    };
  }

  async start(): Promise<SessionStatusSnapshot> {
    try {
      await this.updateStatus("INITIALIZING", "Allocating browser and media resources");
      await this.establishBridge();
      await this.updateStatus("BRIDGING", `${this.session.source.platform} -> ${this.session.target.platform} is live`);
      return this.snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failSession(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async stop(reason = "manual"): Promise<SessionStatusSnapshot> {
    if (this.stopped) {
      return this.snapshot;
    }

    this.stopped = true;
    await this.updateStatus("TERMINATING", reason);
    await this.teardownCurrentAttempt();
    await this.updateStatus("TERMINATED", reason);
    return this.snapshot;
  }

  getSnapshot(): SessionStatusSnapshot {
    return this.snapshot;
  }

  private async requestReconnect(trigger: string): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.reconnectInFlight) {
      return this.reconnectInFlight;
    }

    this.reconnectInFlight = this.handleReconnect(trigger).finally(() => {
      this.reconnectInFlight = undefined;
    });

    return this.reconnectInFlight;
  }

  private async handleReconnect(trigger: string): Promise<void> {
    const maxAttempts = this.session.options.maxReconnectAttempts ?? 3;
    await this.updateStatus("RECONNECTING", trigger);
    await this.teardownCurrentAttempt();

    let lastError = trigger;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.stopped) {
        return;
      }

      try {
        await sleep(Math.min(5_000, attempt * 1_000));
        await this.establishBridge();
        await this.updateStatus("BRIDGING", `Reconnected after ${attempt} attempt(s)`);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.logger.warn("Reconnect attempt failed", {
          attempt,
          maxAttempts,
          error: lastError
        });
        await this.teardownCurrentAttempt();
      }
    }

    await this.failSession(`Reconnect failed after ${maxAttempts} attempt(s): ${lastError}`);
  }

  private async establishBridge(): Promise<void> {
    const resources = await this.resourceManager.allocate(this.session);

    if (this.session.options.enableAudio) {
      await this.audioManager.configure(this.session.id, resources.source, resources.target, {
        enableAec: this.session.options.enableAec,
        dryRun: this.session.options.dryRun
      });
    }

    if (this.session.options.enableVideo) {
      await this.videoManager.configure(this.session.id, resources.source, resources.target, this.session.options.dryRun);
    }

    const sourceFingerprint = this.fingerprintPool.pick();
    const targetFingerprint = this.fingerprintPool.pick([sourceFingerprint.id]);
    const sourceProxy = this.proxyManager.pick();
    const targetProxy = this.proxyManager.pick();

    await Promise.all([
      this.sourceAgent.init(sourceFingerprint, sourceProxy, resources.source, this.session.options.dryRun),
      this.targetAgent.init(targetFingerprint, targetProxy, resources.target, this.session.options.dryRun)
    ]);

    await this.updateStatus("JOINING_A", `Joining ${this.session.source.platform}`);
    await this.sourceAgent.joinMeeting({
      endpoint: this.session.source,
      devices: resources.source,
      session: this.session
    });

    await this.updateStatus("JOINING_B", `Joining ${this.session.target.platform}`);
    await this.targetAgent.joinMeeting({
      endpoint: this.session.target,
      devices: resources.target,
      session: this.session
    });

    this.healthMonitor?.stop();
    this.healthMonitor = new SessionHealthMonitor({
      sessionId: this.session.id,
      logger: this.logger.child({ scope: "health" }),
      sourceAgent: this.sourceAgent,
      targetAgent: this.targetAgent,
      checkAudioHealthy: this.session.options.enableAudio
        ? () => this.audioManager.isHealthy(this.session.id, this.session.options.dryRun)
        : undefined,
      checkVideoHealthy: this.session.options.enableVideo ? () => this.videoManager.isHealthy(this.session.id) : undefined,
      onReconnectNeeded: async (message) => {
        await this.requestReconnect(message);
      },
      onMeetingEnded: async (reason) => {
        await this.stop(reason);
      }
    });
    this.healthMonitor.start();
  }

  private async failSession(message: string): Promise<void> {
    this.stopped = true;
    await this.updateStatus("FAILED", message);
    await this.teardownCurrentAttempt();
  }

  private async teardownCurrentAttempt(): Promise<void> {
    this.healthMonitor?.stop();
    this.healthMonitor = undefined;

    const results = await Promise.allSettled([
      this.sourceAgent.cleanup(),
      this.targetAgent.cleanup(),
      this.audioManager.teardown(this.session.id, this.session.options.dryRun),
      this.videoManager.teardown(this.session.id),
      this.resourceManager.release(this.session.id)
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.warn("Teardown task failed", {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    }
  }

  private async updateStatus(status: SessionStatus, message?: string): Promise<void> {
    this.snapshot = {
      sessionId: this.session.id,
      traceId: this.snapshot.traceId,
      status,
      message
    };

    this.logger.info("Session status updated", {
      status,
      message
    });

    if (this.session.options.webhookUrl) {
      void this.notifyWebhook(status, message);
    }

    if ((status === "FAILED" || status === "TERMINATED") && !this.terminalNotified) {
      this.terminalNotified = true;
      this.options.onTerminal?.(this.snapshot);
    }
  }

  private async notifyWebhook(status: SessionStatus, message?: string): Promise<void> {
    const validation = validateWebhookUrl(this.session.options.webhookUrl!);

    if (!validation.ok) {
      this.logger.warn("Skipping webhook notification", {
        reason: validation.reason
      });
      return;
    }

    const payload = {
      event: "session.status_changed",
      session_id: this.session.id,
      status,
      trace_id: this.snapshot.traceId,
      message,
      timestamp: new Date().toISOString()
    };

    try {
      await fetchWithTimeout(validation.url, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        timeoutMs: 3_000
      });
    } catch (error) {
      this.logger.warn("Webhook notification failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
