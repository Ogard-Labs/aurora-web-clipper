import { DEFAULT_API_URL, createRecordWithSession, listWorkspacesWithSession, normalizeApiUrl, requestEmailCode, signIn, verifyMfa } from './auth.js'
import { createClipperApi } from './clipperApi.js'
import { createClipperState } from './clipperState.js'
import { sealCapturePayload } from './captureEnvelope.js'
import { listOAuthProviders, requestOAuthLinkEmail } from './oauth.js'
import { ensureHostPermission } from './permissions.js'
import { chooseWorkspaceId, derivePopupState, encryptedCaptureSuccessMessage, shouldStopPairingPoll } from './popupState.js'
import { htmlToBlocks } from './tiptapHtml.js'

const form = Object.fromEntries(['apiUrl','workspaceId','workspacePicker','workspaceLabel','workspaceMeta','stateConnect','stateApprove','stateReady','directActions','pairingCode','pairingExpiry','openAurora','cancelPairing','previewTitle','previewUrl','signedOutPanel','signedInPanel','signedInAs','sessionAvatar','pairClipper','pairingStatus','email','password','signIn','signOut','signOutReady','mfaPanel','mfaHint','mfaMethod','mfaCode','verifyMfa','requestEmailCode','cancelMfa','clipPage','clipSelection','clipPageDirect','clipSelectionDirect','status','retryCapture','oauthProviders','statusAction','directWorkspace','directWorkspaceField'].map((id) => [id, document.querySelector(`#${id}`)]))

let currentSession = null
let currentCredentials = null
let authorizations = {}
let pendingMfa = null
let pendingPairing = null
let pendingRetries = []
let pairingTimer = null
let busy = false
let busyMessage = null
let oauthProviders = []
let statusActionHandler = null
let sessionWorkspaces = []

