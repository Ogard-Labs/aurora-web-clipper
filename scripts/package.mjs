import archiver from 'archiver'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const packageFiles = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'icons/icon-128.png',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'manifest.json',
  'src/auth.js',
  'src/background.js',
  'src/capture.js',
  'src/captureEnvelope.js',
  'src/clipperApi.js',
  'src/clipperState.js',
  'src/menus.js',
  'src/oauth.js',
  'src/permissions.js',
  'src/popup.html',
  'src/popup.js',
  'src/popupState.js',
  'src/tiptapHtml.js',
  'src/vendor/Readability.LICENSE.md',
  'src/vendor/Readability.js',
]

const projectRoot = new URL('..', import.meta.url)
const distDirectory = new URL('../dist/', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
// --store builds the Chrome Web Store upload: the same files, with the
// manifest `key` removed because the store refuses it and assigns its own ID.
const forStore = process.argv.includes('--store')
const archivePath = new URL(`auroradocs-web-clipper-${pkg.version}${forStore ? '-chrome-web-store' : ''}.zip`, distDirectory)
const fixedDate = new Date('1980-01-01T00:00:00.000Z')

if (forStore) await rm(archivePath, { force: true })
else await rm(distDirectory, { recursive: true, force: true })
await mkdir(distDirectory, { recursive: true })

async function fileContents(file) {
  const contents = await readFile(new URL(file, projectRoot))
  if (!forStore || file !== 'manifest.json') return contents
  const { key: _key, ...manifest } = JSON.parse(contents.toString('utf8'))
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
}

const output = createWriteStream(fileURLToPath(archivePath))
const archive = archiver('zip', {
  forceLocalTime: false,
  store: true,
})
const outputFinished = finished(output)

archive.pipe(output)
for (const file of packageFiles) {
  archive.append(await fileContents(file), {
    date: fixedDate,
    mode: 0o100644,
    name: file,
  })
}

await archive.finalize()
await outputFinished
