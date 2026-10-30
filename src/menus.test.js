import assert from 'node:assert/strict'
import test from 'node:test'
import { MENU_ITEMS, badgeFor, freshLastCapture, requestFromMenu } from './menus.js'

test('the menu offers page, selection, link and image', () => {
  assert.deepEqual(MENU_ITEMS.map((item) => item.contexts[0]), ['page', 'selection', 'link', 'image'])
})

test('requestFromMenu maps each item to a capture request for the clicked tab and frame', () => {
  const tab = { id: 7, windowId: 2 }
  assert.deepEqual(requestFromMenu({ menuItemId: 'aurora-clip-link', linkUrl: 'https://x.test/a', frameId: 3 }, tab), { mode: 'link', tabId: 7, windowId: 2, frameId: 3, linkUrl: 'https://x.test/a', srcUrl: null, selectionText: '' })
  assert.equal(requestFromMenu({ menuItemId: 'aurora-clip-selection', selectionText: 'hi' }, tab).selectionText, 'hi')
  assert.equal(requestFromMenu({ menuItemId: 'aurora-clip-image', srcUrl: 'https://x.test/i.png' }, tab).srcUrl, 'https://x.test/i.png')
  assert.equal(requestFromMenu({ menuItemId: 'other' }, tab), null)
  assert.equal(requestFromMenu({ menuItemId: 'aurora-clip-page' }, undefined), null)
})

test('badgeFor shows a check on success and ! on failure', () => {
  assert.equal(badgeFor({ ok: true }).text, '✓')
  assert.equal(badgeFor({ ok: false }).text, '!')
})

test('freshLastCapture keeps results for 10 minutes', () => {
  const now = 1_000_000_000
  assert.ok(freshLastCapture({ at: now - 60_000 }, now))
  assert.equal(freshLastCapture({ at: now - 11 * 60_000 }, now), null)
  assert.equal(freshLastCapture(null, now), null)
})
