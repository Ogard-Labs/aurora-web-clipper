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
