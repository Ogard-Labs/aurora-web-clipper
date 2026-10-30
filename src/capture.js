import { createRecordWithSession, listWorkspacesWithSession, requestWithSession } from './auth.js'
import { createClipperApi } from './clipperApi.js'
import { createClipperState } from './clipperState.js'
import { sealCapturePayload } from './captureEnvelope.js'
import { htmlNodesToBlocks } from './tiptapHtml.js'

// The capture service runs in the background worker, so the popup, the
// right-click menu and the shortcut all save clips the same way.

export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 40
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024
export const RASTER_TYPES = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif']])
export const TAGS_NOT_SEALED_NOTICE = "Tags were left out: encrypted clips can't carry tags yet."
export const NO_ARTICLE_NOTICE = "Couldn't find the article text, so the link was saved."
const IMAGE_MODES = new Set(['screenshot', 'image'])

export class CaptureBlockedError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'CaptureBlockedError'
    this.code = code
  }
}

export function objectTypeFor(mode) {
  return mode === 'page' || mode === 'link' ? 'bookmark' : 'page'
}

export function parseTags(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',')
  const tags = []
  for (const item of raw) {
    const tag = String(item).trim().slice(0, MAX_TAG_LENGTH)
    if (tag && !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) tags.push(tag)
    if (tags.length === MAX_TAGS) break
  }
  return tags
}

// Injected into the tab with chrome.scripting, so it must not use anything
// from this module's scope. The worker has no DOMParser, so the selection
// comes back as a plain node tree that htmlNodesToBlocks can read. Elements
// carry no text of their own; hydrate() rebuilds it from the text nodes.
export function readPage(options = {}) {
  const keep = ['href', 'src', 'alt', 'title']
  const snapshot = (node) => {
    if (node.nodeType === 3) return { nodeType: 3, textContent: node.textContent }
    if (node.nodeType !== 1) return null
    const attributes = {}
    for (const name of keep) if (node.hasAttribute(name)) attributes[name] = node.getAttribute(name)
    return { nodeType: 1, tagName: node.tagName, attributes, childNodes: Array.from(node.childNodes, snapshot).filter(Boolean) }
  }
  const selection = window.getSelection()
  const selectionText = selection?.toString() ?? ''
  const selectionNodes = []
  if (selection && selection.rangeCount > 0 && selectionText.trim()) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      for (const node of selection.getRangeAt(index).cloneContents().childNodes) {
        const item = snapshot(node)
        if (item) selectionNodes.push(item)
      }
    }
  }
  const description =
    document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
    document.querySelector('meta[name="description"]')?.getAttribute('content') ||
    ''
  const link = options.linkUrl ? Array.from(document.links).find((anchor) => anchor.href === options.linkUrl) : null
  return {
    title: document.title || location.hostname,
    url: location.href,
    selection: selectionText,
    selectionNodes,
    description,
    linkText: link?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 300) || '',
  }
}

// Injected after src/vendor/Readability.js, which defines Readability in the
// same isolated world. Self-contained for the same reason as readPage.
export function readArticle() {
  if (typeof Readability !== 'function') return null
  const parsed = new Readability(document.cloneNode(true)).parse()
  if (!parsed?.content || (parsed.textContent || '').trim().length < 200) return null
  const keep = ['href', 'src', 'alt', 'title']
  const snapshot = (node) => {
    if (node.nodeType === 3) return { nodeType: 3, textContent: node.textContent }
    if (node.nodeType !== 1) return null
    const attributes = {}
    for (const name of keep) if (node.hasAttribute(name)) attributes[name] = node.getAttribute(name)
    return { nodeType: 1, tagName: node.tagName, attributes, childNodes: Array.from(node.childNodes, snapshot).filter(Boolean) }
  }
  const body = new DOMParser().parseFromString(parsed.content, 'text/html').body
  return { title: parsed.title || document.title, byline: (parsed.byline || '').trim(), nodes: Array.from(body.childNodes, snapshot).filter(Boolean) }
}

