import {
  contacts,
  terminals,
  retireOwner,
  retireContact,
  type DesktopObservationContact,
  type DesktopTerminalObservationOwner,
  type DesktopObservationSource
} from './desktop-terminal-observation-lifetime'
export {
  retireDesktopTerminalObservation,
  type DesktopObservationContact,
  type DesktopTerminalObservationOwner,
  type DesktopObservationSource
} from './desktop-terminal-observation-lifetime'
import {
  catalogFor,
  contactIdentity,
  terminalContactKey,
  readBindings,
  changedKeys,
  clearDesktopObservationCatalog,
  type BindingView
} from './desktop-terminal-observation-views'
import { useAppStore } from '../store'
import {
  onRuntimeEnvironmentsRetired,
  onRuntimeEnvironmentRevisionsChanged
} from './runtime-environment-revision'

let bindings: BindingView | undefined
let installed = false

export function desktopObservationContact(key: string): DesktopObservationContact | null {
  if (!installed) {
    return null
  }
  const identity = contactIdentity(key)
  const old = contacts.get(key)
  if (old && old.signature === identity?.signature) {
    return old
  }
  if (old) {
    retireContact(old)
    return desktopObservationContact(key)
  }
  if (!identity) {
    return null
  }
  const contact: DesktopObservationContact = {
    key,
    ...identity,
    active: true,
    resources: new Set(),
    children: new Map()
  }
  contacts.set(key, contact)
  return contact
}
export function desktopContactForTerminal(id: string) {
  return desktopObservationContact(terminalContactKey(id))
}
export function captureDesktopObservationRead(
  contact: DesktopObservationContact | null,
  source: DesktopObservationSource
) {
  const captured = new Map<string, DesktopTerminalObservationOwner>()
  if (!contact?.active || contacts.get(contact.key) !== contact) {
    return captured
  }
  for (const owner of contact.children.values()) {
    owner.sources.add(source)
    captured.set(owner.id, owner)
  }
  for (const id of (bindings ??= readBindings(useAppStore.getState())).terminalsByRoute.get(
    contact.key
  ) ?? []) {
    if (captured.has(id)) {
      continue
    }
    const owner = captureDesktopTerminalObservation(id, source, contact)
    if (owner) {
      captured.set(id, owner)
    }
  }
  return captured
}
export function captureDesktopTerminalObservation(
  id: string,
  source?: DesktopObservationSource,
  contact = desktopContactForTerminal(id)
): DesktopTerminalObservationOwner | null {
  if (!installed || !contact?.active || contacts.get(contact.key) !== contact) {
    return null
  }
  let owner = terminals.get(id)
  if (owner?.contact !== contact) {
    if (owner) {
      retireOwner(owner)
      return captureDesktopTerminalObservation(id, source, contact)
    }
    owner = undefined
  }
  const bound = (bindings ??= readBindings(useAppStore.getState())).tokensByTerminal.has(id)
  if (!owner && !source && !bound) {
    return null
  }
  if (!owner) {
    owner = { id, contact, active: true, sources: new Set(), dispose: new Set(), retire: () => {} }
    terminals.set(id, owner)
    contact.children.set(id, owner)
    const captured = owner
    owner.retire = () => {
      retireOwner(captured)
    }
    contact.resources.add(owner.retire)
  }
  if (source) {
    owner.sources.add(source)
  }
  return owner
}
export function desktopObservationHasBinding(owner: DesktopTerminalObservationOwner): boolean {
  return (bindings ??= readBindings(useAppStore.getState())).tokensByTerminal.has(owner.id)
}
export function desktopObservationCurrent(
  owner: DesktopTerminalObservationOwner | null
): () => boolean {
  const tokens = owner ? bindings?.tokensByTerminal.get(owner.id) : undefined
  const sources = new Set(owner?.sources)
  return () =>
    Boolean(
      owner?.active &&
      ([...(tokens ?? [])].some((token) => bindings?.tokensByTerminal.get(owner.id)?.has(token)) ||
        [...sources].some((source) => owner.sources.has(source)))
    )
}
export function releaseDesktopObservationSource(
  owner: DesktopTerminalObservationOwner,
  source: DesktopObservationSource
) {
  owner.sources.delete(source)
  if (
    owner.active &&
    !owner.sources.size &&
    !(bindings ??= readBindings(useAppStore.getState())).tokensByTerminal.has(owner.id)
  ) {
    retireOwner(owner)
  }
}
export function installDesktopTerminalObservationOwners(): () => void {
  installed = true
  bindings = undefined
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    const changed = new Set<string>()
    if (state.runtimeEnvironments !== previous.runtimeEnvironments) {
      const old = catalogFor(previous.runtimeEnvironments)
      changedKeys(old, catalogFor(state.runtimeEnvironments), changed)
    }
    if (state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId) {
      changedKeys(
        previous.runtimeStatusByEnvironmentId,
        state.runtimeStatusByEnvironmentId,
        changed
      )
    }
    if (state.sshConnectionStates !== previous.sshConnectionStates) {
      changedKeys(previous.sshConnectionStates, state.sshConnectionStates, changed, 'ssh:')
    }
    if (state.sshTargetGenerations !== previous.sshTargetGenerations) {
      changedKeys(previous.sshTargetGenerations, state.sshTargetGenerations, changed, 'ssh:')
    }
    for (const key of changed) {
      const contact = contacts.get(key)
      if (contact && contact.signature !== contactIdentity(key, state)?.signature) {
        retireContact(contact)
      }
    }
    if (
      state.ptyIdsByTabId !== previous.ptyIdsByTabId ||
      state.terminalLayoutsByTabId !== previous.terminalLayoutsByTabId ||
      state.tabsByWorktree !== previous.tabsByWorktree
    ) {
      const previousBindings = bindings
      bindings = previousBindings || terminals.size ? readBindings(state) : undefined
      if (previousBindings && bindings) {
        for (const [id, tokens] of previousBindings.tokensByTerminal) {
          const owner = terminals.get(id)
          if (
            owner &&
            !owner.sources.size &&
            ![...tokens].some((token) => bindings?.tokensByTerminal.get(id)?.has(token))
          ) {
            retireOwner(owner)
          }
        }
      }
    }
  })
  const retire = (ids: readonly string[]) => {
    for (const id of ids) {
      const contact = contacts.get(id)
      if (contact) {
        retireContact(contact)
      }
    }
  }
  const offRetired = onRuntimeEnvironmentsRetired(retire)
  const offRevision = onRuntimeEnvironmentRevisionsChanged(retire)
  return () => {
    installed = false
    unsubscribe()
    offRetired()
    offRevision()
    const retiredContacts = [...contacts.values()]
    for (const contact of retiredContacts) {
      retireContact(contact)
    }
    bindings = undefined
    clearDesktopObservationCatalog()
  }
}
