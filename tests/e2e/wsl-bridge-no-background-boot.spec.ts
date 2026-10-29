/**
 * E9 guard on a real WSL distro: background work never starts a stopped distro. A project inside
 * the lane's distro is opened, the distro is terminated, and a window of ordinary background work
 * elsewhere must start nothing in it; the user then opening a terminal there starts it. Runs only
 * where ORCA_E2E_WSL_TERMINATE_DISTRO names a distro this run owns, since it terminates it.
 *
 * The running-list watcher is the authoritative assertion: `wsl --list --running`, polled through
 * the window, sees every boot, including a plain UNC read or git.exe with a UNC cwd. The spawn log
 * is diagnostics that name the caller: process-host spawns from any thread or inheriting child,
 * plus main's direct child_process spawns. It cannot see direct spawnSync calls outside
 * process-host (wsl-availability's missing-kernel `--exec /bin/true` is a documented exception)
 * or spawns in children that drop the environment.
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { visitSettingsPanes } from './helpers/settings-pane-visits'
import { buildWslExecArgs } from '../../src/shared/wsl-login-shell-command'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'

const DISTRO = process.env.ORCA_E2E_WSL_TERMINATE_DISTRO?.trim() ?? ''

/** Settings panes whose mount reads host, account, CLI or integration state. */
const SETTINGS_PANES = [
  'general',
  'integrations',
  'accounts',
  'agents',
  'git',
  'tasks',
  'session-history',
  'automations'
] as const

type SpawnRecord = { file: string; args: string[] }

const SPAWN_LOG = path.join(os.tmpdir(), `orca-e2e-wsl-spawns-${process.pid}-${Date.now()}.jsonl`)
// Every process-host spawn in the app (main, worker threads, inheriting children) lands here.
test.use({ launchEnv: { ORCA_E2E_SPAWN_LOG: SPAWN_LOG } })

function wsl(args: readonly string[]): string {
  // UTF-8 instead of wsl.exe's default UTF-16 for its own listings.
  return execFileSync('wsl.exe', [...args], {
    encoding: 'utf8',
    env: { ...process.env, WSL_UTF8: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
}

/**
 * `--list --running` never starts a distro. Exit 1 is "no running distributions"; any other
 * failure (timeout, spawn error, other exit) rejects, so it can never read as "stopped".
 */
function isDistroRunning(distro: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      ['--list', '--running', '--quiet'],
      {
        encoding: 'utf8',
        env: { ...process.env, WSL_UTF8: '1' },
        timeout: 5_000,
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          if (error.code === 1 && !error.killed) {
            resolve(false)
          } else {
            reject(error)
          }
          return
        }
        resolve(
          stdout
            .split(/\r?\n/)
            .map((line) => line.replaceAll('\0', '').trim().toLowerCase())
            .includes(distro.toLowerCase())
        )
      }
    )
  })
}

/** Polls the running list once a second, never overlapping, until stopped; three failed reads in a row fail the guard. */
function watchDistroRunning(distro: string): {
  stop: () => Promise<{ seenRunning: boolean; reads: number }>
} {
  let stopped = false
  let seenRunning = false
  let reads = 0
  let failures = 0
  let failure: unknown = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: Promise<void> = Promise.resolve()
  const tick = (): void => {
    current = isDistroRunning(distro)
      .then((running) => {
        reads += 1
        failures = 0
        seenRunning ||= running
      })
      .catch((error: unknown) => {
        failures += 1
        if (failures >= 3) {
          failure = error
        }
      })
      .finally(() => {
        if (!stopped && failure === null) {
          timer = setTimeout(tick, 1_000)
        }
      })
  }
  tick()
  return {
    stop: async () => {
      stopped = true
      clearTimeout(timer)
      await current
      if (failure !== null) {
        throw new Error(`wsl --list --running kept failing: ${String(failure)}`)
      }
      return { seenRunning, reads }
    }
  }
}

