import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  OAuthCancelledError,
  createVerifier,
  hashVerifier,
  listOAuthProviders,
  readRelayResult,
  requestOAuthLinkEmail,
  runOAuthSignIn,
} from './oauth.js'

const EXTENSION_ID = 'aknfkfnafcppbgknjbibgpcgfhlpgcme'
const REDIRECT = `https://${EXTENSION_ID}.chromiumapp.org/auth/oauth/google/callback`

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

function fakeIdentity(responseUrl) {
  const calls = []
  return {
    calls,
    getRedirectURL: (path) => `https://${EXTENSION_ID}.chromiumapp.org/${path}`,
    launchWebAuthFlow: async (details) => {
      calls.push(details)
      if (responseUrl instanceof Error) throw responseUrl
      return typeof responseUrl === 'function' ? responseUrl(details) : responseUrl
    },
  }
}

test('the verifier is 32 random bytes in base64url and its hash is the SHA-256 the API checks', async () => {
  const verifier = createVerifier()
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(createVerifier(), verifier)
  assert.equal(await hashVerifier(verifier), createHash('sha256').update(verifier).digest('base64url'))
})

test('the relay result gives the code only for the state this sign-in started', () => {
  assert.deepEqual(readRelayResult(`${REDIRECT}#state=s1&code=c1`, 's1'), { code: 'c1' })
  assert.throws(() => readRelayResult(`${REDIRECT}#state=other&code=c1`, 's1'), /did not match/i)
  assert.throws(() => readRelayResult(`${REDIRECT}#state=s1`, 's1'), /no sign-in code/i)
  assert.throws(() => readRelayResult(`${REDIRECT}#state=s1&error=access_denied`, 's1'), OAuthCancelledError)
  assert.throws(
    () => readRelayResult(`${REDIRECT}#state=s1&error=server_error&error_description=Provider%20down`, 's1'),
    /Provider down/,
  )
})

