#!/usr/bin/env node
'use strict'

// Copies the version from package.json into every manifest that repeats it.
// `npm version <patch|minor|x.y.z>` bumps package.json and the lockfile, then
// runs this as its `version` script and commits the result.

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
// [file, path to the version field]
const VERSIONED = [
  ['server.json', ['version']],
  ['.claude-plugin/marketplace.json', ['plugins', 0, 'version']],
  ['plugins/in-parallel/plugin.json', ['version']],
  ['plugins/in-parallel/.claude-plugin/plugin.json', ['version']],
  ['plugins/in-parallel/.codex-plugin/plugin.json', ['version']],
  ['plugins/in-parallel/.cursor-plugin/plugin.json', ['version']],
]

const read = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))

function sync(version = read('package.json').version) {
  for (const [file, keys] of VERSIONED) {
    const json = read(file)
    keys.slice(0, -1).reduce((node, key) => node[key], json)[keys.at(-1)] = version
    fs.writeFileSync(path.join(ROOT, file), JSON.stringify(json, null, 2) + '\n')
  }
  return VERSIONED.map(([file]) => file)
}

if (require.main === module) console.log(`Set ${read('package.json').version} in ${sync().join(', ')}`)

module.exports = { VERSIONED, read }