function runInDistro(distro: string, script: string): void {
  execFileSync('wsl.exe', ['-u', 'root', ...buildWslExecArgs(distro, ['sh', '-c', script])], {
    stdio: 'pipe',
    windowsHide: true
  })
}

/**
 * Logs main's direct child_process spawns too (spawn, exec and execFile all pass through
 * ChildProcess#spawn), beside the process-host log. node-pty terminals do not, and need not.
 */
async function recordMainProcessSpawns(app: ElectronApplication, logFile: string): Promise<void> {
  await app.evaluate((_electron, logFile) => {
    const fs = process.mainModule?.require('node:fs')
    const proto = process.mainModule?.require('node:child_process')?.ChildProcess?.prototype
    if (!fs || !proto) {
      throw new Error('Cannot hook child_process in the main process')
    }
    if (proto.spawn.orcaE9SpawnLog) {
      return
    }
    const original = proto.spawn
    const logged = function (this: unknown, options: { file?: string; args?: string[] }) {
      fs.appendFileSync(
        logFile,
        `${JSON.stringify({ file: String(options?.file ?? ''), args: options?.args ?? [] })}\n`
      )
      return original.call(this, options)
    }
    logged.orcaE9SpawnLog = true
    proto.spawn = logged
  }, logFile)
}

function readSpawnLog(logFile: string): SpawnRecord[] {
  if (!existsSync(logFile)) {
    return []
  }
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line): SpawnRecord => {
      const parsed: unknown = JSON.parse(line)
      const file =
        parsed && typeof parsed === 'object' && 'file' in parsed ? String(parsed.file) : ''
      const args =
        parsed && typeof parsed === 'object' && 'args' in parsed && Array.isArray(parsed.args)
          ? parsed.args.map(String)
          : []
      return { file, args }
    })
}

/** wsl.exe verbs that never start a distro; any other launch counts as starting the default one. */
const NON_BOOTING_WSL_VERBS = new Set([
  '-l',
  '--list',
  '--status',
  '--version',
  '-v',
  '-t',
  '--terminate',
  '--shutdown',
  '--help'
])

/** Fails closed: a wsl.exe launch starts `distro` unless it names another one or only lists. */
function startsDistro(spawn: SpawnRecord, distro: string): boolean {
  if (!/(^|[\\/])wsl(\.exe)?$/i.test(spawn.file)) {
    return false
  }
  // main's ChildProcess#spawn args carry argv0; process-host's do not.
  const raw = /(^|[\\/])wsl(\.exe)?$/i.test(spawn.args[0] ?? '') ? spawn.args.slice(1) : spawn.args
  const args = raw.map((arg) => arg.toLowerCase())
  const named = args.findIndex((arg) => arg === '-d' || arg === '--distribution')
  if (named !== -1) {
    return args[named + 1] === distro.toLowerCase()
  }
  return !NON_BOOTING_WSL_VERBS.has(args[0] ?? '')
}

async function cycleWindowFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'))
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  })
}

async function activate(page: Page, worktreeId: string | null): Promise<void> {
  await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
}

