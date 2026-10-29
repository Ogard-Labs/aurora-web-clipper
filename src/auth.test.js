import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AuroraClipperApiError,
  createRecordWithSession,
  listWorkspacesWithSession,
  normalizeApiUrl,
  requestEmailCode,
  signIn,
  verifyMfa,
} from './auth.js'

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    },
  }
}

function createFetchStub(handlers) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    const call = { url, init, body }
    calls.push(call)
    const handler = handlers.shift()
    if (!handler) throw new Error(`Unexpected fetch call to ${url}`)
    return handler(call)
  }
  return { fetchImpl, calls }
}

test('normalizeApiUrl defaults to the Aurora API', () => {
  assert.equal(normalizeApiUrl(''), 'https://api.aurora.ink')
})

test('normalizeApiUrl trims whitespace and trailing slashes', () => {
  assert.equal(normalizeApiUrl(' https://api.auroradocs.eu/// '), 'https://api.auroradocs.eu')
})

test('signIn returns a refreshable AuroraCloud session', async () => {
  const { fetchImpl, calls } = createFetchStub([
    (call) => {
      assert.equal(call.url, 'https://api.auroradocs.eu/auth/login')
      assert.deepEqual(call.body, { email: 'henrik@example.com', password: 'password123' })
      return jsonResponse(200, {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: { id: 'user_1', email: 'henrik@example.com' },
      })
    },
  ])

  const result = await signIn({
    apiUrl: 'https://api.auroradocs.eu/',
    email: 'henrik@example.com',
    password: 'password123',
    fetchImpl,
  })

  assert.equal(result.status, 'signed_in')
  assert.deepEqual(result.session, {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    user: { id: 'user_1', email: 'henrik@example.com' },
  })
  assert.equal(calls.length, 1)
})

test('signIn returns MFA challenge details without treating it as a bad password', async () => {
  const { fetchImpl } = createFetchStub([
    () => jsonResponse(401, {
      error: 'Multi-factor authentication required.',
      email: 'henrik@example.com',
      mfaId: 'mfa_1',
      otpId: null,
      methods: ['totp', 'email_otp'],
      preferredMethod: 'totp',
    }),
  ])

  const result = await signIn({
    apiUrl: 'https://api.auroradocs.eu',
    email: 'henrik@example.com',
    password: 'password123',
    fetchImpl,
  })

  assert.equal(result.status, 'mfa_required')
  assert.deepEqual(result.challenge, {
    email: 'henrik@example.com',
    mfaId: 'mfa_1',
    otpId: null,
    methods: ['totp', 'email_otp'],
    preferredMethod: 'totp',
  })
})

test('requestEmailCode asks AuroraCloud to attach an email OTP to the MFA challenge', async () => {
  const { fetchImpl, calls } = createFetchStub([
    () => jsonResponse(200, {
      mfaId: 'mfa_1',
      otpId: 'otp_1',
      methods: ['totp', 'email_otp'],
      preferredMethod: 'email_otp',
    }),
  ])

  const challenge = await requestEmailCode({
    apiUrl: 'https://api.auroradocs.eu',
    email: 'henrik@example.com',
    mfaId: 'mfa_1',
    fetchImpl,
  })

  assert.equal(calls[0].url, 'https://api.auroradocs.eu/auth/request-otp')
  assert.deepEqual(calls[0].body, {
    email: 'henrik@example.com',
    mfaId: 'mfa_1',
    challengeId: 'mfa_1',
  })
  assert.equal(challenge.otpId, 'otp_1')
  assert.equal(challenge.preferredMethod, 'email_otp')
})

test('signIn normalizes MFA payloads that omit available methods', async () => {
  const { fetchImpl } = createFetchStub([
    () => jsonResponse(401, {
      error: 'Multi-factor authentication required.',
      email: 'henrik@example.com',
      mfaId: 'mfa_1',
      preferredMethod: 'email_otp',
    }),
  ])

  const result = await signIn({
    apiUrl: 'https://api.auroradocs.eu',
    email: 'henrik@example.com',
    password: 'password123',
    fetchImpl,
  })

  assert.equal(result.status, 'mfa_required')
  assert.deepEqual(result.challenge.methods, ['email_otp'])
  assert.equal(result.challenge.preferredMethod, 'email_otp')
})

