import {
  PRESENTATION_LEAF_ID as LEAF_ID,
  shellPresentation,
  presentationFrame,
  observedRuntimeCatalog,
  connectedSshObservationFixture,
  createRuntimeTerminalInspectionFixtures
} from './runtime-terminal-inspection-test-fixtures'
import {
  publicRuntimeEnvironment,
  connectedRuntimeStatus
} from './paired-runtime-environment-test-fixture'
import {
  retireDesktopTerminalObservation,
  captureDesktopTerminalObservation,
  desktopContactForTerminal,
  desktopObservationContact,
  captureDesktopObservationRead,
  releaseDesktopObservationSource,
  desktopObservationCurrent,
  type DesktopTerminalObservationOwner
} from './desktop-terminal-observation-owner'
// @vitest-environment happy-dom
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { setLocalRuntimeCapabilitiesForTests } from './local-runtime-capabilities'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { sendRuntimePtyInputVerified } from './runtime-terminal-verified-input'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalPaneChatState } from '../components/terminal-pane/use-terminal-pane-chat-state'
import { createPtyInputWriteQueue } from '../components/terminal-pane/pty-input-write-queue'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import {
  acceptDesktopPresentationFrame,
  createDesktopPresentationSource,
  retractDesktopPresentations,
  subscribeDesktopPresentation,
  desktopPresentationSnapshot,
  desktopPresentationForExit
} from './terminal-foreground-presentation'
import { makeUnifiedTab, makeTab } from '../store/slices/store-session-test-harness'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess,
  sendRuntimePtyInput
} from './runtime-terminal-inspection'
import type { RuntimeEnvironmentCallRequest } from './runtime-compatibility-test-fixture'
import { useAppStore } from '../store'

