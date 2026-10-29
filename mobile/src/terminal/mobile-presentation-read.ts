import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  isTerminalPresentationObservation,
  type TerminalPresentationObservation
} from '../../../src/shared/terminal-foreground-presentation'
import {
  cacheFor,
  ownerFor,
  current,
  supplier,
  accept,
  retire,
  notify,
  releaseCache,
  type Client,
  type Owner,
  type MobilePresentationSource
} from './mobile-presentation-cache'
const inspection = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.inspect-presentation',
    method: 'terminal.inspectProcess',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'presentation',
      z.object({
        process: z
          .object({
            presentation: z
              .custom<TerminalPresentationObservation>(isTerminalPresentationObservation)
              .optional()
          })
          .nullable()
      })
    )
  })
)
export function readMobilePresentation(
  client: Client,
  terminal: string,
  expectedIncarnationId?: string | null
): Promise<void> {
  const cache = cacheFor(client)
  const contact = cache.contact
  const existing = cache.owners.get(terminal)
  const owned = cache.listeners.has(terminal) || existing !== undefined
  const owner: Owner = owned
    ? (existing ?? ownerFor(cache, terminal))
    : {
        active: true,
        sources: new Set<Owner | MobilePresentationSource>(),
        members: new Set<MobilePresentationSource>(),
        dispose: new Set<() => void>()
      }
  if (owner.pending?.current()) {
    return owner.pending.promise
  }
  const slot = cache.listeners.get(terminal)
  const sources = new Set(owner.members)
  const slotCurrent = () => Boolean(slot?.size && cache.listeners.get(terminal) === slot)
  const effectCurrent = () =>
    current(client, cache, contact) &&
    owner.active &&
    (slotCurrent() || [...sources].some((source) => owner.members.has(source)))
  const incarnation = expectedIncarnationId ?? owner.incarnation ?? null
  const promise = inspection
    .request(client, { terminal, ...(incarnation ? { expectedIncarnationId: incarnation } : {}) })
    .then((raw) => {
      if (!owned || !effectCurrent() || owner.pending?.promise !== promise) {
        return
      }
      const response = inspection.interpret(raw)
      if (
        !supplier(cache, raw._meta) ||
        !current(client, cache, contact) ||
        !(slotCurrent() || [...sources].some((source) => source.current())) ||
        (!owner.active && cache.owners.has(terminal))
      ) {
        return
      }
      // A current authenticated reply can be the first publication from a replacement runtime.
      const acceptedOwner = owner.active ? owner : ownerFor(cache, terminal)
      if (acceptedOwner !== owner) {
        for (const source of sources) {
          if (source.current()) {
            source.own(terminal, acceptedOwner)
          }
        }
      }
      const value = response?.process?.presentation
      if (value && (!incarnation || value.incarnationId === incarnation)) {
        accept(cache, terminal, acceptedOwner, value, acceptedOwner)
      } else if (!value && cache.modern) {
        retire(cache, terminal)
      }
    })
    .catch(() => {
      if (effectCurrent() && owner.pending?.promise === promise) {
        owner.sources.delete(owner)
        if (!owner.sources.size) {
          owner.value = undefined
          notify(cache, terminal)
        }
      }
    })
    .finally(() => {
      if (owner.pending?.promise === promise) {
        owner.pending = undefined
      }
      releaseCache(client, cache)
    })
  owner.pending = { promise, current: effectCurrent }
  return promise
}
