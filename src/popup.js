import { DEFAULT_API_URL, normalizeApiUrl, requestEmailCode, signIn, verifyMfa } from './auth.js'
import { createClipperApi } from './clipperApi.js'
import { createClipperState } from './clipperState.js'
import { listOAuthProviders, requestOAuthLinkEmail } from './oauth.js'
import { ensureHostPermission } from './permissions.js'
import { freshLastCapture } from './menus.js'
import { appUrl as appUrlFor, capturePath, chooseWorkspaceId, encryptedCaptureSuccessMessage, objectUrl, shouldStopPairingPoll, workspaceChoices, workspaceHint, workspaceOptionLabel } from './popupState.js'

const form = Object.fromEntries(['apiUrl','workspaceId','stateConnect','stateApprove','pairingCode','pairingExpiry','openAurora','cancelPairing','previewTitle','previewUrl','signedOutPanel','signedInAs','sessionAvatar','pairClipper','pairingStatus','email','password','signIn','signOut','signOutReady','mfaPanel','mfaHint','mfaMethod','mfaCode','verifyMfa','requestEmailCode','cancelMfa','status','retryCapture','oauthProviders','statusAction','intro','accountBar','pairCard','captureCard','workspaceSelect','workspaceHint','note','tags','duplicate','duplicateOpen'].map((id) => [id, document.querySelector(`#${id}`)]))

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
let currentPage = null
let duplicateId = null
const clipButtons = [...document.querySelectorAll('[data-mode]')]

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

function currentChoice() { const id = form.workspaceId.value.trim(); return workspaceChoices({ sessionWorkspaces, authorizations, typedId: id }).find((choice) => choice.id === id) ?? null }
function currentPath() { return capturePath({ choice: currentChoice(), hasCredentials: Boolean(currentCredentials), signedIn: Boolean(currentSession?.accessToken && currentSession?.refreshToken) }) }

function render() {
  const signedIn = Boolean(currentSession?.accessToken && currentSession?.refreshToken)
  const paired = Boolean(currentCredentials && Object.keys(authorizations).length)
  const mfa = Boolean(pendingMfa?.mfaId)
  const path = currentPath()
  setVisible(form.intro, !signedIn && !paired)
  setVisible(form.accountBar, signedIn && !mfa)
  setVisible(form.stateConnect, (!signedIn && !paired && !pendingPairing) || mfa)
  setVisible(form.stateApprove, Boolean(pendingPairing) && !mfa)
  setVisible(form.captureCard, (signedIn || paired) && !mfa && !pendingPairing)
  setVisible(form.pairCard, signedIn && !mfa && !pendingPairing && !currentCredentials)
  setVisible(form.signedOutPanel, !signedIn && !mfa)
  setVisible(form.mfaPanel, mfa)
  setVisible(form.signOutReady, paired)
  form.signedInAs.textContent = displayUser(currentSession?.user)
  if (form.sessionAvatar) form.sessionAvatar.textContent = avatarInitials(currentSession?.user)
  if (busy && busyMessage) { form.status.replaceChildren(spinner(), busyMessage) }
  const canClip = !busy && !mfa && (path === 'quick' || path === 'encrypted')
  for (const button of clipButtons) button.disabled = !canClip || (button.dataset.mode === 'screenshot' && path !== 'quick')
  form.workspaceHint.textContent = workspaceHint(path, currentChoice()); setVisible(form.workspaceHint, Boolean(form.workspaceHint.textContent))
  form.tags.disabled = busy || path === 'encrypted'; form.tags.placeholder = path === 'encrypted' ? "Tags aren't sealed yet" : 'Tags, comma separated'; form.note.disabled = busy
  setVisible(form.duplicate, Boolean(duplicateId) && path === 'quick')
  form.signIn.disabled = busy; form.oauthProviders.querySelectorAll('button').forEach((button) => { button.disabled = busy }); form.statusAction.disabled = busy; form.signOut.disabled = busy; form.signOutReady.disabled = busy
  form.pairClipper.disabled = busy || !signedIn || Boolean(currentCredentials)
  form.retryCapture.classList.toggle('hidden', !pendingRetries.length || busy); form.retryCapture.disabled = busy || !currentCredentials
  form.pairingCode.textContent = pendingPairing?.pairingCode || ''
  form.pairingExpiry.textContent = pendingPairing ? `Expires ${new Date(pendingPairing.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''
  form.openAurora.disabled = busy || !pendingPairing; form.cancelPairing.disabled = busy || !pendingPairing
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
  populateWorkspacePicker(); render(); void showLastCapture(); void previewPage().then(() => findDuplicate()); void loadOAuthProviders(); void loadWorkspaces(); if (pendingPairing) void pollPairing()
}

// A clip from the menu, the shortcut or a screenshot finished while the popup was closed.
async function showLastCapture() {
  const { lastCapture } = await chrome.storage.session.get({ lastCapture: null }); await chrome.storage.session.remove('lastCapture')
  try { const tab = await activeTabId(); if (tab) await chrome.action.setBadgeText({ tabId: tab, text: '' }) } catch { /* no tab */ }
  const last = freshLastCapture(lastCapture); if (!last || busy) return
  if (last.ok) showSaved(last.notice ? `${last.message} ${last.notice}` : last.message, last.objectId, last.apiUrl); else setStatus(last.message, 'error')
}
async function activeTabId() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return tab?.id ?? null }

async function findDuplicate() {
  duplicateId = null; render(); if (!currentPage?.url || currentPath() !== 'quick') return
  try { const response = await chrome.runtime.sendMessage({ type: 'AURORA_FIND_CLIP', url: currentPage.url }); duplicateId = response?.ok ? response.objectId : null } catch { duplicateId = null }
  render()
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

// The worker lists the workspaces with the signed-in session, so the user needs no Workspace ID.
async function loadWorkspaces() {
  if (!currentSession) return
  const response = await chrome.runtime.sendMessage({ type: 'AURORA_LIST_WORKSPACES' }).catch((error) => ({ ok: false, error: error.message }))
  if (!response?.ok) {
    if (response?.status === 401) { await clearSession(); setStatus('Your Aurora session has ended. Sign in again.', 'error'); return }
    setStatus(`Couldn't load your workspaces: ${response?.error || 'unknown error'}`, 'error'); return
  }
  sessionWorkspaces = response.workspaces
  const chosen = chooseWorkspaceId(sessionWorkspaces, form.workspaceId.value.trim())
  if (chosen !== form.workspaceId.value) { form.workspaceId.value = chosen; await chrome.storage.sync.set({ workspaceId: chosen }) }
  populateWorkspacePicker(); render(); void findDuplicate()
}

