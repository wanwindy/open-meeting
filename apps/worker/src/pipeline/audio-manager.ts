import type { AudioRoutingAssignment, PlatformDeviceAssignment } from "../types.js";
import type { Logger } from "../utils/logger.js";
import { runCommand } from "../utils/process.js";

export class AudioManager {
  private readonly modulesBySession = new Map<string, number[]>();
  private syntheticModuleId = 10_000;

  constructor(private readonly logger: Logger) {}

  async configure(
    sessionId: string,
    platformA: PlatformDeviceAssignment,
    platformB: PlatformDeviceAssignment,
    options: {
      enableAec: boolean;
      dryRun: boolean;
    }
  ): Promise<AudioRoutingAssignment> {
    const moduleIds: number[] = [];

    moduleIds.push(await this.loadModule(["module-null-sink", `sink_name=${platformA.pulseSink}`], options.dryRun));
    moduleIds.push(await this.loadModule(["module-null-sink", `sink_name=${platformB.pulseSink}`], options.dryRun));
    moduleIds.push(
      await this.loadModule(
        [
          "module-remap-source",
          `master=${platformB.pulseSink}.monitor`,
          `source_name=${platformA.pulseSource}`
        ],
        options.dryRun
      )
    );
    moduleIds.push(
      await this.loadModule(
        [
          "module-remap-source",
          `master=${platformA.pulseSink}.monitor`,
          `source_name=${platformB.pulseSource}`
        ],
        options.dryRun
      )
    );

    if (options.enableAec) {
      this.logger.info("AEC is enabled in config; current MVP keeps routing isolated and leaves fine-tuning to deployment");
    }

    this.modulesBySession.set(sessionId, moduleIds);

    return {
      platformA,
      platformB,
      moduleIds
    };
  }

  async teardown(sessionId: string, dryRun: boolean): Promise<void> {
    const moduleIds = this.modulesBySession.get(sessionId) ?? [];

    for (const moduleId of [...moduleIds].reverse()) {
      await runCommand("pactl", ["unload-module", String(moduleId)], { dryRun }).catch((error) => {
        this.logger.warn("Failed to unload PulseAudio module", {
          moduleId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }

    this.modulesBySession.delete(sessionId);
  }

  async isHealthy(sessionId: string, dryRun: boolean): Promise<boolean> {
    const moduleIds = this.modulesBySession.get(sessionId);

    if (!moduleIds) {
      return false;
    }

    if (dryRun) {
      return true;
    }

    try {
      const result = await runCommand("pactl", ["list", "short", "modules"]);
      const activeIds = new Set(
        result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => Number.parseInt(line.split(/\s+/)[0] ?? "", 10))
          .filter((value) => !Number.isNaN(value))
      );

      return moduleIds.every((moduleId) => activeIds.has(moduleId));
    } catch (error) {
      this.logger.warn("Failed to inspect PulseAudio modules", {
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  private async loadModule(args: string[], dryRun: boolean): Promise<number> {
    if (dryRun) {
      return this.syntheticModuleId++;
    }

    const result = await runCommand("pactl", ["load-module", ...args]);
    const moduleId = Number.parseInt(result.stdout.trim(), 10);

    if (Number.isNaN(moduleId)) {
      throw new Error(`Unexpected pactl output while loading module: ${result.stdout}`);
    }

    return moduleId;
  }
}