// Injected crop overlay. It runs in the extension's isolated world inside a
// closed shadow root, ignores synthetic events, and removes itself before it
// reports, so the screenshot taken afterwards never shows it.
export function cropOverlay() {
  if (window.__auroraCropActive) return
  window.__auroraCropActive = true
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;'
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = '<style>.layer{position:fixed;inset:0;cursor:crosshair;background:rgba(0,0,0,.35);touch-action:none}.box{position:fixed;display:none;border:2px solid #38b494;border-radius:2px;box-shadow:0 0 0 100vmax rgba(0,0,0,.35);pointer-events:none}.hint{position:fixed;top:12px;left:50%;transform:translateX(-50%);padding:6px 12px;border-radius:8px;background:#191919;color:#dfddd0;font:500 13px system-ui,sans-serif;pointer-events:none}</style><div class="layer"></div><div class="box"></div><div class="hint">Drag to capture · Esc to cancel</div>'
  const layer = root.querySelector('.layer')
  const box = root.querySelector('.box')
  const hint = root.querySelector('.hint')
  let start = null
  let rect = null
  const finish = (result) => {
    window.__auroraCropActive = false
    removeEventListener('keydown', onKey, true)
    host.remove()
    const message = result ? { type: 'AURORA_CROP_DONE', box: result, devicePixelRatio: window.devicePixelRatio || 1 } : { type: 'AURORA_CROP_CANCELLED' }
    requestAnimationFrame(() => requestAnimationFrame(() => chrome.runtime.sendMessage(message)))
  }
  const onKey = (event) => {
    if (!event.isTrusted || event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    finish(null)
  }
  layer.addEventListener('pointerdown', (event) => {
    if (!event.isTrusted) return
    event.preventDefault()
    start = { x: event.clientX, y: event.clientY }
    layer.setPointerCapture(event.pointerId)
  })
  layer.addEventListener('pointermove', (event) => {
    if (!event.isTrusted || !start) return
    rect = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) }
    Object.assign(box.style, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    layer.style.background = 'transparent'
    hint.style.display = 'none'
  })
  layer.addEventListener('pointerup', (event) => {
    if (!event.isTrusted || !start) return
    finish(rect && rect.width >= 8 && rect.height >= 8 ? rect : null)
  })
  addEventListener('keydown', onKey, true)
  document.documentElement.append(host)
}

// Injected for Clip image when the worker can't fetch the image itself:
// returns the visible part of the image, in CSS pixels.
export async function imageBox(srcUrl) {
  const image = Array.from(document.images).find((item) => item.currentSrc === srcUrl || item.src === srcUrl)
  if (!image) return null
  image.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const bounds = image.getBoundingClientRect()
  const x = Math.max(0, bounds.left)
  const y = Math.max(0, bounds.top)
  const width = Math.min(innerWidth, bounds.right) - x
  const height = Math.min(innerHeight, bounds.bottom) - y
  if (width < 1 || height < 1) return null
  return { box: { x, y, width, height }, devicePixelRatio: window.devicePixelRatio || 1 }
}

function hydrate(node) {
  if (node?.nodeType === 3) return { nodeType: 3, textContent: String(node.textContent ?? '') }
  if (node?.nodeType !== 1 || typeof node.tagName !== 'string') return null
  const attributes = node.attributes && typeof node.attributes === 'object' ? node.attributes : {}
  const childNodes = (Array.isArray(node.childNodes) ? node.childNodes : []).map(hydrate).filter(Boolean)
  return {
    nodeType: 1,
    tagName: node.tagName,
    textContent: childNodes.map((child) => child.textContent).join(''),
    getAttribute: (name) => (typeof attributes[name] === 'string' ? attributes[name] : null),
    childNodes,
    children: childNodes.filter((child) => child.nodeType === 1),
  }
}

function blocksFrom(nodes, baseUrl) {
  return htmlNodesToBlocks((Array.isArray(nodes) ? nodes : []).map(hydrate).filter(Boolean), { baseUrl })
}

function noteBlocks(note) {
  return String(note ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
}

function sourceBlock(url) {
  return { type: 'paragraph', content: [{ type: 'text', text: 'Source: ' }, { type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url, target: '_blank' } }] }] }
}

function heading(text) {
  return { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: text || 'Web clip' }] }
}