function populateWorkspacePicker() {
  const current = form.workspaceId.value.trim(); const choices = workspaceChoices({ sessionWorkspaces, authorizations, typedId: current })
  form.workspaceSelect.replaceChildren(...choices.map((choice) => { const option = document.createElement('option'); option.value = choice.id; option.textContent = choice.paired ? `${choice.name} · encrypted capture` : workspaceOptionLabel(choice); option.selected = choice.id === current; return option }))
  if (!current && choices[0]) form.workspaceId.value = choices[0].id
  form.workspaceSelect.disabled = choices.length < 2
}

async function readSettings(requireWorkspace = false) {
  const settings = { apiUrl: normalizeApiUrl(form.apiUrl.value), workspaceId: form.workspaceId.value.trim() }
  form.apiUrl.value = settings.apiUrl; form.workspaceId.value = settings.workspaceId
  const permissionGranted = await ensureHostPermission(settings.apiUrl, chrome.permissions)
  if (!permissionGranted) throw new Error(`Permission denied for ${settings.apiUrl}.`)
  await chrome.storage.sync.set(settings)
  if (requireWorkspace && !settings.workspaceId) throw new Error('Workspace ID is required.')
  return settings
}

async function previewPage() { try { const page = await captureActivePage(); currentPage = page; form.previewTitle.textContent = page.title || 'Current browser tab'; form.previewUrl.textContent = page.url || 'Ready to capture' } catch { form.previewUrl.textContent = 'Open a page to preview it here' } }
async function captureActivePage() { const response = await chrome.runtime.sendMessage({ type: 'AURORA_CAPTURE_ACTIVE_TAB' }); if (!response?.ok) throw new Error(response?.error || 'Could not inspect the current tab.'); return response.page }
async function saveSession(session) { currentSession = session; pendingMfa = null; await chrome.storage.session.remove('pendingMfa'); await chrome.storage.local.set({ session }); render(); void loadWorkspaces() }
async function clearSession() { currentSession = null; sessionWorkspaces = []; duplicateId = null; populateWorkspacePicker(); pendingMfa = null; await chrome.storage.session.remove('pendingMfa'); await chrome.storage.local.remove('session'); render() }

