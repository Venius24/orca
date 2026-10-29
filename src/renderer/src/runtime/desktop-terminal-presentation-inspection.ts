import { admitRemoteForegroundEvidence } from '../../../shared/remote-foreground-evidence-admission'
import type { RemoteForegroundEvidence } from '../../../shared/foreground-process-evidence'
import {
  isClientOnlyUnverifiableInspection,
  type TerminalProcessInspection
} from '../../../shared/terminal-process-inspection'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { getRemoteRuntimePtyOwner } from './runtime-terminal-stream'
import {
  isTerminalPresentationObservation,
  type TerminalPresentationObservation
} from '../../../shared/terminal-foreground-presentation'
import { readLocalRuntimeCapabilitiesOrUnknown } from './local-runtime-capabilities'
import { readCachedRuntimeEnvironmentCapability } from './runtime-rpc-client'
import { TERMINAL_FOREGROUND_PRESENTATION_CAPABILITY } from '../../../shared/terminal-runtime-capabilities'
import {
  captureDesktopTerminalObservation,
  desktopObservationCurrent,
  desktopObservationHasBinding,
  retireDesktopTerminalObservation,
  type DesktopTerminalObservationOwner,
  type DesktopObservationSource
} from './desktop-terminal-observation-owner'

type Fact = {
  value?: TerminalPresentationObservation
  sources: Set<DesktopObservationSource>
  admission?: RemoteForegroundEvidence
  generations?: Set<string>
}
const facts = new Map<DesktopTerminalObservationOwner, Fact>()
const listeners = new Map<string, Set<() => void>>()
const currentOwners = new Map<string, DesktopTerminalObservationOwner>()
function notify(id: string) {
  for (const listener of listeners.get(id) ?? []) {
    listener()
  }
}
function factFor(owner: DesktopTerminalObservationOwner): Fact {
  let fact = facts.get(owner)
  if (!fact) {
    fact = { sources: new Set() }
    facts.set(owner, fact)
    currentOwners.set(owner.id, owner)
    owner.dispose.add(() => {
      facts.delete(owner)
      if (currentOwners.get(owner.id) === owner) {
        currentOwners.delete(owner.id)
      }
      if (fact?.value !== undefined && fact.sources.size) {
        notify(owner.id)
      }
    })
  }
  return fact
}
export function desktopPresentationSnapshot(id: string | null | undefined) {
  const owner = id ? currentOwners.get(id) : undefined
  const fact = owner?.active ? facts.get(owner) : undefined
  return fact?.sources.size ? fact.value : undefined
}
export function subscribeDesktopPresentation(id: string, listener: () => void) {
  const slot = listeners.get(id) ?? new Set<() => void>()
  listeners.set(id, slot)
  slot.add(listener)
  return () => {
    slot.delete(listener)
    if (!slot.size) {
      listeners.delete(id)
    }
  }
}
export function supported(id: string) {
  const owner = getRemoteRuntimePtyOwner(id)
  return owner
    ? readCachedRuntimeEnvironmentCapability(
        owner.target.environmentId,
        TERMINAL_FOREGROUND_PRESENTATION_CAPABILITY
      )
    : readLocalRuntimeCapabilitiesOrUnknown()?.includes(TERMINAL_FOREGROUND_PRESENTATION_CAPABILITY)
}
export function desktopPresentationForExit(id: string | undefined) {
  const value = desktopPresentationSnapshot(id)
  return value
    ? value.support === 'legacy'
      ? 'gone'
      : value.state
    : id && supported(id) === false
      ? 'gone'
      : undefined
}
export function accept(
  owner: DesktopTerminalObservationOwner,
  value: TerminalPresentationObservation,
  source: DesktopObservationSource
) {
  if (!owner.active) {
    return
  }
  const fact = factFor(owner)
  const old = fact.value
  if (old?.incarnationId === value.incarnationId) {
    if (
      (old.support === 'supported' && value.support === 'legacy') ||
      value.version < old.version
    ) {
      return
    }
    if (value.version === old.version) {
      fact.sources.add(source)
      return
    }
  }
  fact.value = value
  fact.sources.add(source)
  if (desktopObservationHasBinding(owner)) {
    fact.sources.add(owner)
  }
  owner.contact.modern ||= value.support === 'supported'
  owner.incarnation = value.incarnationId
  notify(owner.id)
}
export function withdraw(owner: DesktopTerminalObservationOwner, source: DesktopObservationSource) {
  const fact = facts.get(owner)
  if (!fact) {
    return
  }
  const visible = fact.sources.size > 0 && fact.value !== undefined
  fact.sources.delete(source)
  if (!fact.sources.size) {
    fact.value = undefined
    fact.admission = undefined
    fact.generations = undefined
    if (visible) {
      notify(owner.id)
    }
  }
}
export function beginDesktopPresentationInspection(id: string) {
  const owner = captureDesktopTerminalObservation(id)
  const current = desktopObservationCurrent(owner)
  return {
    owner,
    current,
    fail() {
      if (owner && current()) {
        withdraw(owner, owner)
      }
    },
    deliver(
      result: TerminalProcessInspection,
      request: {
        remote: boolean
        expectedIncarnationId: string | null
        startedAt: number
        legacy?: boolean
      }
    ) {
      if (!owner || !current()) {
        return
      }
      const fact = factFor(owner)
      if (isClientOnlyUnverifiableInspection(result)) {
        withdraw(owner, owner)
        return
      }
      const presentation = request.legacy
        ? {
            support: 'legacy' as const,
            incarnationId: request.expectedIncarnationId ?? '',
            version: 0
          }
        : isTerminalPresentationObservation(result.presentation)
          ? result.presentation
          : undefined
      if (
        owner.incarnation &&
        ((presentation && presentation.incarnationId !== owner.incarnation) ||
          (request.expectedIncarnationId && request.expectedIncarnationId !== owner.incarnation))
      ) {
        return
      }
      if (request.remote && !getRemoteRuntimePtyOwner(id)) {
        const evidence = admitRemoteForegroundEvidence(result.foregroundProcessEvidence, {
          expectedPtyId: parseAppSshPtyId(id)?.relayPtyId ?? id,
          expectedIncarnationId: request.expectedIncarnationId,
          requestStartedAtMonotonic: request.startedAt,
          receivedAtMonotonic: performance.now(),
          lastAuthorityGeneration: fact.admission?.authorityGeneration ?? null,
          lastObservationEpoch: fact.admission?.observationEpoch ?? -1,
          knownAuthorityGenerations: fact.generations
        })
        if (!evidence) {
          return
        }
        fact.admission = evidence
        ;(fact.generations ??= new Set()).add(evidence.authorityGeneration)
      }
      if (presentation) {
        accept(owner, presentation, owner)
      } else if (owner.contact.modern || supported(id) === true) {
        retireDesktopTerminalObservation(id)
      } else {
        accept(
          owner,
          {
            support: 'legacy',
            incarnationId: request.expectedIncarnationId ?? owner.incarnation ?? '',
            version: 0
          },
          owner
        )
      }
    }
  }
}