test('verifyMfa exchanges the challenge for a refreshable session', async () => {
  const { fetchImpl, calls } = createFetchStub([
    () => jsonResponse(200, {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      user: { id: 'user_1', email: 'henrik@example.com' },
    }),
  ])

  const session = await verifyMfa({
    apiUrl: 'https://api.auroradocs.eu',
    mfaId: 'mfa_1',
    otpId: 'otp_1',
    method: 'email_otp',
    code: '123456',
    fetchImpl,
  })

  assert.equal(calls[0].url, 'https://api.auroradocs.eu/auth/verify-mfa')
  assert.deepEqual(calls[0].body, {
    mfaId: 'mfa_1',
    challengeId: 'mfa_1',
    otpId: 'otp_1',
    method: 'email_otp',
    code: '123456',
  })
  assert.equal(session.accessToken, 'access-token')
  assert.equal(session.refreshToken, 'refresh-token')
})

test('createRecordWithSession refreshes an expired access token once before retrying', async () => {
  const initialSession = {
    accessToken: 'expired-access',
    refreshToken: 'refresh-token',
    user: { id: 'user_1', email: 'henrik@example.com' },
  }
  const { fetchImpl, calls } = createFetchStub([
    () => jsonResponse(401, { error: 'Invalid or expired token.' }),
    () => jsonResponse(200, {
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      user: { id: 'user_1', email: 'henrik@example.com' },
    }),
    () => jsonResponse(200, { id: 'object_1', title: 'Saved' }),
  ])

  const result = await createRecordWithSession({
    apiUrl: 'https://api.auroradocs.eu',
    session: initialSession,
    collection: 'objects',
    body: { title: 'Saved' },
    fetchImpl,
  })

  assert.equal(calls[0].init.headers.Authorization, 'Bearer expired-access')
  assert.equal(calls[1].url, 'https://api.auroradocs.eu/auth/refresh')
  assert.deepEqual(calls[1].body, { refreshToken: 'refresh-token' })
  assert.equal(calls[2].init.headers.Authorization, 'Bearer fresh-access')
  assert.deepEqual(result.record, { id: 'object_1', title: 'Saved' })
  assert.equal(result.session.accessToken, 'fresh-access')
})

test('API errors expose status and server message', async () => {
  const { fetchImpl } = createFetchStub([
    () => jsonResponse(403, { error: 'Workspace access denied.' }),
  ])

  await assert.rejects(
    () => createRecordWithSession({
      apiUrl: 'https://api.auroradocs.eu',
      session: { accessToken: 'access-token', refreshToken: 'refresh-token', user: null },
      collection: 'objects',
      body: { title: 'Blocked' },
      fetchImpl,
    }),
    (error) => error instanceof AuroraClipperApiError
      && error.status === 403
      && error.message === 'Workspace access denied.',
  )
})

test('listWorkspacesWithSession lists the workspaces the signed-in user can use, in API order', async () => {
  const session = { accessToken: 'access', refreshToken: 'refresh', user: null }
  const { fetchImpl, calls } = createFetchStub([
    () => jsonResponse(200, {
      items: [
        { id: 'ws_recent', name: 'Hei', slug: 'hei', settingsJson: {} },
        { id: 'ws_old', name: '', slug: 'old' },
        { name: 'no id' },
      ],
    }),
  ])

  const result = await listWorkspacesWithSession({ apiUrl: 'https://api.aurora.ink', session, fetchImpl })

  assert.equal(calls[0].url, 'https://api.aurora.ink/workspaces')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer access')
  assert.deepEqual(result, {
    workspaces: [
      { id: 'ws_recent', name: 'Hei' },
      { id: 'ws_old', name: 'ws_old' },
    ],
    session,
  })
})

test('listWorkspacesWithSession refreshes an expired access token once and returns the new session', async () => {
  const { fetchImpl, calls } = createFetchStub([
    () => jsonResponse(401, { error: 'Invalid or expired token.' }),
    () => jsonResponse(200, { accessToken: 'fresh-access', refreshToken: 'fresh-refresh', user: null }),
    () => jsonResponse(200, { items: [{ id: 'ws_1', name: 'Work' }] }),
  ])

  const result = await listWorkspacesWithSession({
    apiUrl: 'https://api.aurora.ink',
    session: { accessToken: 'expired', refreshToken: 'refresh', user: null },
    fetchImpl,
  })

  assert.equal(calls[1].url, 'https://api.aurora.ink/auth/refresh')
  assert.equal(calls[2].init.headers.Authorization, 'Bearer fresh-access')
  assert.deepEqual(result.workspaces, [{ id: 'ws_1', name: 'Work' }])
  assert.equal(result.session.accessToken, 'fresh-access')
})
