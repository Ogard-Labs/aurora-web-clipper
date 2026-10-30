export const DEFAULT_API_URL = 'https://api.aurora.ink'

export class AuroraClipperApiError extends Error {
  constructor(message, status, payload) {
    super(message)
    this.name = 'AuroraClipperApiError'
    this.status = status
    this.payload = payload
  }
}

export function normalizeApiUrl(value) {
  const normalized = String(value || DEFAULT_API_URL).trim().replace(/\/+$/, '')
  return normalized || DEFAULT_API_URL
}

export async function signIn({ apiUrl, email, password, fetchImpl = fetch }) {
  try {
    const payload = await requestJson({
      apiUrl,
      path: '/auth/login',
      method: 'POST',
      body: { email, password },
      fetchImpl,
    })
    return { status: 'signed_in', session: normalizeSession(payload) }
  } catch (error) {
    if (error instanceof AuroraClipperApiError && error.status === 401 && error.payload?.mfaId) {
      return {
        status: 'mfa_required',
        challenge: normalizeMfaChallenge(error.payload, email),
      }
    }
    throw error
  }
}

export async function startOAuthSignIn({ apiUrl, provider, extensionRedirectUri, extensionVerifierHash, fetchImpl = fetch }) {
  const query = new URLSearchParams({ intent: 'login', extensionRedirectUri, extensionVerifierHash })
  const payload = await requestJson({
    apiUrl,
    path: `/auth/oauth/${encodeURIComponent(provider)}/start?${query}`,
    method: 'GET',
    fetchImpl,
  })
  if (typeof payload.authUrl !== 'string' || typeof payload.state !== 'string') {
    throw new AuroraClipperApiError('AuroraCloud did not return a sign-in address.', 500, payload)
  }
  return { authUrl: payload.authUrl, state: payload.state }
}

export async function exchangeOAuthCode({ apiUrl, provider, state, code, extensionVerifier, fetchImpl = fetch }) {
  try {
    const payload = await requestJson({
      apiUrl,
      path: `/auth/oauth/${encodeURIComponent(provider)}/exchange`,
      method: 'POST',
      body: { state, code, extensionVerifier },
      fetchImpl,
    })
    return { status: 'signed_in', session: normalizeSession(payload) }
  } catch (error) {
    if (error instanceof AuroraClipperApiError && error.status === 401 && error.payload?.mfaId) {
      return {
        status: 'mfa_required',
        challenge: normalizeMfaChallenge(error.payload, error.payload.email),
      }
    }
    throw error
  }
}

export async function requestOAuthLinkEmail({ apiUrl, linkToken, fetchImpl = fetch }) {
  await requestJson({
    apiUrl,
    path: '/auth/oauth/link/email',
    method: 'POST',
    body: { linkToken },
    fetchImpl,
  })
}

export async function fetchOAuthProviders({ apiUrl, extensionId, fetchImpl = fetch }) {
  const payload = await requestJson({
    apiUrl,
    path: `/auth/oauth/providers?${new URLSearchParams({ extensionId })}`,
    method: 'GET',
    fetchImpl,
  })
  return Array.isArray(payload.items) ? payload.items : []
}

export async function requestEmailCode({ apiUrl, email, mfaId, fetchImpl = fetch }) {
  const payload = await requestJson({
    apiUrl,
    path: '/auth/request-otp',
    method: 'POST',
    body: { email, mfaId, challengeId: mfaId },
    fetchImpl,
  })
  return normalizeMfaChallenge(payload, email)
}

export async function verifyMfa({
  apiUrl,
  mfaId,
  otpId,
  method,
  code,
  fetchImpl = fetch,
}) {
  const payload = await requestJson({
    apiUrl,
    path: '/auth/verify-mfa',
    method: 'POST',
    body: {
      mfaId,
      challengeId: mfaId,
      otpId: otpId || undefined,
      method,
      code,
    },
    fetchImpl,
  })
  return normalizeSession(payload)
}

// Aurora rotates the refresh token on every refresh and treats a second use
// of the old one as theft: after a 60-second grace it signs the user out on
// every device. So concurrent callers share one refresh, a caller still
// holding the old token gets the session that replaced it, and the helpers
// below hand the new session to `onSession` (which saves it) before they do
// anything else that could fail.
const refreshesInFlight = new Map()
const rotatedSessions = new Map()
const ROTATED_SESSION_MEMORY_MS = 10 * 60 * 1000

export function refreshSession({ apiUrl, refreshToken, fetchImpl = fetch, now = Date.now }) {
  const key = `${normalizeApiUrl(apiUrl)} ${refreshToken}`
  const rotated = rotatedSessions.get(key)
  if (rotated && now() - rotated.at < ROTATED_SESSION_MEMORY_MS) return Promise.resolve(rotated.session)
  let pending = refreshesInFlight.get(key)
  if (!pending) {
    pending = requestJson({ apiUrl, path: '/auth/refresh', method: 'POST', body: { refreshToken }, fetchImpl })
      .then((payload) => {
        const session = normalizeSession(payload)
        rotatedSessions.set(key, { session, at: now() })
        return session
      })
      .finally(() => refreshesInFlight.delete(key))
    refreshesInFlight.set(key, pending)
  }
  return pending
}