test('provider sign-in starts with the extension redirect, opens the provider, and exchanges with the verifier', async () => {
  const requests = []
  let verifierHash = ''
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init })
    if (url.includes('/auth/oauth/google/start?')) {
      const query = new URL(url).searchParams
      verifierHash = query.get('extensionVerifierHash')
      assert.equal(query.get('intent'), 'login')
      assert.equal(query.get('extensionRedirectUri'), REDIRECT)
      return jsonResponse(200, { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', state: 'state-1' })
    }
    if (url.endsWith('/auth/oauth/google/exchange')) {
      const body = JSON.parse(init.body)
      assert.equal(body.state, 'state-1')
      assert.equal(body.code, 'code-1')
      assert.equal(createHash('sha256').update(body.extensionVerifier).digest('base64url'), verifierHash)
      return jsonResponse(200, { accessToken: 'access', refreshToken: 'refresh', user: { email: 'ada@example.com' } })
    }
    throw new Error(`unexpected request ${url}`)
  }
  const identity = fakeIdentity(`${REDIRECT}#state=state-1&code=code-1`)

  const result = await runOAuthSignIn({ apiUrl: 'https://api.aurora.ink', provider: 'google', identity, fetchImpl })

  assert.deepEqual(result, {
    status: 'signed_in',
    session: { accessToken: 'access', refreshToken: 'refresh', user: { email: 'ada@example.com' } },
  })
  assert.deepEqual(identity.calls, [{ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', interactive: true }])
  assert.equal(requests.length, 2)
})

test('provider sign-in reports an Aurora code step the same way password sign-in does', async () => {
  const fetchImpl = async (url) => url.includes('/start?')
    ? jsonResponse(200, { authUrl: 'https://github.com/login/oauth/authorize', state: 's' })
    : jsonResponse(401, { error: 'Multi-factor authentication required.', email: 'ada@example.com', mfaId: 'mfa-1', methods: ['totp'], preferredMethod: 'totp' })
  const result = await runOAuthSignIn({
    apiUrl: 'https://api.aurora.ink',
    provider: 'github',
    identity: fakeIdentity(`https://${EXTENSION_ID}.chromiumapp.org/auth/oauth/github/callback#state=s&code=c`),
    fetchImpl,
  })
  assert.equal(result.status, 'mfa_required')
  assert.equal(result.challenge.mfaId, 'mfa-1')
  assert.equal(result.challenge.email, 'ada@example.com')
})

test('closing the provider window is a cancellation, not an error', async () => {
  const fetchImpl = async () => jsonResponse(200, { authUrl: 'https://accounts.google.com/', state: 's' })
  await assert.rejects(
    () => runOAuthSignIn({
      apiUrl: 'https://api.aurora.ink',
      provider: 'google',
      identity: fakeIdentity(new Error('The user did not approve access.')),
      fetchImpl,
    }),
    OAuthCancelledError,
  )
})

test('an unknown provider never reaches the API', async () => {
  await assert.rejects(
    () => runOAuthSignIn({ apiUrl: 'https://api.aurora.ink', provider: 'linear', identity: fakeIdentity(''), fetchImpl: async () => { throw new Error('no request expected') } }),
    /not supported/i,
  )
})

test('the provider list keeps only providers this extension may use', async () => {
  let requested = ''
  const fetchImpl = async (url) => {
    requested = url
    return jsonResponse(200, {
      items: [
        { id: 'apple', name: 'Apple', configured: false, extensionConfigured: false },
        { id: 'google', name: 'Google', configured: true, extensionConfigured: true },
        { id: 'github', name: 'GitHub', configured: true },
      ],
    })
  }
  const providers = await listOAuthProviders({ apiUrl: 'https://api.aurora.ink/', extensionId: EXTENSION_ID, fetchImpl })
  assert.equal(requested, `https://api.aurora.ink/auth/oauth/providers?extensionId=${EXTENSION_ID}`)
  assert.deepEqual(providers, [{ id: 'google', name: 'Google' }])
})

async function signInWithExchangeAnswer(status, payload) {
  const fetchImpl = async (url) => url.includes('/start?')
    ? jsonResponse(200, { authUrl: 'https://login.microsoftonline.com/', state: 's' })
    : jsonResponse(status, payload)
  return runOAuthSignIn({
    apiUrl: 'https://api.aurora.ink',
    provider: 'microsoft',
    identity: fakeIdentity(`https://${EXTENSION_ID}.chromiumapp.org/auth/oauth/microsoft/callback#state=s&code=c`),
    fetchImpl,
  })
}

test('no Aurora account for the provider email is handed to Aurora', async () => {
  const result = await signInWithExchangeAnswer(400, { error: 'No Aurora account exists for this verified OAuth email yet.' })
  assert.deepEqual(result, { status: 'handoff', kind: 'no_account', provider: 'microsoft' })
})

test('an unlinked provider account comes back with the link token to email a link', async () => {
  const result = await signInWithExchangeAnswer(409, {
    error: 'Confirm this sign-in method.',
    code: 'oauth_link_confirmation_required',
    email: 'ada@example.com',
    provider: 'microsoft',
    linkToken: 'link-token-1',
  })
  assert.deepEqual(result, { status: 'handoff', kind: 'link', provider: 'microsoft', email: 'ada@example.com', linkToken: 'link-token-1' })
})

test('an unverified Aurora email is handed to Aurora with the address', async () => {
  const result = await signInWithExchangeAnswer(403, { error: 'Verify your email.', code: 'email_verification_required', email: 'ada@example.com' })
  assert.deepEqual(result, { status: 'handoff', kind: 'verify_email', provider: 'microsoft', email: 'ada@example.com' })
})

test('other refusals keep the server message', async () => {
  await assert.rejects(() => signInWithExchangeAnswer(403, { error: 'This account has been disabled.' }), /disabled/)
})

test('the provider list keeps the API order for all four providers', async () => {
  const fetchImpl = async () => jsonResponse(200, {
    items: ['apple', 'github', 'google', 'microsoft'].map((id) => ({ id, name: id.toUpperCase(), configured: true, extensionConfigured: true })),
  })
  const providers = await listOAuthProviders({ apiUrl: 'https://api.aurora.ink', extensionId: EXTENSION_ID, fetchImpl })
  assert.deepEqual(providers.map((provider) => provider.id), ['apple', 'github', 'google', 'microsoft'])
})

test('the link email is requested with the link token', async () => {
  let call = null
  const fetchImpl = async (url, init) => {
    call = { url, body: JSON.parse(init.body), method: init.method }
    return { ok: true, status: 204, json: async () => { throw new SyntaxError('no body') } }
  }
  await requestOAuthLinkEmail({ apiUrl: 'https://api.aurora.ink', linkToken: 'link-token-1', fetchImpl })
  assert.deepEqual(call, { url: 'https://api.aurora.ink/auth/oauth/link/email', body: { linkToken: 'link-token-1' }, method: 'POST' })
})
