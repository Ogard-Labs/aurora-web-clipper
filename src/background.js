import { DEFAULT_API_URL, normalizeApiUrl } from './auth.js'
import { encryptedCapture, quickCapture, readPage, retryPreparedCapture } from './capture.js'
import { OAuthCancelledError, runOAuthSignIn } from './oauth.js'

async function readActivePage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab found.')
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage })
  return result?.result
}

function errorResponse(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error), code: error?.code ?? null, status: error?.status ?? null }
}

async function clipActiveTab(mode) {
  const { apiUrl, workspaceId } = await chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL, workspaceId: '' })
  if (!workspaceId) throw new Error('Workspace ID is required.')
  const local = await chrome.storage.local.get({ session: null, clipperCredentials: null, clipperAuthorizations: {} })
  const page = await readActivePage()
  if (mode === 'selection' && !page.selection?.trim()) throw new Error('Select text on the page before using Clip selection.')
  const credentials = local.clipperCredentials?.accessToken?.startsWith('aur_clip_a_') ? local.clipperCredentials : null
  const authorization = local.clipperAuthorizations?.[workspaceId]
  if (credentials && authorization?.captureKey) {
    const result = await encryptedCapture({ storage: chrome.storage.local, apiUrl: normalizeApiUrl(apiUrl), credentials, authorization, workspaceId, mode, page })
    return { objectId: result.objectId, path: 'encrypted' }
  }
  if (!local.session) throw new Error(credentials ? 'Clipper authorization is stale. Pair this browser again in Aurora.' : 'Sign in or pair this clipper before capturing.')
  const result = await quickCapture({ apiUrl: normalizeApiUrl(apiUrl), session: local.session, workspaceId, mode, page, onSession: (session) => chrome.storage.local.set({ session }) })
  return { objectId: result.objectId, path: 'quick' }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'AURORA_CAPTURE_ACTIVE_TAB') {
    readActivePage().then((page) => sendResponse({ ok: true, page }), (error) => sendResponse(errorResponse(error)))
    return true
  }
  if (message?.type === 'AURORA_CLIP') {
    clipActiveTab(message.mode).then((result) => sendResponse({ ok: true, ...result }), (error) => sendResponse(errorResponse(error)))
    return true
  }
  if (message?.type === 'AURORA_RETRY_CAPTURE') {
    chrome.storage.local.get({ clipperCredentials: null })
      .then(({ clipperCredentials }) => retryPreparedCapture({ storage: chrome.storage.local, credentials: clipperCredentials }))
      .then((result) => sendResponse({ ok: true, captureId: result?.captureId ?? null }), (error) => sendResponse(errorResponse(error)))
    return true
  }
  return false
})

let oauthSignInRunning = false

// The sign-in runs here, not in the popup: Chrome closes the popup as soon as
// the provider window takes focus. The popup reads the stored session when it
// opens again.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'AURORA_OAUTH_SIGN_IN') return false
  if (oauthSignInRunning) {
    sendResponse({ ok: false, error: 'A sign-in window is already open.' })
    return false
  }

  oauthSignInRunning = true
  runOAuthSignIn({ apiUrl: message.apiUrl, provider: message.provider, identity: chrome.identity })
    .then(async (result) => {
      if (result.status === 'mfa_required') {
        // Session storage is memory-only and cleared when the browser closes.
        await chrome.storage.session.set({ pendingMfa: result.challenge })
        sendResponse({ ok: false, mfa: true })
        return
      }
      if (result.status === 'handoff') {
        sendResponse({ ok: false, handoff: result })
        return
      }
      await chrome.storage.local.set({ session: result.session })
      sendResponse({ ok: true })
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        cancelled: error instanceof OAuthCancelledError,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => {
      oauthSignInRunning = false
    })

  return true
})
