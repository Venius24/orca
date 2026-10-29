import {
  publicRuntimeEnvironment,
  connectedRuntimeStatus
} from './paired-runtime-environment-test-fixture'
import { makeHostSnapshot } from './host-session-mirror-frame-fixtures'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { TerminalPresentationObservation } from '../../../shared/terminal-foreground-presentation'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../shared/terminal-input'
import { admitSshConnectionState } from '../../../shared/ssh-retained-payload-admission'
import { installDesktopTerminalObservationOwners } from './desktop-terminal-observation-owner'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { useAppStore, type AppState } from '../store'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import type { RemoteForegroundEvidence } from '../../../shared/foreground-process-evidence'
export function liveEvidence(ptyId: string, processName = 'bash'): RemoteForegroundEvidence {
  return {
    authorityGeneration: 'authority-1',
    observationEpoch: 1,
    capturedAgeMs: 0,
    ptyId,
    ptyIncarnationId: 'incarnation-1',
    verdict: 'live',
    processName,
    fence: {
      platform: 'posix',
      shellPid: 1,
      shellStartTime: '1',
      tty: '/dev/pts/1',
      foregroundPgid: 1
    }
  }
}

export function createRuntimeTerminalInspectionFixtures(): {
  runtimeCall: Mock
  runtimeTransportCall: Mock
  localWrite: Mock
  localWriteAccepted: Mock
  localForeground: Mock
  localHasChildren: Mock
  localInspect: Mock
} {
  const runtimeCall = vi.fn()
  const runtimeTransportCall = vi.fn()
  const localWrite = vi.fn()
  const localWriteAccepted = vi.fn()
  const localForeground = vi.fn()
  const localHasChildren = vi.fn()
  const localInspect = vi.fn()

  let dispose: (() => void) | undefined
  afterEach(() => dispose?.())
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
    runtimeCall.mockResolvedValue({
      ok: true,
      result: {
        process: {
          foregroundProcess: 'bash',
          hasChildProcesses: true,
          foregroundProcessEvidence: liveEvidence('terminal-1')
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    runtimeTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeCall(args)
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: runtimeTransportCall },
        runtime: { call: runtimeTransportCall },
        pty: {
          write: localWrite,
          writeAccepted: localWriteAccepted,
          getForegroundProcess: localForeground,
          hasChildProcesses: localHasChildren,
          inspectProcess: localInspect
        }
      }
    })
    useAppStore.setState({
      settings: createGlobalSettingsFixture({
        ...useAppStore.getState().settings,
        experimentalAgentHibernation: true
      }),
      terminalLayoutsByTabId: {},
      lastTerminalInputAtByPaneKey: {},
      ptyIdsByTabId: {},
      runtimeEnvironments: [],
      runtimeStatusByEnvironmentId: new Map()
    })
    dispose = installDesktopTerminalObservationOwners()
  })

  return {
    runtimeCall,
    runtimeTransportCall,
    localWrite,
    localWriteAccepted,
    localForeground,
    localHasChildren,
    localInspect
  }
}

export function installSshPresentationInspectionFixture() {
  const id = 'ssh:host@@pty-1'
  const presentation = {
    support: 'supported',
    incarnationId: 'incarnation-1',
    version: 1,
    state: 'agent-in-front'
  } as const
  const authorityA = admitSshConnectionState(
    {
      targetId: 'host',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      providerEpoch: 'provider-A',
      connectionGeneration: 1
    },
    'host'
  )
  const authorityB = admitSshConnectionState(
    {
      targetId: 'host',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      providerEpoch: 'provider-B',
      connectionGeneration: 2
    },
    'host'
  )
  if (!authorityA || !authorityB) {
    throw new Error('fixture authority rejected')
  }
  useAppStore.setState({
    ptyIdsByTabId: { ssh: [id] },
    sshTargetGenerations: new Map([['host', 1]]),
    sshConnectionStates: new Map([['host', authorityA]])
  })
  return { id, presentation, authorityB }
}

export const INSPECTION_LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const INSPECTION_PANE_KEY = `tab-1:${INSPECTION_LEAF_ID}`
export function makeByteOversizedTerminalInput(): string {
  return '😀'.repeat(Math.floor(TERMINAL_INPUT_MAX_BYTES / 4) + 1)
}

export const PRESENTATION_LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const shellPresentation = {
  support: 'supported' as const,
  incarnationId: 'inc',
  version: 1,
  state: 'not-in-front' as const
}

export function presentationFrame(
  worktree: string,
  id: string,
  incarnationId: string,
  presentation?: TerminalPresentationObservation
): RuntimeMobileSessionTabsResult {
  const frame = makeHostSnapshot(worktree, id, id)
  for (const tab of frame.tabs) {
    if (tab.type === 'terminal') {
      Object.assign(tab, { ptyId: id, terminal: id, incarnationId, presentation })
    }
  }
  return frame
}

export function observedRuntimeCatalog(n: number) {
  let catalogReads = 0
  const derivationReads = Array(n).fill(0)
  const rows = Array.from({ length: n }, (_, i) => {
    const row = publicRuntimeEnvironment({ id: `host-${i}` })
    Object.defineProperty(row, 'id', {
      get: () => {
        catalogReads++
        return `host-${i}`
      },
      enumerable: true
    })
    Object.defineProperty(row, 'createdAt', {
      get: () => {
        derivationReads[i]++
        return 1
      },
      enumerable: true
    })
    return row
  })
  const statuses = new Map(
    rows.map((row) => [row.id, connectedRuntimeStatus(`runtime-${row.id}`, 0)])
  )
  return {
    rows,
    statuses,
    derivationReads,
    get catalogReads() {
      return catalogReads
    },
    resetCatalogReads() {
      catalogReads = 0
    }
  }
}

export function installInputMarkerLayoutFixture() {
  useAppStore.setState({
    settings: { experimentalAgentHibernation: false } as never,
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: INSPECTION_LEAF_ID },
        activeLeafId: INSPECTION_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [INSPECTION_LEAF_ID]: 'local-pty' }
      }
    }
  })
}

export function connectedSshObservationFixture(): AppState['sshConnectionStates'] {
  return new Map([
    [
      'target',
      {
        targetId: 'target',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        providerEpoch: 'one',
        connectionGeneration: 1
      }
    ]
  ])
}
