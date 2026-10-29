// Lost push subscriptions produce no receive count or ACK; watchdog reattachment must replace stale listeners to recover the pane.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopTerminalObservationOwner } from '../../runtime/desktop-terminal-observation-owner'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: true } }))

type ExitCallback = Parameters<Window['api']['pty']['onExit']>[0]
type UnavailableCallback = Parameters<NonNullable<Window['api']['pty']['onWriteUnavailable']>>[0]

type DataCallback = (payload: { id: string; data: string; rawLength?: number }) => void

describe('pty dispatcher push-listener reattach and delivery blackhole', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  let dataCallbacks: DataCallback[] = []
  let exitCallbacks: ExitCallback[] = []
  let unavailableCallbacks: UnavailableCallback[] = []
  let dataUnsubscribes: ReturnType<typeof vi.fn>[] = []
  const ackDataMock = vi.fn()
  const reportMock = vi.fn(() =>
    Promise.resolve({
      inFlightTotalChars: 0,
      inFlightPtyCount: 0,
      msSinceLastAck: null
    })
  )

  beforeEach(() => {
    vi.resetModules()
    dataCallbacks = []
    exitCallbacks = []
    unavailableCallbacks = []
    dataUnsubscribes = []
    ackDataMock.mockClear()
    reportMock.mockClear()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          ackData: ackDataMock,
          reportRendererDeliveryState: reportMock,
          getPtyDataListenerCount: () => dataCallbacks.length,
          onData: vi.fn((cb: DataCallback) => {
            dataCallbacks.push(cb)
            const unsubscribe = vi.fn()
            dataUnsubscribes.push(unsubscribe)
            return unsubscribe
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn((cb: ExitCallback) => {
            exitCallbacks.push(cb)
            return () => {}
          }),
          onWriteUnavailable: vi.fn((cb: UnavailableCallback) => {
            unavailableCallbacks.push(cb)
            return () => {}
          }),
          onDeliveryResyncRequest: vi.fn(() => () => {}),
          respondDeliveryResync: vi.fn()
        }
      }
    } as unknown as typeof window
  })

  afterEach(async () => {
    // Stop the real watchdog interval before this suite removes its mocked window.
    const { stopTerminalDeliveryWatchdog } = await import('./terminal-delivery-watchdog')
    stopTerminalDeliveryWatchdog()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('blackholed delivery reproduces the wedge: no handler dispatch, no ACK ever', async () => {
    const { ensurePtyDispatcher, ptyDataHandlers } = await import('./pty-dispatcher')
    ensurePtyDispatcher()
    const received: string[] = []
    ptyDataHandlers.set('pty-1', (data) => received.push(data))

    dataCallbacks[0]?.({ id: 'pty-1', data: 'before-wedge' })
    expect(received).toEqual(['before-wedge'])
    expect(ackDataMock).toHaveBeenCalledTimes(1)

    const blackhole = (
      window as Window & {
        __terminalDeliveryWatchdog?: { blackhole: (on: boolean) => void }
      }
    ).__terminalDeliveryWatchdog
    expect(blackhole).toBeDefined()
    blackhole!.blackhole(true)

    // Vanished chunks have neither receive count nor ACK, leaving unrepaid main-side debt.
    dataCallbacks[0]?.({ id: 'pty-1', data: 'lost-in-wedge' })
    expect(received).toEqual(['before-wedge'])
    expect(ackDataMock).toHaveBeenCalledTimes(1)

    blackhole!.blackhole(false)
  })

  it('reattach drops stale push subscriptions and binds fresh ones', async () => {
    const { ensurePtyDispatcher, ptyDataHandlers, reattachPtyDispatcherPushListeners } =
      await import('./pty-dispatcher')
    ensurePtyDispatcher()
    const received: string[] = []
    ptyDataHandlers.set('pty-1', (data) => received.push(data))
    expect(dataCallbacks).toHaveLength(1)

    reattachPtyDispatcherPushListeners()

    expect(dataUnsubscribes[0]).toHaveBeenCalledTimes(1)
    expect(dataCallbacks).toHaveLength(2)

    dataCallbacks[1]?.({ id: 'pty-1', data: 'after-reattach' })
    expect(received).toEqual(['after-reattach'])
    expect(ackDataMock).toHaveBeenCalledTimes(1)
  })
  it.each(['unavailable', 'exit'] as const)(
    '%s retires before callbacks and stale cleanup preserves a reentrant replacement after reattach',
    async (event) => {
      const dispatcher = await import('./pty-dispatcher')
      dispatcher.ensurePtyDispatcher()
      const owners = await import('../../runtime/desktop-terminal-observation-owner')
      const dispose = owners.installDesktopTerminalObservationOwners()
      try {
        const source = new Map<string, DesktopTerminalObservationOwner>()
        const old = owners.captureDesktopTerminalObservation('pty-1', source)!
        old.incarnation = 'old'
        const independent = owners.captureDesktopTerminalObservation('other-pty', source)!
        const retired = vi.fn(() => {
          expect(old.active).toBe(false)
          expect(old.contact.children.has(old.id)).toBe(false)
          expect(old.contact.resources.has(old.retire)).toBe(false)
          expect(old.sources.size).toBe(0)
          expect(old.dispose.size).toBe(0)
          owners.captureDesktopTerminalObservation('pty-1', source)!.incarnation = 'new'
        })
        old.dispose.add(retired)
        const callback = vi.fn(() => {
          expect(retired).toHaveBeenCalledTimes(1)
          const replacement = owners.captureDesktopTerminalObservation('pty-1', source)!
          expect(replacement).not.toBe(old)
          old.retire()
          owners.releaseDesktopObservationSource(old, source)
          expect(owners.captureDesktopTerminalObservation('pty-1', source)).toBe(replacement)
          expect(replacement.active).toBe(true)
        })
        dispatcher.ptyWriteUnavailableHandlers.set('pty-1', callback)
        dispatcher.ptyExitHandlers.set('pty-1', callback)
        const offExit = dispatcher.subscribeToPtyExit('pty-1', callback)
        dispatcher.reattachPtyDispatcherPushListeners()
        if (event === 'exit') {
          exitCallbacks[1]!({ id: 'pty-1', code: 0, incarnationId: 'old' })
          expect(callback).toHaveBeenCalledTimes(2)
        } else {
          unavailableCallbacks[1]!({ id: 'pty-1' })
          expect(callback).toHaveBeenCalledTimes(1)
        }
        exitCallbacks[1]!({ id: 'pty-1', code: 0, incarnationId: 'old' })
        expect(owners.captureDesktopTerminalObservation('pty-1', source)?.incarnation).toBe('new')
        expect(retired).toHaveBeenCalledTimes(1)
        expect(independent.active).toBe(true)
        offExit()
      } finally {
        dispose()
      }
    }
  )
})
