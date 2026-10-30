import assert from 'node:assert/strict'
import test from 'node:test'
import { CaptureBlockedError, quickCapture, selectionContent } from './capture.js'

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
    calls.push({ url, method: init.method, body })
    if (url.endsWith('/workspaces')) return jsonResponse(200, { items })
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
      { nodeType: 1, tagName: 'P', textContent: 'Bold link', attributes: {}, childNodes: [
        { nodeType: 1, tagName: 'STRONG', textContent: 'Bold', attributes: {}, childNodes: [{ nodeType: 3, textContent: 'Bold' }] },
        { nodeType: 3, textContent: ' ' },
        { nodeType: 1, tagName: 'A', textContent: 'link', attributes: { href: '/b' }, childNodes: [{ nodeType: 3, textContent: 'link' }] },
      ] },
    ],
  })
  const paragraph = content.content[1].content[0]
  assert.equal(paragraph.type, 'paragraph')
  assert.deepEqual(paragraph.content[0], { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] })
  assert.equal(paragraph.content.at(-1).marks[0].attrs.href, 'https://example.com/b')
})

test('selectionContent keeps lists from the page node snapshot', () => {
  const el = (tagName, ...childNodes) => ({ nodeType: 1, tagName, textContent: '', attributes: {}, childNodes })
  const text = (textContent) => ({ nodeType: 3, textContent })
  const content = selectionContent({ ...page, selectionNodes: [el('UL', el('LI', text('a')), el('LI', text('b')))] })
  assert.equal(content.content[1].content[0].type, 'bulletList')
  assert.equal(content.content[1].content[0].content.length, 2)
})
