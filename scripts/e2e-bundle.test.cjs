'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { e2eFiles, main, MARKETPLACE } = require('./e2e-bundle')
const setup = require('./setup-lib')
const { DEVELOPMENT } = setup
const { SKILLS, tmp } = require('./test-helpers.cjs')

const ENDPOINT = 'http://localhost:4000/mcp'
const SECRET = 'pat_secret_value'

const out = t => path.join(tmp(t, 'in-parallel-e2e'), 'bundle')

const read = (root, name) => fs.readFileSync(path.join(root, name), 'utf8')
const walk = root => fs.readdirSync(root, { recursive: true }).filter(name => fs.statSync(path.join(root, name)).isFile())

for (const { agent, plugin, config, server } of [
  { agent: 'claude', plugin: '', config: '.mcp.json', server: { type: 'http', url: ENDPOINT, headers: { Authorization: 'Bearer ${E2E_TEST_TOKEN}' } } },
  { agent: 'codex', plugin: 'plugins/in-parallel', config: 'mcp.json', server: { type: 'streamable-http', url: ENDPOINT, bearer_token_env_var: 'E2E_TEST_TOKEN' } },
]) {
  test(`${agent}: the plugin has the hooks, skills and endpoint, and only the token variable name`, t => {
    const root = out(t)
    const logs = []
    process.env.E2E_TEST_TOKEN = SECRET
    t.after(() => delete process.env.E2E_TEST_TOKEN)
    main(['--agent', agent, '--url', ENDPOINT, '--out', root, '--token-env', 'E2E_TEST_TOKEN'], line => logs.push(line))
    const dir = path.join(root, plugin)
    assert.equal(JSON.parse(read(dir, `.${agent}-plugin/plugin.json`)).hooks, `./hooks/${agent}.json`)
    assert.deepEqual(JSON.parse(read(dir, `hooks/${agent}.json`)), JSON.parse(read(setup.SOURCE, `experimental/agent-work/hooks/${agent}.json`)))
    assert.ok(fs.existsSync(path.join(dir, 'scripts/reminders.js')))
    for (const skill of SKILLS) assert.ok(fs.existsSync(path.join(dir, 'skills', skill, 'SKILL.md')), skill)
    assert.deepEqual(JSON.parse(read(dir, config)).mcpServers.in_parallel, server)
    assert.equal(fs.existsSync(path.join(root, setup.RECEIPT)), false)
    assert.ok(!walk(root).some(name => read(root, name).includes(SECRET)))
    if (agent === 'claude') {
      // A plugin directory for --plugin-dir, without the setup marketplace.
      assert.equal(fs.existsSync(path.join(root, '.claude-plugin/marketplace.json')), false)
      assert.match(logs.join('\n'), new RegExp(`claude --plugin-dir ${root}`))
    } else {
      // A local marketplace of its own.
      const market = JSON.parse(read(root, '.agents/plugins/marketplace.json'))
      assert.equal(market.name, MARKETPLACE)
      assert.notEqual(market.name, setup.MARKETPLACE)
      assert.deepEqual(market.plugins.map(entry => entry.source.path), ['./plugins/in-parallel'])
    }
  })
}

test('without --token-env no authentication is configured', () => {
  for (const agent of ['claude', 'codex']) {
    const files = e2eFiles({ agent, url: 'http://127.0.0.1:4000/mcp' })
    const config = agent === 'claude' ? '.mcp.json' : 'plugins/in-parallel/mcp.json'
    assert.deepEqual(Object.keys(JSON.parse(files[config]).mcpServers.in_parallel).sort(), ['type', 'url'])
  }
})

test('non-loopback URLs, bad variable names, other agents and foreign directories are refused', t => {
  for (const url of [DEVELOPMENT, 'https://www.in-parallel.ai/mcp', 'https://localhost.example.com/mcp', 'http://10.0.0.1/mcp', undefined]) {
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

test('setup still adds experimental features for the Development host and localhost only, and the tool is not shipped', () => {
  for (const agent of setup.AGENTS) assert.deepEqual(setup.bundle(agent, 'https://in-parallel.example/mcp').receipt.experimental, [])
  const [{ files }] = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: setup.SOURCE, encoding: 'utf8' })
  )
  const packed = files.map(file => file.path)
  assert.ok(packed.includes('scripts/setup.js'))
  assert.ok(!packed.includes('scripts/e2e-bundle.js'))
})
