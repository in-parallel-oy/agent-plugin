'use strict'

// Clients cache a plugin by its version, so a content change shipped without a
// version bump reaches no one, and Codex keeps trusting the old hooks. The last
// recorded content digest is committed with the version it shipped as.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const source = path.resolve(__dirname, '..')
const RECORD = path.join(__dirname, 'plugin-content.json')
// Everything a client installs: skills, hooks and their scripts, connection and manifests.
const CONTENT = ['skills', 'experimental', 'assets', 'mcp.json', '.mcp.json', 'plugin.json',
  '.claude-plugin', '.codex-plugin', '.cursor-plugin', '.agents', 'LICENSE', 'NOTICE']
const VERSIONED = ['package.json', 'plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json']

function files(name) {
  const file = path.join(source, name)
  return fs.statSync(file).isDirectory()
    ? fs.readdirSync(file).sort().flatMap(entry => files(path.join(name, entry)))
    : [name]
}

function contentDigest() {
  const hash = crypto.createHash('sha256')
  for (const name of CONTENT.flatMap(files)) {
    // The version itself is not content.
    const content = fs.readFileSync(path.join(source, name), 'utf8').replace(/"version":\s*"[^"]*"/g, '"version": ""')
    hash.update(`${name.split(path.sep).join('/')}\0${content}\0`)
  }
  return hash.digest('hex')
}

test('every manifest carries the package version', () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(source, 'package.json')))
  for (const name of VERSIONED) assert.equal(JSON.parse(fs.readFileSync(path.join(source, name))).version, version, name)
  for (const plugin of JSON.parse(fs.readFileSync(path.join(source, '.claude-plugin/marketplace.json'))).plugins) assert.equal(plugin.version, version)
  const lock = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json')))
  assert.deepEqual([lock.version, lock.packages[''].version], [version, version])
})

test('plugin content does not change without a version bump', () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(source, 'package.json')))
  const recorded = JSON.parse(fs.readFileSync(RECORD, 'utf8'))
  const digest = contentDigest()
  if (digest === recorded.digest) return
  assert.notEqual(version, recorded.version,
    `Plugin content changed but the version is still ${version}. Bump the version in ${VERSIONED.join(', ')}, .claude-plugin/marketplace.json and package-lock.json, then run: UPDATE_PLUGIN_CONTENT=1 sh scripts/test.sh`)
  if (process.env.UPDATE_PLUGIN_CONTENT === '1') {
    fs.writeFileSync(RECORD, JSON.stringify({ version, digest }, null, 2) + '\n')
    return
  }
  assert.fail(`Plugin content changed for version ${version}. Record it with: UPDATE_PLUGIN_CONTENT=1 sh scripts/test.sh`)
})
