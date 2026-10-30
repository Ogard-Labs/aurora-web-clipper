import assert from 'node:assert/strict'
import test from 'node:test'
import { CaptureBlockedError, NO_ARTICLE_NOTICE, TAGS_NOT_SEALED_NOTICE, clipContent, encryptedCapture, findExistingClip, normalizeUrl, objectTypeFor, parseTags, quickCapture, selectionContent } from './capture.js'

const session = { accessToken: 'access', refreshToken: 'refresh', user: null }
const page = { title: 'Example', url: 'https://example.com/a', description: 'About it', selection: 'Hello world', selectionNodes: [] }

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload } }
}

// Answers GET /workspaces with the given items and every record POST with an id.
function stubApi(items) {
  const calls = []
  let next = 0
  const fetchImpl = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ url, method: init.method, body, form: init.body instanceof FormData ? init.body : null })
    if (url.endsWith('/workspaces')) return jsonResponse(200, { items })
    if (url.includes('/api/collections/images/records')) return jsonResponse(200, { id: 'img_1', file: 'aurora screenshot.png' })
    if (url.includes('/api/collections/')) return jsonResponse(200, { id: `rec_${(next += 1)}` })
    throw new Error(`Unexpected fetch call to ${url}`)
  }
  return { fetchImpl, calls, writes: () => calls.filter((call) => call.url.includes('/api/collections/')) }
}

for (const [label, items] of [
  ['encrypted', [{ id: 'ws_1', name: 'Secret', e2eeEnabled: true }]],
  ['of unknown encryption (older server)', [{ id: 'ws_1', name: 'Old' }]],
  ['missing from the list', [{ id: 'ws_other', name: 'Other', e2eeEnabled: false }]],
]) {
  test(`quickCapture writes nothing to a workspace that is ${label}`, async () => {
    const api = stubApi(items)
    await assert.rejects(
      quickCapture({ apiUrl: 'https://api.aurora.ink', session, workspaceId: 'ws_1', mode: 'selection', page, fetchImpl: api.fetchImpl }),
      (error) => error instanceof CaptureBlockedError && /^WORKSPACE_ENCRYPT/.test(error.code),
    )
    assert.deepEqual(api.writes(), [])
  })
}

test('quickCapture writes nothing when the workspace check fails', async () => {
  const fetchImpl = async () => jsonResponse(500, { error: 'down' })
  await assert.rejects(
    quickCapture({ apiUrl: 'https://api.aurora.ink', session, workspaceId: 'ws_1', mode: 'page', page, fetchImpl }),
    (error) => error.code === 'WORKSPACE_CHECK_FAILED',
  )
})

test('quickCapture saves a page clip to an unencrypted workspace and returns the object id', async () => {
  const api = stubApi([{ id: 'ws_1', name: 'Notes', e2eeEnabled: false }])
  const result = await quickCapture({ apiUrl: 'https://api.aurora.ink', session, workspaceId: 'ws_1', mode: 'page', page, fetchImpl: api.fetchImpl })

  assert.equal(result.objectId, 'rec_1')
  assert.deepEqual(api.writes().map((call) => [call.url.split('/collections/')[1], call.body.key ?? call.body.type]), [
    ['objects/records', 'bookmark'],
    ['object_properties/records', 'inbox'],
    ['object_properties/records', 'source_url'],
    ['object_properties/records', 'description'],
  ])
  assert.equal(api.writes()[0].body.workspace_id, 'ws_1')
})

test('quickCapture adds the quoted selection as content', async () => {
  const api = stubApi([{ id: 'ws_1', name: 'Notes', e2eeEnabled: false }])
  await quickCapture({ apiUrl: 'https://api.aurora.ink', session, workspaceId: 'ws_1', mode: 'selection', page, fetchImpl: api.fetchImpl })
  const content = api.writes().at(-1)
  assert.match(content.url, /content\/records$/)
  assert.equal(content.body.object_id, 'rec_1')
  assert.equal(content.body.content_json.content[1].type, 'blockquote')
})

test('selectionContent keeps formatting from the page node snapshot', () => {
  const content = selectionContent({
    ...page,
    selectionNodes: [
      { nodeType: 1, tagName: 'P', attributes: {}, childNodes: [
        { nodeType: 1, tagName: 'STRONG', attributes: {}, childNodes: [{ nodeType: 3, textContent: 'Bold' }] },
        { nodeType: 3, textContent: ' ' },
        { nodeType: 1, tagName: 'A', attributes: { href: '/b' }, childNodes: [{ nodeType: 3, textContent: 'link' }] },
      ] },
    ],
  })
  const paragraph = content.content[1].content[0]
  assert.equal(paragraph.type, 'paragraph')
  assert.deepEqual(paragraph.content[0], { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] })
  assert.equal(paragraph.content.at(-1).marks[0].attrs.href, 'https://example.com/b')
})

const plain = [{ id: 'ws_1', name: 'Notes', e2eeEnabled: false }]

test('objectTypeFor saves pages and links as bookmarks, everything else as pages', () => {
  assert.deepEqual(['page', 'link', 'selection', 'article', 'screenshot', 'image'].map(objectTypeFor), ['bookmark', 'bookmark', 'page', 'page', 'page', 'page'])
})

test('parseTags trims, drops empty and duplicate tags, and caps count and length', () => {
  assert.deepEqual(parseTags(' research, AI ,, ai, '), ['research', 'AI'])
  assert.equal(parseTags(Array.from({ length: 30 }, (_, index) => `t${index}`)).length, 20)
  assert.equal(parseTags(['x'.repeat(60)])[0].length, 40)
})

