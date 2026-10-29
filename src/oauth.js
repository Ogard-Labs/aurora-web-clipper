import { exchangeOAuthCode, fetchOAuthProviders, startOAuthSignIn } from './auth.js'

const PROVIDERS = new Set(['apple', 'github', 'google', 'microsoft'])

export class OAuthCancelledError extends Error {
  constructor() {
    super('Sign-in was cancelled.')
    this.name = 'OAuthCancelledError'
  }
}

function base64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

// The verifier never leaves this sign-in. AuroraCloud gets its hash at start
// and the verifier itself only at exchange, so a code read from the provider
// window cannot be turned into a session anywhere else.
export function createVerifier() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function hashVerifier(verifier) {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

export function readRelayResult(responseUrl, expectedState) {
  const fragment = new URLSearchParams(new URL(responseUrl).hash.slice(1))
  if (fragment.get('state') !== expectedState) {
    throw new Error('The sign-in answer did not match this sign-in. Try again.')
  }
  const error = fragment.get('error')
  if (error === 'access_denied') throw new OAuthCancelledError()
  if (error) throw new Error(fragment.get('error_description') || `Sign-in failed (${error}).`)
  const code = fragment.get('code')
  if (!code) throw new Error('The provider returned no sign-in code. Try again.')
  return { code }
}

export async function runOAuthSignIn({ apiUrl, provider, identity, fetchImpl = fetch }) {
  if (!PROVIDERS.has(provider)) throw new Error(`Sign-in with ${provider} is not supported.`)
  const verifier = createVerifier()
  const { authUrl, state } = await startOAuthSignIn({
    apiUrl,
    provider,
    extensionRedirectUri: identity.getRedirectURL(`auth/oauth/${provider}/callback`),
    extensionVerifierHash: await hashVerifier(verifier),
    fetchImpl,
  })
  let responseUrl
  try {
    responseUrl = await identity.launchWebAuthFlow({ url: authUrl, interactive: true })
  } catch {
    // Chrome rejects with "The user did not approve access." when the window
    // is closed, and gives no code to tell that apart from other failures.
    throw new OAuthCancelledError()
  }
  if (!responseUrl) throw new OAuthCancelledError()
  const { code } = readRelayResult(responseUrl, state)
  return exchangeOAuthCode({ apiUrl, provider, state, code, extensionVerifier: verifier, fetchImpl })
}

export async function listOAuthProviders({ apiUrl, extensionId, fetchImpl = fetch }) {
  const items = await fetchOAuthProviders({ apiUrl, extensionId, fetchImpl })
  return items
    .filter((item) => PROVIDERS.has(item?.id) && item.configured && item.extensionConfigured === true)
    .map((item) => ({ id: item.id, name: item.name }))
}
