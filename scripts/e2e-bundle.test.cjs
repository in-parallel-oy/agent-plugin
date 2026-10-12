'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { e2eFiles, main, MARKETPLACE } = require('./e2e-bundle')
const setup = require('./setup-lib')

const ENDPOINT = 'http://localhost:4000/mcp'
const SECRET = 'pat_secret_value'

function out(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'in-parallel-e2e-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'bundle')
}

const read = (root, name) => fs.readFileSync(path.join(root, name), 'utf8')
const walk = root => fs.readdirSync(root, { recursive: true }).filter(name => fs.statSync(path.join(root, name)).isFile())

test('Claude Code gets a plugin directory with the hooks, skills and endpoint, and only the token variable name', t => {
  const root = out(t)
  const logs = []
  process.env.E2E_TEST_TOKEN = SECRET
  t.after(() => delete process.env.E2E_TEST_TOKEN)
  main(['--agent', 'claude', '--url', ENDPOINT, '--out', root, '--token-env', 'E2E_TEST_TOKEN'], line => logs.push(line))
  const manifest = JSON.parse(read(root, '.claude-plugin/plugin.json'))
  assert.equal(manifest.hooks, './hooks/claude.json')
  assert.deepEqual(JSON.parse(read(root, 'hooks/claude.json')), JSON.parse(read(setup.SOURCE, 'experimental/agent-work/hooks/claude.json')))
  assert.ok(fs.existsSync(path.join(root, 'scripts/reminders.js')))
  for (const skill of ['in-parallel', 'in-parallel-agent-work', 'work-on']) assert.ok(fs.existsSync(path.join(root, 'skills', skill, 'SKILL.md')), skill)
  assert.deepEqual(JSON.parse(read(root, '.mcp.json')).mcpServers.in_parallel, { type: 'http', url: ENDPOINT, headers: { Authorization: 'Bearer ${E2E_TEST_TOKEN}' } })
  assert.equal(fs.existsSync(path.join(root, '.claude-plugin/marketplace.json')), false)
  assert.equal(fs.existsSync(path.join(root, setup.RECEIPT)), false)
  assert.ok(!walk(root).some(name => read(root, name).includes(SECRET)))
  assert.match(logs.join('\n'), new RegExp(`claude --plugin-dir ${root}`))
})

test('Codex gets a local marketplace with the hooks, skills and endpoint, and bearer_token_env_var', t => {
  const root = out(t)
  process.env.E2E_TEST_TOKEN = SECRET
  t.after(() => delete process.env.E2E_TEST_TOKEN)
  main(['--agent', 'codex', '--url', ENDPOINT, '--out', root, '--token-env', 'E2E_TEST_TOKEN'], () => {})
  const plugin = path.join(root, 'plugins/in-parallel')
  const market = JSON.parse(read(root, '.agents/plugins/marketplace.json'))
  assert.equal(market.name, MARKETPLACE)
  assert.notEqual(market.name, setup.MARKETPLACE)
  assert.deepEqual(market.plugins.map(entry => entry.source.path), ['./plugins/in-parallel'])
  assert.equal(JSON.parse(read(plugin, '.codex-plugin/plugin.json')).hooks, './hooks/codex.json')
  assert.deepEqual(JSON.parse(read(plugin, 'hooks/codex.json')), JSON.parse(read(setup.SOURCE, 'experimental/agent-work/hooks/codex.json')))
  for (const skill of ['in-parallel', 'in-parallel-agent-work', 'work-on']) assert.ok(fs.existsSync(path.join(plugin, 'skills', skill, 'SKILL.md')), skill)
  assert.deepEqual(JSON.parse(read(plugin, 'mcp.json')).mcpServers.in_parallel, { type: 'streamable-http', url: ENDPOINT, bearer_token_env_var: 'E2E_TEST_TOKEN' })
  assert.ok(!walk(root).some(name => read(root, name).includes(SECRET)))
})

test('without --token-env no authentication is configured', () => {
  for (const agent of ['claude', 'codex']) {
    const files = e2eFiles({ agent, url: 'http://127.0.0.1:4000/mcp' })
    const config = agent === 'claude' ? '.mcp.json' : 'plugins/in-parallel/mcp.json'
    assert.deepEqual(Object.keys(JSON.parse(files[config]).mcpServers.in_parallel).sort(), ['type', 'url'])
  }
})

test('non-loopback URLs, bad variable names, other agents and foreign directories are refused', t => {
  for (const url of ['https://www.in-parallel.dev/mcp', 'https://www.in-parallel.ai/mcp', 'https://localhost.example.com/mcp', 'http://10.0.0.1/mcp', undefined]) {
    assert.throws(() => e2eFiles({ agent: 'claude', url }), /loopback|HTTPS MCP URL/, String(url))
  }
  assert.throws(() => e2eFiles({ agent: 'claude', url: ENDPOINT, tokenEnv: 'A=B' }), /variable name/)
  for (const agent of ['cursor', 'other', undefined]) assert.throws(() => e2eFiles({ agent, url: ENDPOINT }), /Choose an agent/)
  const root = out(t)
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'keep.txt'), 'mine')
  assert.throws(() => main(['--agent', 'claude', '--url', ENDPOINT, '--out', root], () => {}), /not written by this tool/)
  assert.equal(read(root, 'keep.txt'), 'mine')
  // Its own output can be rewritten.
  const own = out(t)
  main(['--agent', 'claude', '--url', ENDPOINT, '--out', own], () => {})
  main(['--agent', 'codex', '--url', ENDPOINT, '--out', own], () => {})
  assert.ok(fs.existsSync(path.join(own, '.agents/plugins/marketplace.json')))
})

test('setup still adds experimental features for the Development host only, and the tool is not shipped', () => {
  for (const agent of setup.AGENTS) assert.deepEqual(setup.bundle(agent, ENDPOINT).receipt.experimental, [])
  const files = JSON.parse(fs.readFileSync(path.join(setup.SOURCE, 'package.json'), 'utf8')).files
  assert.ok(files.includes('!scripts/e2e-bundle.js'))
})
