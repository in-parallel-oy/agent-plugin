'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { unzipSync } = require('fflate')
const { packageFiles } = require('./package')
const source = path.resolve(__dirname, '..')

for (const client of ['claude', 'codex', 'chatgpt-desktop']) {
  test(`${client}: export includes executable hooks and literal MCP endpoints without local state`, () => {
    const files = packageFiles(client, { url: 'https://demo.example/mcp' })
    const kind = client === 'claude' ? 'claude' : 'codex'
    const manifest = JSON.parse(files[`.${kind}-plugin/plugin.json`])
    assert.ok(files[manifest.hooks.slice(2)])
    assert.ok(files['skills/in-parallel-work/SKILL.md'])
    assert.deepEqual(files.LICENSE, fs.readFileSync(path.join(source, 'LICENSE')))
    assert.deepEqual(files.NOTICE, fs.readFileSync(path.join(source, 'NOTICE')))
    for (const name of ['.mcp.json', 'mcp.json']) assert.equal(JSON.parse(files[name]).mcpServers.in_parallel.url, 'https://demo.example/mcp')
    assert.ok(Object.keys(files).every(name => /^(skills\/|scripts\/|hooks\/|\.(claude|codex)-plugin\/plugin.json$|\.?mcp.json$|LICENSE$|NOTICE$)/.test(name)))
    assert.equal(files['plugin.json'], undefined)
    assert.equal(files['scripts/setup.js'], undefined)
  })
}

test('ChatGPT web packages only skills and an existing app reference', () => {
  assert.throws(() => packageFiles('chatgpt-web'), /existing registered/)
  assert.throws(() => packageFiles('chatgpt-web', { appId: 'plugin_123' }), /existing registered/)
  for (const appId of ['asdk_app_test', 'connector_test', 'templated_apps_test']) {
    const files = packageFiles('chatgpt-web', { appId })
    assert.deepEqual(JSON.parse(files['.app.json']), { apps: { in_parallel: { id: appId, required: true } } })
    const manifest = JSON.parse(files['.codex-plugin/plugin.json'])
    assert.equal(manifest.apps, './.app.json')
    assert.equal(manifest.hooks, undefined)
    assert.equal(manifest.mcpServers, undefined)
    assert.ok(files['skills/in-parallel-work/SKILL.md'])
    assert.deepEqual(files.LICENSE, fs.readFileSync(path.join(source, 'LICENSE')))
    assert.deepEqual(files.NOTICE, fs.readFileSync(path.join(source, 'NOTICE')))
    assert.ok(!Object.keys(files).some(name => /mcp|^hooks\/|^scripts\//.test(name)))
  }
})

test('rejects incompatible clients, endpoints, and app references before creating files', () => {
  assert.throws(() => packageFiles('copilot'), /Choose a client/)
  assert.throws(() => packageFiles('chatgpt-web', { appId: 'asdk_app_test', url: 'https://example.com/mcp' }), /omit --url/)
  assert.throws(() => packageFiles('claude', { url: 'http://localhost:4000/mcp' }), /connects from the cloud/)
  assert.throws(() => packageFiles('codex', { url: 'https://user:secret@example.com/mcp' }), /HTTPS MCP/)
  assert.throws(() => packageFiles('codex', { appId: 'asdk_app_test' }), /only supported/)
})

test('Claude cloud packages reject HTTPS loopback endpoints without restricting local Codex packages', () => {
  for (const url of [
    'https://localhost:54104/mcp', 'https://LOCALHOST./mcp', 'https://app.localhost/mcp',
    'https://127.0.0.1/mcp', 'https://127.1.2.3/mcp', 'https://2130706433/mcp',
    'https://[::1]/mcp', 'https://[::ffff:127.0.0.1]/mcp',
  ]) {
    assert.throws(() => packageFiles('claude', { url }), /connects from the cloud/)
    assert.equal(JSON.parse(packageFiles('codex', { url })['mcp.json']).mcpServers.in_parallel.url, new URL(url).href)
  }
  const url = 'https://localhost.example.com/mcp'
  assert.equal(JSON.parse(packageFiles('claude', { url })['.mcp.json']).mcpServers.in_parallel.url, url)
})

test('creates an uploadable ZIP without client CLIs and refuses to overwrite an existing archive', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'in-parallel-package-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const output = path.join(dir, 'plugin.zip')
  const run = () => spawnSync(process.execPath, [path.join(__dirname, 'package.js'), '--client', 'claude', '--output', output], { encoding: 'utf8', env: { ...process.env, PATH: dir } })
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  const archive = fs.readFileSync(output)
  assert.ok(unzipSync(archive)['.claude-plugin/plugin.json'])
  assert.equal(run().status, 1)
  assert.deepEqual(fs.readFileSync(output), archive)
})

test('portable and native OpenAI manifests agree on hooks and presentation', () => {
  const portable = JSON.parse(fs.readFileSync(path.join(source, 'plugin.json')))
  const native = JSON.parse(fs.readFileSync(path.join(source, '.codex-plugin/plugin.json')))
  assert.deepEqual(portable.extensions['com.openai'], { hooks: native.hooks, interface: native.interface })
  const marketplace = JSON.parse(fs.readFileSync(path.join(source, '.agents/plugins/marketplace.json')))
  assert.equal(marketplace.plugins[0].source.path, './')
  for (const name of ['package.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(source, name))).version, native.version)
  }
  assert.equal(portable.version, native.version)
})

test('changing a registered app invalidates the cloud package cache version', () => {
  const version = appId => JSON.parse(packageFiles('chatgpt-web', { appId })['.codex-plugin/plugin.json']).version
  assert.equal(version('asdk_app_first'), version('asdk_app_first'))
  assert.notEqual(version('asdk_app_first'), version('asdk_app_second'))
})
