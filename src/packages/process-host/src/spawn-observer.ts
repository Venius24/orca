import { appendFileSync } from 'node:fs'

// Main installs diagnostics here; daemon, relay, and CLI cannot depend on main code.
export type SpawnObserver = (command: string, args: readonly string[], blockMs: number) => void

let observer: SpawnObserver | null = null

/**
 * E2E only: every process-host spawn, in any thread or child that inherits the environment, is
 * appended here as a JSON line, so a guard can see spawns main's own observer never would.
 * Logs full argv, which can include tokens; tests only (main drops it outside e2e mode).
 */
export const E2E_SPAWN_LOG_ENV = 'ORCA_E2E_SPAWN_LOG'

function e2eSpawnLog(): string | undefined {
  return process.env[E2E_SPAWN_LOG_ENV] || undefined
}

export function setSpawnObserver(next: SpawnObserver | null): void {
  observer = next
}

export function notifySpawnObserver(
  command: string,
  args: readonly string[],
  blockMs: number
): void {
  observer?.(command, args, blockMs)
  const log = e2eSpawnLog()
  if (log) {
    try {
      appendFileSync(log, `${JSON.stringify({ file: command, args })}\n`)
    } catch {
      // A diagnostics write must never fail the spawn it describes.
    }
  }
}

export function hasSpawnObserver(): boolean {
  return observer !== null || e2eSpawnLog() !== undefined
}
