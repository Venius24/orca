import type { DesktopPresentationSource } from './terminal-foreground-presentation'

export type DesktopObservationContact = {
  key: string
  signature: string
  runtimeId?: string
  revision?: number
  active: boolean
  modern?: boolean
  children: Map<string, DesktopTerminalObservationOwner>
  resources: Set<() => void>
}
export type DesktopTerminalObservationOwner = {
  id: string
  contact: DesktopObservationContact
  incarnation?: string | null
  active: boolean
  sources: Set<DesktopObservationSource>
  dispose: Set<() => void>
  retire: () => void
}
export type DesktopObservationSource =
  | DesktopTerminalObservationOwner
  | DesktopPresentationSource
  | ReadonlyMap<string, DesktopTerminalObservationOwner>
export const contacts = new Map<string, DesktopObservationContact>()
export const terminals = new Map<string, DesktopTerminalObservationOwner>()

export function retireDesktopTerminalObservation(id: string, incarnation?: string): void {
  const owner = terminals.get(id)
  if (!owner || (incarnation && owner.incarnation && owner.incarnation !== incarnation)) {
    return
  }
  retireOwner(owner)
}
export function retireOwner(owner: DesktopTerminalObservationOwner) {
  if (!owner.active) {
    return
  }
  owner.active = false
  if (terminals.get(owner.id) === owner) {
    terminals.delete(owner.id)
  }
  if (owner.contact.children.get(owner.id) === owner) {
    owner.contact.children.delete(owner.id)
  }
  owner.contact.resources.delete(owner.retire)
  owner.sources.clear()
  const disposers = [...owner.dispose]
  owner.dispose.clear()
  for (const dispose of disposers) {
    dispose()
  }
}
export function retireContact(contact: DesktopObservationContact): void {
  if (!contact.active) {
    return
  }
  contact.active = false
  if (contacts.get(contact.key) === contact) {
    contacts.delete(contact.key)
  }
  const resources = [...contact.resources]
  contact.resources.clear()
  for (const dispose of resources) {
    dispose()
  }
  contact.children.clear()
}
