import { isTerminalPresentationObservation } from '../../../shared/terminal-foreground-presentation'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  captureDesktopTerminalObservation,
  captureDesktopObservationRead,
  desktopObservationContact,
  releaseDesktopObservationSource,
  retireDesktopTerminalObservation,
  type DesktopTerminalObservationOwner
} from './desktop-terminal-observation-owner'
import { accept, withdraw, supported } from './desktop-terminal-presentation-inspection'
export {
  desktopPresentationSnapshot,
  subscribeDesktopPresentation,
  desktopPresentationForExit,
  beginDesktopPresentationInspection
} from './desktop-terminal-presentation-inspection'
const sources = new Map<string, DesktopPresentationSource>()
export type DesktopPresentationDelivery = {
  apply: (frame: RuntimeMobileSessionTabsResult) => void
  dispose: () => void
}
export type DesktopPresentationSource = DesktopPresentationDelivery & {
  capture: (frame: RuntimeMobileSessionTabsResult) => DesktopPresentationDelivery
  current: () => boolean
  apply: (frame: RuntimeMobileSessionTabsResult) => void
  retain: (worktrees: readonly string[]) => void
  retract: (worktree?: string) => void
  dispose: () => void
}
export function createDesktopPresentationSource(
  scope: string,
  label = 'snapshot',
  isCurrent = () => true,
  read = false
): DesktopPresentationSource {
  const key = `${scope}\0${label}`
  sources.get(key)?.dispose()
  const contact = desktopObservationContact(
    scope === LOCAL_STRUCTURED_SESSION_OWNER ? 'local' : scope
  )
  type Member = { owner: DesktopTerminalObservationOwner; retire: () => void }
  const members = new Map<string, Map<string, Member>>()
  const associations = new Map<DesktopTerminalObservationOwner, number>()
  const detach = (member: Member) => {
    member.owner.dispose.delete(member.retire)
    const count = (associations.get(member.owner) ?? 1) - 1
    if (count > 0) {
      associations.set(member.owner, count)
    } else {
      associations.delete(member.owner)
      withdraw(member.owner, source)
      releaseDesktopObservationSource(member.owner, source)
    }
  }
  let readOwners: ReturnType<typeof captureDesktopObservationRead> | undefined
  const pending = new Set<() => void>()
  const terminalId = (tab: RuntimeMobileSessionTabsResult['tabs'][number]) =>
    tab.type !== 'terminal'
      ? null
      : scope === LOCAL_STRUCTURED_SESSION_OWNER
        ? tab.ptyId
        : tab.status === 'ready'
          ? toRemoteRuntimePtyId(tab.terminal, scope)
          : null
  let active = true
  const source: DesktopPresentationSource = {
    current: () => active && contact?.active === true && isCurrent(),
    retain(worktrees) {
      const retained = new Set(worktrees)
      for (const workspace of members.keys()) {
        if (!retained.has(workspace)) {
          source.retract(workspace)
        }
      }
    },
    retract(worktree) {
      for (const workspace of worktree ? [worktree] : members.keys()) {
        const previous = members.get(workspace)
        members.delete(workspace)
        for (const member of previous?.values() ?? []) {
          detach(member)
        }
      }
    },
    dispose() {
      active = false
      const disposers = [...pending]
      for (const dispose of disposers) {
        dispose()
      }
      source.retract()
      for (const owner of readOwners?.values() ?? []) {
        releaseDesktopObservationSource(owner, source)
      }
      readOwners?.clear()
      contact?.resources.delete(source.dispose)
      if (sources.get(key) === source) {
        sources.delete(key)
      }
    },
    capture(frame) {
      const captured = new Map<string, DesktopTerminalObservationOwner>()
      const retirements = new Map<DesktopTerminalObservationOwner, () => void>()
      const capture = (owner: DesktopTerminalObservationOwner) => {
        if (captured.get(owner.id) === owner) {
          return
        }
        captured.set(owner.id, owner)
        const retire = () => {
          captured.delete(owner.id)
          retirements.delete(owner)
          owner.dispose.delete(retire)
        }
        retirements.set(owner, retire)
        owner.dispose.add(retire)
      }
      if (source.current()) {
        for (const member of members.get(frame.worktree)?.values() ?? []) {
          member.owner.sources.add(captured)
          capture(member.owner)
        }
        for (const tab of frame.tabs) {
          const id = terminalId(tab)
          const owner = id
            ? (readOwners?.get(id) ?? captureDesktopTerminalObservation(id, captured, contact))
            : null
          if (owner?.active) {
            owner.sources.add(captured)
            capture(owner)
          }
        }
      }
      let live = true
      const dispose = () => {
        live = false
        pending.delete(dispose)
        for (const [owner, retire] of retirements) {
          owner.dispose.delete(retire)
        }
        retirements.clear()
        for (const owner of captured.values()) {
          releaseDesktopObservationSource(owner, captured)
        }
        captured.clear()
      }
      pending.add(dispose)
      return {
        dispose,
        apply(frame) {
          if (!live || !source.current()) {
            return
          }
          try {
            applyFrame(frame, captured)
          } finally {
            dispose()
          }
        }
      }
    },
    apply(frame) {
      const delivery = source.capture(frame)
      try {
        delivery.apply(frame)
      } finally {
        delivery.dispose()
      }
    }
  }
  function applyFrame(
    frame: RuntimeMobileSessionTabsResult,
    captured: ReadonlyMap<string, DesktopTerminalObservationOwner>
  ) {
    if (!source.current()) {
      return
    }
    const previous = members.get(frame.worktree)
    const next = new Map<string, Member>()
    members.set(frame.worktree, next)
    for (const tab of frame.tabs) {
      if (tab.type !== 'terminal') {
        continue
      }
      const id = terminalId(tab)
      if (!id) {
        continue
      }
      let owner = captured.get(id)
      if (!owner?.active) {
        continue
      }
      owner.sources.add(source)
      const value =
        isTerminalPresentationObservation(tab.presentation) &&
        tab.presentation.incarnationId === tab.incarnationId
          ? tab.presentation
          : undefined
      const modernReset = !value && (owner.contact.modern || supported(id) === true)
      if ((owner.incarnation && owner.incarnation !== tab.incarnationId) || modernReset) {
        retireDesktopTerminalObservation(id)
        owner = captureDesktopTerminalObservation(id, source, contact) ?? undefined
        if (!owner) {
          continue
        }
      }
      owner.incarnation = tab.incarnationId
      let member = previous?.get(id)
      if (member?.owner !== owner) {
        const captured = owner
        const worktree = frame.worktree
        const acquired: Member = {
          owner,
          retire: () => {
            const workspace = members.get(worktree)
            if (workspace?.get(id) === acquired) {
              workspace.delete(id)
              if (!workspace.size) {
                members.delete(worktree)
              }
            }
            detach(acquired)
          }
        }
        owner.dispose.add(acquired.retire)
        associations.set(captured, (associations.get(captured) ?? 0) + 1)
        member = acquired
      }
      next.set(id, member)
      if (value) {
        accept(owner, value, source)
      } else {
        withdraw(owner, source)
      }
    }
    for (const [id, member] of previous ?? []) {
      if (!next.has(id)) {
        if (captured.get(id) === member.owner) {
          detach(member)
        } else {
          next.set(id, member)
        }
      }
    }
    if (next.size) {
      members.set(frame.worktree, next)
    } else {
      members.delete(frame.worktree)
    }
  }
  if (read) {
    readOwners = captureDesktopObservationRead(contact, source)
  }
  sources.set(key, source)
  contact?.resources.add(source.dispose)
  return source
}
export function acceptDesktopPresentationFrame(
  scope: string,
  frame: RuntimeMobileSessionTabsResult,
  source: string | DesktopPresentationSource = 'snapshot'
) {
  const delivery =
    typeof source === 'string'
      ? (sources.get(`${scope}\0${source}`) ?? createDesktopPresentationSource(scope, source))
      : source
  delivery.apply(frame)
}
export function retractDesktopPresentations(scope: string, worktree?: string, label = 'snapshot') {
  const source = sources.get(`${scope}\0${label}`)
  if (worktree === undefined) {
    source?.dispose()
  } else {
    source?.retract(worktree)
  }
}
