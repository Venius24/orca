import {
  deferred,
  result,
  success,
  failure,
  makeHarness,
  settle,
  type TestResult
} from './mobile-session-tabs-stream-health-test-fixture'
import { BridgeConnectionCache } from '../mobile-web-shell/bridge/bridge-client-connection-cache'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { terminalInputSend } from '../terminal/mobile-terminal-operations'
import {
  createMobilePresentationSource,
  retractMobilePresentations,
  mobilePresentationEntry,
  mobilePresentationSnapshot,
  subscribeMobilePresentation,
  readMobilePresentation
} from '../terminal/terminal-presentation'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  MobileSessionTabsStreamHealth,
  type SessionTabsApplyOutcome
} from './mobile-session-tabs-stream-health'

describe('MobileSessionTabsStreamHealth', () => {
  it('coalesces a cohort and runs one trailing request for a newer requirement', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)

    const first = harness.controller.requestReconciliation()
    const shared = harness.controller.requestReconciliation()

    expect(shared).toBe(first)
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    let sharedSettled = false
    void shared.then(() => {
      sharedSettled = true
    })

    harness.requests[0]!.resolve(success(result(1)))
    await settle()
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    expect(sharedSettled).toBe(false)

    harness.requests[1]!.resolve(success(result(2)))
    await first
    expect(sharedSettled).toBe(true)
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    expect(harness.apply).toHaveBeenCalledTimes(2)
  })

  it('coalesces repeated retries and releases the retry cohort after failure', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)

    const halfOpen = harness.controller.requestReconciliation()
    const retry = harness.controller.retryReconciliation()
    const repeatedRetry = harness.controller.retryReconciliation()
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    expect(repeatedRetry).toBe(retry)

    harness.requests[1]!.resolve(failure())
    await retry
    const nextRetry = harness.controller.retryReconciliation()
    expect(harness.sendRequest).toHaveBeenCalledTimes(3)
    expect(nextRetry).not.toBe(retry)

    harness.requests[2]!.resolve(success(result(3)))
    await nextRetry
    harness.requests[0]!.resolve(success(result(1)))
    await halfOpen
    expect(harness.apply).toHaveBeenCalledTimes(1)
  })

  it('starts distinct pre- and post-snapshot lists and discards the stale barrier', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const subscription = harness.controller.beginSubscription()

    const preSnapshot = harness.controller.ensureReconciliation()
    subscription.listener(result(2, 'snapshot'))
    const postSnapshot = harness.controller.ensureReconciliation()
    expect(harness.controller.ensureReconciliation()).toBe(postSnapshot)

    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    expect(harness.controller.isCertified()).toBe(false)

    harness.requests[0]!.resolve(success(result(1, undefined, ['stale-list'])))
    await preSnapshot
    expect(harness.consumeAccepted).toHaveBeenCalledTimes(1)

    harness.requests[1]!.resolve(success(result(2, undefined, ['post-snapshot'])))
    await postSnapshot
    expect(harness.controller.isCertified()).toBe(true)
    expect(harness.consumeAccepted).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tabs: ['post-snapshot'] }),
      ['post-snapshot'],
      'list'
    )
  })

  it('invalidates live state for a same-generation replayed snapshot', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const subscription = harness.controller.beginSubscription()
    subscription.listener(result(1, 'updated'))
    expect(harness.controller.isCertified()).toBe(true)

    subscription.listener(result(2, 'snapshot'))
    expect(harness.controller.isCertified()).toBe(false)
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)

    harness.requests[0]!.resolve(success(result(2)))
    await settle()
    expect(harness.controller.isCertified()).toBe(true)
  })

  it('requires a pre-snapshot and post-snapshot list after stable generation migration', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const subscription = harness.controller.beginSubscription()
    subscription.listener(result(1, 'updated'))
    expect(harness.controller.isCertified()).toBe(true)

    harness.generation.current = 2
    const preSnapshot = harness.controller.poll()
    expect(preSnapshot).not.toBeNull()
    expect(harness.controller.isCertified()).toBe(false)

    subscription.listener(result(2, 'snapshot'))
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)

    harness.requests[0]!.resolve(success(result(2, undefined, ['generation-pre'])))
    await preSnapshot
    harness.requests[1]!.resolve(success(result(2, undefined, ['generation-post'])))
    await settle()

    expect(harness.controller.isCertified()).toBe(true)
    expect(harness.controller.poll()).toBeNull()
    expect(harness.consumeAccepted).not.toHaveBeenCalledWith(
      expect.objectContaining({ tabs: ['generation-pre'] }),
      expect.anything(),
      'list'
    )
  })

  it('ignores old generation results even before the next polling tick', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const pending = harness.controller.requestReconciliation()
    harness.generation.current = 2

    harness.requests[0]!.resolve(success(result(1)))
    await pending

    expect(harness.apply).not.toHaveBeenCalled()
    expect(harness.consumeAccepted).not.toHaveBeenCalled()
  })

  it('keeps a failed requirement pending without an immediate or trailing retry', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const pending = harness.controller.requestReconciliation()
    harness.requests[0]!.resolve(failure())
    await pending
    await settle()

    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    const retry = harness.controller.poll()
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    harness.requests[1]!.resolve(success(result(1)))
    await retry
    await settle()
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('retries a failed explicit reconciliation even while stream health stays live', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const subscription = harness.controller.beginSubscription()
    subscription.listener(result(1, 'updated'))

    const failed = harness.controller.requestReconciliation()
    harness.requests[0]!.resolve(failure())
    await failed
    const retry = harness.controller.poll()

    expect(retry).not.toBeNull()
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    harness.requests[1]!.resolve(success(result(1)))
    await retry
    expect(harness.controller.poll()).toBeNull()
  })

  it('lets an accepted update satisfy only requirements raised before apply', async () => {
    let controller: MobileSessionTabsStreamHealth<TestResult, string>
    let raisedRequirement: Promise<void> | null = null
    const apply = vi.fn((value: TestResult): SessionTabsApplyOutcome<string> => {
      if (value.type === 'updated') {
        raisedRequirement = controller.requestReconciliation()
      }
      return { accepted: true, effectiveTabs: value.tabs }
    })
    const harness = makeHarness({ apply })
    controller = harness.controller
    controller.setReconciliationActive(true)
    const subscription = controller.beginSubscription()

    subscription.listener(result(1, 'updated'))

    expect(controller.isCertified()).toBe(true)
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    harness.requests[0]!.resolve(success(result(1)))
    await raisedRequirement
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    const retry = controller.poll()
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    harness.requests[1]!.resolve(success(result(1)))
    await retry
  })

  it('does not consume a rejected stream snapshot or update', () => {
    const apply = vi.fn((value: TestResult): SessionTabsApplyOutcome<string> =>
      value.type ? { accepted: false } : { accepted: true, effectiveTabs: value.tabs }
    )
    const harness = makeHarness({ apply })
    const subscription = harness.controller.beginSubscription()

    subscription.listener(result(1, 'snapshot'))
    subscription.listener(result(2, 'updated'))

    expect(harness.consumeAccepted).not.toHaveBeenCalled()
    expect(harness.controller.isCertified()).toBe(false)
    expect(harness.sendRequest).not.toHaveBeenCalled()
  })

  it('fences cancelled subscription frames', () => {
    const harness = makeHarness()
    const subscription = harness.controller.beginSubscription()
    subscription.cancel()

    subscription.listener(result(1, 'updated'))

    expect(harness.apply).not.toHaveBeenCalled()
    expect(harness.consumeAccepted).not.toHaveBeenCalled()
  })

  it('records requirements while inactive without issuing background requests', async () => {
    const harness = makeHarness()
    const subscription = harness.controller.beginSubscription()

    subscription.listener(result(1, 'snapshot'))
    subscription.listener({
      type: 'error',
      snapshotVersion: 1,
      tabs: []
    })
    await harness.controller.requestReconciliation()

    expect(harness.sendRequest).not.toHaveBeenCalled()
    harness.controller.setReconciliationActive(true)
    const resumed = harness.controller.ensureReconciliation()
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    harness.requests[0]!.resolve(success(result(1)))
    await resumed
  })

  it('keeps polling a certified stream while local recovery work remains', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const subscription = harness.controller.beginSubscription()
    subscription.listener(result(1, 'updated'))
    harness.setRecoveryNeeded(true)

    const poll = harness.controller.poll()
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    harness.requests[0]!.resolve(success(result(1)))
    await poll

    harness.setRecoveryNeeded(false)
    expect(harness.controller.poll()).toBeNull()
  })

  it('makes delayed pending-recovery requests no-ops after accepted consumption resolves them', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    expect(await harness.controller.requestPendingRecovery()).toBeUndefined()
    expect(harness.sendRequest).not.toHaveBeenCalled()

    harness.setRecoveryNeeded(true)
    const pending = harness.controller.requestPendingRecovery()
    harness.requests[0]!.resolve(success(result(1)))
    await pending
    harness.setRecoveryNeeded(false)

    await harness.controller.requestPendingRecovery()
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('ignores list results owned by a disposed route controller', async () => {
    const harness = makeHarness()
    harness.controller.setReconciliationActive(true)
    const pending = harness.controller.requestReconciliation()
    harness.controller.dispose()

    harness.requests[0]!.resolve(success(result(1)))
    await pending

    expect(harness.apply).not.toHaveBeenCalled()
    expect(harness.consumeAccepted).not.toHaveBeenCalled()
  })

  it('discards a list after a newer accepted application outside the controller', async () => {
    let applicationRevision = 0
    const harness = makeHarness({
      getApplicationRevision: () => applicationRevision
    })
    harness.controller.setReconciliationActive(true)
    const pending = harness.controller.requestReconciliation()

    applicationRevision += 1
    harness.requests[0]!.resolve(success(result(1)))
    await pending

    expect(harness.apply).not.toHaveBeenCalled()
    expect(harness.consumeAccepted).not.toHaveBeenCalled()
    expect(harness.sendRequest).toHaveBeenCalledTimes(1)
    const retry = harness.controller.poll()
    expect(harness.sendRequest).toHaveBeenCalledTimes(2)
    harness.requests[1]!.resolve(success(result(2)))
    await retry
    expect(harness.apply).toHaveBeenCalledTimes(1)
  })
})