// Runs `send` with the session; on 401 refreshes once, saves, and retries.
async function withSession({ apiUrl, session, onSession, fetchImpl }, send) {
  try {
    return { value: await send(session), session }
  } catch (error) {
    if (!(error instanceof AuroraClipperApiError) || error.status !== 401 || !session?.refreshToken) throw error
  }
  const refreshedSession = await refreshSession({ apiUrl, refreshToken: session.refreshToken, fetchImpl })
  await onSession(refreshedSession)
  return { value: await send(refreshedSession), session: refreshedSession }
}

const noSessionSink = async () => {}

export async function createRecordWithSession({ apiUrl, session, collection, body, onSession = noSessionSink, fetchImpl = fetch }) {
  const result = await withSession({ apiUrl, session, onSession, fetchImpl }, (current) => postRecord({ apiUrl, session: current, collection, body, fetchImpl }))
  return { record: result.value, session: result.session }
}

// Any signed-in API call: on 401 it refreshes the session once and retries.
export async function requestWithSession({ apiUrl, session, path, method = 'GET', body, form, onSession = noSessionSink, fetchImpl = fetch }) {
  const result = await withSession({ apiUrl, session, onSession, fetchImpl }, (current) => {
    if (!current?.accessToken) throw new AuroraClipperApiError('Sign in to Aurora first.', 401, {})
    return requestJson({ apiUrl, path, method, body, form, token: current.accessToken, fetchImpl })
  })
  return { payload: result.value, session: result.session }
}

export async function listWorkspacesWithSession({ apiUrl, session, onSession = noSessionSink, fetchImpl = fetch }) {
  const result = await withSession({ apiUrl, session, onSession, fetchImpl }, (current) => getWorkspaces({ apiUrl, session: current, fetchImpl }))
  return { workspaces: result.value, session: result.session }
}

async function getWorkspaces({ apiUrl, session, fetchImpl }) {
  if (!session?.accessToken) {
    throw new AuroraClipperApiError('Sign in to Aurora first.', 401, {})
  }
  const payload = await requestJson({ apiUrl, path: '/workspaces', method: 'GET', token: session.accessToken, fetchImpl })
  return (Array.isArray(payload.items) ? payload.items : [])
    .filter((item) => typeof item?.id === 'string' && item.id)
    // e2eeEnabled is null when an older server leaves it out; callers treat that as encrypted.
    .map((item) => ({
      id: item.id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.id,
      e2eeEnabled: typeof item.e2eeEnabled === 'boolean' ? item.e2eeEnabled : null,
    }))
}

async function postRecord({ apiUrl, session, collection, body, fetchImpl }) {
  if (!session?.accessToken) {
    throw new AuroraClipperApiError('Sign in to Aurora before clipping.', 401, {})
  }
  return requestJson({
    apiUrl,
    path: `/api/collections/${encodeURIComponent(collection)}/records`,
    method: 'POST',
    body,
    token: session.accessToken,
    fetchImpl,
  })
}

async function requestJson({ apiUrl, path, method, body, form, token, fetchImpl }) {
  // A FormData body sets its own multipart Content-Type.
  const headers = form ? {} : { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`

  // credentials: 'omit' keeps AuroraCloud's web sign-in cookie out of the
  // browser. Without it, a clipper sign-in or refresh handed the web app the
  // clipper's session; the two then refreshed one token from two places and
  // AuroraCloud signed the user out everywhere for token reuse.
  const response = await fetchImpl(`${normalizeApiUrl(apiUrl)}${path}`, {
    method,
    credentials: 'omit',
    headers,
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new AuroraClipperApiError(
      payload.message || payload.error || `AuroraCloud returned HTTP ${response.status}.`,
      response.status,
      payload,
    )
  }
  return payload
}

function normalizeSession(payload) {
  if (!payload?.accessToken || !payload?.refreshToken) {
    throw new AuroraClipperApiError('AuroraCloud did not return a refreshable session.', 500, payload ?? {})
  }
  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    user: payload.user ?? null,
  }
}

function normalizeMfaChallenge(payload, fallbackEmail) {
  const payloadMethods = Array.isArray(payload.methods)
    ? payload.methods.filter((method) => method === 'totp' || method === 'email_otp')
    : []
  const payloadPreferredMethod = payload.preferredMethod === 'totp' || payload.preferredMethod === 'email_otp'
    ? payload.preferredMethod
    : null
  const methods = payloadMethods.length ? payloadMethods : [payloadPreferredMethod ?? 'email_otp']
  const preferredMethod = payloadPreferredMethod && methods.includes(payloadPreferredMethod)
    ? payloadPreferredMethod
    : methods[0]

  return {
    email: payload.email || fallbackEmail || '',
    mfaId: payload.mfaId,
    otpId: payload.otpId ?? null,
    methods,
    preferredMethod,
  }
}
