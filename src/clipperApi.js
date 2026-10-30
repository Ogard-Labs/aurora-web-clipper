export class ClipperApiError extends Error {
  constructor(message, status, payload = {}) {
    super(message)
    this.name = 'ClipperApiError'
    this.status = status
    this.payload = payload
  }
}

export function normalizeClipperApiUrl(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '')
  if (!normalized) throw new Error('CLIPPER_API_URL_REQUIRED')
  const url = new URL(normalized)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) throw new Error('CLIPPER_API_ORIGIN_INVALID')
  return normalized
}

export async function requestClipperApiOriginPermission(apiUrl, permissionsApi = globalThis.chrome?.permissions) {
  const normalized = normalizeClipperApiUrl(apiUrl)
  const url = new URL(normalized)
  const origin = `${url.protocol}//${url.host}/*`
  if (origin === 'https://api.aurora.ink/*' || origin === 'https://api.auroradocs.eu/*' || url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true
  if (!permissionsApi?.request) return false
  return permissionsApi.request({ origins: [origin] })
}

export function createClipperApi({ apiUrl, credentials, fetchImpl = fetch, permissionsApi, onCredentials, onAuthorizationStale } = {}) {
  const normalizedApiUrl = normalizeClipperApiUrl(apiUrl)
  let currentCredentials = credentials

  async function request(path, init = {}, token) {
    const headers = new Headers(init.headers)
    headers.set('Content-Type', 'application/json')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const response = await fetchImpl(`${normalizedApiUrl}${path}`, { ...init, credentials: 'omit', headers })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new ClipperApiError(String(payload.message || payload.error || `AuroraCloud returned HTTP ${response.status}.`), response.status, payload)
    return payload
  }

  async function refreshClipperCredential() {
    if (!currentCredentials?.refreshToken) throw new ClipperApiError('Clipper authorization is unavailable.', 401)
    const response = await request('/api/clipper/token/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: currentCredentials.refreshToken }) })
    if (typeof response.accessToken !== 'string' || typeof response.refreshToken !== 'string') throw new ClipperApiError('AuroraCloud returned invalid clipper credentials.', 500, response)
    currentCredentials = { ...currentCredentials, accessToken: response.accessToken, refreshToken: response.refreshToken }
    await onCredentials?.(currentCredentials)
    return currentCredentials
  }

  async function scoped(run) {
    if (!currentCredentials?.accessToken) throw new ClipperApiError('Pair this clipper before capturing.', 401)
    try {
      return await run(currentCredentials.accessToken)
    } catch (error) {
      if (!(error instanceof ClipperApiError)) throw error
      if (error.status === 403) {
        await onAuthorizationStale?.(error)
        throw error
      }
      if (error.status !== 401) throw error
      try {
        const next = await refreshClipperCredential()
        return await run(next.accessToken)
      } catch (retryError) {
        if (retryError instanceof ClipperApiError && (retryError.status === 401 || retryError.status === 403)) await onAuthorizationStale?.(retryError)
        throw retryError
      }
    }
  }

  return {
    async startClipperPairing(input) {
      if (!await requestClipperApiOriginPermission(normalizedApiUrl, permissionsApi)) throw new ClipperApiError('Allow the configured AuroraCloud origin before pairing this clipper.', 403)
      return request('/api/clipper/pairings', { method: 'POST', body: JSON.stringify({ workspaceId: input.workspaceId, deviceId: input.deviceId, deviceLabel: input.deviceLabel, exchangeSecret: input.exchangeSecret }) }, input.sessionToken)
    },
    pollPairingExchange(input) {
      return request(`/api/clipper/pairings/${encodeURIComponent(input.pairingCode)}/exchange`, { method: 'POST', body: JSON.stringify({ exchangeSecret: input.exchangeSecret }) })
    },
    refreshClipperCredential,
    async listClipperAuthorizations() {
      const result = await scoped((token) => request('/api/clipper/authorizations', {}, token))
      return Array.isArray(result.authorizations) ? result.authorizations : []
    },
    submitEncryptedCapture(input) {
      return scoped((token) => request(`/api/clipper/workspaces/${encodeURIComponent(input.workspaceId)}/captures`, {
        method: 'POST',
        body: JSON.stringify({ captureId: input.captureId, generation: input.generation, envelopeVersion: input.envelopeVersion, envelope: { version: input.envelope.version, ephemeralPublicKey: input.envelope.ephemeralPublicKey, ciphertext: input.envelope.ciphertext } }),
      }, token))
    },
    getCredentials: () => currentCredentials,
  }
}