test.describe('E9: background work on a stopped real WSL distro', () => {
  test.skip(
    process.platform !== 'win32' || !DISTRO,
    'Needs a Windows run that owns a WSL distro it may terminate (ORCA_E2E_WSL_TERMINATE_DISTRO)'
  )

  test('starts nothing in the stopped distro until the user opens a terminal there', async ({
    electronApp,
    orcaPage: page
  }, testInfo) => {
    // Distro setup, a terminate, a 20 s background window and a boot.
    test.setTimeout(300_000)
    await waitForSessionReady(page)
    const localWorktreeId = await waitForActiveWorktree(page)
    const linuxRoot = `/tmp/orca-e9-${Date.now()}`
    const repoLinuxPath = `${linuxRoot}/repo`
    runInDistro(
      DISTRO,
      `mkdir -p ${quotePosixShell(repoLinuxPath)} && cd ${quotePosixShell(repoLinuxPath)} && ` +
        'git init -q -b main . && printf "# e9\\n" > README.md && git add . && ' +
        'git -c user.name=e2e -c user.email=e2e@example.com commit -qm init'
    )
    const uncPath = `\\\\wsl.localhost\\${DISTRO}${repoLinuxPath.replaceAll('/', '\\')}`
    try {
      // Open the WSL project while the distro runs: its sidebar card carries a linked issue and PR.
      const wslWorktreeId = await page.evaluate(async (path) => {
        const store = window.__store!
        const added = await window.api.repos.add({ path, kind: 'git' })
        if ('error' in added) {
          throw new Error(added.error)
        }
        await store.getState().fetchWorktrees(added.repo.id)
        const worktree = store
          .getState()
          .worktreesByRepo[added.repo.id]?.find((row) => row.isMainWorktree)
        if (!worktree) {
          throw new Error('WSL checkout missing')
        }
        await store.getState().updateWorktreeMeta(worktree.id, { linkedIssue: 1, linkedPR: 2 })
        return { worktreeId: worktree.id, repoId: added.repo.id }
      }, uncPath)
      await activate(page, wslWorktreeId.worktreeId)
      await activate(page, localWorktreeId)

      await recordMainProcessSpawns(electronApp, SPAWN_LOG)
      // Counted from before the terminate, so work started while it stops counts too.
      const spawnsBefore = readSpawnLog(SPAWN_LOG).length
      wsl(['--terminate', DISTRO])
      // WSL1 instances can live only seconds, so watch the running list from the terminate on.
      const watcher = watchDistroRunning(DISTRO)
      let watched: { seenRunning: boolean; reads: number } | undefined
      try {
        for (let round = 0; round < 2; round += 1) {
          await cycleWindowFocus(page)
          await activate(page, null)
          await cycleWindowFocus(page)
          await activate(page, localWorktreeId)
          await visitSettingsPanes(page, SETTINGS_PANES, wslWorktreeId.repoId)
          await page.evaluate(() => window.__store?.getState().setActiveView('tasks'))
          await page.evaluate(async () => {
            // Account switches re-sync every account home, including WSL ones.
            await window.api.codexAccounts.select({ accountId: null }).catch(() => {})
            await window.api.claudeAccounts.select({ accountId: null }).catch(() => {})
          })
          await page.evaluate(() => window.__store?.getState().setActiveView('terminal'))
        }
        await page.screenshot({ path: testInfo.outputPath('wsl-bridge-background-window.png') })
        // ast-grep-ignore: test-no-real-time-wait -- the claim is that nothing boots over a window of real background work
        await page.waitForTimeout(15_000)
      } finally {
        watched = await watcher.stop()
      }
      // Authoritative: the distro never ran during the window.
      expect(watched.reads).toBeGreaterThan(10)
      expect(watched.seenRunning).toBe(false)
      expect(await isDistroRunning(DISTRO)).toBe(false)
      // Diagnostics that name the caller; non-empty so the check cannot pass vacuously.
      const background = readSpawnLog(SPAWN_LOG).slice(spawnsBefore)
      expect(background.length).toBeGreaterThan(0)
      expect(background.filter((spawn) => startsDistro(spawn, DISTRO))).toEqual([])

      // The user opens the WSL workspace and a terminal in it: that act starts the distro.
      await activate(page, wslWorktreeId.worktreeId)
      await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
      await page
        .getByRole('menuitem', { name: /New Terminal/ })
        .first()
        .click()
      await expect(page.locator('.xterm:visible').first()).toBeVisible({ timeout: 60_000 })
      await expect.poll(() => isDistroRunning(DISTRO), { timeout: 60_000 }).toBe(true)
      await page.screenshot({ path: testInfo.outputPath('wsl-bridge-after-terminal.png') })
    } finally {
      runInDistro(DISTRO, `rm -rf ${quotePosixShell(linuxRoot)}`)
      rmSync(SPAWN_LOG, { force: true })
    }
  })
})
