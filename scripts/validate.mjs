import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const requiredPermissions = new Set(['activeTab', 'identity', 'scripting', 'storage'])

// AuroraCloud relays provider sign-ins only to this extension ID
// (AURORA_AUTH_CLIPPER_EXTENSION_IDS). The manifest key fixes it; a different
// key would give every install a new ID that the server refuses.
export const CLIPPER_EXTENSION_ID = 'aknfkfnafcppbgknjbibgpcgfhlpgcme'

// Chrome's rule: the first 32 hex digits of SHA-256 over the public key,
// with 0–f mapped to a–p.
export function extensionIdFromKey(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('')
}

const broadHostPatterns = new Set(['<all_urls>'])
const broadWildcardHostPattern = /^(?:https?|\*):\/\/\*\//

function isBroadHostPattern(value) {
  return typeof value === 'string' && (broadHostPatterns.has(value) || broadWildcardHostPattern.test(value))
}

export async function validateManifest({ manifest, packageVersion }) {
  for (const permission of requiredPermissions) {
    if (!manifest.permissions?.includes(permission)) {
      throw new Error(`manifest.json is missing permission: ${permission}`)
    }
  }

  if (manifest.manifest_version !== 3) {
    throw new Error('Aurora Web Clipper must stay on Manifest V3')
  }

  if (manifest.version !== packageVersion) {
    throw new Error(`manifest.json version ${manifest.version} does not match package.json version ${packageVersion}`)
  }

  if (typeof manifest.key !== 'string' || !manifest.key) {
    throw new Error('manifest.json must define the key that fixes the extension ID')
  }

  if (extensionIdFromKey(manifest.key) !== CLIPPER_EXTENSION_ID) {
    throw new Error(`manifest.json key gives extension ID ${extensionIdFromKey(manifest.key)}, expected ${CLIPPER_EXTENSION_ID}`)
  }

  if (!manifest.action?.default_popup) {
    throw new Error('manifest.json must define action.default_popup')
  }

  for (const size of [16, 32, 48, 128]) {
    const icon = `icons/icon-${size}.png`
    if (manifest.icons?.[size] !== icon || manifest.action.default_icon?.[size] !== icon) {
      throw new Error(`manifest.json must use ${icon} as the ${size}px icon and toolbar icon`)
    }
  }

  if (!manifest.background?.service_worker) {
    throw new Error('manifest.json must define background.service_worker')
  }

  const requiredHosts = manifest.host_permissions ?? []
  const broadRequired = requiredHosts.find(isBroadHostPattern)
  if (broadRequired) {
    throw new Error(`Aurora Web Clipper must not request broad host access (${broadRequired})`)
  }

  if (!manifest.optional_host_permissions?.includes('https://*/*')) {
    throw new Error('manifest.json must declare optional_host_permissions containing "https://*/*"')
  }

  await readFile(new URL(`../${manifest.action.default_popup}`, import.meta.url), 'utf8')
  await readFile(new URL(`../${manifest.background.service_worker}`, import.meta.url), 'utf8')
  for (const size of [16, 32, 48, 128]) {
    await readFile(new URL(`../icons/icon-${size}.png`, import.meta.url))
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'))
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

  await validateManifest({ manifest, packageVersion: pkg.version })

  console.log('Aurora Web Clipper manifest is valid.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
