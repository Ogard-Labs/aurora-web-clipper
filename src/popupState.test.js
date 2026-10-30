import assert from 'node:assert/strict'
import test from 'node:test'
import { capturePath, chooseWorkspaceId, objectUrl, shouldStopPairingPoll, workspaceChoices, workspaceOptionLabel } from './popupState.js'

const futureExpiry = '2026-07-18T15:00:00.000Z'
const now = Date.parse('2026-07-18T14:00:00.000Z')

test('keeps polling when AuroraCloud reports an unapproved pairing as unavailable', () => {
  assert.equal(shouldStopPairingPoll({ status: 410 }, futureExpiry, now), false)
})

test('stops polling for malformed or unauthorized pairing requests', () => {
  assert.equal(shouldStopPairingPoll({ status: 400 }, futureExpiry, now), true)
  assert.equal(shouldStopPairingPoll({ status: 403 }, futureExpiry, now), true)
})

test('stops polling once the local pairing expiry has passed', () => {
  assert.equal(shouldStopPairingPoll({ status: 410 }, futureExpiry, Date.parse(futureExpiry)), true)
})

test('the workspace you chose before stays chosen while you can still use it', () => {
  const workspaces = [{ id: 'ws_recent', name: 'Hei' }, { id: 'ws_saved', name: 'Work' }]
  assert.equal(chooseWorkspaceId(workspaces, 'ws_saved'), 'ws_saved')
})

test('without a usable saved workspace, the most recently updated one is chosen', () => {
  const workspaces = [{ id: 'ws_recent', name: 'Hei' }, { id: 'ws_old', name: 'Old' }]
  assert.equal(chooseWorkspaceId(workspaces, ''), 'ws_recent')
  assert.equal(chooseWorkspaceId(workspaces, 'ws_removed'), 'ws_recent')
})

test('with no workspaces, the typed workspace ID is kept', () => {
  assert.equal(chooseWorkspaceId([], 'ws_typed'), 'ws_typed')
})

test('objectUrl opens the saved item in the web app', () => {
  assert.equal(objectUrl('https://api.aurora.ink', 'abc123'), 'https://app.aurora.ink/object/abc123')
  assert.equal(objectUrl('http://localhost:8787', 'abc123'), 'http://localhost:8787/object/abc123')
})

test('workspaceOptionLabel marks encrypted workspaces only', () => {
  assert.equal(workspaceOptionLabel({ name: 'Secret', e2eeEnabled: true }), 'Secret · encrypted')
  assert.equal(workspaceOptionLabel({ name: 'Notes', e2eeEnabled: false }), 'Notes')
  assert.equal(workspaceOptionLabel({ name: 'Old', e2eeEnabled: null }), 'Old')
})

test('workspaceChoices merges named workspaces, paired ones and a typed ID', () => {
  const choices = workspaceChoices({
    sessionWorkspaces: [{ id: 'ws_a', name: 'Notes', e2eeEnabled: false }, { id: 'ws_b', name: 'Secret', e2eeEnabled: true }],
    authorizations: { ws_b: { captureKey: { publicKey: 'k' } }, ws_c: { captureKey: { publicKey: 'k' } } },
    typedId: 'ws_typed',
  })
  assert.deepEqual(choices.map((choice) => [choice.id, choice.paired]), [['ws_a', false], ['ws_b', true], ['ws_c', true], ['ws_typed', false]])
})

test('capturePath seals paired workspaces and allows quick capture only when confirmed unencrypted', () => {
  assert.equal(capturePath({ choice: { paired: true, e2eeEnabled: true }, hasCredentials: true, signedIn: false }), 'encrypted')
  assert.equal(capturePath({ choice: { paired: false, e2eeEnabled: false }, hasCredentials: false, signedIn: true }), 'quick')
  assert.equal(capturePath({ choice: { paired: false, e2eeEnabled: true }, hasCredentials: false, signedIn: true }), 'blocked')
  assert.equal(capturePath({ choice: { paired: false, e2eeEnabled: null }, hasCredentials: false, signedIn: true }), 'blocked')
  assert.equal(capturePath({ choice: null, hasCredentials: false, signedIn: true }), 'none')
})
