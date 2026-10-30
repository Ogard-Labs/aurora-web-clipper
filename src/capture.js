import { createRecordWithSession, listWorkspacesWithSession } from './auth.js'
import { createClipperApi } from './clipperApi.js'
import { createClipperState } from './clipperState.js'
import { sealCapturePayload } from './captureEnvelope.js'
import { htmlNodesToBlocks } from './tiptapHtml.js'

// The capture service runs in the background worker, so the popup, the
// right-click menu and the shortcut all save clips the same way.

export class CaptureBlockedError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'CaptureBlockedError'
    this.code = code
  }
}

// Injected into the tab with chrome.scripting, so it must not use anything
// from this module's scope. The worker has no DOMParser, so the selection
// comes back as a plain node tree that htmlNodesToBlocks can read.
export function readPage() {
  const snapshot = (node) => {
    if (node.nodeType === 3) return { nodeType: 3, textContent: node.textContent }
    if (node.nodeType !== 1) return null
    return {
      nodeType: 1,
      tagName: node.tagName,
      textContent: node.textContent,
      attributes: Object.fromEntries(Array.from(node.attributes, (attribute) => [attribute.name, attribute.value])),
      childNodes: Array.from(node.childNodes, snapshot).filter(Boolean),
    }
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
  return {
    title: document.title || location.hostname,
    url: location.href,
    selection: selectionText,
    selectionNodes,
    description,
  }
}

function hydrate(node) {
  if (node?.nodeType === 3) return { nodeType: 3, textContent: String(node.textContent ?? '') }
  if (node?.nodeType !== 1 || typeof node.tagName !== 'string') return null
  const attributes = node.attributes && typeof node.attributes === 'object' ? node.attributes : {}
  return {
    nodeType: 1,
    tagName: node.tagName,
    textContent: String(node.textContent ?? ''),
    getAttribute: (name) => (typeof attributes[name] === 'string' ? attributes[name] : null),
    childNodes: (Array.isArray(node.childNodes) ? node.childNodes : []).map(hydrate).filter(Boolean),
  }
}

export function selectionContent(page) {
  const quote = page.selection.trim()
  const nodes = (Array.isArray(page.selectionNodes) ? page.selectionNodes : []).map(hydrate).filter(Boolean)
  const blocks = htmlNodesToBlocks(nodes, { baseUrl: page.url })
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: page.title || 'Web clip' }] },
      { type: 'blockquote', content: blocks.length ? blocks : [{ type: 'paragraph', content: [{ type: 'text', text: quote }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Source: ' }, { type: 'text', text: page.url, marks: [{ type: 'link', attrs: { href: page.url, target: '_blank' } }] }] },
    ],
  }
}

export function generateId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from(crypto.getRandomValues(new Uint8Array(15)), (byte) => alphabet[byte % alphabet.length]).join('')
}

// Plaintext writes happen only when the API says the workspace is not
// end-to-end encrypted. A missing answer counts as encrypted (NFR-1).
export async function quickCapture({ apiUrl, session, workspaceId, mode, page, onSession = async () => {}, fetchImpl = fetch }) {
  let listed
  try {
    listed = await listWorkspacesWithSession({ apiUrl, session, fetchImpl })
  } catch (error) {
    if (error.status === 401) throw error
    throw new CaptureBlockedError("Couldn't check this workspace. Try again.", 'WORKSPACE_CHECK_FAILED')
  }
  let current = listed.session
  if (current !== session) await onSession(current)
  const workspace = listed.workspaces.find((item) => item.id === workspaceId)
  if (workspace?.e2eeEnabled === true) {
    throw new CaptureBlockedError('This workspace is end-to-end encrypted. Use Enable encrypted capture so the clip stays sealed.', 'WORKSPACE_ENCRYPTED')
  }
  if (workspace?.e2eeEnabled !== false) {
    throw new CaptureBlockedError("Aurora didn't confirm this workspace is unencrypted. Use Enable encrypted capture for it.", 'WORKSPACE_ENCRYPTION_UNKNOWN')
  }

  const create = async (collection, body) => {
    const result = await createRecordWithSession({ apiUrl, session: current, collection, body, fetchImpl })
    if (result.session !== current) await onSession(result.session)
    current = result.session
    return result.record
  }
  const property = (objectId, key, valueType, values) => create('object_properties', { object_id: objectId, key, value_type: valueType, ...values })

  const object = await create('objects', { workspace_id: workspaceId, type: mode === 'page' ? 'bookmark' : 'page', title: page.title || page.url, icon: null, is_deleted: false, is_template: false, format_version: 1 })
  await property(object.id, 'inbox', 'boolean', { value_bool: true })
  await property(object.id, 'source_url', 'url', { value_text: page.url })
  if (page.description) await property(object.id, 'description', 'text', { value_text: page.description })
  if (mode === 'selection') await create('content', { object_id: object.id, content_json: selectionContent(page) })
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

export async function encryptedCapture({ storage, apiUrl, credentials, authorization, workspaceId, mode, page, fetchImpl = fetch }) {
  const captureId = generateId()
  const payload = { version: 1, captureId, objectId: generateId(), objectType: mode === 'page' ? 'bookmark' : 'page', title: page.title || page.url, sourceUrl: page.url, description: page.description || null, inbox: true, content: mode === 'selection' ? selectionContent(page) : null, capturedAt: new Date().toISOString() }
  let context = { workspaceId, captureId, clientId: credentials.clientId, generation: authorization.captureKey.generation, version: 1 }
  const { state, api } = scopedApi({ storage, apiUrl, credentials, workspaceId, fetchImpl })
  const submit = async (current) => {
    const envelope = await sealCapturePayload(payload, current.captureKey.publicKey, context)
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
  return { objectId: payload.objectId, captureId }
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