describe('terminal presentation through the phone feed and send owners', () => {
  it.each([10, 100])(
    'hands actual logical replay and %s scoped owners across live/dormant contacts',
    async (n) => {
      const first = createFakeRpcClient()
      const logical = createStableLogicalRpcClient(first, 'relay')
      const client = scopeRpcClientToExecutionHost(logical, 'runtime:host')
      const tab = (state: 'agent-in-front' | 'not-in-front', version = 1) => ({
        terminal: 'term',
        incarnationId: 'inc',
        presentation: { support: 'supported', incarnationId: 'inc', version, state }
      })
      const listener = vi.fn()
      // At 10 the cache observer precedes the controller; at 100 beginSubscription reorders it.
      let stop = n === 10 ? subscribeMobilePresentation(client, 'term', listener) : () => {}
      const consume = vi.fn()
      const makeController = () =>
        new MobileSessionTabsStreamHealth<{ type?: string; tabs: unknown[] }, unknown>({
          client,
          scope: 'wt',
          apply: (result) => ({ accepted: true, effectiveTabs: result.tabs }),
          consumeAccepted: consume,
          hasRecoveryNeed: () => false
        })
      let controller = makeController()
      let subscription = controller.beginSubscription()
      let unstream = client.subscribe('session.tabs.subscribe', {}, subscription.listener)
      if (n === 100) {
        stop = subscribeMobilePresentation(client, 'term', listener)
      }
      first.streams[0]!.emit(
        { type: 'updated', tabs: [tab('agent-in-front', 9)] },
        { runtimeId: 'one' }
      )
      controller.setReconciliationActive(true)
      const oldList = controller.requestReconciliation()
      const oldDirect = readMobilePresentation(client, 'term', 'inc')
      const second = createFakeRpcClient()
      await logical.migrateTo(second, 'lan')
      second.streams[0]!.emit(
        { type: 'snapshot', tabs: [tab('agent-in-front')] },
        { runtimeId: 'two' }
      )
      second.requests[0]!.resolve({
        id: 'list',
        ok: true,
        result: { tabs: [tab('agent-in-front')] },
        _meta: { runtimeId: 'two' }
      })
      await settle()
      second.streams[0]!.emit(
        { type: 'updated', tabs: [tab('not-in-front', 2)] },
        { runtimeId: 'two' }
      )
      expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('not-in-front')
      const requests = second.requests.length
      expect(controller.poll()).toBeNull()
      expect(second.requests).toHaveLength(requests)
      first.streams[0]!.emit(
        { type: 'updated', tabs: [tab('agent-in-front', 99)] },
        { runtimeId: 'one' }
      )
      first.requests.forEach((request) =>
        request.resolve({
          id: 'stale',
          ok: true,
          result: {
            tabs: [tab('agent-in-front', 99)],
            process: { presentation: tab('agent-in-front', 99).presentation }
          },
          _meta: { runtimeId: 'one' }
        })
      )
      await Promise.all([oldList, oldDirect])
      expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('not-in-front')
      // Current listener survives degraded child replacement; retired physical work still does not.
      second.streams[0]!.emit({ type: 'end', tabs: [] })
      second.streams[0]!.emit({ type: 'updated', tabs: [tab('agent-in-front')] })
      second.requests
        .slice(requests)
        .forEach((request) => request.resolve({ id: 'recovery', ok: true, result: { tabs: [] } }))
      await settle()
      second.streams[0]!.emit({ type: 'updated', tabs: [tab('agent-in-front', 2)] })
      expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('agent-in-front')
      const independent = createMobilePresentationSource(client, 'independent')
      independent.apply([tab('agent-in-front', 2)])
      const scopes = Array.from({ length: n }, (_, i) => {
        const scope = createMobilePresentationSource(client, `scope-${i}`)
        scope.apply([{ ...tab('not-in-front'), terminal: `term-${i}` }])
        return scope
      })
      const entries = scopes.map((_, i) => mobilePresentationEntry(client, `term-${i}`))
      let capturedVisits = 0
      entries.forEach((entry) => {
        let active = true
        Object.defineProperty(entry, 'active', {
          get: () => {
            capturedVisits++
            return active
          },
          set: (value: boolean) => {
            active = value
          },
          configurable: true
        })
      })
      const capture = independent.capture()
      capture.apply([tab('agent-in-front', 2)])
      expect(capturedVisits).toBe(n) // Production per-client captured-owner admission, not a fake inventory.
      capturedVisits = 0
      scopes.forEach((scope, i) => {
        const stale = scope.capture()
        scope.dispose()
        stale.apply([{ ...tab('not-in-front'), terminal: `term-${i}` }])
        stale.dispose()
        expect(mobilePresentationSnapshot(client, `term-${i}`)).toBeUndefined()
        const entry = entries[i]!
        expect(entry.active).toBe(false)
        expect('members' in entry && entry.members.size).toBe(0)
      })
      capture.dispose()
      expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('agent-in-front')
      const third = createFakeRpcClient()
      await logical.migrateTo(third, 'relay')
      third.streams[0]!.emit({ type: 'updated', tabs: [tab('not-in-front')] })
      expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('not-in-front')
      controller.dispose()
      unstream()
      stop()
      independent.dispose()
      retractMobilePresentations(client)
      expect(third.stateListeners()).toBe(1) // Only the logical physical-session observer remains.
      const fourth = createFakeRpcClient()
      await logical.migrateTo(fourth, 'lan') // No presentation observer is present while dormant.
      expect(scopeRpcClientToExecutionHost(logical, 'runtime:host')).toBe(client)
      controller = makeController()
      subscription = controller.beginSubscription()
      unstream = client.subscribe('session.tabs.subscribe', {}, subscription.listener)
      stop = subscribeMobilePresentation(client, 'term', listener)
      fourth.streams[0]!.emit({ type: 'updated', tabs: [tab('not-in-front')] })
      expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('not-in-front')
      controller.dispose()
      unstream()
      stop()
      retractMobilePresentations(client)
      const oldStop = subscribeMobilePresentation(client, 'term', listener)
      const held = readMobilePresentation(client, 'term', 'inc')
      oldStop()
      const newStop = subscribeMobilePresentation(client, 'term', listener)
      const direct = readMobilePresentation(client, 'term', 'inc')
      fourth.requests.at(-1)!.resolve({
        id: 'new',
        ok: true,
        result: { process: { presentation: tab('agent-in-front').presentation } }
      })
      await direct
      fourth.requests.at(-2)!.resolve({
        id: 'old',
        ok: true,
        result: { process: { presentation: tab('not-in-front', 99).presentation } }
      })
      await held
      oldStop()
      expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('agent-in-front')
      newStop()
      retractMobilePresentations(client)
      logical.close()
      expect(fourth.stateListeners()).toBe(0)
    }
  )

  it('re-enters the actual native state cache at the same numeric generation without metadata', () => {
    const connection = new BridgeConnectionCache()
    const connected = {
      state: 'connected' as const,
      generation: 0,
      reconnectAttempt: 0,
      lastConnectedAt: null,
      lastInboundAt: null
    }
    connection.prime(connected)
    const client = createFakeRpcClient({
      getState: () => connection.read()!.state,
      getGeneration: () => connection.read()!.generation ?? 0
    })
    client.onStateChange = (listener) => connection.onStateChange(listener)
    const stop = subscribeMobilePresentation(client, 'term', vi.fn())
    const controller = new MobileSessionTabsStreamHealth<{ tabs: unknown[] }, unknown>({
      client,
      scope: 'wt',
      apply: (result) => ({ accepted: true, effectiveTabs: result.tabs }),
      consumeAccepted: vi.fn(),
      hasRecoveryNeed: () => false
    })
    const subscription = controller.beginSubscription()
    const stream = client.subscribe('session.tabs.subscribe', {}, subscription.listener)
    const tab = {
      terminal: 'term',
      incarnationId: 'inc',
      presentation: {
        support: 'supported',
        incarnationId: 'inc',
        version: 7,
        state: 'not-in-front'
      }
    }
    client.streams[0]!.emit({ type: 'updated', tabs: [tab] })
    expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('not-in-front')
    connection.apply({ ...connected, state: 'disconnected' })
    expect(mobilePresentationSnapshot(client, 'term')).toBeUndefined()
    connection.apply(connected)
    client.streams[0]!.emit({
      type: 'updated',
      tabs: [{ ...tab, presentation: { ...tab.presentation, version: 1, state: 'agent-in-front' } }]
    })
    expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('agent-in-front')
    stop()
    stream()
    controller.dispose()
    connection.close()
    expect(mobilePresentationSnapshot(client, 'term')).toBeUndefined()
  })

  it('keeps reentrant replacement exact through source disposal and admitted publication', () => {
    const physical = createFakeRpcClient()
    const logical = createStableLogicalRpcClient(physical, 'relay')
    const client = scopeRpcClientToExecutionHost(logical, 'runtime:host')
    const tab = {
      terminal: 'term',
      incarnationId: 'inc',
      presentation: {
        support: 'supported',
        incarnationId: 'inc',
        version: 1,
        state: 'not-in-front'
      }
    }
    const first = createMobilePresentationSource(client, 'wt')
    first.apply([tab])
    let replacement = first
    let stop = subscribeMobilePresentation(client, 'term', () => {
      stop()
      replacement = createMobilePresentationSource(client, 'wt')
      replacement.apply([
        { ...tab, presentation: { ...tab.presentation, state: 'agent-in-front' } }
      ])
    })
    const acquired = createMobilePresentationSource(client, 'wt')
    expect(replacement.current()).toBe(true)
    first.dispose()
    expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('agent-in-front')
    acquired.dispose()
    expect(mobilePresentationSnapshot(client, 'term')).toBeUndefined()
    expect(physical.stateListeners()).toBe(1)
    const publisher = createMobilePresentationSource(client, 'wt')
    stop = subscribeMobilePresentation(client, 'term', () => {
      stop()
      retractMobilePresentations(client)
      replacement = createMobilePresentationSource(client, 'wt')
      replacement.apply([
        { ...tab, presentation: { ...tab.presentation, state: 'agent-in-front' } }
      ])
    })
    publisher.apply([
      { ...tab, presentation: { ...tab.presentation, version: 2 } },
      { ...tab, terminal: 'late' }
    ])
    expect(mobilePresentationSnapshot(client, 'late')).toBeUndefined()
    expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('agent-in-front')
    publisher.dispose()
    expect(replacement.current()).toBe(true)
    replacement.dispose()
    logical.close()
    expect(physical.stateListeners()).toBe(0)
  })

  it('does not recreate direct authority when runtime-reset notification releases its exact listener', async () => {
    const physical = createFakeRpcClient()
    const logical = createStableLogicalRpcClient(physical, 'relay')
    const client = scopeRpcClientToExecutionHost(logical, 'runtime:host')
    const independent = createMobilePresentationSource(client, 'other')
    let stop = subscribeMobilePresentation(client, 'term', vi.fn())
    const value = { support: 'supported', incarnationId: 'inc', version: 1, state: 'not-in-front' }
    const read = readMobilePresentation(client, 'term', 'inc')
    physical.requests.at(-1)!.resolve({
      id: 'first',
      ok: true,
      result: { process: { presentation: value } },
      _meta: { runtimeId: 'one' }
    })
    await read
    expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('not-in-front')
    const previousStop = stop
    stop = subscribeMobilePresentation(client, 'term', () => stop())
    previousStop()
    const replacement = readMobilePresentation(client, 'term', 'inc')
    physical.requests.at(-1)!.resolve({
      id: 'new',
      ok: true,
      result: { process: { presentation: { ...value, state: 'agent-in-front' } } },
      _meta: { runtimeId: 'two' }
    })
    await replacement
    expect(mobilePresentationSnapshot(client, 'term')).toBeUndefined()
    expect(independent.current()).toBe(true)
    independent.dispose()
    logical.close()
    expect(physical.stateListeners()).toBe(0)
  })

  it('cannot certify or reacquire a cancelled logical event during scalar application', () => {
    const physical = createFakeRpcClient()
    const logical = createStableLogicalRpcClient(physical, 'relay')
    const client = scopeRpcClientToExecutionHost(logical, 'runtime:host')
    const consume = vi.fn()
    const controller = new MobileSessionTabsStreamHealth<{ tabs: unknown[] }, unknown>({
      client,
      scope: 'wt',
      apply: () => {
        subscription.cancel()
        return { accepted: true, effectiveTabs: [] }
      },
      consumeAccepted: consume,
      hasRecoveryNeed: () => false
    })
    const subscription = controller.beginSubscription()
    const stop = client.subscribe('session.tabs.subscribe', {}, subscription.listener)
    physical.streams[0]!.emit({ type: 'updated', tabs: [] })
    expect(consume).not.toHaveBeenCalled()
    expect(controller.isCertified()).toBe(false)
    controller.dispose()
    stop()
    logical.close()
    expect(physical.stateListeners()).toBe(0)
  })

  it.each([10, 100])(
    'delivers %s writes without reads or presentation notifications',
    async (n) => {
      const sendRequest = vi.fn(
        async (_method: string, _params: unknown): Promise<RpcResponse> => ({
          id: 'send',
          ok: true,
          result: { send: { accepted: true } }
        })
      )
      let generation = 1
      const physical = createFakeRpcClient({ getGeneration: () => generation })
      const client: RpcClient = { ...physical, sendRequest }
      const listeners = [vi.fn(), vi.fn()]
      const stops = listeners.map((listener) =>
        subscribeMobilePresentation(client, 'term', listener)
      )
      const consumeAccepted = vi.fn()
      const controller = new MobileSessionTabsStreamHealth<{ tabs: unknown[] }, unknown>({
        client,
        scope: 'wt',
        apply: (value) => ({ accepted: true, effectiveTabs: value.tabs }),
        consumeAccepted,
        hasRecoveryNeed: () => false
      })
      const feed = controller.beginSubscription()
      const tab = {
        terminal: 'term',
        incarnationId: 'inc',
        presentation: {
          support: 'supported',
          incarnationId: 'inc',
          version: 1,
          state: 'not-in-front'
        }
      }
      feed.listener({ type: 'updated', tabs: [tab] }, { runtimeId: 'runtime-1' })
      expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('not-in-front')
      listeners.forEach((listener) => listener.mockClear())
      for (let i = 0; i < n; i++) {
        expect(
          terminalInputSend.interpret(
            await terminalInputSend.request(client, { terminal: 'term', text: 'x', enter: false })
          )
        ).toBe(true)
      }
      expect(sendRequest).toHaveBeenCalledTimes(n)
      expect(sendRequest.mock.calls.every(([method]) => method === 'terminal.send')).toBe(true)
      listeners.forEach((listener) => expect(listener).not.toHaveBeenCalled())
      for (let i = 0; i < n; i++) {
        const other = new MobileSessionTabsStreamHealth<{ tabs: unknown[] }, unknown>({
          client,
          scope: `other-${i}`,
          apply: (value) => ({ accepted: true, effectiveTabs: value.tabs }),
          consumeAccepted: vi.fn(),
          hasRecoveryNeed: () => false
        })
        other.beginSubscription().listener({ type: 'updated', tabs: [tab] })
        other.dispose()
        expect(physical.stateListeners()).toBe(2)
        expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('not-in-front')
      }
      feed.listener({ type: 'updated', tabs: [tab] })
      listeners.forEach((listener) => expect(listener).not.toHaveBeenCalled())
      feed.listener({ type: 'updated', tabs: [] })
      expect(mobilePresentationSnapshot(client, 'term')).toBeUndefined()
      listeners.forEach((listener) => expect(listener).toHaveBeenCalledTimes(1))
      feed.listener({ type: 'updated', tabs: [tab] })
      listeners.forEach((listener) => listener.mockClear())
      feed.listener({ type: 'updated', tabs: [{ terminal: 'term', incarnationId: 'replacement' }] })
      expect(mobilePresentationSnapshot(client, 'term')).toBeUndefined()
      expect(mobilePresentationEntry(client, 'term').value).toBeUndefined()
      feed.listener({ type: 'updated', tabs: [] })
      expect(mobilePresentationSnapshot(client, 'term')).toBeUndefined()
      feed.listener({
        type: 'updated',
        tabs: [{ ...tab, presentation: { ...tab.presentation, version: 2 } }]
      })
      expect(listeners[0]).toHaveBeenCalledTimes(2)
      feed.listener({ type: 'end' })
      expect(mobilePresentationSnapshot(client, 'term')).toBeUndefined()
      expect(listeners[0]).toHaveBeenCalledTimes(3)
      const currentFeed = controller.beginSubscription()
      currentFeed.listener({ type: 'updated', tabs: [tab] })
      controller.setReconciliationActive(true)
      const list = deferred<RpcResponse>()
      sendRequest.mockImplementationOnce(() => list.promise)
      const oldList = controller.requestReconciliation()
      sendRequest.mockImplementationOnce(async () => ({
        id: 'direct-reset',
        ok: true,
        result: { process: {} }
      }))
      await readMobilePresentation(client, 'term', 'inc')
      expect(mobilePresentationSnapshot(client, 'term')).toBeUndefined()
      const acceptedBeforeList = consumeAccepted.mock.calls.length
      list.resolve({ id: 'old-list', ok: true, result: { tabs: [tab] } })
      await oldList
      expect(consumeAccepted).toHaveBeenCalledTimes(acceptedBeforeList + 1)
      expect(mobilePresentationSnapshot(client, 'term')).toBeUndefined()
      controller.setReconciliationActive(false)
      for (const state of ['agent-in-front', 'not-in-front'] as const) {
        const old = deferred<RpcResponse>()
        sendRequest.mockImplementationOnce(() => old.promise)
        const pending = readMobilePresentation(client, 'term', 'inc')
        currentFeed.listener({ type: 'updated', tabs: [{ ...tab, presentation: undefined }] })
        expect(mobilePresentationSnapshot(client, 'term')).toBeUndefined()
        const runtimeId = `runtime-${state}`
        sendRequest.mockImplementationOnce(async () => ({
          id: 'current',
          ok: true,
          _meta: { runtimeId },
          result: { process: { presentation: { ...tab.presentation, state } } }
        }))
        await readMobilePresentation(client, 'term', 'inc')
        old.resolve({
          id: 'retired',
          ok: true,
          _meta: { runtimeId: 'runtime-1' },
          result: { process: { presentation: { ...tab.presentation, version: 99 } } }
        })
        await pending
        expect(mobilePresentationSnapshot(client, 'term')?.state).toBe(state)
        currentFeed.listener({ type: 'updated', tabs: [tab] }, { runtimeId: 'runtime-1' })
        expect(mobilePresentationSnapshot(client, 'term')?.state).toBe(state)
        sendRequest.mockImplementationOnce(async () => ({
          id: 'no-fact',
          ok: true,
          result: { process: {} }
        }))
        await readMobilePresentation(client, 'term', 'inc')
        expect(mobilePresentationSnapshot(client, 'term')).toBeUndefined()
      }
      const retired = deferred<RpcResponse>()
      sendRequest.mockImplementationOnce(() => retired.promise)
      const stale = readMobilePresentation(client, 'term', 'inc')
      physical.pushState('reconnecting')
      generation++
      physical.pushState('connected')
      currentFeed.listener({ type: 'updated', tabs: [tab] })
      expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('not-in-front')
      sendRequest.mockImplementationOnce(async () => ({
        id: 'replacement',
        ok: true,
        _meta: { runtimeId: 'runtime-new' },
        result: { process: { presentation: tab.presentation } }
      }))
      await readMobilePresentation(client, 'term', 'inc')
      retired.resolve({
        id: 'old-generation',
        ok: true,
        result: {
          process: { presentation: { ...tab.presentation, version: 100, state: 'agent-in-front' } }
        }
      })
      await stale
      expect(mobilePresentationSnapshot(client, 'term')?.state).toBe('not-in-front')
      if (n === 100) {
        stops.forEach((stop) => stop())
      }
      controller.dispose()
      if (n === 10) {
        stops.forEach((stop) => stop())
      }
      expect(physical.stateListeners()).toBe(0)
      for (let i = 0; i < n; i++) {
        await readMobilePresentation(client, `unowned-${i}`)
      }
      expect(physical.stateListeners()).toBe(0)
    }
  )
})