// The TipTap document saved with a clip, or null when there is nothing to
// add beyond the properties (a page or link with no note).
export function clipContent({ mode, page, note, imageSrc }) {
  const notes = noteBlocks(note)
  if (mode === 'selection') {
    const blocks = blocksFrom(page.selectionNodes, page.url)
    const quote = blocks.length ? blocks : [{ type: 'paragraph', content: [{ type: 'text', text: page.selection.trim() }] }]
    return { type: 'doc', content: [...notes, heading(page.title), { type: 'blockquote', content: quote }, sourceBlock(page.url)] }
  }
  if (mode === 'article') {
    const byline = page.article.byline ? [{ type: 'paragraph', content: [{ type: 'text', text: page.article.byline, marks: [{ type: 'italic' }] }] }] : []
    return { type: 'doc', content: [...notes, heading(page.article.title || page.title), ...byline, ...blocksFrom(page.article.nodes, page.url), sourceBlock(page.url)] }
  }
  if (IMAGE_MODES.has(mode)) {
    return { type: 'doc', content: [...notes, { type: 'image', attrs: { src: imageSrc, alt: page.title || null } }, sourceBlock(page.url)] }
  }
  return notes.length ? { type: 'doc', content: [...notes, sourceBlock(page.url)] } : null
}

export function selectionContent(page, note) {
  return clipContent({ mode: 'selection', page, note })
}

export function clipTitle(mode, page) {
  const title = page.title || page.url
  if (mode === 'screenshot') return `Screenshot: ${title}`
  if (mode === 'image') return `Image from ${title}`
  if (mode === 'article') return page.article?.title || title
  return title
}

export function generateId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from(crypto.getRandomValues(new Uint8Array(15)), (byte) => alphabet[byte % alphabet.length]).join('')
}

// Same fragment the web app adds in uploadWorkspaceBlob, so the editor knows
// which workspace the file belongs to.
export function imageSrcFor(apiUrl, workspaceId, record) {
  const meta = encodeURIComponent(JSON.stringify({ v: 1, workspaceId, kind: 'image' }))
  return `${String(apiUrl).replace(/\/+$/, '')}/api/files/images/${record.id}/${encodeURIComponent(record.file)}#aurora-asset=${meta}`
}

export async function cropImage(blob, box, devicePixelRatio = 1) {
  const bitmap = await createImageBitmap(blob)
  const scale = Number(devicePixelRatio) > 0 ? Number(devicePixelRatio) : 1
  const x = Math.min(bitmap.width, Math.max(0, Math.round(box.x * scale)))
  const y = Math.min(bitmap.height, Math.max(0, Math.round(box.y * scale)))
  const width = Math.min(bitmap.width - x, Math.round(box.width * scale))
  const height = Math.min(bitmap.height - y, Math.round(box.height * scale))
  if (width < 1 || height < 1) throw new Error('The selected area is empty.')
  const canvas = new OffscreenCanvas(width, height)
  canvas.getContext('2d').drawImage(bitmap, x, y, width, height, 0, 0, width, height)
  bitmap.close?.()
  return canvas.convertToBlob({ type: 'image/png' })
}

// Plaintext writes happen only when the API says the workspace is not
// end-to-end encrypted. A missing answer counts as encrypted (NFR-1).
export async function checkWorkspace({ apiUrl, session, workspaceId, onSession = async () => {}, fetchImpl = fetch }) {
  let listed
  try {
    listed = await listWorkspacesWithSession({ apiUrl, session, fetchImpl })
  } catch (error) {
    if (error.status === 401) throw error
    throw new CaptureBlockedError("Couldn't check this workspace. Try again.", 'WORKSPACE_CHECK_FAILED')
  }
  if (listed.session !== session) await onSession(listed.session)
  const workspace = listed.workspaces.find((item) => item.id === workspaceId)
  if (workspace?.e2eeEnabled === true) {
    throw new CaptureBlockedError('This workspace is end-to-end encrypted. Use Enable encrypted capture so the clip stays sealed.', 'WORKSPACE_ENCRYPTED')
  }
  if (workspace?.e2eeEnabled !== false) {
    throw new CaptureBlockedError("Aurora didn't confirm this workspace is unencrypted. Use Enable encrypted capture for it.", 'WORKSPACE_ENCRYPTION_UNKNOWN')
  }
  return listed.session
}

