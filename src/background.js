import { DEFAULT_API_URL, listWorkspacesWithSession, normalizeApiUrl } from './auth.js'
import { CaptureBlockedError, NO_ARTICLE_NOTICE, RASTER_TYPES, checkWorkspace, cropImage, cropOverlay, encryptedCapture, findExistingClip, imageBox, normalizeUrl, quickCapture, readArticle, readPage, retryPreparedCapture } from './capture.js'
import { CLIP_PAGE_COMMAND, MENU_ITEMS, SUCCESS_BADGE_MS, badgeFor, requestFromMenu } from './menus.js'
import { OAuthCancelledError, runOAuthSignIn } from './oauth.js'

// Every capture, from the popup, the right-click menu or the shortcut, runs
// through clip() below and reports with report().

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const item of MENU_ITEMS) chrome.contextMenus.create(item)
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const request = requestFromMenu(info, tab)
  if (request) void runAndReport(request)
})

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === CLIP_PAGE_COMMAND && typeof tab?.id === 'number') void runAndReport({ mode: 'page', tabId: tab.id, windowId: tab.windowId })
})

function errorResponse(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error), code: error?.code ?? null, status: error?.status ?? null }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab found.')
  return tab
}

function target(tabId, frameId) {
  return frameId ? { tabId, frameIds: [frameId] } : { tabId }
}

async function readTab(tabId, frameId, options = {}) {
  const [result] = await chrome.scripting.executeScript({ target: target(tabId, frameId), func: readPage, args: [options] })
  return result?.result
}

async function readTabArticle(tabId, frameId) {
  await chrome.scripting.executeScript({ target: target(tabId, frameId), files: ['src/vendor/Readability.js'] })
  const [result] = await chrome.scripting.executeScript({ target: target(tabId, frameId), func: readArticle })
  return result?.result ?? null
}

async function screenshotBlob(windowId) {
  return (await fetch(await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }))).blob()
}

// Clip image: the original file when the worker may fetch it, else the
// image's visible box from a screenshot of the tab.
async function grabImage({ tabId, frameId, windowId, srcUrl }) {
  try {
    const response = await fetch(srcUrl, { credentials: 'omit' })
    if (response.ok) {
      const blob = await response.blob()
      if (RASTER_TYPES.has(blob.type)) return blob
    }
  } catch { /* fall back to the visible box */ }
  const [result] = await chrome.scripting.executeScript({ target: target(tabId, frameId), func: imageBox, args: [srcUrl] })
  const found = result?.result
  if (!found) throw new Error("Couldn't find that image on the page.")
  return cropImage(await screenshotBlob(windowId), found.box, found.devicePixelRatio)
}

async function loadContext() {
  const { apiUrl, workspaceId } = await chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL, workspaceId: '' })
  const local = await chrome.storage.local.get({ session: null, clipperCredentials: null, clipperAuthorizations: {} })
  const credentials = local.clipperCredentials?.accessToken?.startsWith('aur_clip_a_') ? local.clipperCredentials : null
  const authorization = local.clipperAuthorizations?.[workspaceId]
  return {
    apiUrl: normalizeApiUrl(apiUrl),
    workspaceId,
    session: local.session?.accessToken ? local.session : null,
    credentials,
    authorization: credentials && authorization?.captureKey ? authorization : null,
  }
}

const saveSession = (session) => chrome.storage.local.set({ session })
const indexKey = (workspaceId) => `clipIndex:${workspaceId}`

async function rememberClip(workspaceId, url, objectId) {
  const key = indexKey(workspaceId)
  const { [key]: index } = await chrome.storage.session.get({ [key]: null })
  if (index) await chrome.storage.session.set({ [key]: { ...index, urls: { ...index.urls, [normalizeUrl(url)]: objectId } } })
}

async function save(context, request, page, image = null) {
  const { mode } = request
  if (context.authorization) {
    const result = await encryptedCapture({ storage: chrome.storage.local, apiUrl: context.apiUrl, credentials: context.credentials, authorization: context.authorization, workspaceId: context.workspaceId, mode, page, note: request.note, tags: request.tags })
    return { objectId: result.objectId, path: 'encrypted', notice: result.notice }
  }
  const result = await quickCapture({ apiUrl: context.apiUrl, session: context.session, workspaceId: context.workspaceId, mode, page, note: request.note, tags: request.tags, image, onSession: saveSession })
  await rememberClip(context.workspaceId, page.url, result.objectId)
  return { objectId: result.objectId, path: 'quick' }
}

