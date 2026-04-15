import type { BaseAgent } from "../agents/base-agent.js";
import type { SessionStatus } from "../types.js";
import type { Logger } from "../utils/logger.js";

interface SessionHealthMonitorOptions {
  sessionId: string;
  logger: Logger;
  sourceAgent: BaseAgent;
  targetAgent: BaseAgent;
  checkVideoHealthy?: () => Promise<boolean> | boolean;
  checkAudioHealthy?: () => Promise<boolean> | boolean;
  onReconnectNeeded: (message: string) => Promise<void>;
  onMeetingEnded: (reason: string) => Promise<void>;
  intervalMs?: number;
}

export class SessionHealthMonitor {
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: SessionHealthMonitorOptions) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs ?? 5_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    const { logger, sourceAgent, targetAgent, onReconnectNeeded, onMeetingEnded } = this.options;

    if (!sourceAgent.isAlive() || !targetAgent.isAlive()) {
      await onReconnectNeeded("Browser process is no longer alive");
      return;
    }

    if (this.options.checkAudioHealthy && !(await this.options.checkAudioHealthy())) {
      logger.warn("Audio routing is unhealthy");
      await onReconnectNeeded("Audio routing is unhealthy");
      return;
    }

    if (this.options.checkVideoHealthy && !(await this.options.checkVideoHealthy())) {
      logger.warn("Video forwarding is unhealthy");
      await onReconnectNeeded("Video forwarding is unhealthy");
      return;
    }

    await Promise.all([sourceAgent.keepAlive(), targetAgent.keepAlive()]);

    if ((await sourceAgent.hasMeetingEnded()) || (await targetAgent.hasMeetingEnded())) {
      await onMeetingEnded("meeting_ended");
    }
  }
}
