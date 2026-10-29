import { useAppStore, type AppState } from '../store'
import { runtimeHostContactForEntry } from '../../../shared/runtime-host-contact'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { getCurrentDirectSshAuthority } from '../store/slices/worktrees/listing/direct-ssh-authority'
import { getRemoteRuntimePtyOwner } from './runtime-terminal-stream'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
export type BindingView = {
  tokensByTerminal: Map<string, Set<string>>
  terminalsByRoute: Map<string, Set<string>>
}
let catalog:
  | {
      rows: AppState['runtimeEnvironments']
      byId: Map<string, AppState['runtimeEnvironments'][number]>
    }
  | undefined
export function catalogFor(rows: AppState['runtimeEnvironments']) {
  if (catalog?.rows === rows) {
    return catalog.byId
  }
  const byId = new Map<string, AppState['runtimeEnvironments'][number]>()
  for (const row of rows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, row)
    }
  }
  catalog = { rows, byId }
  return byId
}
export function contactIdentity(key: string, state = useAppStore.getState()) {
  if (key === 'local') {
    return { signature: 'local-ipc' }
  }
  if (key.startsWith('ssh:')) {
    const target = key.slice(4)
    const authority = getCurrentDirectSshAuthority(state, `ssh:${target}`)
    const registration = state.sshTargetGenerations.get(target)
    return authority && registration !== undefined
      ? {
          signature: JSON.stringify([
            registration,
            authority.providerEpoch,
            authority.connectionGeneration
          ])
        }
      : null
  }
  const registration = catalogFor(state.runtimeEnvironments).get(key)
  const entry = state.runtimeStatusByEnvironmentId.get(key)
  const contact = runtimeHostContactForEntry(entry)
  if (!registration || contact.verdict !== 'live') {
    return null
  }
  const revision =
    getRuntimeEnvironmentRevision(key) ?? registration.pairingRevision ?? registration.createdAt
  return {
    signature: JSON.stringify([
      registration.createdAt,
      revision,
      contact.status.runtimeId,
      entry?.connectionGeneration
    ]),
    revision,
    runtimeId: contact.status.runtimeId
  }
}
export function terminalContactKey(id: string) {
  const remote = getRemoteRuntimePtyOwner(id)
  const ssh = parseAppSshPtyId(id)
  return remote?.target.environmentId ?? (ssh ? `ssh:${ssh.connectionId}` : 'local')
}
export function readBindings(state: AppState): BindingView {
  const result = new Map<string, Set<string>>()
  const add = (id: string | null | undefined, token: string) => {
    if (!id) {
      return
    }
    const tokens = result.get(id) ?? new Set<string>()
    tokens.add(token)
    result.set(id, tokens)
  }
  for (const [tab, ids] of Object.entries(state.ptyIdsByTabId)) {
    for (const id of ids) {
      add(id, tab)
    }
  }
  for (const [tab, layout] of Object.entries(state.terminalLayoutsByTabId)) {
    for (const [leaf, id] of Object.entries(layout.ptyIdsByLeafId ?? {})) {
      add(id, `${tab}:${leaf}`)
    }
  }
  for (const tabs of Object.values(state.tabsByWorktree)) {
    for (const tab of tabs) {
      add(tab.ptyId, tab.id)
    }
  }
  const terminalsByRoute = new Map<string, Set<string>>()
  for (const id of result.keys()) {
    const key = terminalContactKey(id)
    const group = terminalsByRoute.get(key) ?? new Set<string>()
    group.add(id)
    terminalsByRoute.set(key, group)
  }
  return { tokensByTerminal: result, terminalsByRoute }
}
export function changedKeys<V>(
  previous: ReadonlyMap<string, V>,
  next: ReadonlyMap<string, V>,
  changed: Set<string>,
  prefix = ''
) {
  for (const [key, value] of previous) {
    if (next.get(key) !== value) {
      changed.add(prefix + key)
    }
  }
  for (const [key, value] of next) {
    if (previous.get(key) !== value) {
      changed.add(prefix + key)
    }
  }
}
export function clearDesktopObservationCatalog() {
  catalog = undefined
}