export async function quickCapture({ apiUrl, session, workspaceId, mode, page, note = '', tags = [], image = null, onSession = async () => {}, fetchImpl = fetch }) {
  let current = await checkWorkspace({ apiUrl, session, workspaceId, onSession, fetchImpl })
  const track = async (next) => {
    if (next !== current) await onSession(next)
    current = next
  }
  const create = async (collection, body) => {
    const result = await createRecordWithSession({ apiUrl, session: current, collection, body, fetchImpl })
    await track(result.session)
    return result.record
  }
  const property = (objectId, key, valueType, values) => create('object_properties', { object_id: objectId, key, value_type: valueType, ...values })

  if (IMAGE_MODES.has(mode) && !image) throw new Error('No image to save.')
  const object = await create('objects', { workspace_id: workspaceId, type: objectTypeFor(mode), title: clipTitle(mode, page), icon: null, is_deleted: false, is_template: false, format_version: 1 })
  await property(object.id, 'inbox', 'boolean', { value_bool: true })
  await property(object.id, 'source_url', 'url', { value_text: page.url })
  if (page.description) await property(object.id, 'description', 'text', { value_text: page.description })
  const tagList = parseTags(tags)
  if (tagList.length) await property(object.id, 'tags', 'text', { value_text: tagList.join(',') })

  let imageSrc = null
  if (image) {
    if (image.size > MAX_IMAGE_BYTES) throw new Error('This image is larger than 64 MB.')
    const extension = RASTER_TYPES.get(image.type) ?? 'png'
    const form = new FormData()
    form.append('workspace_id', workspaceId)
    form.append('object_id', object.id)
    form.append('folder', 'clipper')
    form.append('original_url', page.url)
    form.append('size_bytes', String(image.size))
    form.append('file', image, `aurora-${mode}-${Date.now()}.${extension}`)
    const uploaded = await requestWithSession({ apiUrl, session: current, path: '/api/collections/images/records', method: 'POST', form, fetchImpl })
    await track(uploaded.session)
    imageSrc = imageSrcFor(apiUrl, workspaceId, uploaded.payload)
  }

  const content = clipContent({ mode, page, note, imageSrc })
  if (content) await create('content', { object_id: object.id, content_json: content })
  return { objectId: object.id, session: current }
}

async function refreshAuthorization({ api, storage, workspaceId }) {
  const list = await api.listClipperAuthorizations()
  const next = list.find((item) => item?.workspaceId === workspaceId && item.captureKey?.publicKey)
  if (!next) throw new Error('This clipper is no longer approved. Pair it again in Aurora.')
  const { clipperAuthorizations } = await storage.get({ clipperAuthorizations: {} })
  await storage.set({ clipperAuthorizations: { ...clipperAuthorizations, [workspaceId]: next } })
  return next
}

function scopedApi({ storage, apiUrl, credentials, workspaceId, fetchImpl }) {
  const state = createClipperState({ storage })
  const api = createClipperApi({
    apiUrl,
    credentials,
    fetchImpl,
    onCredentials: (next) => state.saveCredentials(next),
    onAuthorizationStale: async () => {
      const { clipperAuthorizations } = await storage.get({ clipperAuthorizations: {} })
      delete clipperAuthorizations[workspaceId]
      await storage.remove('clipperCredentials')
      await storage.set({ clipperAuthorizations })
    },
  })
  return { state, api }
}

export async function encryptedCapture({ storage, apiUrl, credentials, authorization, workspaceId, mode, page, note = '', tags = [], fetchImpl = fetch }) {
  if (IMAGE_MODES.has(mode)) throw new CaptureBlockedError("Screenshots aren't available for encrypted workspaces yet.", 'IMAGE_ENCRYPTED')
  const captureId = generateId()
  const payload = { version: 1, captureId, objectId: generateId(), objectType: objectTypeFor(mode), title: clipTitle(mode, page), sourceUrl: page.url, description: page.description || null, inbox: true, content: clipContent({ mode, page, note }), capturedAt: new Date().toISOString() }
  let context = { workspaceId, captureId, clientId: credentials.clientId, generation: authorization.captureKey.generation, version: 1 }
  const { state, api } = scopedApi({ storage, apiUrl, credentials, workspaceId, fetchImpl })
  const submit = async (current) => {
    let envelope
    try {
      envelope = await sealCapturePayload(payload, current.captureKey.publicKey, context)
    } catch (error) {
      if (error.message === 'CAPTURE_TOO_LARGE') throw new Error('This clip is too long to encrypt in one go.')
      throw error
    }
    await state.savePreparedCapture({ context: { ...context, apiUrl }, envelope, receipt: null, plaintext: payload })
    await api.submitEncryptedCapture({ workspaceId, captureId, generation: context.generation, envelopeVersion: current.captureKey.envelopeVersion || 1, envelope })
  }
  try {
    await submit(authorization)
  } catch (error) {
    if (error.status !== 409 || error.payload?.code !== 'CAPTURE_KEY_ROTATED') throw error
    const next = await refreshAuthorization({ api, storage, workspaceId })
    context = { ...context, generation: next.captureKey.generation }
    await submit(next)
  }
  await state.clearPreparedCapture(captureId)
  return { objectId: payload.objectId, captureId, notice: parseTags(tags).length ? TAGS_NOT_SEALED_NOTICE : null }
}