async function handleSignIn() {
  try { setBusy(true); setBusyStatus('Signing in...'); const settings = await readSettings(); const email = form.email.value.trim(); const password = form.password.value; if (!email || !password) throw new Error('Email and password are required.'); const result = await signIn({ apiUrl: settings.apiUrl, email, password }); form.password.value = ''; if (result.status === 'mfa_required') { pendingMfa = result.challenge; render(); form.mfaCode.focus(); return } await saveSession(result.session); setStatus('Signed in to Aurora.', 'success') } catch (error) { setStatus(error.message || String(error), 'error') } finally { setBusy(false) }
}

async function handleMfaEmail() { if (!pendingMfa?.mfaId) return; try { setBusy(true); setBusyStatus('Sending email code...'); const settings = await readSettings(); pendingMfa = { ...pendingMfa, ...await requestEmailCode({ apiUrl: settings.apiUrl, email: pendingMfa.email || form.email.value.trim(), mfaId: pendingMfa.mfaId }) }; setStatus('Email code sent.', 'success') } catch (error) { setStatus(error.message || String(error), 'error') } finally { setBusy(false) } }
async function handleMfaVerify() { if (!pendingMfa?.mfaId) return; try { setBusy(true); setBusyStatus('Verifying code...'); const settings = await readSettings(); const method = form.mfaMethod.value || pendingMfa.preferredMethod; if (method === 'email_otp' && !pendingMfa.otpId) pendingMfa = { ...pendingMfa, ...await requestEmailCode({ apiUrl: settings.apiUrl, email: pendingMfa.email || form.email.value.trim(), mfaId: pendingMfa.mfaId }) }; const session = await verifyMfa({ apiUrl: settings.apiUrl, mfaId: pendingMfa.mfaId, otpId: pendingMfa.otpId, method, code: form.mfaCode.value.trim() }); pendingMfa = null; form.mfaCode.value = ''; await saveSession(session); setStatus('Signed in to Aurora.', 'success') } catch (error) { setStatus(error.message || String(error), 'error') } finally { setBusy(false) } }

function appUrl() { return appUrlFor(form.apiUrl.value) }
async function handlePair() {
  try { setBusy(true); const settings = await readSettings(true); if (!currentSession?.accessToken) throw new Error('Sign in before pairing this clipper.'); const saved = (await chrome.storage.local.get({ clipperSettings: {} })).clipperSettings || {}; const device = { deviceId: saved.deviceId || `clipper_${generateId()}`, deviceLabel: saved.deviceLabel || 'Aurora Web Clipper' }; const exchangeSecret = randomSecret(); const api = createClipperApi({ apiUrl: settings.apiUrl }); const pairing = await api.startClipperPairing({ ...device, ...settings, exchangeSecret, sessionToken: currentSession.accessToken }); pendingPairing = { ...pairing, ...settings, ...device, exchangeSecret }; await chrome.storage.local.set({ pendingClipperPairing: pendingPairing, clipperSettings: { ...saved, ...device, apiUrl: settings.apiUrl } }); setPairingStatus('Approve this browser in Aurora. Recovery phrases never enter the extension.'); render(); void pollPairing() } catch (error) { setPairingStatus(error.message || String(error), 'error') } finally { setBusy(false) }
}

async function pollPairing() {
  if (!pendingPairing || pairingTimer) return
  const pairing = pendingPairing; const api = createClipperApi({ apiUrl: pairing.apiUrl })
  const poll = async () => { if (!pendingPairing || pairing.pairingCode !== pendingPairing.pairingCode) return; if (Date.parse(pairing.expiresAt) <= Date.now()) { pendingPairing = null; await chrome.storage.local.remove('pendingClipperPairing'); setPairingStatus('Pairing expired. Start again.', 'error'); render(); return } try { const exchange = await api.pollPairingExchange({ pairingCode: pairing.pairingCode, exchangeSecret: pairing.exchangeSecret }); if (exchange?.accessToken && exchange?.refreshToken && exchange.authorization && exchange.captureKey) { const state = createClipperState({ storage: chrome.storage.local }); currentCredentials = await state.completePairing({ apiUrl: pairing.apiUrl, deviceId: pairing.deviceId, deviceLabel: pairing.deviceLabel, ...exchange }); authorizations = { ...authorizations, [exchange.authorization.workspaceId]: { workspaceId: exchange.authorization.workspaceId, captureKey: exchange.captureKey, limits: exchange.limits } }; currentSession = null; pendingPairing = null; await chrome.storage.local.remove(['pendingClipperPairing', 'session']); populateWorkspacePicker(); setPairingStatus('Encrypted capture enabled.', 'success'); setStatus('Encrypted capture enabled.', 'success'); render(); return } } catch (error) { if (shouldStopPairingPoll(error, pairing.expiresAt)) { pendingPairing = null; await chrome.storage.local.remove('pendingClipperPairing'); setPairingStatus(error.message || 'Pairing was rejected.', 'error'); render(); return } } pairingTimer = setTimeout(() => { pairingTimer = null; void poll() }, 1000) }
  await poll()
}

