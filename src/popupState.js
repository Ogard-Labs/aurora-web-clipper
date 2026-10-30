export function derivePopupState({ session, scopedCredentials, pairing, authorization, busy = false }) {
  if (busy) return { kind: 'busy', encrypted: Boolean(authorization?.captureKey) }
  if (pairing) return { kind: 'approve', encrypted: false }
  if (scopedCredentials?.accessToken && authorization?.captureKey?.publicKey) return { kind: 'ready', encrypted: true }
  if (session?.accessToken && session?.refreshToken) return { kind: 'connect', encrypted: false }
  return { kind: 'connect', encrypted: false }
}

export function encryptedCaptureSuccessMessage() {
  return 'Encrypted clip queued. It will appear after Aurora unlocks this workspace.'
}

export function shouldStopPairingPoll(error, expiresAt, now = Date.now()) {
  if (Date.parse(expiresAt) <= now) return true
  return error?.status === 400 || error?.status === 403
}

export function chooseWorkspaceId(workspaces, savedId) {
  if (workspaces.some((workspace) => workspace.id === savedId)) return savedId
  return workspaces[0]?.id ?? savedId
}

// The web app lives on the API host with `api.` swapped for `app.`.
export function appUrl(apiUrl) {
  const url = new URL(apiUrl)
  if (url.hostname.startsWith('api.')) url.hostname = `app.${url.hostname.slice(4)}`
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function objectUrl(apiUrl, objectId) {
  return new URL(`object/${encodeURIComponent(objectId)}`, appUrl(apiUrl)).toString()
}

export function workspaceOptionLabel(workspace) {
  return workspace.e2eeEnabled === true ? `${workspace.name} · encrypted` : workspace.name
}

// One workspace picker for both paths: the signed-in user's workspaces by
// name, plus workspaces this browser is paired with for encrypted capture.
export function workspaceChoices({ sessionWorkspaces = [], authorizations = {}, typedId = '' }) {
  const choices = sessionWorkspaces.map((workspace) => ({ ...workspace, paired: Boolean(authorizations[workspace.id]?.captureKey) }))
  for (const id of Object.keys(authorizations)) {
    if (!choices.some((choice) => choice.id === id)) choices.push({ id, name: id, e2eeEnabled: true, paired: true })
  }
  if (typedId && !choices.some((choice) => choice.id === typedId)) choices.push({ id: typedId, name: typedId, e2eeEnabled: null, paired: false })
  return choices
}

// Which way a clip into this workspace goes. Mirrors the worker's choice in
// src/background.js: paired means sealed, otherwise quick only when the API
// confirmed the workspace is unencrypted.
export function capturePath({ choice, hasCredentials, signedIn }) {
  if (!choice) return 'none'
  if (choice.paired && hasCredentials) return 'encrypted'
  if (!signedIn) return 'none'
  return choice.e2eeEnabled === false ? 'quick' : 'blocked'
}

export function workspaceHint(path, choice) {
  if (path === 'encrypted') return 'End-to-end encrypted · trusted browser'
  if (path === 'blocked' && choice?.e2eeEnabled === true) return 'Encrypted workspace. Enable encrypted capture below to clip here.'
  if (path === 'blocked') return "Aurora didn't say whether this workspace is encrypted, so quick capture is off."
  return ''
}
