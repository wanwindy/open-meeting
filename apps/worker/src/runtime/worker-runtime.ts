import { randomUUID } from "node:crypto";

import { SessionOrchestrator } from "../orchestrator/session-orchestrator.js";
import { SessionResourceManager } from "../resources/session-resource-manager.js";
import type {
  BridgeSession,
  SessionOptions,
  SessionStatusSnapshot,
  WorkerNodeInfo
} from "../types.js";
import type { Logger } from "../utils/logger.js";

const DEFAULT_RECENT_SNAPSHOT_LIMIT = 1_000;

export class WorkerRuntime {
  private readonly sessions = new Map<string, SessionOrchestrator>();
  private readonly recentSnapshots = new Map<string, SessionStatusSnapshot>();
  private readonly recentSnapshotLimit = parseRecentSnapshotLimit(process.env.WORKER_RECENT_SNAPSHOTS_LIMIT);
  private readonly resourceManager: SessionResourceManager;

  constructor(
    private readonly nodeInfo: WorkerNodeInfo,
    private readonly logger: Logger
  ) {
    this.resourceManager = new SessionResourceManager(logger.child({ scope: "resources" }));
  }

  async startSession(session: Omit<BridgeSession, "options"> & { options?: Partial<SessionOptions> }): Promise<SessionStatusSnapshot> {
    const normalizedSession: BridgeSession = {
      ...session,
      options: {
        enableAudio: session.options?.enableAudio ?? true,
        enableVideo: session.options?.enableVideo ?? true,
        enableAec: session.options?.enableAec ?? false,
        dryRun: session.options?.dryRun ?? false,
        traceId: session.options?.traceId ?? randomUUID(),
        webhookUrl: session.options?.webhookUrl,
        maxReconnectAttempts: session.options?.maxReconnectAttempts ?? 3
      }
    };

    if (this.sessions.has(normalizedSession.id)) {
      throw new Error(`Session ${normalizedSession.id} already exists`);
    }

    const orchestrator = new SessionOrchestrator(
      normalizedSession,
      this.logger.child({
        scope: "session",
        sessionId: normalizedSession.id,
        traceId: normalizedSession.options.traceId
      }),
      this.resourceManager,
      {
        onTerminal: (snapshot) => {
          this.sessions.delete(snapshot.sessionId);
          this.rememberRecentSnapshot(snapshot);
        }
      }
    );

    this.recentSnapshots.delete(normalizedSession.id);
    this.sessions.set(normalizedSession.id, orchestrator);

    try {
      return await orchestrator.start();
    } catch (error) {
      this.sessions.delete(normalizedSession.id);
      throw error;
    }
  }

  async stopSession(sessionId: string, reason = "manual"): Promise<SessionStatusSnapshot> {
    const orchestrator = this.sessions.get(sessionId);

    if (!orchestrator) {
      const snapshot = this.recentSnapshots.get(sessionId);

      if (snapshot) {
        return snapshot;
      }

      throw new Error(`Session ${sessionId} not found`);
    }

    const snapshot = await orchestrator.stop(reason);
    this.sessions.delete(sessionId);
    this.rememberRecentSnapshot(snapshot);
    return snapshot;
  }

  getSessionStatus(sessionId: string): SessionStatusSnapshot {
    const orchestrator = this.sessions.get(sessionId);

    if (!orchestrator) {
      const snapshot = this.getRecentSnapshot(sessionId);

      if (snapshot) {
        return snapshot;
      }

      throw new Error(`Session ${sessionId} not found`);
    }

    return orchestrator.getSnapshot();
  }

  heartbeat(): { nodeId: string; activeSessions: number; status: string } {
    return {
      nodeId: this.nodeInfo.nodeId,
      activeSessions: this.sessions.size,
      status: "online"
    };
  }

  getNodeInfo(): WorkerNodeInfo {
    return this.nodeInfo;
  }

  async shutdown(reason = "process_shutdown"): Promise<void> {
    const sessionIds = [...this.sessions.keys()];

    await Promise.allSettled(sessionIds.map((sessionId) => this.stopSession(sessionId, reason)));
  }

  private getRecentSnapshot(sessionId: string): SessionStatusSnapshot | undefined {
    const snapshot = this.recentSnapshots.get(sessionId);

    if (!snapshot) {
      return undefined;
    }

    // Refresh insertion order so the cache behaves like a small LRU.
    this.recentSnapshots.delete(sessionId);
    this.recentSnapshots.set(sessionId, snapshot);
    return snapshot;
  }

  private rememberRecentSnapshot(snapshot: SessionStatusSnapshot): void {
    if (this.recentSnapshotLimit < 1) {
      return;
    }

    this.recentSnapshots.delete(snapshot.sessionId);
    this.recentSnapshots.set(snapshot.sessionId, snapshot);

    while (this.recentSnapshots.size > this.recentSnapshotLimit) {
      const oldestSessionId = this.recentSnapshots.keys().next().value;

      if (!oldestSessionId) {
        break;
      }

      this.recentSnapshots.delete(oldestSessionId);
    }
  }
}

function parseRecentSnapshotLimit(rawValue: string | undefined): number {
  if (!rawValue) {
    return DEFAULT_RECENT_SNAPSHOT_LIMIT;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_RECENT_SNAPSHOT_LIMIT;
  }

  return parsed;
}