// Capture runs in the background worker (src/capture.js). It may refresh the
// session or credentials in storage, so the popup reloads them afterwards.
async function reloadCaptureState() {
  const local = await chrome.storage.local.get({ session: null, clipperCredentials: null, clipperAuthorizations: {} })
  currentSession = validSession(local.session); currentCredentials = validCredentials(local.clipperCredentials); authorizations = validAuthorizations(local.clipperAuthorizations)
  pendingRetries = await createClipperState({ storage: chrome.storage.local }).getPreparedCaptures(); populateWorkspacePicker()
}

function showSaved(message, objectId, apiUrl = form.apiUrl.value) { setStatus(message, 'success'); if (objectId) setStatusAction('Open in Aurora', () => chrome.tabs.create({ url: objectUrl(apiUrl, objectId) })) }

async function retryCapture() {
  try { setBusy(true); setBusyStatus('Retrying encrypted capture...'); const response = await chrome.runtime.sendMessage({ type: 'AURORA_RETRY_CAPTURE' }); await reloadCaptureState(); if (!response?.ok) throw new Error(response?.error || 'Retry failed.'); setStatus(encryptedCaptureSuccessMessage(), 'success') } catch (error) { setStatus(error.message || String(error), 'error') } finally { setBusy(false) }
}

async function clip(mode) {
  try {
    setBusy(true); setBusyStatus(mode === 'screenshot' ? 'Starting the screenshot...' : 'Saving to Aurora...'); await readSettings(true)
    const response = await chrome.runtime.sendMessage({ type: 'AURORA_CLIP', mode, note: form.note.value, tags: form.tags.value })
    if (response?.pending) { window.close(); return }
    await chrome.storage.session.remove('lastCapture'); await reloadCaptureState()
    if (!response?.ok) { if (response?.status === 401 && currentSession) await clearSession(); throw new Error(response?.error || 'Capture failed.') }
    form.note.value = ''; form.tags.value = ''; if (response.path === 'quick') duplicateId = response.objectId
    const message = response.path === 'encrypted' ? encryptedCaptureSuccessMessage() : 'Saved to Aurora Inbox.'
    showSaved(response.notice ? `${message} ${response.notice}` : message, response.objectId)
  } catch (error) { setStatus(error.message || String(error), 'error') } finally { setBusy(false) }
}

form.signIn.addEventListener('click', handleSignIn); form.statusAction.addEventListener('click', () => statusActionHandler?.()); form.signOut.addEventListener('click', () => clearSession()); form.pairClipper.addEventListener('click', handlePair); form.requestEmailCode.addEventListener('click', handleMfaEmail); form.verifyMfa.addEventListener('click', handleMfaVerify); form.cancelMfa.addEventListener('click', () => { pendingMfa = null; form.mfaCode.value = ''; void chrome.storage.session.remove('pendingMfa'); render() }); for (const button of clipButtons) button.addEventListener('click', () => clip(button.dataset.mode)); form.duplicateOpen.addEventListener('click', () => chrome.tabs.create({ url: objectUrl(form.apiUrl.value, duplicateId) })); form.retryCapture.addEventListener('click', retryCapture); form.openAurora.addEventListener('click', () => chrome.tabs.create({ url: appUrl() })); form.cancelPairing.addEventListener('click', async () => { pendingPairing = null; if (pairingTimer) clearTimeout(pairingTimer); pairingTimer = null; await chrome.storage.local.remove('pendingClipperPairing'); render() }); form.signOutReady.addEventListener('click', async () => { currentCredentials = null; authorizations = {}; await chrome.storage.local.remove(['clipperCredentials', 'clipperAuthorizations']); populateWorkspacePicker(); render() }); form.workspaceSelect.addEventListener('change', () => { form.workspaceId.value = form.workspaceSelect.value; void chrome.storage.sync.set({ workspaceId: form.workspaceId.value }); render(); void findDuplicate() });
// A provider sign-in finishes in the background; pick up its session if the popup is still open.
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.session) { currentSession = validSession(changes.session.newValue); render() } if (area === 'session' && changes.pendingMfa) { pendingMfa = changes.pendingMfa.newValue?.mfaId ? changes.pendingMfa.newValue : null; render() } })
loadSettings().catch((error) => setStatus(error.message || String(error), 'error'))