describe('runtime terminal presentation routing', () => {
  const {
    runtimeCall,
    localWrite,
    localWriteAccepted,
    localForeground,
    localHasChildren,
    localInspect
  } = createRuntimeTerminalInspectionFixtures()
  afterEach(cleanup)
  it.each([10, 100])(
    'addresses current host children and accepted inputs at %s unrelated hosts',
    async (n) => {
      const catalog = observedRuntimeCatalog(n)
      const { rows, statuses, derivationReads } = catalog
      const id = (i: number) => `remote:host-${i}@@terminal`
      catalog.resetCatalogReads()
      useAppStore.setState({
        runtimeEnvironments: rows,
        runtimeStatusByEnvironmentId: statuses,
        ptyIdsByTabId: Object.fromEntries(rows.map((_, i) => [`tab-${i}`, [id(i)]]))
      })
      const contacts = rows.map((_, i) => desktopObservationContact(`host-${i}`)!)
      const owners = rows.map((_, i) => captureDesktopTerminalObservation(id(i))!)
      expect(contacts.every((contact) => contact.children.size === 1)).toBe(true)
      expect(catalog.catalogReads).toBe(2 * n) // One accepted catalog-index build shared by all acquisitions.
      const disposals = owners.map((owner) => {
        const dispose = vi.fn()
        owner.dispose.add(dispose)
        return dispose
      })
      catalog.resetCatalogReads()
      const childVisits = Array(n).fill(0)
      contacts.forEach((contact, i) => {
        const values = contact.children.values.bind(contact.children)
        vi.spyOn(contact.children, 'values').mockImplementation(function* () {
          for (const owner of values()) {
            childVisits[i]++
            yield owner
          }
          return undefined
        })
      })
      const memberships = owners.map((owner) => vi.spyOn(owner.sources, 'add'))
      for (let i = 0; i < n; i++) {
        const token = new Map<string, DesktopTerminalObservationOwner>()
        const read = captureDesktopObservationRead(contacts[i]!, token)
        expect([...read.values()]).toEqual([owners[i]])
        for (const owner of read.values()) {
          releaseDesktopObservationSource(owner, token)
        }
      }
      expect(childVisits).toEqual(Array(n).fill(1))
      memberships.forEach((add) => expect(add).toHaveBeenCalledTimes(1))
      expect(catalog.catalogReads).toBe(0)
      let compared = 0
      const iterator = statuses[Symbol.iterator].bind(statuses)
      vi.spyOn(statuses, Symbol.iterator).mockImplementation(function* () {
        for (const entry of iterator()) {
          compared++
          yield entry
        }
        return undefined
      })
      derivationReads.fill(0)
      useAppStore.getState().setRuntimeEnvironmentStatus('host-0', {
        ...connectedRuntimeStatus('runtime-host-0', 0),
        checkedAt: 3
      })
      expect(compared).toBe(2 * n) // Reducer Map copy plus the adapter's old-input comparison pass.
      expect(derivationReads[0]).toBeGreaterThan(0)
      expect(derivationReads.slice(1)).toEqual(Array(n - 1).fill(0))
      expect(catalog.catalogReads).toBe(0)
      expect(desktopObservationContact('host-0')).toBe(contacts[0])
      expect(owners[0]!.active).toBe(true)
      // Real default bootstrap captures before its held supplier and never visits another host.
      const held: ((value: unknown) => void)[] = []
      runtimeCall.mockImplementation(() => new Promise((resolve) => held.push(resolve)))
      childVisits.fill(0)
      const { loadInitialWebSessionTabs } = await import('./web-session-tabs-sync/load-initial')
      for (let i = 0; i < n; i++) {
        loadInitialWebSessionTabs({
          environmentId: `host-${i}`,
          expectedEnvironmentConnectionGeneration: 0,
          expectedEnvironmentPairingRevision: undefined,
          expectedTrackingGeneration: 0,
          isCurrent: () => true
        })
      }
      expect(childVisits).toEqual(Array(n).fill(1))
      expect(held).toHaveLength(n)
      expect(contacts.every((contact) => contact.resources.size === 2)).toBe(true)
      held.forEach((resolve) => resolve({ ok: true, result: { snapshots: [] } }))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(contacts.every((contact) => contact.resources.size === 1)).toBe(true)
      // Grow unrelated owners, then unrelated bindings, independently of the target.
      const unrelated = Array.from({ length: n }, (_, i) =>
        captureDesktopTerminalObservation(
          `remote:host-1@@source-${i}`,
          new Map<string, DesktopTerminalObservationOwner>()
        )!
      )
      let bindingVisits = 0
      const otherBindings = Array.from({ length: n }, (_, i) => `remote:host-1@@bound-${i}`)
      const iterate = otherBindings[Symbol.iterator].bind(otherBindings)
      vi.spyOn(otherBindings, Symbol.iterator).mockImplementation(function* () {
        for (const id of iterate()) {
          bindingVisits++
          yield id
        }
        return undefined
      })
      useAppStore.setState({
        ptyIdsByTabId: { ...useAppStore.getState().ptyIdsByTabId, extra: otherBindings }
      })
      expect(bindingVisits).toBe(n)
      childVisits.fill(0)
      const token = new Map<string, DesktopTerminalObservationOwner>()
      const target = captureDesktopObservationRead(contacts[0]!, token)
      expect(target.size).toBe(1)
      expect(childVisits).toEqual([1, ...Array(n - 1).fill(0)])
      expect(bindingVisits).toBe(n) // No warm normalization of unrelated bindings.
      for (const owner of target.values()) {
        releaseDesktopObservationSource(owner, token)
      }
      const targetBindings = Array.from({ length: n }, (_, i) => `remote:host-0@@bound-${i}`)
      useAppStore.setState({
        ptyIdsByTabId: { ...useAppStore.getState().ptyIdsByTabId, target: targetBindings }
      })
      const largeToken = new Map<string, DesktopTerminalObservationOwner>()
      const largeTarget = captureDesktopObservationRead(contacts[0]!, largeToken)
      expect(largeTarget.size).toBe(n + 1)
      expect(contacts[0]!.children.size).toBe(n + 1)
      for (const owner of largeTarget.values()) {
        releaseDesktopObservationSource(owner, largeToken)
      }
      expect(unrelated.every((owner) => owner.active)).toBe(true)
      const localOwner = captureDesktopTerminalObservation(
        'local-bound',
        new Map<string, DesktopTerminalObservationOwner>()
      )!
      const local = localOwner.contact
      const { refreshLocalStructuredSessionTabs } =
        await import('./local-structured-session-tabs-sync/inventory-refresh')
      const localRead = refreshLocalStructuredSessionTabs()
      expect(localOwner.sources.size).toBe(2)
      held.at(-1)!({ ok: true, result: { snapshots: [] } })
      await localRead
      expect(localOwner.sources.size).toBe(1)
      const { refreshWebRuntimeSessionTabsSnapshot } =
        await import('./web-runtime-session-snapshot')
      childVisits.fill(0)
      const eager = refreshWebRuntimeSessionTabsSnapshot('host-0', 'worktree')
      expect(childVisits[0]).toBe(n + 1) // Before lazy apply-module/supplier awaits.
      expect(childVisits.slice(1)).toEqual(Array(n - 1).fill(0))
      useAppStore.getState().clearRuntimeEnvironmentStatus('host-0')
      expect(contacts[0]!.children.size).toBe(0)
      expect(owners[0]!.active).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 0))
      held.at(-1)!({ ok: false, error: { code: 'unavailable', message: 'test' } })
      await eager
      expect(local.children.get('local-bound')).toBe(localOwner)
      releaseDesktopObservationSource(localOwner, [...localOwner.sources][0]!)
      useAppStore.getState().retainRuntimeEnvironmentStatuses([])
      expect(
        contacts.every((contact) => contact.children.size === 0 && contact.resources.size === 0)
      ).toBe(true)
      expect(
        owners.every((owner) => !owner.active && !owner.sources.size && !owner.dispose.size)
      ).toBe(true)
      disposals.forEach((dispose) => expect(dispose).toHaveBeenCalledTimes(1))
    }
  )

  it('retires exact binding/catalog/revision/SSH children without stale cleanup selecting replacements', async () => {
    const environment = 'accepted-owner'
    const id = `remote:${environment}@@terminal`
    useAppStore.setState({
      runtimeEnvironments: [publicRuntimeEnvironment({ id: environment })],
      runtimeStatusByEnvironmentId: new Map([[environment, connectedRuntimeStatus('A', 0)]]),
      ptyIdsByTabId: { old: [id] }
    })
    const first = captureDesktopTerminalObservation(id)!
    const captured = desktopObservationCurrent(first)
    useAppStore.setState({ ptyIdsByTabId: { replacement: [id] } })
    expect(first.active).toBe(false)
    expect(captured()).toBe(false)
    const replacement = captureDesktopTerminalObservation(id)!
    first.retire()
    expect(captureDesktopTerminalObservation(id)).toBe(replacement)
    const independent = new Map<string, DesktopTerminalObservationOwner>()
    captureDesktopTerminalObservation(id, independent)
    useAppStore.setState({ ptyIdsByTabId: { next: [id] } })
    expect(replacement.active).toBe(true)
    releaseDesktopObservationSource(replacement, independent)
    const source = createDesktopPresentationSource(environment, 'accepted')
    source.apply(presentationFrame('worktree', 'terminal', 'inc', shellPresentation))
    const equal = desktopPresentationSnapshot(id)
    useAppStore.getState().applyRuntimeHostStatusSnapshot({
      environmentId: environment,
      pairingRevision: 999,
      sequence: 1,
      checkedAt: 2,
      status: null,
      verification: 'unavailable',
      transport: 'disconnected'
    })
    expect(desktopPresentationSnapshot(id)).toBe(equal)
    useAppStore.getState().applyRuntimeHostStatusSnapshot({
      environmentId: environment,
      pairingRevision: 1,
      sequence: 1,
      checkedAt: 2,
      status: null,
      verification: 'unavailable',
      transport: 'disconnected'
    })
    expect(desktopPresentationSnapshot(id)).toBeUndefined()
    expect(replacement.active).toBe(false)
    useAppStore.getState().clearRuntimeEnvironmentStatus(environment)
    useAppStore.getState().setRuntimeEnvironmentStatus(environment, connectedRuntimeStatus('B', 0))
    const current = createDesktopPresentationSource(environment, 'accepted')
    current.apply(
      presentationFrame('worktree', 'terminal', 'inc', {
        ...shellPresentation,
        state: 'agent-in-front'
      })
    )
    source.dispose()
    expect(desktopPresentationSnapshot(id)?.state).toBe('agent-in-front')
    const contact = desktopObservationContact(environment)!
    const { replaceRuntimeEnvironmentRevisions } = await import('./runtime-environment-revision')
    replaceRuntimeEnvironmentRevisions([{ id: environment, createdAt: 1, pairingRevision: 2 }])
    replaceRuntimeEnvironmentRevisions([{ id: environment, createdAt: 1, pairingRevision: 3 }])
    expect(contact.active).toBe(false)
    useAppStore.setState({ runtimeEnvironments: [] })
    expect(desktopObservationContact(environment)).toBeNull()
    useAppStore.setState({ runtimeEnvironments: [publicRuntimeEnvironment({ id: environment })] })
    expect(desktopObservationContact(environment)).not.toBe(contact)
    const sshId = 'ssh:target@@pty'
    useAppStore.setState({
      sshConnectionStates: connectedSshObservationFixture(),
      sshTargetGenerations: new Map([['target', 1]]),
      ptyIdsByTabId: { ssh: [sshId] }
    })
    const ssh = captureDesktopTerminalObservation(sshId)!
    expect(ssh?.contact.key).toBe('ssh:target')
    useAppStore.setState({ sshTargetGenerations: new Map() })
    expect(ssh.active).toBe(false)
    expect(ssh.contact.children.size).toBe(0)
    current.dispose()
  })

  it.each([10, 100])(
    'sends %s separated 16KiB physical queue chunks with no presentation work',
    async (n) => {
      const id = `queue-${n}`
      const listener = vi.fn()
      const stop = subscribeDesktopPresentation(id, listener)
      const writes = vi.fn(async (pty: string, data: string, inputKind: TerminalInputKind) => {
        await sendRuntimePtyInput(pty, data, inputKind)
      })
      const queue = createPtyInputWriteQueue({ isWritable: () => true, write: writes })
      const chunk = `${'x'.repeat(16 * 1024 - 1)}\n`
      for (let i = 0; i < n; i++) {
        expect(queue.enqueue(id, chunk, 'driving')).toBe(true)
        await queue.waitForDrain()
      }
      expect(writes).toHaveBeenCalledTimes(n)
      expect(localWrite).toHaveBeenCalledTimes(n)
      expect(localWrite.mock.calls.map(([, data]) => data).join('')).toBe(chunk.repeat(n))
      expect(localInspect).not.toHaveBeenCalled()
      expect(localForeground).not.toHaveBeenCalled()
      expect(localHasChildren).not.toHaveBeenCalled()
      expect(listener).not.toHaveBeenCalled()
      stop()
    }
  )
  it.each(['mounted', 'unmounted', 'refused', 'title-sibling', 'legacy'])(
    'uses actual route/store owner for %s',
    async (flow) => {
      const refused = flow === 'refused'
      const id = `actual-owner-${flow}`
      const leaf = LEAF_ID
      const sibling = '22222222-2222-4222-8222-222222222222'
      const active = flow === 'title-sibling' ? sibling : leaf
      const tab = makeUnifiedTab({
        id: 'actual-tab',
        worktreeId: 'wt',
        groupId: 'g',
        viewMode: 'chat'
      })
      const layout = {
        root: { type: 'leaf' as const, leafId: leaf },
        activeLeafId: leaf,
        expandedLeafId: null,
        chatLeafId: leaf,
        ptyIdsByLeafId: { [leaf]: id }
      }
      useAppStore.setState({
        unifiedTabsByWorktree: { wt: [tab] },
        tabsByWorktree: { wt: [makeTab({ id: 'actual-tab', worktreeId: 'wt', viewMode: 'chat' })] },
        terminalLayoutsByTabId: { 'actual-tab': layout },
        agentStatusByPaneKey: {},
        paneForegroundAgentByPaneKey: {},
        runtimePaneTitlesByTabId: { 'actual-tab': { 2: 'codex' } },
        settings: createGlobalSettingsFixture({
          ...useAppStore.getState().settings,
          experimentalNativeChat: true
        })
      })
      const writes: string[] = []
      const unsubscribe = useAppStore.subscribe((state, previous) => {
        if (state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree) {
          writes.push('mode')
        }
        if (state.terminalLayoutsByTabId !== previous.terminalLayoutsByTabId) {
          writes.push('layout')
        }
      })
      const answers: ((value: unknown) => void)[] = []
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this hook calls only runtime.call; the installed test window has no other runtime ports.
      window.api.runtime = { call: runtimeCall } as never
      runtimeCall.mockImplementation((request: RuntimeEnvironmentCallRequest) =>
        request.method === 'layout.apply'
          ? new Promise((done) => {
              answers.push(done)
            })
          : Promise.resolve({ ok: true, result: {} })
      )
      const controller = {
        tabId: 'actual-tab',
        worktreeId: 'wt',
        paneCount: 1,
        tabWideAgentHintLeafId: null,
        setTabWideAgentHintLeafId: vi.fn(),
        nativeChatTranscriptIsLocalReadable: true,
        onAgentExitedRef: { current: vi.fn() },
        managerRef: {
          current: {
            getPanes: () => [
              { id: 1, leafId: leaf },
              { id: 2, leafId: sibling }
            ],
            getActivePane: () => ({ id: active === leaf ? 1 : 2, leafId: active })
          }
        }
      }
      let renders = 0
      function useActualOwner() {
        renders++
        const [chatLeafId, setChatLeafId] = useState<string | null>(leaf)
        const props = { ...controller, chatLeafId, setChatLeafId }
        return useTerminalPaneChatState(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: props supplies every controller port read by this hook; unrelated terminal managers are intentionally absent.
          props as unknown as Parameters<typeof useTerminalPaneChatState>[0]
        )
      }
      localWriteAccepted.mockResolvedValue(true)
      const rows = useAppStore.getState().agentStatusByPaneKey
      let hook = flow === 'unmounted' ? null : renderHook(useActualOwner)
      if (flow === 'mounted') {
        await act(async () => {
          useAppStore.setState({
            runtimeEnvironments: [publicRuntimeEnvironment({ id: 'other-environment' })],
            runtimeStatusByEnvironmentId: new Map([
              ['other-environment', connectedRuntimeStatus('other-runtime', 0)]
            ])
          })
        })
        await act(async () => {})
        const settled = renders
        for (const host of [LOCAL_STRUCTURED_SESSION_OWNER, 'other-environment']) {
          await act(async () => {
            acceptDesktopPresentationFrame(
              host,
              presentationFrame('unrelated', 'other-pty', 'inc', shellPresentation)
            )
          })
          expect(renders).toBe(settled)
        }
        await act(async () => {
          useAppStore
            .getState()
            .setRuntimeEnvironmentStatus('other-environment', { status: null, checkedAt: 2 })
        })
        expect(renders).toBe(settled)
      }
      localInspect.mockResolvedValue({
        foregroundProcess: 'zsh',
        hasChildProcesses: true,
        presentation: shellPresentation
      })
      await act(async () => {
        if (flow === 'legacy') {
          setLocalRuntimeCapabilitiesForTests([])
          controller.onAgentExitedRef.current(leaf)
        } else {
          await inspectRuntimeTerminalProcess(id)
        }
      })
      if (!hook) {
        hook = renderHook(useActualOwner)
      }
      expect(hook.result.current.effectiveChatViewMode).toBe(
        flow === 'title-sibling' || (ORCA_LAYOUT_OWNER_IS_MAIN && flow === 'legacy')
      )
      expect(hook.result.current.chatLeafId).toBe(flow === 'title-sibling' ? sibling : null)
      if (ORCA_LAYOUT_OWNER_IS_MAIN && flow !== 'title-sibling') {
        expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
        for (const version of flow === 'legacy' ? [] : [2, 3]) {
          localInspect.mockResolvedValue({
            foregroundProcess: 'zsh',
            hasChildProcesses: true,
            presentation: {
              ...shellPresentation,
              version,
              state: version === 2 ? undefined : 'not-in-front'
            }
          })
          await act(async () => {
            await inspectRuntimeTerminalProcess(id)
          })
        }
        expect(
          runtimeCall.mock.calls.filter(
            ([request]) =>
              request.method === 'layout.apply' && request.params.command.type === 'setTabProps'
          )
        ).toHaveLength(1)
        await act(async () => {
          if (!refused) {
            useAppStore.setState({
              unifiedTabsByWorktree: { wt: [{ ...tab, viewMode: 'terminal' }] }
            })
          }
          answers.forEach((answer) =>
            answer({
              ok: true,
              result: refused ? { ok: false, code: 'tab_not_found' } : { ok: true, result: {} }
            })
          )
        })
        expect(hook.result.current.effectiveChatViewMode).toBe(refused)
      } else {
        expect(useAppStore.getState().unifiedTabsByWorktree.wt[0].viewMode).toBe(
          flow === 'title-sibling' ? 'chat' : 'terminal'
        )
      }
      const before = writes.length
      await act(async () => {
        await inspectRuntimeTerminalProcess(id)
        acceptDesktopPresentationFrame(
          LOCAL_STRUCTURED_SESSION_OWNER,
          presentationFrame('wt', id, 'inc', {
            ...shellPresentation,
            version:
              ORCA_LAYOUT_OWNER_IS_MAIN && flow !== 'title-sibling' && flow !== 'legacy' ? 3 : 1
          })
        )
        await inspectRuntimeTerminalProcess(id)
      })
      expect(writes).toHaveLength(before)
      expect(useAppStore.getState().terminalLayoutsByTabId['actual-tab'].chatLeafId).toBe(
        flow === 'title-sibling' ? sibling : undefined
      )
      expect(useAppStore.getState().agentStatusByPaneKey).toBe(rows)
      localInspect.mockResolvedValue({
        foregroundProcess: 'codex',
        hasChildProcesses: true,
        presentation: {
          ...shellPresentation,
          version: 4,
          state: 'agent-in-front'
        }
      })
      await act(async () => {
        await inspectRuntimeTerminalProcess(id)
      })
      expect(hook.result.current.effectiveChatViewMode).toBe(
        flow === 'title-sibling' || (ORCA_LAYOUT_OWNER_IS_MAIN && refused)
      )
      expect(await sendRuntimePtyInputVerified(id, 'fg\r', 'driving')).toBe(true)
      expect(localWriteAccepted).toHaveBeenCalledTimes(1)
      if (ORCA_LAYOUT_OWNER_IS_MAIN && refused) {
        const beforeWake = runtimeCall.mock.calls.filter(
          ([request]) => request.method === 'layout.apply'
        ).length
        localInspect.mockResolvedValue({
          foregroundProcess: 'zsh',
          hasChildProcesses: false,
          presentation: { ...shellPresentation, version: 5 }
        })
        await act(async () => {
          await inspectRuntimeTerminalProcess(id)
        })
        expect(
          runtimeCall.mock.calls.filter(([request]) => request.method === 'layout.apply')
        ).toHaveLength(beforeWake + 1)
        await act(async () => {
          useAppStore.setState({
            unifiedTabsByWorktree: { wt: [{ ...tab, viewMode: 'terminal' }] }
          })
          answers.forEach((answer) => answer({ ok: true, result: { ok: true, result: {} } }))
        })
        expect(hook.result.current.effectiveChatViewMode).toBe(false)
      }
      if (flow === 'mounted') {
        await act(async () => {
          hook.result.current.handleToggleNativeChat()
        })
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          await act(async () => {
            useAppStore.setState({ unifiedTabsByWorktree: { wt: [{ ...tab, viewMode: 'chat' }] } })
            answers.forEach((answer) => answer({ ok: true, result: { ok: true, result: {} } }))
          })
        }
        expect(hook.result.current.effectiveChatViewMode).toBe(true)
        for (const state of ['not-in-front', 'agent-in-front'] as const) {
          let finish = () => {}
          localInspect.mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finish = () =>
                  resolve({
                    foregroundProcess: 'codex',
                    hasChildProcesses: true,
                    presentation: { ...shellPresentation, version: 9, state: 'not-in-front' }
                  })
              })
          )
          const late = inspectRuntimeTerminalProcess(id)
          await act(async () => {
            retireDesktopTerminalObservation(id)
          })
          expect(desktopPresentationSnapshot(id)).toBeUndefined()
          await act(async () => {
            if (!hook.result.current.effectiveChatViewMode) {
              hook.result.current.handleToggleNativeChat()
            }
            if (ORCA_LAYOUT_OWNER_IS_MAIN) {
              useAppStore.setState({
                unifiedTabsByWorktree: { wt: [{ ...tab, viewMode: 'chat' }] }
              })
              answers.forEach((answer) => answer({ ok: true, result: { ok: true, result: {} } }))
            }
          })
          expect(hook.result.current.effectiveChatViewMode).toBe(true)
          const current = { ...shellPresentation, state }
          await act(async () => {
            acceptDesktopPresentationFrame(
              LOCAL_STRUCTURED_SESSION_OWNER,
              presentationFrame('wt', id, 'inc', current)
            )
            finish()
            await late
          })
          expect(desktopPresentationSnapshot(id)).toEqual(current)
          expect(hook.result.current.effectiveChatViewMode).toBe(state === 'agent-in-front')
          if (ORCA_LAYOUT_OWNER_IS_MAIN && state === 'not-in-front') {
            await act(async () => {
              useAppStore.setState({
                unifiedTabsByWorktree: { wt: [{ ...tab, viewMode: 'terminal' }] }
              })
              answers.forEach((answer) => answer({ ok: true, result: { ok: true, result: {} } }))
            })
          }
        }
      }
      hook.unmount()
      setLocalRuntimeCapabilitiesForTests(null)
      unsubscribe()
    }
  )
  it('delivers the same paid confirmation before the main callback and preserves legacy/unknown suppliers', async () => {
    const id = 'confirm-presentation'
    useAppStore.setState({ ptyIdsByTabId: { confirmation: [id, 'legacy-confirm'] } })
    const observation = shellPresentation
    const confirm = vi.fn(async () => ({ foregroundProcess: 'zsh', presentation: observation }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this modern-only supplier is called with includePresentation; the one-argument overload is exercised separately.
    window.api.pty.confirmForegroundProcess = confirm as never
    const stop = subscribeDesktopPresentation(id, vi.fn())
    expect(await confirmRuntimeTerminalForegroundProcess(id)).toBe('zsh')
    expect(desktopPresentationForExit(id)).toBe('not-in-front')
    expect(localInspect).not.toHaveBeenCalled()
    window.api.pty.confirmForegroundProcess = vi.fn(async () => 'zsh')
    await confirmRuntimeTerminalForegroundProcess('legacy-confirm')
    expect(desktopPresentationForExit('legacy-confirm')).toBe('gone')
    localInspect.mockResolvedValue({
      foregroundProcess: null,
      hasChildProcesses: true,
      presentation: { ...observation, version: 2, state: undefined }
    })
    await inspectRuntimeTerminalProcess(id)
    await confirmRuntimeTerminalForegroundProcess(id)
    expect(desktopPresentationForExit(id)).toBeUndefined()
    type Confirmation = Awaited<ReturnType<typeof window.api.pty.confirmForegroundProcess>>
    let finish!: (value: Confirmation) => void
    const held = vi.fn(
      () =>
        new Promise<Confirmation>((resolve) => {
          finish = resolve
        })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: held resolves the opted-in overload's exact union; this flow never calls its old one-argument overload.
    window.api.pty.confirmForegroundProcess = held as never
    const stale = confirmRuntimeTerminalForegroundProcess(id)
    const staleInspection = inspectRuntimeTerminalProcess(id)
    acceptDesktopPresentationFrame(
      LOCAL_STRUCTURED_SESSION_OWNER,
      presentationFrame('confirmation', id, 'replacement')
    )
    finish({ foregroundProcess: 'zsh', presentation: observation })
    await Promise.all([stale, staleInspection])
    expect(desktopPresentationSnapshot(id)).toBeUndefined()
    acceptDesktopPresentationFrame(
      LOCAL_STRUCTURED_SESSION_OWNER,
      presentationFrame('confirmation', id, 'replacement', {
        support: 'legacy',
        incarnationId: 'replacement',
        version: 1
      })
    )
    expect(desktopPresentationSnapshot(id)?.incarnationId).toBe('replacement')
    expect(desktopPresentationForExit(id)).toBe('gone')
    for (const result of [null, { foregroundProcess: null }]) {
      const id = `failed-confirm-${result === null}`
      const failed = confirmRuntimeTerminalForegroundProcess(id)
      finish(result)
      await failed
      expect(desktopPresentationForExit(id)).toBeUndefined()
    }
    retractDesktopPresentations(LOCAL_STRUCTURED_SESSION_OWNER, 'confirmation')
    stop()
  })

  it.each([10, 100])(
    'retires %s actual bound/direct/source resources at contact loss',
    async (n) => {
      const environment = `resource-${n}`
      const id = (i: number) => `remote:${environment}@@terminal-${i}`
      useAppStore.setState({
        runtimeEnvironments: [publicRuntimeEnvironment({ id: environment })],
        runtimeStatusByEnvironmentId: new Map([
          [environment, connectedRuntimeStatus('runtime-A', 0)]
        ]),
        ptyIdsByTabId: { resources: Array.from({ length: n * 2 }, (_, i) => id(i)) }
      })
      const frame = (i: number) =>
        presentationFrame(`scope-${i}`, `terminal-${i}`, 'inc', shellPresentation)
      const source = createDesktopPresentationSource(environment, 'global')
      const independent = createDesktopPresentationSource(environment, 'active')
      const stop = subscribeDesktopPresentation(id(0), vi.fn())
      runtimeCall.mockResolvedValue({
        ok: true,
        result: {
          process: {
            foregroundProcess: 'powershell',
            hasChildProcesses: false,
            presentation: shellPresentation
          }
        }
      })
      const contact = desktopContactForTerminal(id(0))
      const owners: (DesktopTerminalObservationOwner | null)[] = []
      for (let i = 0; i < n; i++) {
        source.apply(frame(i))
        await inspectRuntimeTerminalProcess(id(i))
        owners.push(captureDesktopTerminalObservation(id(i)))
        await inspectRuntimeTerminalProcess(`remote:${environment}@@unowned-${i}`)
      }
      for (let i = n; i < n * 2; i++) {
        await inspectRuntimeTerminalProcess(id(i))
        owners.push(captureDesktopTerminalObservation(id(i)))
      }
      expect(contact?.resources.size).toBe(n * 2 + 2)
      const heldRead = createDesktopPresentationSource(environment, 'held-list', () => true, true)
      const heldFrames = Array.from({ length: n }, (_, i) => source.capture(frame(i)))
      for (let i = 0; i < n; i++) {
        retireDesktopTerminalObservation(id(i))
      }
      for (let i = 0; i < n; i++) {
        independent.apply(
          presentationFrame(`scope-${i}`, `terminal-${i}`, 'inc', {
            ...shellPresentation,
            state: 'agent-in-front'
          })
        )
        heldFrames[i]!.apply(frame(i))
        heldFrames[i]!.dispose()
        heldRead.apply(frame(i))
        expect(desktopPresentationSnapshot(id(i))?.state).toBe('agent-in-front')
        owners[i] = captureDesktopTerminalObservation(id(i))
      }
      heldRead.dispose()
      independent.retain(['scope-0'])
      independent.apply(frame(0))
      for (let i = 0; i < n; i++) {
        source.apply(frame(i))
      }
      const deletes = vi.spyOn(Map.prototype, 'delete')
      source.dispose()
      expect(desktopPresentationSnapshot(id(0))?.state).toBe('agent-in-front')
      const scopedDeletes = deletes.mock.calls.filter(([key]) =>
        String(key).startsWith('scope-')
      ).length
      expect(scopedDeletes).toBe(n)
      deletes.mockRestore()
      const equal = desktopPresentationSnapshot(id(0))
      useAppStore
        .getState()
        .setRuntimeEnvironmentStatus(environment, { ...connectedRuntimeStatus('runtime-A', 0) })
      expect(desktopPresentationSnapshot(id(0))).toBe(equal)
      if (n === 10) {
        useAppStore
          .getState()
          .setRuntimeEnvironmentStatus(environment, { status: null, checkedAt: 2 })
      } else {
        useAppStore.getState().applyRuntimeHostStatusSnapshot({
          environmentId: environment,
          pairingRevision: 1,
          sequence: 1,
          checkedAt: 2,
          status: connectedRuntimeStatus('runtime-A', 0).status,
          verification: 'unavailable',
          transport: 'disconnected'
        })
      }
      expect(contact?.resources.size).toBe(0)
      for (let i = 0; i < n * 2; i++) {
        expect(owners[i]?.active).toBe(false)
        expect(owners[i]?.dispose.size).toBe(0)
        expect(owners[i]?.sources.size).toBe(0)
        expect(desktopPresentationSnapshot(id(i))).toBeUndefined()
        expect(desktopPresentationSnapshot(`remote:${environment}@@unowned-${i}`)).toBeUndefined()
      }
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          [environment, connectedRuntimeStatus('runtime-B', 0)]
        ])
      })
      const replacement = createDesktopPresentationSource(environment, 'active')
      replacement.apply(frame(0))
      independent.dispose()
      expect(desktopPresentationSnapshot(id(0))).toEqual(shellPresentation)
      replacement.dispose()
      useAppStore.setState({ ptyIdsByTabId: {} })
      stop()
    }
  )
})
