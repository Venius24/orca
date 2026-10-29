import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { E2E_SPAWN_LOG_ENV, setSpawnObserver } from './spawn-observer'
import { runProcess, runProcessSync, spawnProcess } from './run-process'

afterEach(() => {
  setSpawnObserver(null)
  delete process.env[E2E_SPAWN_LOG_ENV]
})

describe('spawn observer', () => {
  it('reports the resolved program for a spawnProcess child', async () => {
    const seen: { command: string; args: readonly string[]; blockMs: number }[] = []
    setSpawnObserver((command, args, blockMs) => seen.push({ command, args, blockMs }))
    const child = spawnProcess({ program: process.execPath, args: ['-e', 'process.exit(0)'] })
    await new Promise((resolve) => child.on('exit', resolve))
    expect(seen).toHaveLength(1)
    expect(seen[0].command).toBe(process.execPath)
    expect(seen[0].args).toEqual(['-e', 'process.exit(0)'])
    expect(seen[0].blockMs).toBeGreaterThanOrEqual(0)
  })

  it('reports exactly once for runProcess, which spawns through spawnProcess', async () => {
    let calls = 0
    setSpawnObserver(() => {
      calls += 1
    })
    await runProcess({ program: process.execPath, args: ['-e', 'process.exit(0)'] })
    expect(calls).toBe(1)
  })

  it('reports the whole blocking run of runProcessSync', () => {
    const seen: { command: string; blockMs: number }[] = []
    setSpawnObserver((command, _args, blockMs) => seen.push({ command, blockMs }))
    const result = runProcessSync({
      program: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(3), 50)']
    })
    expect(result.code).toBe(3)
    expect(seen).toHaveLength(1)
    expect(seen[0].command).toBe(process.execPath)
    expect(seen[0].blockMs).toBeGreaterThanOrEqual(40)
  })

  it('reports a runProcessSync launch that throws or times out', () => {
    const seen: string[] = []
    setSpawnObserver((command) => seen.push(command))
    const missing = path.join(tmpdir(), 'orca-spawn-observer-missing-program')
    expect(() => runProcessSync({ program: missing, args: [] })).toThrow()
    const timedOut = runProcessSync({
      program: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      timeoutMs: 50
    })
    expect(timedOut.timedOut).toBe(true)
    expect(seen).toEqual([missing, process.execPath])
  })

  it('stops reporting after the observer is cleared', async () => {
    let calls = 0
    setSpawnObserver(() => {
      calls += 1
    })
    setSpawnObserver(null)
    await runProcess({ program: process.execPath, args: ['-e', 'process.exit(0)'] })
    expect(calls).toBe(0)
  })

  it('logs every spawn, sync or async, to the e2e spawn log when one is named', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orca-spawn-log-'))
    const log = path.join(dir, 'spawns.jsonl')
    process.env[E2E_SPAWN_LOG_ENV] = log
    try {
      await runProcess({ program: process.execPath, args: ['-e', 'process.exit(0)'] })
      runProcessSync({ program: process.execPath, args: ['-e', 'process.exit(0)'] })
      const lines = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(lines).toEqual([
        { file: process.execPath, args: ['-e', 'process.exit(0)'] },
        { file: process.execPath, args: ['-e', 'process.exit(0)'] }
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
