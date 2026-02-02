import { ChildProcess, spawn } from "node:child_process";
import treeKill from "tree-kill";
import log from "electron-log";

const logger = log.scope("process_manager");

export interface RunningAppInfo {
  process: ChildProcess;
  processId: number;
  isDocker: boolean;
  containerName?: string;
}

export const runningApps = new Map<number, RunningAppInfo>();
let processCounterValue = 0;

export const processCounter = {
  get value(): number {
    return processCounterValue;
  },
  set value(newValue: number) {
    processCounterValue = newValue;
  },
  increment(): number {
    return ++processCounterValue;
  },
};

/**
 * Kills a running process with its child processes
 * @param process The child process to kill
 * @param pid The process ID
 * @returns A promise that resolves when the process is closed or timeout
 */
export function killProcess(process: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      logger.warn(
        `Timeout waiting for process (PID: ${process.pid}) to close.`,
      );
      resolve();
    }, 5000);

    process.on("close", (_code, _signal) => {
      clearTimeout(timeout);
      resolve();
    });

    process.on("error", (err) => {
      clearTimeout(timeout);
      logger.error(
        `Error during stop sequence for process (PID: ${process.pid}): ${err.message}`,
      );
      resolve();
    });

    if (process.pid) {
      treeKill(process.pid, "SIGTERM", (err: Error | undefined) => {
        if (err) {
          logger.warn(`tree-kill error for PID ${process.pid}: ${err.message}`);
        }
      });
    } else {
      logger.warn(`Cannot tree-kill process: PID is undefined.`);
    }
  });
}

/**
 * Gracefully stops a Docker container by name. Resolves even if the container doesn't exist.
 */
export function stopDockerContainer(containerName: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = spawn("docker", ["stop", containerName], { stdio: "pipe" });
    stop.on("close", () => resolve());
    stop.on("error", () => resolve());
  });
}

/**
 * Removes Docker named volumes used for an app's dependencies.
 * Best-effort: resolves even if volumes don't exist.
 */
export function removeDockerVolumesForApp(appId: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const pnpmVolume = `dyad-pnpm-${appId}`;

    const rm = spawn("docker", ["volume", "rm", "-f", pnpmVolume], {
      stdio: "pipe",
    });
    rm.on("close", () => resolve());
    rm.on("error", () => resolve());
  });
}

/**
 * Stops an app based on its RunningAppInfo (container vs host) and removes it from the running map.
 */
export async function stopAppByInfo(
  appId: number,
  appInfo: RunningAppInfo,
): Promise<void> {
  if (appInfo.isDocker) {
    const containerName = appInfo.containerName || `dyad-app-${appId}`;
    await stopDockerContainer(containerName);
  } else {
    await killProcess(appInfo.process);
  }
  runningApps.delete(appId);
}

/**
 * Removes an app from the running apps map if it's the current process
 * @param appId The app ID
 * @param process The process to check against
 */
export function removeAppIfCurrentProcess(
  appId: number,
  process: ChildProcess,
): void {
  const currentAppInfo = runningApps.get(appId);
  if (currentAppInfo && currentAppInfo.process === process) {
    runningApps.delete(appId);
  }
}
