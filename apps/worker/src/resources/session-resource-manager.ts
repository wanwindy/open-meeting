import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { getPlatformConfig } from "../config/platform-config.js";
import type { BridgeSession, SessionResourceAssignment } from "../types.js";
import type { Logger } from "../utils/logger.js";
import { spawnLongRunningProcess, terminateProcess } from "../utils/process.js";
import { sleep } from "../utils/wait.js";

interface DisplayReservation {
  displayNumber: number;
  process?: ChildProcessWithoutNullStreams;
}

interface SessionResourceReservation {
  displays: [DisplayReservation, DisplayReservation];
  videoDevices: string[];
  assignment: SessionResourceAssignment;
}

export class SessionResourceManager {
  private readonly reservations = new Map<string, SessionResourceReservation>();
  private readonly allocatedDisplayNumbers = new Set<number>();
  private readonly allocatedVideoDevices = new Set<string>();
  private readonly displayStart = Number.parseInt(process.env.WORKER_XVFB_DISPLAY_START ?? "99", 10);
  private readonly displayCount = Number.parseInt(process.env.WORKER_XVFB_DISPLAY_COUNT ?? "24", 10);
  private readonly videoDevices = parseVideoDevices(process.env.WORKER_VIDEO_DEVICES);

  constructor(private readonly logger: Logger) {}

  async allocate(session: BridgeSession): Promise<SessionResourceAssignment> {
    const existing = this.reservations.get(session.id);

    if (existing) {
      return existing.assignment;
    }

    const sourceBrowser = getPlatformConfig(session.source.platform).browser;
    const targetBrowser = getPlatformConfig(session.target.platform).browser;
    const sourceDisplay = this.reserveDisplay();
    const targetDisplay = this.reserveDisplay();
    const reservation: SessionResourceReservation = {
      displays: [sourceDisplay, targetDisplay],
      videoDevices: [],
      assignment: {
        source: {
          display: `:${sourceDisplay.displayNumber}`,
          pulseSink: `bridge_${session.id}_a_sink`,
          pulseSource: `bridge_${session.id}_a_mic`
        },
        target: {
          display: `:${targetDisplay.displayNumber}`,
          pulseSink: `bridge_${session.id}_b_sink`,
          pulseSource: `bridge_${session.id}_b_mic`
        }
      }
    };

    try {
      if (!session.options.dryRun) {
        sourceDisplay.process = await this.startXvfb(sourceDisplay.displayNumber, sourceBrowser.windowWidth, sourceBrowser.windowHeight);
        targetDisplay.process = await this.startXvfb(targetDisplay.displayNumber, targetBrowser.windowWidth, targetBrowser.windowHeight);
      }

      if (session.options.enableVideo) {
        const [sourceVideoDevice, targetVideoDevice] = await this.reserveVideoPair(session.options.dryRun);
        reservation.videoDevices = [sourceVideoDevice, targetVideoDevice];
        reservation.assignment.source.videoDevice = sourceVideoDevice;
        reservation.assignment.target.videoDevice = targetVideoDevice;
      }

      this.reservations.set(session.id, reservation);
      return reservation.assignment;
    } catch (error) {
      await this.releaseReservation(reservation);
      throw error;
    }
  }

  async release(sessionId: string): Promise<void> {
    const reservation = this.reservations.get(sessionId);

    if (!reservation) {
      return;
    }

    await this.releaseReservation(reservation);
    this.reservations.delete(sessionId);
  }

  private reserveDisplay(): DisplayReservation {
    for (let offset = 0; offset < this.displayCount; offset += 1) {
      const displayNumber = this.displayStart + offset;

      if (this.allocatedDisplayNumbers.has(displayNumber)) {
        continue;
      }

      this.allocatedDisplayNumbers.add(displayNumber);
      return { displayNumber };
    }

    throw new Error(`No free Xvfb display is available in range :${this.displayStart}-:${this.displayStart + this.displayCount - 1}`);
  }

  private async reserveVideoPair(dryRun: boolean): Promise<[string, string]> {
    if (dryRun) {
      return [this.videoDevices[0] ?? "/dev/video-dryrun-a", this.videoDevices[1] ?? "/dev/video-dryrun-b"];
    }

    if (this.videoDevices.length < 2) {
      throw new Error(
        "Video is enabled but WORKER_VIDEO_DEVICES is not configured with at least two mapped v4l2loopback devices"
      );
    }

    const available = this.videoDevices.filter((device) => !this.allocatedVideoDevices.has(device));

    if (available.length < 2) {
      throw new Error(
        `Not enough free virtual camera devices; set WORKER_VIDEO_DEVICES with at least two unused devices per session`
      );
    }

    const selected = available.slice(0, 2) as [string, string];

    for (const device of selected) {
      await access(device, fsConstants.F_OK).catch(() => {
        throw new Error(
          `Virtual camera device ${device} is missing. Load v4l2loopback on the host before starting the worker.`
        );
      });
    }

    for (const device of selected) {
      this.allocatedVideoDevices.add(device);
    }

    return selected;
  }

  private async startXvfb(displayNumber: number, width: number, height: number): Promise<ChildProcessWithoutNullStreams> {
    const display = `:${displayNumber}`;
    const childProcess = spawnLongRunningProcess("Xvfb", [display, "-screen", "0", `${width}x${height}x24`], {
      env: globalThis.process.env
    });

    childProcess.stderr.on("data", (chunk) => {
      this.logger.warn("Xvfb stderr", {
        display,
        stderr: chunk.toString().trim()
      });
    });

    childProcess.on("exit", (code, signal) => {
      this.logger.warn("Xvfb exited", {
        display,
        code,
        signal
      });
    });

    await this.waitForDisplay(displayNumber, childProcess);
    return childProcess;
  }

  private async waitForDisplay(displayNumber: number, process: ChildProcessWithoutNullStreams): Promise<void> {
    const lockPath = `/tmp/.X${displayNumber}-lock`;
    const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
    const startedAt = Date.now();

    while (Date.now() - startedAt < 5_000) {
      if (process.exitCode !== null) {
        throw new Error(`Xvfb :${displayNumber} exited before the display became ready`);
      }

      const ready = (await pathExists(lockPath)) || (await pathExists(socketPath));
      if (ready) {
        return;
      }

      await sleep(100);
    }

    throw new Error(`Timed out waiting for Xvfb :${displayNumber} to become ready`);
  }

  private async releaseReservation(reservation: SessionResourceReservation): Promise<void> {
    for (const device of reservation.videoDevices) {
      this.allocatedVideoDevices.delete(device);
    }

    for (const display of reservation.displays) {
      this.allocatedDisplayNumbers.delete(display.displayNumber);

      if (display.process) {
        await terminateProcess(display.process).catch((error) => {
          this.logger.warn("Failed to stop Xvfb process", {
            display: `:${display.displayNumber}`,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }
  }
}

function parseVideoDevices(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
