/**
 * E9 guard on a real WSL distro: background work never starts a stopped distro. A project inside
 * the lane's distro is opened, the distro is terminated, and a window of ordinary background work
 * elsewhere must launch nothing in it; the user then opening a terminal there starts it. Runs only
 * where ORCA_E2E_WSL_TERMINATE_DISTRO names a distro this run owns, since it terminates it.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

function wsl(args: readonly string[]): string {
  // UTF-8 instead of wsl.exe's default UTF-16 for its own listings.
  return execFileSync('wsl.exe', [...args], {
    encoding: 'utf8',
    env: { ...process.env, WSL_UTF8: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
}

/** `--list --running` never starts a distro; it exits non-zero when none runs. */
function isDistroRunning(distro: string): boolean {
  let listing: string
  try {
    listing = wsl(['--list', '--running', '--quiet'])
  } catch {
    return false
  }
  return listing
    .split(/\r?\n/)
    .map((line) => line.replaceAll('\0', '').trim().toLowerCase())
    .includes(distro.toLowerCase())
}

function runInDistro(distro: string, script: string): void {
  execFileSync('wsl.exe', ['-u', 'root', ...buildWslExecArgs(distro, ['sh', '-c', script])], {
    stdio: 'pipe',
    windowsHide: true
  })
}

/**
 * Logs every child the main process starts to `logFile`, one JSON line each: spawn, exec and
 * execFile all pass through ChildProcess#spawn. node-pty terminals do not, and need not.
 */
async function recordMainProcessSpawns(app: ElectronApplication, logFile: string): Promise<void> {
  await app.evaluate((_electron, logFile) => {
    const fs = process.mainModule?.require('node:fs')
    const proto = process.mainModule?.require('node:child_process')?.ChildProcess?.prototype
    if (!fs || !proto || proto.spawn.orcaE9SpawnLog) {
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

function readMainProcessSpawns(logFile: string): SpawnRecord[] {
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

/** A wsl.exe launch that runs something in `distro` (or the default one); listings are fine. */
function startsDistro(spawn: SpawnRecord, distro: string): boolean {
  if (!/(^|[\\/])wsl(\.exe)?$/i.test(spawn.file)) {
    return false
  }
  const args = spawn.args.slice(1).map((arg) => arg.toLowerCase())
  const named = args.findIndex((arg) => arg === '-d' || arg === '--distribution')
  if (named !== -1) {
    return args[named + 1] === distro.toLowerCase()
  }
  return args.includes('--exec') || args.includes('-e')
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
    const logDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-spawns-'))
    const spawnLog = path.join(logDir, 'spawns.jsonl')
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

      await recordMainProcessSpawns(electronApp, spawnLog)
      wsl(['--terminate', DISTRO])
      await expect.poll(() => isDistroRunning(DISTRO), { timeout: 60_000 }).toBe(false)
      const spawnsBefore = readMainProcessSpawns(spawnLog).length
      // WSL1 instances can live only seconds, so watch the running list through the whole window.
      let seenRunning = false
      const watcher = setInterval(() => {
        seenRunning ||= isDistroRunning(DISTRO)
      }, 1_000)
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
        clearInterval(watcher)
      }
      const background = readMainProcessSpawns(spawnLog).slice(spawnsBefore)
      expect(background.filter((spawn) => startsDistro(spawn, DISTRO))).toEqual([])
      expect(seenRunning).toBe(false)
      expect(isDistroRunning(DISTRO)).toBe(false)

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
      rmSync(logDir, { recursive: true, force: true })
    }
  })
})
