import assert from 'node:assert/strict'
import test from 'node:test'
import { openCaptureEnvelope, sealCapturePayload } from './captureEnvelope.js'

const context = { workspaceId: 'workspace000001', captureId: 'capture00000001', clientId: 'client000000001', generation: 1, version: 1 }
const payload = { version: 1, captureId: context.captureId, objectId: 'object000000001', objectType: 'bookmark', title: 'Aurora', sourceUrl: 'https://aurora.ink', description: null, inbox: true, content: null, capturedAt: '2026-07-15T09:00:00.000Z' }

async function keypair() {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
  const encode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  return { publicKey: encode(await crypto.subtle.exportKey('raw', pair.publicKey)), privateKey: encode(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).slice(-32)) }
}

test('seals and opens a capture with the Aurora protocol envelope', async () => {
  const recipient = await keypair()
  const envelope = await sealCapturePayload(payload, recipient.publicKey, context)
  assert.equal(envelope.version, 1)
  assert.match(envelope.ciphertext, /^__e2ee__\{"v":2,/)
  assert.deepEqual(await openCaptureEnvelope(envelope, recipient.privateKey, context), payload)
})

test('rejects tampering and context substitution', async () => {
  const recipient = await keypair()
  const envelope = await sealCapturePayload(payload, recipient.publicKey, context)
  const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` }
  await assert.rejects(() => openCaptureEnvelope(tampered, recipient.privateKey, context))
  await assert.rejects(() => openCaptureEnvelope(envelope, recipient.privateKey, { ...context, generation: 2 }))
})
