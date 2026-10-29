import type { TerminalPresentationObservation } from '../../../src/shared/terminal-foreground-presentation'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
export type Owner = {
  value?: TerminalPresentationObservation
  incarnation?: string | null
  active: boolean
  sources: Set<Owner | MobilePresentationSource>
  members: Set<MobilePresentationSource>
  dispose: Set<() => void>
  pending?: { promise: Promise<void>; current: () => boolean }
}
export type Client = UnvalidatedRpcRequestPort &
  Partial<Pick<RpcClient, 'getState' | 'getGeneration' | 'onStateChange'>>
export type MobilePresentationContact = {
  generation: number
}
export type Cache = {
  owners: Map<string, Owner>
  listeners: Map<string, Set<() => void>>
  sources: Map<string, MobilePresentationSource>
  contact: MobilePresentationContact | null
  generation: number
  runtimeId?: string
  modern?: boolean
  retired: Set<string>
  unsubscribe?: () => void
}
export type MobilePresentationDelivery = {
  apply: (tabs: readonly unknown[], metadata?: RpcResponse['_meta']) => void
  dispose: () => void
}
export type MobilePresentationSource = MobilePresentationDelivery & {
  capture: () => MobilePresentationDelivery
  current: () => boolean
  own: (terminal: string, owner: Owner) => void
  apply: (tabs: readonly unknown[], metadata?: RpcResponse['_meta']) => void
  dispose: () => void
}
export const clients = new WeakMap<Client, Cache>()
export function notify(cache: Cache, terminal: string) {
  for (const listener of cache.listeners.get(terminal) ?? []) {
    listener()
  }
}
function detach(cache: Cache, terminal: string, owner: Owner) {
  if (cache.owners.get(terminal) !== owner) {
    return () => {}
  }
  const visible = owner.value !== undefined && owner.sources.size > 0
  owner.active = false
  owner.pending = undefined
  owner.value = undefined
  owner.sources.clear()
  owner.members.clear()
  cache.owners.delete(terminal)
  const disposers = [...owner.dispose]
  owner.dispose.clear()
  return () => {
    for (const dispose of disposers) {
      dispose()
    }
    if (visible) {
      notify(cache, terminal)
    }
  }
}
export function retire(cache: Cache, terminal: string, owner = cache.owners.get(terminal)) {
  if (owner) {
    detach(cache, terminal, owner)()
  }
}
export function releaseOwner(cache: Cache, terminal: string, owner: Owner) {
  if (cache.owners.get(terminal) !== owner) {
    return
  }
  if (owner.pending && !owner.pending.current()) {
    owner.pending = undefined
  }
  if (!cache.listeners.has(terminal) && !owner.members.size) {
    retire(cache, terminal, owner)
  }
}
export function reset(cache: Cache) {
  const notifications = [...cache.owners].map(([terminal, owner]) => detach(cache, terminal, owner))
  for (const notify of notifications) {
    notify()
  }
}
function reconcile(client: Client, cache: Cache) {
  if (clients.get(client) !== cache) {
    return
  }
  const generation = client.getGeneration?.() ?? 0
  const connected = !client.getState || client.getState() === 'connected'
  if (cache.generation === generation && Boolean(cache.contact) === connected) {
    return
  }
  cache.contact = connected ? { generation } : null
  cache.generation = generation
  cache.modern = false
  cache.runtimeId = undefined
  cache.retired.clear()
  reset(cache)
}
export function cacheFor(client: Client): Cache {
  let cache = clients.get(client)
  if (!cache) {
    cache = {
      owners: new Map(),
      listeners: new Map(),
      sources: new Map(),
      contact: null,
      generation: client.getGeneration?.() ?? 0,
      retired: new Set()
    }
    clients.set(client, cache)
  }
  reconcile(client, cache)
  if (clients.get(client) !== cache) {
    return cacheFor(client)
  }
  if (!cache.unsubscribe && client.onStateChange) {
    const captured = cache
    cache.unsubscribe = client.onStateChange(() => reconcile(client, captured))
  }
  return cache
}
export function releaseCache(client: Client, cache: Cache) {
  if (
    clients.get(client) === cache &&
    !cache.listeners.size &&
    !cache.sources.size &&
    !cache.owners.size
  ) {
    clients.delete(client)
    cache.contact = null
    const unsubscribe = cache.unsubscribe
    cache.unsubscribe = undefined
    cache.retired.clear()
    cache.modern = false
    cache.runtimeId = undefined
    unsubscribe?.()
  }
}
export function current(client: Client, cache: Cache, contact: MobilePresentationContact | null) {
  return (
    contact !== null &&
    clients.get(client) === cache &&
    cache.contact === contact &&
    cache.generation === (client.getGeneration?.() ?? 0) &&
    (!client.getState || client.getState() === 'connected')
  )
}
export function supplier(cache: Cache, metadata?: RpcResponse['_meta']) {
  const id = metadata?.runtimeId
  if (!id || id === cache.runtimeId) {
    return true
  }
  if (cache.retired.has(id)) {
    return false
  }
  const previous = cache.runtimeId
  cache.runtimeId = id
  if (previous) {
    cache.retired.add(previous)
    cache.modern = false
    reset(cache)
  }
  return cache.runtimeId === id
}
export function ownerFor(cache: Cache, terminal: string) {
  let owner = cache.owners.get(terminal)
  if (!owner) {
    owner = { active: true, sources: new Set(), members: new Set(), dispose: new Set() }
    cache.owners.set(terminal, owner)
  }
  return owner
}
export function accept(
  cache: Cache,
  terminal: string,
  owner: Owner,
  value: TerminalPresentationObservation,
  source: Owner | MobilePresentationSource
) {
  const old = owner.value
  if (old?.incarnationId === value.incarnationId) {
    if (
      value.version < old.version ||
      (old.support === 'supported' && value.support === 'legacy')
    ) {
      return
    }
    if (value.version === old.version) {
      owner.sources.add(source)
      return
    }
  }
  cache.modern ||= value.support === 'supported'
  owner.incarnation = value.incarnationId
  owner.sources.add(source)
  owner.value = value
  notify(cache, terminal)
}
