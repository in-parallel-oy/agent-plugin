'use strict'

// Clients cache a plugin by its version, so a content change shipped without a
// version bump reaches no one, and Codex keeps trusting the old hooks. The last
// recorded content digest is committed with the version it shipped as.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const source = path.resolve(__dirname, '..')
const RECORD = path.join(__dirname, 'plugin-content.json')
// Everything a store client installs is what the package ships, less the setup
// tool (scripts/*.js), the README and the experimental features, which setup
// installs from this checkout and never reach the store.
const CONTENT = require('../package.json').files.filter(entry => !entry.startsWith('scripts/') && !entry.startsWith('!') && entry !== 'README.md' && entry !== 'experimental')

// Tracked and new files only: git-ignored noise such as .DS_Store is not content.
function files() {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...CONTENT], { cwd: source, encoding: 'utf8' })
    .split('\0').filter(Boolean).sort()
}

function contentDigest() {
  const hash = crypto.createHash('sha256')
  for (const name of files()) {
    // The version itself is not content.
    const content = fs.readFileSync(path.join(source, name), 'utf8').replace(/"version":\s*"[^"]*"/g, '"version": ""')
    hash.update(`${name}\0${content}\0`)
  }
  return hash.digest('hex')
}

test('plugin content does not change without a version bump', () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(source, 'package.json')))
  const recorded = JSON.parse(fs.readFileSync(RECORD, 'utf8'))
  const digest = contentDigest()
  if (digest === recorded.digest) return
  assert.notEqual(version, recorded.version,
    `Plugin content changed but the version is still ${version}. Bump it with npm version, then run: UPDATE_PLUGIN_CONTENT=1 sh scripts/test.sh`)
  if (process.env.UPDATE_PLUGIN_CONTENT === '1') {
    fs.writeFileSync(RECORD, JSON.stringify({ version, digest }, null, 2) + '\n')
    return
  }
  assert.fail(`Plugin content changed for version ${version}. Record it with: UPDATE_PLUGIN_CONTENT=1 sh scripts/test.sh`)
})
