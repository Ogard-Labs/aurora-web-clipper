import { OAuthCancelledError, runOAuthSignIn } from './oauth.js'

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'AURORA_CAPTURE_ACTIVE_TAB') return false

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0]
    if (!tab?.id) {
      sendResponse({ ok: false, error: 'No active tab found.' })
      return
    }

    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const selection = window.getSelection()
          const selectionText = selection?.toString() ?? ''
          let selectionHtml = ''
          if (selection && selection.rangeCount > 0 && selectionText.trim()) {
            const fragment = document.createElement('div')
            for (let index = 0; index < selection.rangeCount; index += 1) {
              fragment.append(selection.getRangeAt(index).cloneContents())
            }
            selectionHtml = fragment.innerHTML
          }
          const description =
            document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
            document.querySelector('meta[name="description"]')?.getAttribute('content') ||
            ''
          return {
            title: document.title || location.hostname,
            url: location.href,
            selection: selectionText,
            selectionHtml,
            description,
          }
        },
      })
      sendResponse({ ok: true, page: result?.result })
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  return true
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