test('a note goes first in the content, and gives a page clip content of its own', () => {
  assert.equal(clipContent({ mode: 'page', page, note: '' }), null)
  const content = clipContent({ mode: 'page', page, note: 'Read later\nsecond line' })
  assert.deepEqual(content.content.map((block) => block.type), ['paragraph', 'paragraph', 'paragraph'])
  assert.equal(content.content[0].content[0].text, 'Read later')
  assert.equal(selectionContent(page, 'why').content[0].content[0].text, 'why')
})

test('quickCapture saves tags as the comma-separated tags property the web app reads', async () => {
  const api = stubApi(plain)
  await quickCapture({ apiUrl: 'https://api.aurora.ink', session, workspaceId: 'ws_1', mode: 'page', page, note: 'n', tags: 'a, b', fetchImpl: api.fetchImpl })
  const tags = api.writes().find((call) => call.body?.key === 'tags')
  assert.deepEqual([tags.body.value_type, tags.body.value_text], ['text', 'a,b'])
  assert.match(api.writes().at(-1).url, /content\/records$/)
})

test('quickCapture uploads a screenshot to the object and links it with the asset fragment', async () => {
  const api = stubApi(plain)
  const image = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
  await quickCapture({ apiUrl: 'https://api.aurora.ink', session, workspaceId: 'ws_1', mode: 'screenshot', page, image, fetchImpl: api.fetchImpl })
  const upload = api.calls.find((call) => call.url.includes('/images/records'))
  assert.equal(upload.method, 'POST')
  assert.equal(upload.form.get('workspace_id'), 'ws_1')
  assert.equal(upload.form.get('object_id'), 'rec_1')
  assert.equal(upload.form.get('file').type, 'image/png')
  const object = api.writes()[0]
  assert.equal(object.body.type, 'page')
  assert.equal(object.body.title, 'Screenshot: Example')
  const imageNode = api.writes().at(-1).body.content_json.content[0]
  assert.equal(imageNode.type, 'image')
  assert.equal(imageNode.attrs.src, `https://api.aurora.ink/api/files/images/img_1/aurora%20screenshot.png#aurora-asset=${encodeURIComponent(JSON.stringify({ v: 1, workspaceId: 'ws_1', kind: 'image' }))}`)
})

test('an article clip holds the title, byline and article blocks', () => {
  const article = { title: 'Long read', byline: 'By Ada', nodes: [{ nodeType: 1, tagName: 'H2', attributes: {}, childNodes: [{ nodeType: 3, textContent: 'Part one' }] }, { nodeType: 1, tagName: 'P', attributes: {}, childNodes: [{ nodeType: 3, textContent: 'Body text' }] }] }
  const content = clipContent({ mode: 'article', page: { ...page, article }, note: '' })
  assert.deepEqual(content.content.map((block) => block.type), ['heading', 'paragraph', 'heading', 'paragraph', 'paragraph'])
  assert.equal(content.content[2].content[0].text, 'Part one')
  assert.ok(NO_ARTICLE_NOTICE)
})

test('encryptedCapture refuses screenshots and images before sealing anything', async () => {
  for (const mode of ['screenshot', 'image']) {
    await assert.rejects(encryptedCapture({ storage: null, apiUrl: 'https://api.aurora.ink', credentials: {}, authorization: {}, workspaceId: 'ws_1', mode, page }), (error) => error.code === 'IMAGE_ENCRYPTED')
  }
  assert.ok(TAGS_NOT_SEALED_NOTICE)
})

test('normalizeUrl ignores the fragment and a trailing slash', () => {
  assert.equal(normalizeUrl('https://Example.com/a/#top'), 'https://example.com/a')
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/')
})

function duplicateApi({ items = plain, properties = [], object = { id: 'obj_1', is_deleted: false } } = {}) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.endsWith('/workspaces')) return jsonResponse(200, { items })
    if (url.includes('/object_properties/records?')) return jsonResponse(200, { items: properties })
    if (url.includes('/objects/records/')) return object ? jsonResponse(200, object) : jsonResponse(404, {})
    throw new Error(`Unexpected fetch call to ${url}`)
  }
  return { fetchImpl, calls }
}

test('findExistingClip finds an earlier clip of the same URL and caches the index', async () => {
  const api = duplicateApi({ properties: [{ object_id: 'obj_1', value_text: 'https://example.com/a/' }] })
  const result = await findExistingClip({ apiUrl: 'https://api.aurora.ink', session, workspaceId: 'ws_1', url: 'https://example.com/a#x', now: 1000, fetchImpl: api.fetchImpl })
  assert.equal(result.objectId, 'obj_1')
  assert.match(decodeURIComponent(api.calls[1]), /filter=workspace_id="ws_1" && key="source_url"/)
  const again = duplicateApi()
  await findExistingClip({ apiUrl: 'https://api.aurora.ink', session, workspaceId: 'ws_1', url: 'https://example.com/a', index: result.index, now: 2000, fetchImpl: again.fetchImpl })
  assert.equal(again.calls.some((url) => url.includes('/object_properties/')), false)
})

test('findExistingClip skips deleted objects and never lists an encrypted workspace', async () => {
  const deleted = duplicateApi({ properties: [{ object_id: 'obj_1', value_text: 'https://example.com/a' }], object: { id: 'obj_1', is_deleted: true } })
  assert.equal((await findExistingClip({ apiUrl: 'https://api.aurora.ink', session, workspaceId: 'ws_1', url: 'https://example.com/a', fetchImpl: deleted.fetchImpl })).objectId, null)
  const encrypted = duplicateApi({ items: [{ id: 'ws_1', name: 'S', e2eeEnabled: true }] })
  assert.equal((await findExistingClip({ apiUrl: 'https://api.aurora.ink', session, workspaceId: 'ws_1', url: 'https://example.com/a', fetchImpl: encrypted.fetchImpl })).objectId, null)
  assert.equal(encrypted.calls.length, 1)
})
