import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { CLIPPER_EXTENSION_ID, extensionIdFromKey, validateManifest } from '../scripts/validate.mjs'

test('package and manifest versions are both the standalone 0.4.1 release', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'))
  assert.equal(pkg.version, '0.4.1')
  assert.equal(manifest.version, pkg.version)
})

test('README documents public installation, authentication, and privacy behavior', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const requiredStatements = [
    'Load unpacked',
    'https://api.aurora.ink',
    'Workspace ID',
    'MFA',
    'chrome.storage.local',
    'activeTab',
    'MCP tokens are not used by the Web Clipper',
  ]

  for (const statement of requiredStatements) {
    assert.match(readme, new RegExp(statement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('dedicated setup guide covers install, connection, verification, updates, and removal', async () => {
  const [readme, setup] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/setup.md', import.meta.url), 'utf8'),
  ])

  assert.match(readme, /\[Setup guide\]\(docs\/setup\.md\)/)
  for (const text of [
    '# Setup',
    'latest published ZIP',
    'chrome://extensions',
    'Load unpacked',
    'https://api.aurora.ink',
    'Workspace ID',
    'Settings → Workspace',
    'email and password',
    'MFA',
    'Clip page',
    'Clip selection',
    'MCP tokens are not used',
    'Update the extension',
    'preserves the existing local session',
    'sign in again',
    'Uninstall',
  ]) {
    assert.ok(setup.includes(text), `docs/setup.md is missing required setup guidance: ${text}`)
  }
})

test('public release surfaces derive the archive name from the package version', async () => {
  const bugTemplate = await readFile(new URL('../.github/ISSUE_TEMPLATE/bug.yml', import.meta.url), 'utf8')
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const ciWorkflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const releaseWorkflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

  assert.doesNotMatch(bugTemplate, /0\.9\.2/)
  assert.match(readme, /Aurora download page/)
  assert.match(readme, /release mirror operations/)
  assert.match(ciWorkflow, /ASSET_NAME="auroradocs-web-clipper-\$\{PACKAGE_VERSION\}\.zip"/)
  assert.match(releaseWorkflow, /ASSET_NAME="auroradocs-web-clipper-\$\{PACKAGE_VERSION\}\.zip"/)
})

const validManifest = {
  manifest_version: 3,
  version: '0.4.1',
  icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  action: {
    default_popup: 'src/popup.html',
    default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  },
  background: { service_worker: 'src/background.js' },
  permissions: ['activeTab', 'contextMenus', 'identity', 'scripting', 'storage'],
  commands: { 'clip-page': { suggested_key: { default: 'Alt+Shift+S' }, description: 'Clip this page to Aurora' } },
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmPkX8rpIlTKA6Xep6OKALQWl4yss2FPs8jDsCsBQEP552SD2grB7RF0oNlGCiBhJV2w2leJdbosDUV2nrTRuximrJf16fGFgwC31Q8WV/Fl9ZWVr/F0ZVFoI25Tg7UXczguN38pdu3tO2Va1hsWiv3x+Dr1JObMfoOUeHgIiF2qDvnhDFWcrJspR3mpX+ccgIdNRIeNyC+aqmO1Bnau/wXOo3t6bvOC21/Lv5VzKflHCZESBnFyHMH4EA1ixdAU+iJ3faD/qhJIn8uc2XURb6JmVL8cLoBiwiCf1Pjpn/2mmFoc6zwK4BPkCes0+V0gMA5JVi62fw0r3Z9x+GartOQIDAQAB',
  host_permissions: ['https://api.aurora.ink/*', 'https://api.auroradocs.eu/*', 'http://localhost/*', 'http://127.0.0.1/*'],
  optional_host_permissions: ['https://*/*'],
}

test('validateManifest accepts the expected standalone release manifest', async () => {
  await validateManifest({ manifest: validManifest, packageVersion: '0.4.1' })
})

test('validateManifest requires the identity permission for provider sign-in', async () => {
  const manifest = { ...validManifest, permissions: ['activeTab', 'contextMenus', 'scripting', 'storage'] }
  await assert.rejects(() => validateManifest({ manifest, packageVersion: '0.4.1' }), /identity/)
})

test('validateManifest requires the Aurora icons for the toolbar and the extensions page', async () => {
  const { icons: _icons, ...withoutIcons } = validManifest
  await assert.rejects(() => validateManifest({ manifest: withoutIcons, packageVersion: '0.4.1' }), /icon/)
  const withoutToolbarIcon = { ...validManifest, action: { default_popup: 'src/popup.html' } }
  await assert.rejects(() => validateManifest({ manifest: withoutToolbarIcon, packageVersion: '0.4.1' }), /icon/)
})

test('the manifest key pins the extension ID AuroraCloud allowlists', async () => {
  assert.equal(extensionIdFromKey(validManifest.key), CLIPPER_EXTENSION_ID)
  assert.equal(CLIPPER_EXTENSION_ID, 'aknfkfnafcppbgknjbibgpcgfhlpgcme')
  const { key: _key, ...withoutKey } = validManifest
  await assert.rejects(() => validateManifest({ manifest: withoutKey, packageVersion: '0.4.1' }), /key/)
  const otherKey = Buffer.from('not the clipper key').toString('base64')
  await assert.rejects(() => validateManifest({ manifest: { ...validManifest, key: otherKey }, packageVersion: '0.4.1' }), /extension ID/)
})

test('validateManifest rejects host_permissions containing <all_urls>', async () => {
  const manifest = { ...validManifest, host_permissions: ['<all_urls>'] }
  await assert.rejects(
    () => validateManifest({ manifest, packageVersion: '0.4.1' }),
    /must not request broad host access/,
  )
})

test('validateManifest rejects host_permissions containing https://*/*', async () => {
  const manifest = { ...validManifest, host_permissions: ['https://*/*'] }
  await assert.rejects(
    () => validateManifest({ manifest, packageVersion: '0.4.1' }),
    /must not request broad host access/,
  )
})

test('validateManifest rejects host_permissions containing *://*/*', async () => {
  const manifest = { ...validManifest, host_permissions: ['*://*/*'] }
  await assert.rejects(
    () => validateManifest({ manifest, packageVersion: '0.4.1' }),
    /must not request broad host access/,
  )
})

for (const broadPattern of ['https://*/', 'http://*/', 'https://*/foo*', '*://*/api']) {
  test(`validateManifest rejects host_permissions containing ${broadPattern}`, async () => {
    const manifest = { ...validManifest, host_permissions: [broadPattern] }
    await assert.rejects(
      () => validateManifest({ manifest, packageVersion: '0.4.1' }),
      /must not request broad host access/,
    )
  })
}

test('validateManifest rejects missing optional_host_permissions', async () => {
  const { optional_host_permissions, ...manifest } = validManifest
  await assert.rejects(
    () => validateManifest({ manifest, packageVersion: '0.4.1' }),
    /optional_host_permissions/,
  )
})

test('validateManifest rejects optional_host_permissions without https wildcard', async () => {
  const manifest = { ...validManifest, optional_host_permissions: ['https://api.example.com/*'] }
  await assert.rejects(
    () => validateManifest({ manifest, packageVersion: '0.4.1' }),
    /optional_host_permissions/,
  )
})

test('validateManifest refuses a permission that would show an install warning', async () => {
  const manifest = { ...validManifest, permissions: [...validManifest.permissions, 'tabs'] }
  await assert.rejects(() => validateManifest({ manifest, packageVersion: '0.4.1' }), /tabs/)
})

test('validateManifest requires the Alt+Shift+S clip shortcut', async () => {
  const { commands: _commands, ...manifest } = validManifest
  await assert.rejects(() => validateManifest({ manifest, packageVersion: '0.4.1' }), /Alt\+Shift\+S/)
})
