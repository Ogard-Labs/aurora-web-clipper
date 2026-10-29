import archiver from 'archiver'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const packageFiles = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'manifest.json',
  'src/auth.js',
  'src/background.js',
  'src/captureEnvelope.js',
  'src/clipperApi.js',
  'src/clipperState.js',
  'src/oauth.js',
  'src/permissions.js',
  'src/popup.html',
  'src/popup.js',
  'src/popupState.js',
  'src/tiptapHtml.js',
]

const projectRoot = new URL('..', import.meta.url)
const distDirectory = new URL('../dist/', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const archivePath = new URL(`auroradocs-web-clipper-${pkg.version}.zip`, distDirectory)
const fixedDate = new Date('1980-01-01T00:00:00.000Z')

await rm(distDirectory, { recursive: true, force: true })
await mkdir(distDirectory, { recursive: true })

const output = createWriteStream(fileURLToPath(archivePath))
const archive = archiver('zip', {
  forceLocalTime: false,
  store: true,
})
const outputFinished = finished(output)

archive.pipe(output)
for (const file of packageFiles) {
  archive.append(await readFile(new URL(file, projectRoot)), {
    date: fixedDate,
    mode: 0o100644,
    name: file,
  })
}

await archive.finalize()
await outputFinished
