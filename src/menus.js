// Right-click menu items and toolbar badge feedback. The menu and the
// shortcut run without the popup, so the badge is how they report back.

export const MENU_ITEMS = [
  { id: 'aurora-clip-page', title: 'Clip page to Aurora', contexts: ['page'] },
  { id: 'aurora-clip-selection', title: 'Clip selection to Aurora', contexts: ['selection'] },
  { id: 'aurora-clip-link', title: 'Clip link to Aurora', contexts: ['link'] },
  { id: 'aurora-clip-image', title: 'Clip image to Aurora', contexts: ['image'] },
]

const MODES = {
  'aurora-clip-page': 'page',
  'aurora-clip-selection': 'selection',
  'aurora-clip-link': 'link',
  'aurora-clip-image': 'image',
}

export const CLIP_PAGE_COMMAND = 'clip-page'
export const SUCCESS_BADGE_MS = 4000
export const LAST_CAPTURE_MAX_AGE_MS = 10 * 60 * 1000

export function requestFromMenu(info, tab) {
  const mode = MODES[info?.menuItemId]
  if (!mode || typeof tab?.id !== 'number') return null
  return {
    mode,
    tabId: tab.id,
    windowId: tab.windowId,
    frameId: typeof info.frameId === 'number' ? info.frameId : 0,
    linkUrl: mode === 'link' ? info.linkUrl ?? null : null,
    srcUrl: mode === 'image' ? info.srcUrl ?? null : null,
    selectionText: mode === 'selection' ? info.selectionText ?? '' : '',
  }
}

export function badgeFor(result) {
  return result?.ok ? { text: '✓', color: '#0f766e' } : { text: '!', color: '#c0392b' }
}

export function freshLastCapture(lastCapture, now = Date.now()) {
  return lastCapture && typeof lastCapture.at === 'number' && now - lastCapture.at < LAST_CAPTURE_MAX_AGE_MS ? lastCapture : null
}
