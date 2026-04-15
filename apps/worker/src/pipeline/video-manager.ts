import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { PlatformDeviceAssignment, VideoRoutingAssignment } from "../types.js";
import type { Logger } from "../utils/logger.js";
import { spawnLongRunningProcess, terminateProcess } from "../utils/process.js";

interface VideoProcessState {
  dryRun: boolean;
  failed: boolean;
  processes: ChildProcessWithoutNullStreams[];
}

export class VideoManager {
  private readonly processesBySession = new Map<string, VideoProcessState>();

  constructor(private readonly logger: Logger) {}

  async configure(
    sessionId: string,
    platformA: PlatformDeviceAssignment,
    platformB: PlatformDeviceAssignment,
    dryRun: boolean
  ): Promise<VideoRoutingAssignment> {
    const processes: ChildProcessWithoutNullStreams[] = [];
    const state: VideoProcessState = {
      dryRun,
      failed: false,
      processes
    };

    if (!dryRun) {
      if (!platformA.videoDevice || !platformB.videoDevice) {
        throw new Error("Video is enabled but virtual camera devices are missing");
      }

      const processA = this.spawnForwarder(sessionId, platformA.display, platformB.videoDevice, state);
      const processB = this.spawnForwarder(sessionId, platformB.display, platformA.videoDevice, state);
      processes.push(processA, processB);
    }

    this.processesBySession.set(sessionId, state);

    return {
      ffmpegProcessIds: processes.map((process) => process.pid ?? 0),
      platformA,
      platformB
    };
  }

  async teardown(sessionId: string): Promise<void> {
    const state = this.processesBySession.get(sessionId);
    const processes = state?.processes ?? [];

    for (const process of processes) {
      await terminateProcess(process).catch((error) => {
        this.logger.warn("Failed to stop FFmpeg process", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }

    this.processesBySession.delete(sessionId);
  }

  isHealthy(sessionId: string): boolean {
    const state = this.processesBySession.get(sessionId);

    if (!state) {
      return false;
    }

    if (state.dryRun) {
      return true;
    }

    if (state.failed) {
      return false;
    }

    return state.processes.every((process) => process.exitCode === null && !process.killed);
  }

  private spawnForwarder(
    sessionId: string,
    display: string,
    device: string,
    state: VideoProcessState
  ): ChildProcessWithoutNullStreams {
    const args = [
      "-loglevel",
      "warning",
      "-f",
      "x11grab",
      "-video_size",
      "1280x720",
      "-framerate",
      "15",
      "-i",
      display,
      "-vf",
      "format=yuv420p",
      "-f",
      "v4l2",
      device
    ];

    this.logger.info("Starting FFmpeg video forwarder", { display, device });
    const childProcess = spawnLongRunningProcess("ffmpeg", args, { env: globalThis.process.env });

    childProcess.stderr.on("data", (chunk) => {
      this.logger.warn("FFmpeg stderr", {
        sessionId,
        display,
        device,
        stderr: chunk.toString().trim()
      });
    });

    childProcess.on("error", (error) => {
      state.failed = true;
      this.logger.error("FFmpeg process error", {
        sessionId,
        display,
        device,
        error: error.message
      });
    });

    childProcess.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        state.failed = true;
      }

      this.logger.warn("FFmpeg process exited", {
        sessionId,
        display,
        device,
        code,
        signal
      });
    });

    return childProcess;
  }
}
