import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function readCentralDirectoryEntries(contents) {
  const entries = []

  for (let offset = 0; offset <= contents.length - 46; offset += 1) {
    if (contents.readUInt32LE(offset) !== 0x02014b50) continue

    const nameLength = contents.readUInt16LE(offset + 28)
    const extraLength = contents.readUInt16LE(offset + 30)
    const commentLength = contents.readUInt16LE(offset + 32)
    entries.push({
      commentLength,
      compressionMethod: contents.readUInt16LE(offset + 10),
      dosDate: contents.readUInt16LE(offset + 14),
      dosTime: contents.readUInt16LE(offset + 12),
      externalAttributes: contents.readUInt32LE(offset + 38),
      extraLength,
      madeByPlatform: contents.readUInt8(offset + 5),
      name: contents.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
    })
    offset += 45 + nameLength + extraLength + commentLength
  }

  return entries
}

test('release package uses the exact lexical public-file allowlist', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

  await execFileAsync(process.execPath, ['scripts/package.mjs'], { cwd: projectRoot })

  const archivePath = `dist/auroradocs-web-clipper-${pkg.version}.zip`
  const archiveUrl = new URL(`../${archivePath}`, import.meta.url)
  const { stdout } = await execFileAsync('unzip', ['-Z1', archivePath], { cwd: projectRoot })
  const entries = stdout.trim().split('\n')

  assert.deepEqual(entries, [
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
    'src/oauth.js',
    'src/permissions.js',
    'src/popup.html',
    'src/popup.js',
    'src/popupState.js',
    'src/tiptapHtml.js',
  ])
})

test('release package bytes use fixed platform-independent stored entries', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

  await execFileAsync(process.execPath, ['scripts/package.mjs'], { cwd: projectRoot })

  const archiveUrl = new URL(`../dist/auroradocs-web-clipper-${pkg.version}.zip`, import.meta.url)
  const firstArchive = await readFile(archiveUrl)
  const entries = readCentralDirectoryEntries(firstArchive)

  assert.equal(entries.length, 20)
  for (const entry of entries) {
    assert.equal(entry.compressionMethod, 0, `${entry.name} must use ZIP STORE`)
    assert.equal(entry.dosDate, 33, `${entry.name} must use 1980-01-01`)
    assert.equal(entry.dosTime, 0, `${entry.name} must use 00:00:00`)
    assert.equal(entry.madeByPlatform, 3, `${entry.name} must use fixed Unix metadata`)
    assert.equal(entry.externalAttributes >>> 16, 0o100644, `${entry.name} must use mode 100644`)
    assert.equal(entry.extraLength, 0, `${entry.name} must not contain platform-specific extra data`)
    assert.equal(entry.commentLength, 0, `${entry.name} must not contain comments`)
  }

  const firstHash = sha256(firstArchive)

  await new Promise((resolve) => setTimeout(resolve, 2200))
  await execFileAsync(process.execPath, ['scripts/package.mjs'], { cwd: projectRoot })
  const secondHash = sha256(await readFile(archiveUrl))

  assert.equal(secondHash, firstHash)
})
