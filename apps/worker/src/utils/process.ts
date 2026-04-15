import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCommand(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { dryRun?: boolean } = {}
): Promise<CommandResult> {
  if (options.dryRun) {
    return {
      stdout: `[dry-run] ${command} ${args.join(" ")}`,
      stderr: "",
      exitCode: 0
    };
  }

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: "pipe"
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 1;

      if (exitCode !== 0) {
        reject(new Error(`${command} exited with code ${exitCode}: ${stderr}`));
        return;
      }

      resolve({ stdout, stderr, exitCode });
    });
  });
}

export function spawnLongRunningProcess(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio = {}
): ChildProcessWithoutNullStreams {
  return spawn(command, args, {
    ...options,
    stdio: "pipe"
  });
}

export async function terminateProcess(
  process: ChildProcessWithoutNullStreams,
  options: { signal?: NodeJS.Signals; timeoutMs?: number } = {}
): Promise<void> {
  if (process.killed || process.exitCode !== null) {
    return;
  }

  const signal = options.signal ?? "SIGTERM";
  const timeoutMs = options.timeoutMs ?? 3_000;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (process.exitCode === null && !process.killed) {
        process.kill("SIGKILL");
      }
    }, timeoutMs);

    process.once("close", () => {
      clearTimeout(timer);
      resolve();
    });

    process.kill(signal);
  });
}