function setStatus(message, kind = 'info') { busyMessage = null; form.status.replaceChildren(message); form.status.dataset.kind = kind; setStatusAction(null) }
function setBusyStatus(message, kind = 'info') { busyMessage = message; form.status.replaceChildren(spinner(), message); form.status.dataset.kind = kind; setStatusAction(null) }
function setStatusAction(label, handler) { statusActionHandler = label ? handler : null; form.statusAction.textContent = label || ''; setVisible(form.statusAction, Boolean(label)) }
function setPairingStatus(message, kind = 'info') { form.pairingStatus.textContent = message; form.pairingStatus.dataset.kind = kind }
function setVisible(element, visible) { element.classList.toggle('hidden', !visible) }
function setBusy(value) { busy = value; if (!value) busyMessage = null; render() }
function spinner() { const el = document.createElement('span'); el.className = 'spinner'; el.setAttribute('aria-hidden', 'true'); return el }
function avatarInitials(user) { const name = user?.displayName || user?.name || user?.email || ''; const match = name.match(/[A-Za-z0-9]/); return match ? match[0].toUpperCase() : 'A' }
function displayUser(user) { return user?.email || user?.displayName || user?.name || 'Aurora' }
function validSession(value) { return value && typeof value.accessToken === 'string' && typeof value.refreshToken === 'string' ? value : null }
function validCredentials(value) { return value && typeof value.clientId === 'string' && value.accessToken?.startsWith('aur_clip_a_') && value.refreshToken?.startsWith('aur_clip_r_') ? value : null }
function validAuthorizations(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {} }
function validPairing(value) { return value && typeof value.pairingCode === 'string' && typeof value.exchangeSecret === 'string' && typeof value.workspaceId === 'string' && Date.parse(value.expiresAt) > Date.now() ? value : null }
function generateId() { const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'; return Array.from(crypto.getRandomValues(new Uint8Array(15)), (byte) => alphabet[byte % alphabet.length]).join('') }
function randomSecret() { let binary = ''; for (const byte of crypto.getRandomValues(new Uint8Array(32))) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') }

function render() {
  const workspaceId = form.workspacePicker?.value || form.workspaceId.value.trim()
  const state = derivePopupState({ session: currentSession, scopedCredentials: currentCredentials, pairing: pendingPairing, authorization: authorizations[workspaceId], busy })
  const signedIn = Boolean(currentSession?.accessToken && currentSession?.refreshToken)
  const mfa = Boolean(pendingMfa?.mfaId)
  setVisible(form.stateConnect, state.kind === 'connect' || mfa)
  setVisible(form.stateApprove, state.kind === 'approve')
  setVisible(form.stateReady, state.kind === 'ready' && !mfa)
  setVisible(form.directActions, signedIn && state.kind !== 'ready' && !mfa)
  setVisible(form.signedOutPanel, !signedIn && !mfa)
  setVisible(form.signedInPanel, signedIn && !mfa)
  setVisible(form.mfaPanel, mfa)
  form.signedInAs.textContent = displayUser(currentSession?.user)
  if (form.sessionAvatar) form.sessionAvatar.textContent = avatarInitials(currentSession?.user)
  if (busy && busyMessage) { form.status.replaceChildren(spinner(), busyMessage) }
  form.clipPage.disabled = busy || state.kind !== 'ready' || mfa
  form.clipSelection.disabled = busy || state.kind !== 'ready' || mfa
  form.clipPageDirect.disabled = busy || !signedIn || mfa
  form.clipSelectionDirect.disabled = busy || !signedIn || mfa
  form.signIn.disabled = busy; form.oauthProviders.querySelectorAll('button').forEach((button) => { button.disabled = busy }); form.statusAction.disabled = busy; form.signOut.disabled = busy; form.signOutReady.disabled = busy
  form.pairClipper.disabled = busy || !signedIn || Boolean(currentCredentials)
  form.retryCapture.classList.toggle('hidden', !pendingRetries.length || busy); form.retryCapture.disabled = busy || !currentCredentials
  form.pairingCode.textContent = pendingPairing?.pairingCode || ''
  form.pairingExpiry.textContent = pendingPairing ? `Expires ${new Date(pendingPairing.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''
  form.openAurora.disabled = busy || !pendingPairing; form.cancelPairing.disabled = busy || !pendingPairing
  form.workspaceLabel.textContent = workspaceId || 'Choose a workspace'; form.workspaceMeta.textContent = state.kind === 'ready' ? 'End-to-end encrypted · trusted browser' : 'Not paired yet'
  renderMfa()
}

function renderMfa() {
  if (!pendingMfa?.mfaId) return
  const methods = pendingMfa.methods?.length ? pendingMfa.methods : ['email_otp']
  form.mfaMethod.replaceChildren(...methods.map((method) => { const option = document.createElement('option'); option.value = method; option.textContent = method === 'totp' ? 'Authenticator app' : 'Email code'; return option }))
  form.mfaHint.textContent = methods.includes('totp') ? 'Enter your authenticator code, or request an email code.' : 'Enter the Aurora sign-in code sent to your email.'
  form.verifyMfa.disabled = busy; form.requestEmailCode.disabled = busy || !methods.includes('email_otp'); form.cancelMfa.disabled = busy
}

async function loadSettings() {
  const sync = await chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL, workspaceId: '' })
  form.apiUrl.value = normalizeApiUrl(sync.apiUrl); form.workspaceId.value = sync.workspaceId
  const local = await chrome.storage.local.get({ session: null, clipperCredentials: null, clipperAuthorizations: {}, pendingClipperPairing: null })
  currentSession = validSession(local.session); currentCredentials = validCredentials(local.clipperCredentials); authorizations = validAuthorizations(local.clipperAuthorizations); pendingPairing = validPairing(local.pendingClipperPairing)
  pendingRetries = await createClipperState({ storage: chrome.storage.local }).getPreparedCaptures()
  const stored = (await chrome.storage.session.get({ pendingMfa: null })).pendingMfa; if (stored?.mfaId && !currentSession) pendingMfa = stored
  populateWorkspacePicker(); render(); void previewPage(); void loadOAuthProviders(); void loadWorkspaces(); if (pendingPairing) void pollPairing()
}

// One button per provider this AuroraCloud server allows for this extension.
async function loadOAuthProviders() {
  try { oauthProviders = await listOAuthProviders({ apiUrl: normalizeApiUrl(form.apiUrl.value), extensionId: chrome.runtime.id }) } catch { oauthProviders = [] }
  form.oauthProviders.replaceChildren(...oauthProviders.map((provider) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = `Continue with ${provider.name}`; button.disabled = busy; button.addEventListener('click', () => handleOAuthSignIn(provider.id)); return button }))
  setVisible(form.oauthProviders, oauthProviders.length > 0)
}

function providerName(id) { return oauthProviders.find((provider) => provider.id === id)?.name || id }

function showHandoff(handoff) {
  if (handoff.kind === 'no_account') { setStatus('There is no Aurora account for this email yet. Create one in Aurora, then sign in here.'); setStatusAction('Open Aurora', () => chrome.tabs.create({ url: appUrl() })); return }
  if (handoff.kind === 'verify_email') { setStatus(`Confirm your email first. Check ${handoff.email || 'your inbox'} for the Aurora message, then try again.`); setStatusAction('Open Aurora', () => chrome.tabs.create({ url: appUrl() })); return }
  setStatus(`This ${providerName(handoff.provider)} account is not linked to your Aurora account yet.`)
  setStatusAction('Email me a link', async () => { try { setBusy(true); setBusyStatus('Sending the link...'); await requestOAuthLinkEmail({ apiUrl: normalizeApiUrl(form.apiUrl.value), linkToken: handoff.linkToken }); setStatus(`Check ${handoff.email || 'your email'} for the link, then sign in again.`, 'success') } catch (error) { setStatus(error.message || String(error), 'error') } finally { setBusy(false) } })
}

async function handleOAuthSignIn(provider) {
  try { setBusy(true); setBusyStatus('Finish signing in in the new window...'); const settings = await readSettings(); const response = await chrome.runtime.sendMessage({ type: 'AURORA_OAUTH_SIGN_IN', provider, apiUrl: settings.apiUrl }); if (response?.ok) { currentSession = validSession((await chrome.storage.local.get({ session: null })).session); setStatus('Signed in to Aurora.', 'success'); void loadWorkspaces(); return } if (response?.cancelled) { setStatus(''); return } if (response?.mfa) { pendingMfa = (await chrome.storage.session.get({ pendingMfa: null })).pendingMfa; setStatus(''); render(); form.mfaCode.focus(); return } if (response?.handoff) { showHandoff(response.handoff); return } throw new Error(response?.error || 'Sign-in failed.') } catch (error) { setStatus(error.message || String(error), 'error') } finally { setBusy(false) }
}

// Quick capture uses the signed-in session, so it can list the workspaces itself instead of asking for an ID.
async function loadWorkspaces() {
  if (!currentSession) return
  try {
    const { workspaces, session } = await listWorkspacesWithSession({ apiUrl: normalizeApiUrl(form.apiUrl.value), session: currentSession })
    if (session !== currentSession) { currentSession = session; await chrome.storage.local.set({ session }) }
    sessionWorkspaces = workspaces
    const chosen = chooseWorkspaceId(workspaces, form.workspaceId.value.trim())
    if (chosen !== form.workspaceId.value) { form.workspaceId.value = chosen; await chrome.storage.sync.set({ workspaceId: chosen }) }
    populateDirectWorkspaces(); populateWorkspacePicker(); render()
  } catch { /* keep the typed Workspace ID */ }
}

function populateDirectWorkspaces() {
  form.directWorkspace.replaceChildren(...sessionWorkspaces.map((workspace) => { const option = document.createElement('option'); option.value = workspace.id; option.textContent = workspace.name; option.selected = workspace.id === form.workspaceId.value; return option }))
  setVisible(form.directWorkspaceField, sessionWorkspaces.length > 1)
}

function populateWorkspacePicker() {
  const ids = Object.keys(authorizations); const current = form.workspaceId.value.trim(); form.workspacePicker.replaceChildren()
  if (!ids.length) { const option = document.createElement('option'); option.value = current; option.textContent = current || 'Pair a workspace first'; form.workspacePicker.append(option); form.workspacePicker.disabled = true; return }
  ids.forEach((id) => { const option = document.createElement('option'); option.value = id; option.textContent = id; option.selected = id === current || (!current && ids.length === 1); form.workspacePicker.append(option) })
  form.workspacePicker.disabled = false; form.workspaceId.value = form.workspacePicker.value
}

async function readSettings(requireWorkspace = false) {
  const settings = { apiUrl: normalizeApiUrl(form.apiUrl.value), workspaceId: (form.workspacePicker.value || form.workspaceId.value).trim() }
  form.apiUrl.value = settings.apiUrl; form.workspaceId.value = settings.workspaceId
  const permissionGranted = await ensureHostPermission(settings.apiUrl, chrome.permissions)
  if (!permissionGranted) throw new Error(`Permission denied for ${settings.apiUrl}.`)
  await chrome.storage.sync.set(settings)
  if (requireWorkspace && !settings.workspaceId) throw new Error('Workspace ID is required.')
  return settings
}

async function previewPage() { try { const page = await captureActivePage(); form.previewTitle.textContent = page.title || 'Current browser tab'; form.previewUrl.textContent = page.url || 'Ready to capture' } catch { form.previewUrl.textContent = 'Open a page to preview it here' } }
async function captureActivePage() { const response = await chrome.runtime.sendMessage({ type: 'AURORA_CAPTURE_ACTIVE_TAB' }); if (!response?.ok) throw new Error(response?.error || 'Could not inspect the current tab.'); return response.page }
async function saveSession(session) { currentSession = session; pendingMfa = null; await chrome.storage.session.remove('pendingMfa'); await chrome.storage.local.set({ session }); render(); void loadWorkspaces() }
async function clearSession() { currentSession = null; sessionWorkspaces = []; populateDirectWorkspaces(); pendingMfa = null; await chrome.storage.session.remove('pendingMfa'); await chrome.storage.local.remove('session'); render() }

async function handleSignIn() {
  try { setBusy(true); setBusyStatus('Signing in...'); const settings = await readSettings(); const email = form.email.value.trim(); const password = form.password.value; if (!email || !password) throw new Error('Email and password are required.'); const result = await signIn({ apiUrl: settings.apiUrl, email, password }); form.password.value = ''; if (result.status === 'mfa_required') { pendingMfa = result.challenge; render(); form.mfaCode.focus(); return } await saveSession(result.session); setStatus('Signed in to Aurora.', 'success') } catch (error) { setStatus(error.message || String(error), 'error') } finally { setBusy(false) }
}

async function handleMfaEmail() { if (!pendingMfa?.mfaId) return; try { setBusy(true); setBusyStatus('Sending email code...'); const settings = await readSettings(); pendingMfa = { ...pendingMfa, ...await requestEmailCode({ apiUrl: settings.apiUrl, email: pendingMfa.email || form.email.value.trim(), mfaId: pendingMfa.mfaId }) }; setStatus('Email code sent.', 'success') } catch (error) { setStatus(error.message || String(error), 'error') } finally { setBusy(false) } }
async function handleMfaVerify() { if (!pendingMfa?.mfaId) return; try { setBusy(true); setBusyStatus('Verifying code...'); const settings = await readSettings(); const method = form.mfaMethod.value || pendingMfa.preferredMethod; if (method === 'email_otp' && !pendingMfa.otpId) pendingMfa = { ...pendingMfa, ...await requestEmailCode({ apiUrl: settings.apiUrl, email: pendingMfa.email || form.email.value.trim(), mfaId: pendingMfa.mfaId }) }; const session = await verifyMfa({ apiUrl: settings.apiUrl, mfaId: pendingMfa.mfaId, otpId: pendingMfa.otpId, method, code: form.mfaCode.value.trim() }); pendingMfa = null; form.mfaCode.value = ''; await saveSession(session); setStatus('Signed in to Aurora.', 'success') } catch (error) { setStatus(error.message || String(error), 'error') } finally { setBusy(false) } }

function appUrl() { const url = new URL(form.apiUrl.value); if (url.hostname.startsWith('api.')) url.hostname = `app.${url.hostname.slice(4)}`; url.pathname = '/'; url.search = ''; url.hash = ''; return url.toString() }
async function handlePair() {
  try { setBusy(true); const settings = await readSettings(true); if (!currentSession?.accessToken) throw new Error('Sign in before pairing this clipper.'); const saved = (await chrome.storage.local.get({ clipperSettings: {} })).clipperSettings || {}; const device = { deviceId: saved.deviceId || `clipper_${generateId()}`, deviceLabel: saved.deviceLabel || 'Aurora Web Clipper' }; const exchangeSecret = randomSecret(); const api = createClipperApi({ apiUrl: settings.apiUrl }); const pairing = await api.startClipperPairing({ ...device, ...settings, exchangeSecret, sessionToken: currentSession.accessToken }); pendingPairing = { ...pairing, ...settings, ...device, exchangeSecret }; await chrome.storage.local.set({ pendingClipperPairing: pendingPairing, clipperSettings: { ...saved, ...device, apiUrl: settings.apiUrl } }); setPairingStatus('Approve this browser in Aurora. Recovery phrases never enter the extension.'); render(); void pollPairing() } catch (error) { setPairingStatus(error.message || String(error), 'error') } finally { setBusy(false) }
}

async function pollPairing() {
  if (!pendingPairing || pairingTimer) return
  const pairing = pendingPairing; const api = createClipperApi({ apiUrl: pairing.apiUrl })
  const poll = async () => { if (!pendingPairing || pairing.pairingCode !== pendingPairing.pairingCode) return; if (Date.parse(pairing.expiresAt) <= Date.now()) { pendingPairing = null; await chrome.storage.local.remove('pendingClipperPairing'); setPairingStatus('Pairing expired. Start again.', 'error'); render(); return } try { const exchange = await api.pollPairingExchange({ pairingCode: pairing.pairingCode, exchangeSecret: pairing.exchangeSecret }); if (exchange?.accessToken && exchange?.refreshToken && exchange.authorization && exchange.captureKey) { const state = createClipperState({ storage: chrome.storage.local }); currentCredentials = await state.completePairing({ apiUrl: pairing.apiUrl, deviceId: pairing.deviceId, deviceLabel: pairing.deviceLabel, ...exchange }); authorizations = { ...authorizations, [exchange.authorization.workspaceId]: { workspaceId: exchange.authorization.workspaceId, captureKey: exchange.captureKey, limits: exchange.limits } }; currentSession = null; pendingPairing = null; await chrome.storage.local.remove(['pendingClipperPairing', 'session']); populateWorkspacePicker(); setPairingStatus('Encrypted capture enabled.', 'success'); setStatus('Encrypted capture enabled.', 'success'); render(); return } } catch (error) { if (shouldStopPairingPoll(error, pairing.expiresAt)) { pendingPairing = null; await chrome.storage.local.remove('pendingClipperPairing'); setPairingStatus(error.message || 'Pairing was rejected.', 'error'); render(); return } } pairingTimer = setTimeout(() => { pairingTimer = null; void poll() }, 1000) }
  await poll()
}

async function clearAuthorization(workspaceId) { currentCredentials = null; delete authorizations[workspaceId]; await chrome.storage.local.remove('clipperCredentials'); await chrome.storage.local.set({ clipperAuthorizations: authorizations }); populateWorkspacePicker(); render() }
async function refreshAuthorization(api, workspaceId) { const list = await api.listClipperAuthorizations(); const next = list.find((item) => item?.workspaceId === workspaceId && item.captureKey?.publicKey); if (!next) throw new Error('This clipper is no longer approved. Pair it again in Aurora.'); authorizations = { ...authorizations, [workspaceId]: next }; await chrome.storage.local.set({ clipperAuthorizations: authorizations }); return next }

function selectionContent(page) { const quote = page.selection.trim(); const blocks = htmlToBlocks(page.selectionHtml, page.url); return { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: page.title || 'Web clip' }] }, { type: 'blockquote', content: blocks.length ? blocks : [{ type: 'paragraph', content: [{ type: 'text', text: quote }] }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Source: ' }, { type: 'text', text: page.url, marks: [{ type: 'link', attrs: { href: page.url, target: '_blank' } }] }] }] } }

async function clipEncrypted(settings, mode, page, scoped) {
  const captureId = generateId(); const payload = { version: 1, captureId, objectId: generateId(), objectType: mode === 'page' ? 'bookmark' : 'page', title: page.title || page.url, sourceUrl: page.url, description: page.description || null, inbox: true, content: mode === 'selection' ? selectionContent(page) : null, capturedAt: new Date().toISOString() }
  let context = { workspaceId: settings.workspaceId, captureId, clientId: scoped.credentials.clientId, generation: scoped.authorization.captureKey.generation, version: 1 }
  const state = createClipperState({ storage: chrome.storage.local }); const api = createClipperApi({ apiUrl: scoped.apiUrl, credentials: scoped.credentials, onCredentials: async (credentials) => { currentCredentials = credentials; await state.saveCredentials(credentials) }, onAuthorizationStale: () => clearAuthorization(settings.workspaceId) })
  const submit = async (authorization) => { const envelope = await sealCapturePayload(payload, authorization.captureKey.publicKey, context); await state.savePreparedCapture({ context: { ...context, apiUrl: scoped.apiUrl }, envelope, receipt: null, plaintext: payload }); await api.submitEncryptedCapture({ workspaceId: settings.workspaceId, captureId, generation: context.generation, envelopeVersion: authorization.captureKey.envelopeVersion || 1, envelope }) }
  try { await submit(scoped.authorization) } catch (error) { if (error.status !== 409 || error.payload?.code !== 'CAPTURE_KEY_ROTATED') throw error; setBusyStatus('Refreshing encrypted capture authorization...'); const authorization = await refreshAuthorization(api, settings.workspaceId); context = { ...context, generation: authorization.captureKey.generation }; await submit(authorization) }
  await state.clearPreparedCapture(captureId); pendingRetries = await state.getPreparedCaptures(); setStatus(encryptedCaptureSuccessMessage(), 'success')
}

async function retryCapture() {
  const prepared = pendingRetries[0]; if (!prepared) return
  try { setBusy(true); setBusyStatus('Retrying encrypted capture...'); const state = createClipperState({ storage: chrome.storage.local }); const api = createClipperApi({ apiUrl: prepared.context.apiUrl, credentials: currentCredentials, onCredentials: async (credentials) => { currentCredentials = credentials; await state.saveCredentials(credentials) }, onAuthorizationStale: () => clearAuthorization(prepared.context.workspaceId) }); const send = (item) => api.submitEncryptedCapture({ workspaceId: item.context.workspaceId, captureId: item.context.captureId, generation: item.context.generation, envelopeVersion: item.envelope.version, envelope: item.envelope }); try { await send(prepared) } catch (error) { if (error.status !== 409 || error.payload?.code !== 'CAPTURE_KEY_ROTATED' || !prepared.payloadCiphertext) throw error; const authorization = await refreshAuthorization(api, prepared.context.workspaceId); const payload = await state.openPreparedPayload(prepared); const context = { ...prepared.context, generation: authorization.captureKey.generation, version: 1 }; const envelope = await sealCapturePayload(payload, authorization.captureKey.publicKey, context); const refreshed = await state.savePreparedCapture({ context, envelope, receipt: null, plaintext: payload }); await send(refreshed) } await state.clearPreparedCapture(prepared.context.captureId); pendingRetries = await state.getPreparedCaptures(); setStatus(encryptedCaptureSuccessMessage(), 'success') } catch (error) { setStatus(error.message || String(error), 'error') } finally { setBusy(false) }
}

async function directCreate(settings, collection, body) { const result = await createRecordWithSession({ apiUrl: settings.apiUrl, session: currentSession, collection, body }); if (result.session.accessToken !== currentSession?.accessToken || result.session.refreshToken !== currentSession?.refreshToken) await saveSession(result.session); return result.record }
async function property(settings, objectId, key, valueType, values) { return directCreate(settings, 'object_properties', { object_id: objectId, key, value_type: valueType, ...values }) }
async function clip(mode) {
  try { setBusy(true); setBusyStatus('Capturing...'); const settings = await readSettings(true); if (!currentSession && !currentCredentials) throw new Error('Sign in or pair this clipper before capturing.'); const page = await captureActivePage(); if (mode === 'selection' && !page.selection?.trim()) throw new Error('Select text on the page before using Clip selection.'); const scoped = currentCredentials && authorizations[settings.workspaceId]?.captureKey ? { apiUrl: settings.apiUrl, credentials: currentCredentials, authorization: authorizations[settings.workspaceId] } : null; if (scoped) { setBusyStatus('Encrypting capture...'); await clipEncrypted(settings, mode, page, scoped); return } if (!currentSession) throw new Error('Clipper authorization is stale. Pair this browser again in Aurora.'); setBusyStatus('Saving to Aurora...'); const object = await directCreate(settings, 'objects', { workspace_id: settings.workspaceId, type: mode === 'page' ? 'bookmark' : 'page', title: page.title || page.url, icon: null, is_deleted: false, is_template: false, format_version: 1 }); await property(settings, object.id, 'inbox', 'boolean', { value_bool: true }); await property(settings, object.id, 'source_url', 'url', { value_text: page.url }); if (page.description) await property(settings, object.id, 'description', 'text', { value_text: page.description }); if (mode === 'selection') await directCreate(settings, 'content', { object_id: object.id, content_json: selectionContent(page) }); setStatus('Saved to Aurora Inbox.', 'success') } catch (error) { pendingRetries = await createClipperState({ storage: chrome.storage.local }).getPreparedCaptures(); if (error.status === 401 && currentSession) await clearSession(); setStatus(error.message || String(error), 'error') } finally { setBusy(false) }
}

form.signIn.addEventListener('click', handleSignIn); form.statusAction.addEventListener('click', () => statusActionHandler?.()); form.signOut.addEventListener('click', () => clearSession()); form.pairClipper.addEventListener('click', handlePair); form.requestEmailCode.addEventListener('click', handleMfaEmail); form.verifyMfa.addEventListener('click', handleMfaVerify); form.cancelMfa.addEventListener('click', () => { pendingMfa = null; form.mfaCode.value = ''; void chrome.storage.session.remove('pendingMfa'); render() }); form.clipPage.addEventListener('click', () => clip('page')); form.clipSelection.addEventListener('click', () => clip('selection')); form.clipPageDirect.addEventListener('click', () => clip('page')); form.clipSelectionDirect.addEventListener('click', () => clip('selection')); form.retryCapture.addEventListener('click', retryCapture); form.openAurora.addEventListener('click', () => chrome.tabs.create({ url: appUrl() })); form.cancelPairing.addEventListener('click', async () => { pendingPairing = null; if (pairingTimer) clearTimeout(pairingTimer); pairingTimer = null; await chrome.storage.local.remove('pendingClipperPairing'); render() }); form.signOutReady.addEventListener('click', async () => { currentCredentials = null; authorizations = {}; await chrome.storage.local.remove(['clipperCredentials', 'clipperAuthorizations']); populateWorkspacePicker(); render() }); form.workspacePicker.addEventListener('change', () => { form.workspaceId.value = form.workspacePicker.value; render() }); form.directWorkspace.addEventListener('change', () => { form.workspaceId.value = form.directWorkspace.value; populateWorkspacePicker(); void chrome.storage.sync.set({ workspaceId: form.workspaceId.value }); render() });
// A provider sign-in finishes in the background; pick up its session if the popup is still open.
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.session) { currentSession = validSession(changes.session.newValue); render() } if (area === 'session' && changes.pendingMfa) { pendingMfa = changes.pendingMfa.newValue?.mfaId ? changes.pendingMfa.newValue : null; render() } })
loadSettings().catch((error) => setStatus(error.message || String(error), 'error'))