export async function retryPreparedCapture({ storage, credentials, fetchImpl = fetch }) {
  const state = createClipperState({ storage })
  const [prepared] = await state.getPreparedCaptures()
  if (!prepared) return null
  const { workspaceId } = prepared.context
  const { api } = scopedApi({ storage, apiUrl: prepared.context.apiUrl, credentials, workspaceId, fetchImpl })
  const send = (item) => api.submitEncryptedCapture({ workspaceId: item.context.workspaceId, captureId: item.context.captureId, generation: item.context.generation, envelopeVersion: item.envelope.version, envelope: item.envelope })
  try {
    await send(prepared)
  } catch (error) {
    if (error.status !== 409 || error.payload?.code !== 'CAPTURE_KEY_ROTATED' || !prepared.payloadCiphertext) throw error
    const authorization = await refreshAuthorization({ api, storage, workspaceId })
    const payload = await state.openPreparedPayload(prepared)
    const context = { ...prepared.context, generation: authorization.captureKey.generation, version: 1 }
    const envelope = await sealCapturePayload(payload, authorization.captureKey.publicKey, context)
    await send(await state.savePreparedCapture({ context, envelope, receipt: null, plaintext: payload }))
  }
  await state.clearPreparedCapture(prepared.context.captureId)
  return { captureId: prepared.context.captureId }
}

export function normalizeUrl(value) {
  try {
    const url = new URL(value)
    url.hash = ''
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1)
    return url.href
  } catch {
    return String(value ?? '')
  }
}

export const CLIP_INDEX_MAX_AGE_MS = 5 * 60 * 1000

// Finds an earlier clip of this URL in a workspace the API confirms is
// unencrypted (D-4). `index` is the cached { at, urls } map, rebuilt when stale.
export async function findExistingClip({ apiUrl, session, workspaceId, url, index = null, now = Date.now(), onSession = async () => {}, fetchImpl = fetch }) {
  let current
  try {
    current = await checkWorkspace({ apiUrl, session, workspaceId, onSession, fetchImpl })
  } catch (error) {
    if (error instanceof CaptureBlockedError) return { objectId: null, index: null }
    throw error
  }
  const get = async (path) => {
    const result = await requestWithSession({ apiUrl, session: current, path, fetchImpl })
    if (result.session !== current) await onSession(result.session)
    current = result.session
    return result.payload
  }
  let fresh = index && now - index.at < CLIP_INDEX_MAX_AGE_MS ? index : null
  if (!fresh) {
    const filter = `workspace_id="${workspaceId}" && key="source_url"`
    const payload = await get(`/api/collections/object_properties/records?filter=${encodeURIComponent(filter)}&perPage=1000`)
    const urls = {}
    for (const item of Array.isArray(payload.items) ? payload.items : []) {
      if (typeof item?.value_text === 'string' && typeof item.object_id === 'string') urls[normalizeUrl(item.value_text)] = item.object_id
    }
    fresh = { at: now, urls }
  }
  const objectId = fresh.urls[normalizeUrl(url)]
  if (!objectId) return { objectId: null, index: fresh }
  try {
    const object = await get(`/api/collections/objects/records/${encodeURIComponent(objectId)}`)
    if (object?.is_deleted) return { objectId: null, index: fresh }
  } catch (error) {
    if (error.status === 404) return { objectId: null, index: fresh }
    throw error
  }
  return { objectId, index: fresh }
}