async function clip(request) {
  const context = await loadContext()
  if (!context.workspaceId) throw new Error('Choose a workspace in the clipper first.')
  if (!context.authorization && !context.session) throw new Error(context.credentials ? 'Clipper authorization is stale. Pair this browser again in Aurora.' : 'Sign in to the clipper first.')
  const tab = typeof request.tabId === 'number' ? await chrome.tabs.get(request.tabId) : await activeTab()
  const frameId = request.frameId ?? 0
  const imageMode = request.mode === 'screenshot' || request.mode === 'image'
  if (imageMode && context.authorization) throw new CaptureBlockedError("Screenshots aren't available for encrypted workspaces yet.", 'IMAGE_ENCRYPTED')

  if (request.mode === 'screenshot') {
    // Check before the user drags, then wait for the overlay's message.
    await checkWorkspace({ apiUrl: context.apiUrl, session: context.session, workspaceId: context.workspaceId, onSession: saveSession })
    await chrome.storage.session.set({ cropJob: { note: request.note ?? '', tags: request.tags ?? [], tabId: tab.id, windowId: tab.windowId, workspaceId: context.workspaceId, at: Date.now() } })
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: cropOverlay })
    return { pending: true }
  }

  let page = await readTab(tab.id, frameId, { linkUrl: request.linkUrl })
  let mode = request.mode
  let notice = null
  if (mode === 'link') {
    if (!request.linkUrl) throw new Error('No link to clip.')
    page = { ...page, title: page.linkText || request.linkUrl, url: request.linkUrl, description: `Linked from ${page.title}`, selection: '', selectionNodes: [] }
  }
  if (mode === 'selection' && !page.selection?.trim()) {
    if (!request.selectionText?.trim()) throw new Error('Select text on the page before using Clip selection.')
    page = { ...page, selection: request.selectionText, selectionNodes: [] }
  }
  if (mode === 'article') {
    const article = await readTabArticle(tab.id, frameId)
    if (article) page = { ...page, article }
    else { mode = 'page'; notice = NO_ARTICLE_NOTICE }
  }
  const image = mode === 'image' ? await grabImage({ tabId: tab.id, frameId, windowId: tab.windowId, srcUrl: request.srcUrl }) : null
  const result = await save(context, { ...request, mode }, page, image)
  return { ...result, notice: result.notice ?? notice, tabId: tab.id }
}

async function finishCrop(message, sender) {
  const { cropJob } = await chrome.storage.session.get({ cropJob: null })
  if (!cropJob || sender.tab?.id !== cropJob.tabId) return
  await chrome.storage.session.remove('cropJob')
  if (message.type === 'AURORA_CROP_CANCELLED') return
  try {
    const context = await loadContext()
    if (context.workspaceId !== cropJob.workspaceId) throw new Error('The workspace changed during the screenshot. Try again.')
    if (context.authorization || !context.session) throw new CaptureBlockedError("Screenshots aren't available for encrypted workspaces yet.", 'IMAGE_ENCRYPTED')
    const image = await cropImage(await screenshotBlob(cropJob.windowId), message.box, message.devicePixelRatio)
    const page = await readTab(cropJob.tabId, 0)
    const result = await save(context, { mode: 'screenshot', note: cropJob.note, tags: cropJob.tags }, page, image)
    await report({ ok: true, ...result }, cropJob.tabId)
  } catch (error) {
    await report(errorResponse(error), cropJob.tabId)
  }
}

async function report(result, tabId) {
  const { apiUrl } = await chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL })
  const message = result.ok ? (result.path === 'encrypted' ? 'Encrypted clip queued. It will appear after Aurora unlocks this workspace.' : 'Saved to Aurora Inbox.') : result.error
  await chrome.storage.session.set({ lastCapture: { ok: result.ok, message, notice: result.notice ?? null, objectId: result.objectId ?? null, apiUrl: normalizeApiUrl(apiUrl), at: Date.now() } })
  if (typeof tabId !== 'number') return
  const badge = badgeFor(result)
  await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color })
  await chrome.action.setBadgeText({ tabId, text: badge.text })
  if (result.ok) setTimeout(() => { void chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}) }, SUCCESS_BADGE_MS)
}

async function runAndReport(request) {
  let response
  try {
    response = { ok: true, ...(await clip(request)) }
  } catch (error) {
    response = errorResponse(error)
  }
  if (!response.pending) await report(response, response.tabId ?? request.tabId).catch(() => {})
  return response
}

// The popup lists workspaces through here, so only the worker ever refreshes
// the session (see refreshSession in src/auth.js).
async function listWorkspaces() {
  const context = await loadContext()
  if (!context.session) return { workspaces: [] }
  const { workspaces } = await listWorkspacesWithSession({ apiUrl: context.apiUrl, session: context.session, onSession: saveSession })
  return { workspaces }
}

async function findClip(url) {
  const context = await loadContext()
  if (!context.session || context.authorization || !context.workspaceId || !url) return { objectId: null }
  const key = indexKey(context.workspaceId)
  const { [key]: index } = await chrome.storage.session.get({ [key]: null })
  const result = await findExistingClip({ apiUrl: context.apiUrl, session: context.session, workspaceId: context.workspaceId, url, index, onSession: saveSession })
  if (result.index && result.index !== index) await chrome.storage.session.set({ [key]: result.index })
  return { objectId: result.objectId, apiUrl: context.apiUrl }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false
  if (message?.type === 'AURORA_CROP_DONE' || message?.type === 'AURORA_CROP_CANCELLED') {
    void finishCrop(message, sender)
    return false
  }
  if (message?.type === 'AURORA_CAPTURE_ACTIVE_TAB') {
    activeTab().then((tab) => readTab(tab.id, 0)).then((page) => sendResponse({ ok: true, page }), (error) => sendResponse(errorResponse(error)))
    return true
  }
  if (message?.type === 'AURORA_CLIP') {
    runAndReport({ mode: message.mode, note: message.note ?? '', tags: message.tags ?? [], tabId: message.tabId }).then(sendResponse)
    return true
  }
  if (message?.type === 'AURORA_LIST_WORKSPACES') {
    listWorkspaces().then((result) => sendResponse({ ok: true, ...result }), (error) => sendResponse(errorResponse(error)))
    return true
  }
  if (message?.type === 'AURORA_FIND_CLIP') {
    findClip(message.url).then((result) => sendResponse({ ok: true, ...result }), (error) => sendResponse(errorResponse(error)))
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
