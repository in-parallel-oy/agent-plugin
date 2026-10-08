'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const setup = require('./setup-lib')
// The shipped default endpoint, read rather than repeated so fixtures follow the config.
const PRODUCTION = JSON.parse(fs.readFileSync(path.join(setup.SOURCE, 'mcp.json'), 'utf8')).mcpServers.in_parallel.url

// Everything the retired work journal hooks left in ~/.in-parallel, plus a file setup must keep.
function journalCache(home) {
  const dir = path.join(home, '.in-parallel')
  for (const name of ['contributions.lock', 'sessions', 'lock-1-a']) fs.mkdirSync(path.join(dir, name), { recursive: true })
  for (const name of ['contributions.json', 'contributions.json.1.a.tmp', 'sessions/marker.json', 'keep.txt']) fs.writeFileSync(path.join(dir, name), 'cache')
  return () => fs.readdirSync(dir).filter(name => name !== 'setup').sort()
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'in-parallel-setup-test-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

function host(agent, home) {
  const state = { plugins: [], marketplaces: [], calls: [], failInstall: false, failRemove: false, ignoreRemove: false, stale: false, claudeVersion: '2.1.263 (Claude Code)' }
  state.execute = (command, args, options) => {
    assert.equal(command, agent.command)
    state.calls.push(args)
    if (args.join(' ') === 'mcp get in_parallel --json') {
      assert.equal(options.capture, true)
      if (state.missingMcp) throw new Error('No MCP server found')
      return state.mcp || { enabled: true, transport: { type: 'streamable_http',
        url: setup.managed(setup.target(agent, home), agent).endpoint } }
    }
    if (args.join(' ') === '--version') { assert.equal(options.capture, 'text'); return state.claudeVersion }
    if (args.join(' ') === 'plugin list --json') {
      assert.equal(options.capture, true)
      return agent.id === 'codex' ? { installed: state.plugins, available: [] } : state.plugins
    }
    if (args.join(' ') === 'plugin marketplace list --json') {
      return agent.id === 'codex' ? { marketplaces: state.marketplaces } : state.marketplaces
    }
    if (args[1] === 'marketplace') {
      if (args[2] === 'add') state.marketplaces.push({ name: setup.MARKETPLACE,
        [agent.id === 'codex' ? 'root' : 'path']: args[3] })
      if (args[2] === 'remove') state.marketplaces = state.marketplaces.filter(market => market.name !== args[3])
      return
    }
    if (['add', 'install', 'update'].includes(args[1])) {
      if (state.failInstall) throw new Error('Native installation failed')
      const receipt = setup.managed(setup.target(agent, home), agent)
      state.plugins = [...state.plugins.filter(plugin => (plugin.pluginId || plugin.id) !== setup.PLUGIN),
        { [agent.id === 'codex' ? 'pluginId' : 'id']: setup.PLUGIN,
        version: state.stale ? '0.0.0' : receipt.version, enabled: true, scope: 'user' }]
    } else if (['remove', 'uninstall'].includes(args[1])) {
      if (state.failRemove) throw new Error('Native removal failed')
      if (!state.ignoreRemove) state.plugins = state.plugins.filter(plugin => (plugin.pluginId || plugin.id) !== args[2])
    }
    else throw new Error(`Unexpected command: ${args.join(' ')}`)
  }
  return state
}

test('endpoint accepts production and loopback development without embedding secrets', () => {
  for (const url of [PRODUCTION, 'http://localhost:54104/mcp', 'http://127.0.0.1:5000/mcp', 'http://[::1]:5000/mcp']) assert.equal(setup.endpoint(url), url)
  for (const url of ['http://some-server/mcp', 'https://user:secret@host/mcp', 'https://host/mcp?token=secret', 'https://host/mcp#token', 'file:///tmp/mcp']) assert.throws(() => setup.endpoint(url), /Use an HTTPS/)
})

for (const agent of setup.AGENTS) {
  test(`${agent.name}: install, rerun, diagnose, and remove only managed files`, t => {
    const home = fixture(t)
    const native = host(agent, home)
    const logs = []
    const options = { home, cwd: home, env: {}, execute: native.execute, log: line => logs.push(line) }
    const remaining = journalCache(home)
    setup.install(agent, 'http://localhost:54104/mcp', options)
    assert.deepEqual(remaining(), ['keep.txt'])
    assert.ok(logs.some(line => /Removed the retired work journal cache/.test(line)))
    const root = setup.target(agent, home)
    const first = setup.managed(root, agent)
    setup.install(agent, 'http://localhost:54104/mcp', options)
    assert.deepEqual(setup.managed(root, agent), first)
    assert.equal(native.marketplaces.length, agent.command ? 1 : 0)
    journalCache(home)
    setup.doctor(agent, options)
    assert.deepEqual(remaining(), ['keep.txt'])
    assert.ok(logs.some(line => /To verify, ask your agent: Check my In Parallel connection\.\n/.test(line)))
    assert.ok(!logs.some(line => /Experimental|Send to AI|work journal setup|hooks/.test(line)))
    const plugin = agent.id === 'cursor' ? root : path.join(root, 'plugins', 'in-parallel')
    assert.equal(fs.existsSync(path.join(plugin, 'plugin.json')), false)
    for (const file of ['.mcp.json', 'mcp.json']) {
      const expected = JSON.parse(fs.readFileSync(path.join(setup.SOURCE, file), 'utf8'))
      assert.deepEqual(Object.keys(expected.mcpServers), ['in_parallel'])
      expected.mcpServers.in_parallel.url = 'http://localhost:54104/mcp'
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plugin, file), 'utf8')), expected)
    }
    assert.equal(fs.existsSync(path.join(plugin, 'scripts')), false)
    journalCache(home)
    setup.uninstall(agent, options)
    assert.equal(fs.existsSync(root), false)
    assert.equal(native.plugins.length, 0)
    assert.equal(native.marketplaces.length, 0)
    assert.deepEqual(remaining(), ['keep.txt'])
  })

  test(`${agent.name}: dry run makes no files or native mutations`, t => {
    const home = fixture(t)
    const native = host(agent, home)
    const remaining = journalCache(home)
    const before = remaining()
    setup.install(agent, PRODUCTION, { home, cwd: home, env: {}, execute: native.execute, dryRun: true, log() {} })
    assert.equal(fs.existsSync(setup.target(agent, home)), false)
    assert.ok(native.calls.every(args => args.includes('list')))
    setup.uninstall(agent, { home, execute: native.execute, dryRun: true, log() {} })
    assert.deepEqual(remaining(), before)
  })

  test(`${agent.name}: locally modified files survive updates and uninstall`, t => {
    const home = fixture(t)
    const native = host(agent, home)
    const options = { home, cwd: home, env: {}, execute: native.execute, log() {} }
    setup.install(agent, PRODUCTION, options)
    const root = setup.target(agent, home)
    const custom = path.join(root, 'custom.txt')
    fs.writeFileSync(custom, 'keep this')
    const before = native.calls.length
    assert.throws(() => setup.install(agent, 'http://localhost:54104/mcp', options), /Installed files were changed/)
    assert.throws(() => setup.uninstall(agent, options), /Installed files were changed/)
    assert.equal(fs.readFileSync(custom, 'utf8'), 'keep this')
    assert.equal(native.calls.length, before)
  })
}

test('source and environment changes produce new cache versions without changing the checkout', t => {
  const home = fixture(t)
  const source = path.join(home, 'source')
  fs.cpSync(setup.SOURCE, source, { recursive: true, filter: file => !['node_modules', '.git'].includes(path.basename(file)) })
  const agent = setup.AGENTS[1]
  const original = fs.readFileSync(path.join(source, 'mcp.json'), 'utf8')
  const prod = setup.bundle(agent, PRODUCTION, source)
  const local = setup.bundle(agent, 'http://localhost:54104/mcp', source)
  assert.notEqual(prod.receipt.version, local.receipt.version)
  fs.appendFileSync(path.join(source, 'skills/in-parallel/SKILL.md'), '\nUpdated skill\n')
  assert.notEqual(setup.bundle(agent, 'http://localhost:54104/mcp', source).receipt.version, local.receipt.version)
  assert.equal(fs.readFileSync(path.join(source, 'mcp.json'), 'utf8'), original)
})

test('foreign plugins and marketplace collisions stop before creating files', t => {
  const home = fixture(t)
  const agent = setup.AGENTS[1]
  const native = host(agent, home)
  native.plugins = [{ pluginId: 'in-parallel@personal', enabled: true }]
  assert.throws(() => setup.install(agent, PRODUCTION, { home, cwd: home, env: {}, execute: native.execute }), setup.ReplacementRequired)
  assert.equal(fs.existsSync(setup.target(agent, home)), false)
  native.plugins = []
  native.marketplaces = [{ name: setup.MARKETPLACE, path: '/someone/else' }]
  assert.throws(() => setup.install(agent, PRODUCTION, { home, cwd: home, env: {}, execute: native.execute }), /marketplace already exists/)
  assert.equal(fs.existsSync(setup.target(agent, home)), false)
})

test('failed native installation can be retried and stale registration is not success', t => {
  const home = fixture(t)
  const agent = setup.AGENTS[0]
  const native = host(agent, home)
  const options = { home, cwd: home, env: {}, execute: native.execute, log() {} }
  native.failInstall = true
  assert.throws(() => setup.install(agent, PRODUCTION, options), /Native installation failed/)
  native.failInstall = false
  native.stale = true
  assert.throws(() => setup.install(agent, PRODUCTION, options), /expected enabled plugin version/)
  native.stale = false
  setup.install(agent, PRODUCTION, options)
  assert.equal(native.marketplaces.length, 1)
})

test('unmanaged directories and symlinks are never replaced', t => {
  const home = fixture(t)
  const agent = setup.AGENTS[2]
  const root = setup.target(agent, home)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'mine.txt'), 'keep')
  assert.throws(() => setup.install(agent, PRODUCTION, { home, cwd: home, env: {} }), /not managed/)
  fs.rmSync(root, { recursive: true })
  const other = path.join(home, 'other')
  fs.mkdirSync(other)
  fs.symlinkSync(other, root)
  assert.throws(() => setup.install(agent, PRODUCTION, { home, cwd: home, env: {} }), /symlink/)
  assert.equal(fs.existsSync(other), true)
})


test('only the Development environment adds experimental features, and reminder hooks only for Claude Code and Codex', () => {
  for (const agent of setup.AGENTS) {
    const prefix = agent.id === 'cursor' ? '' : 'plugins/in-parallel/'
    for (const url of [PRODUCTION, 'http://localhost:54104/mcp', 'https://in-parallel.example/mcp',
      'https://staging.in-parallel.dev/mcp', 'https://www.in-parallel.dev.example.com/mcp']) {
      const stable = setup.bundle(agent, url)
      assert.deepEqual(stable.receipt.experimental, [], url)
      assert.ok(!Object.keys(stable.files).some(name => /in-parallel-agent-work|work-on|(^|\/)(hooks|scripts)\//.test(name)), url)
      assert.equal(JSON.parse(stable.files[`${prefix}.${agent.id}-plugin/plugin.json`]).hooks, undefined)
    }
    for (const url of ['https://www.in-parallel.dev/mcp', 'https://in-parallel.dev/mcp']) {
      const dev = setup.bundle(agent, url)
      assert.deepEqual(dev.receipt.experimental, ['agent-work'])
      for (const skill of ['in-parallel', 'in-parallel-agent-work', 'work-on']) assert.ok(dev.files[`${prefix}skills/${skill}/SKILL.md`], skill)
      assert.ok(dev.files[`${prefix}skills/work-on/agents/openai.yaml`])
      const manifest = JSON.parse(dev.files[`${prefix}.${agent.id}-plugin/plugin.json`])
      const extra = Object.keys(dev.files).filter(name => /(^|\/)(hooks|scripts)\//.test(name)).sort()
      if (agent.id === 'cursor') {
        assert.equal(manifest.hooks, undefined)
        assert.deepEqual(extra, [])
        continue
      }
      assert.equal(manifest.hooks, `./hooks/${agent.id}.json`)
      assert.deepEqual(extra, [`${prefix}hooks/${agent.id}.json`, `${prefix}scripts/reminders.js`])
      const hooks = JSON.parse(dev.files[`${prefix}hooks/${agent.id}.json`]).hooks
      assert.deepEqual(Object.keys(hooks), ['UserPromptSubmit', 'PostToolUse', 'Stop'])
      const root = agent.id === 'claude' ? '${CLAUDE_PLUGIN_ROOT}' : '${PLUGIN_ROOT}'
      for (const groups of Object.values(hooks)) {
        for (const hook of groups.flatMap(group => group.hooks)) assert.equal(hook.command, `node "${root}/scripts/reminders.js"`)
      }
    }
  }
})

test('doctor asks to rerun setup for work journal receipts and accepts the current feature set', t => {
  const home = fixture(t)
  const agent = setup.AGENTS.find(agent => agent.id === 'cursor')
  const logs = []
  const options = { home, cwd: home, env: {}, log: message => logs.push(message) }
  const file = path.join(setup.target(agent, home), setup.RECEIPT)
  for (const url of ['https://www.in-parallel.dev/mcp', 'http://localhost:54104/mcp']) {
    setup.install(agent, url, options)
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const experimental of [['work-claims'], undefined]) {
      fs.writeFileSync(file, JSON.stringify({ ...receipt, experimental }))
      assert.throws(() => setup.doctor(agent, options), /retired work journal\. Run setup again/)
    }
    setup.install(agent, url, options)
    logs.length = 0
    setup.doctor(agent, options)
    const dev = url.startsWith('https:')
    assert.equal(/Experimental: agent-work/.test(logs.join('\n')), dev)
    assert.equal(/Send to AI/.test(logs.join('\n')), dev)
  }
  setup.install(agent, PRODUCTION, options)
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...receipt, experimental: ['agent-work'] }))
  assert.throws(() => setup.doctor(agent, options), /outdated experimental features/)
})

for (const agent of setup.AGENTS) {
  test(`${agent.name}: Development install adds the work-on command and reminders; doctor reports them; uninstall removes them`, t => {
    const home = fixture(t)
    const native = host(agent, home)
    const logs = []
    const options = { home, cwd: home, env: {}, execute: native.execute, log: line => logs.push(line) }
    const url = 'https://www.in-parallel.dev/mcp'
    setup.install(agent, url, options)
    const root = setup.target(agent, home)
    const plugin = agent.id === 'cursor' ? root : path.join(root, 'plugins', 'in-parallel')
    const hooks = agent.id !== 'cursor'
    assert.ok(fs.existsSync(path.join(plugin, 'skills', 'work-on', 'SKILL.md')))
    assert.equal(fs.existsSync(path.join(plugin, 'scripts', 'reminders.js')), hooks)
    assert.equal(fs.existsSync(path.join(plugin, 'hooks', `${agent.id}.json`)), hooks)
    assert.equal(/\/hooks/.test(logs.join('\n')), hooks)
    logs.length = 0
    setup.doctor(agent, options)
    const report = logs.join('\n')
    assert.match(report, /Experimental: agent-work\nCommands: work-on\n/)
    assert.match(report, hooks ? /Reminder hooks: on prompts with an In Parallel link, after pull requests, and before stopping/ : /Reminder hooks: not available for this client/)
    assert.match(report, /work-on command/)

    // A copy installed before the command and reminders existed needs setup again.
    const file = path.join(root, setup.RECEIPT)
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'))
    const prefix = agent.id === 'cursor' ? '' : 'plugins/in-parallel/'
    for (const name of Object.keys(receipt.files).filter(name => name.startsWith(`${prefix}skills/work-on/`) || /(^|\/)(hooks|scripts)\//.test(name))) {
      fs.rmSync(path.join(root, name))
      delete receipt.files[name]
    }
    fs.writeFileSync(file, JSON.stringify(receipt))
    assert.throws(() => setup.doctor(agent, options), /installed with outdated files\. Run setup again/)
    setup.install(agent, url, options)
    setup.doctor(agent, options)

    // A production copy missing a newer base skill file needs setup again too, without naming experimental features.
    setup.install(agent, PRODUCTION, options)
    const base = JSON.parse(fs.readFileSync(file, 'utf8'))
    const skill = Object.keys(base.files).find(name => name.startsWith(`${prefix}skills/in-parallel/`))
    fs.rmSync(path.join(root, skill))
    delete base.files[skill]
    fs.writeFileSync(file, JSON.stringify(base))
    assert.throws(() => setup.doctor(agent, options), error => /installed with outdated files\./.test(error.message) && !/experimental/.test(error.message))

    setup.uninstall(agent, options)
    assert.equal(fs.existsSync(root), false)
  })
}

test('Cursor replacement stages outside plugin discovery and restores the prior bundle on failure', t => {
  const home = fixture(t)
  const agent = setup.AGENTS.find(agent => agent.id === 'cursor')
  const options = { home, cwd: home, env: {}, log() {} }
  setup.install(agent, PRODUCTION, options)
  const root = setup.target(agent, home)
  const previous = setup.managed(root, agent)
  const discovery = path.dirname(root)
  const observed = []
  const rename = fs.renameSync
  let failed = false
  t.mock.method(fs, 'renameSync', (from, to) => {
    observed.push(fs.readdirSync(discovery))
    if (to === root && !failed) { failed = true; throw new Error('Simulated installation failure') }
    return rename(from, to)
  })
  assert.throws(() => setup.install(agent, 'http://localhost:54104/mcp', options), /Simulated installation failure/)
  assert.deepEqual(setup.managed(root, agent), previous)
  for (const entries of observed) assert.ok(entries.every(name => name === 'in-parallel'), entries.join(', '))
  assert.deepEqual(fs.readdirSync(discovery), ['in-parallel'])
})

test('Cursor replacement refuses cross-filesystem staging before moving the installed plugin', t => {
  const home = fixture(t)
  const agent = setup.AGENTS.find(agent => agent.id === 'cursor')
  const options = { home, cwd: home, env: {}, log() {} }
  setup.install(agent, PRODUCTION, options)
  const root = setup.target(agent, home)
  const previous = setup.managed(root, agent)
  const stat = fs.statSync
  t.mock.method(fs, 'statSync', (file, ...args) => {
    const result = stat(file, ...args)
    if (file === path.dirname(root)) result.dev += 1
    return result
  })
  assert.throws(() => setup.install(agent, 'http://localhost:54104/mcp', options), /same filesystem/)
  assert.deepEqual(setup.managed(root, agent), previous)
})

function prompts(selected, answer = 'http://localhost:54104/mcp', confirmation = true, environment = 'custom') {
  const ui = { selections: [], environments: [], texts: [], confirmations: [], messages: [] }
  ui.intro = ui.outro = ui.cancel = message => ui.messages.push(message)
  ui.log = { success: ui.intro, error: ui.intro, info: ui.intro }
  ui.isCancel = value => typeof value === 'symbol'
  ui.multiselect = async options => { ui.selections.push(options); return selected }
  ui.select = async options => { ui.environments.push(options); return environment ?? options.initialValue }
  ui.text = async options => { ui.texts.push(options); return answer }
  ui.confirm = async options => { ui.confirmations.push(options); return confirmation }
  return ui
}

test('checkbox multiselect installs all selected agents and skips unselected agents', async t => {
  const { main } = require('./setup')
  const home = fixture(t)
  const ui = prompts(['claude', 'cursor'])
  const installed = []
  const status = await main([], { home, cwd: home, env: {}, interactive: true, prompts: ui, operations: {
    install(agent, url, options) { installed.push({ agent: agent.id, url, dryRun: options.dryRun }) },
  } })
  assert.equal(status, 0)
  assert.deepEqual(ui.selections[0].options.map(option => option.value), ['claude', 'codex', 'cursor'])
  assert.equal(ui.selections[0].required, true)
  assert.deepEqual(installed, [
    { agent: 'claude', url: 'http://localhost:54104/mcp', dryRun: false },
    { agent: 'cursor', url: 'http://localhost:54104/mcp', dryRun: false },
  ])
  assert.match(ui.texts[0].validate('https://user:secret@host/mcp'), /without credentials/)
  assert.match(ui.texts[0].validate(''), /Enter an HTTPS MCP URL/)
  assert.equal(ui.texts[0].validate('http://localhost:54104/mcp'), undefined)
})

for (const url of [PRODUCTION, 'https://www.in-parallel.dev/mcp']) {
  test(`environment selection installs ${url} without asking for a URL`, async t => {
    const { main } = require('./setup')
    const home = fixture(t)
    const agent = setup.AGENTS[2]
    const ui = prompts(['cursor'], undefined, true, url)
    assert.equal(await main([], { home, cwd: home, env: {}, interactive: true, prompts: ui }), 0)
    assert.equal(ui.environments[0].initialValue, PRODUCTION)
    assert.deepEqual(ui.environments[0].options.map(option => option.label), ['Production', 'Development', 'Custom'])
    assert.equal(ui.texts.length, 0)
    assert.equal(setup.managed(setup.target(agent, home), agent).endpoint, url)
    for (const name of ['.mcp.json', 'mcp.json']) {
      const config = JSON.parse(fs.readFileSync(path.join(setup.target(agent, home), name), 'utf8'))
      assert.equal(config.mcpServers.in_parallel.url, url)
    }
  })
}

test('accepting the default environment installs production', async t => {
  const { main } = require('./setup')
  const home = fixture(t)
  const ui = prompts(['cursor'], undefined, true, null)
  const urls = []
  assert.equal(await main([], { home, cwd: home, env: {}, interactive: true, prompts: ui, operations: {
    install(agent, url) { urls.push(url) },
  } }), 0)
  assert.deepEqual(urls, [PRODUCTION])
  assert.equal(ui.texts.length, 0)
})

test('rerunning setup preserves the selected hosted environment', async t => {
  const { main } = require('./setup')
  const home = fixture(t)
  const agent = setup.AGENTS[2]
  const url = 'https://www.in-parallel.dev/mcp'
  setup.install(agent, url, { home, cwd: home, env: {}, log() {} })
  const ui = prompts(['cursor'], undefined, true, null)
  assert.equal(await main([], { home, cwd: home, env: {}, interactive: true, prompts: ui }), 0)
  assert.equal(ui.environments[0].initialValue, url)
  assert.equal(ui.texts.length, 0)
  assert.equal(setup.managed(setup.target(agent, home), agent).endpoint, url)
})

for (const [before, after] of [
  [PRODUCTION, 'https://www.in-parallel.dev/mcp'],
  ['http://localhost:54104/mcp', 'https://www.in-parallel.dev/mcp'],
  ['https://www.in-parallel.dev/mcp', 'http://localhost:54104/mcp'],
  ['http://localhost:54104/mcp', 'http://localhost:54105/mcp'],
]) {
  test(`updates ask again and can switch from ${before} to ${after}`, async t => {
    const { main } = require('./setup')
    const home = fixture(t)
    const agent = setup.AGENTS[2]
    setup.install(agent, before, { home, cwd: home, env: {}, log() {} })
    const custom = after.startsWith('http:')
    const ui = prompts(['cursor'], after, true, custom ? 'custom' : after)
    assert.equal(await main([], { home, cwd: home, env: {}, interactive: true, prompts: ui }), 0)
    assert.equal(ui.environments.length, 1)
    assert.equal(ui.texts.length, custom ? 1 : 0)
    assert.equal(setup.managed(setup.target(agent, home), agent).endpoint, after)
    for (const name of ['.mcp.json', 'mcp.json']) {
      const config = JSON.parse(fs.readFileSync(path.join(setup.target(agent, home), name), 'utf8'))
      assert.equal(config.mcpServers.in_parallel.url, after)
    }
  })
}

test('custom selection never silently falls back to production on an empty URL', async t => {
  const { main } = require('./setup')
  const home = fixture(t)
  const ui = prompts(['cursor'], '')
  await assert.rejects(main([], { home, cwd: home, env: {}, interactive: true, prompts: ui, operations: {
    install() { assert.fail('An empty custom URL must not install') },
  } }), /Use an HTTPS MCP URL/)
  assert.equal(ui.texts[0].defaultValue, undefined)
})

test('cancelling any setup prompt never installs anything', async t => {
  const { main } = require('./setup')
  const home = fixture(t)
  for (const ui of [prompts(Symbol('cancel')), prompts(['cursor'], undefined, true, Symbol('cancel')), prompts(['cursor'], Symbol('cancel'))]) {
    const status = await main([], { home, cwd: home, env: {}, interactive: true, prompts: ui, operations: {
      install() { assert.fail('Cancellation must not install') },
    } })
    assert.equal(status, 130)
    assert.equal(fs.existsSync(setup.target(setup.AGENTS[2], home)), false)
  }
})

test('rerunning selection remembers the endpoint and dry run reaches every selected agent', async t => {
  const { main } = require('./setup')
  const home = fixture(t)
  setup.install(setup.AGENTS[2], 'http://localhost:54104/mcp', { home, cwd: home, env: {}, log() {} })
  const ui = prompts(['cursor'], '', true, null)
  const calls = []
  assert.equal(await main(['--dry-run'], { home, cwd: home, env: {}, interactive: true, prompts: ui, operations: {
    install(agent, url, options) { calls.push({ id: agent.id, url, dryRun: options.dryRun }) },
  } }), 0)
  assert.equal(ui.texts[0].defaultValue, 'http://localhost:54104/mcp')
  assert.equal(ui.texts[0].validate(''), undefined)
  assert.equal(ui.environments[0].initialValue, 'custom')
  assert.deepEqual(calls, [{ id: 'cursor', url: 'http://localhost:54104/mcp', dryRun: true }])
})

test('uninstall uses multiselect without asking for a URL', async t => {
  const { main } = require('./setup')
  const ui = prompts(['claude', 'codex'])
  const removed = []
  assert.equal(await main(['uninstall', '--dry-run'], { home: fixture(t), interactive: true, prompts: ui, operations: {
    uninstall(agent, options) { assert.equal(options.dryRun, true); removed.push(agent.id) },
  } }), 0)
  assert.deepEqual(removed, ['claude', 'codex'])
  assert.equal(ui.texts.length, 0)
  assert.equal(ui.environments.length, 0)
})

test('one client failure does not prevent other selected clients from installing', async t => {
  const { main } = require('./setup')
  const ui = prompts(['claude', 'codex', 'cursor'])
  const attempted = []
  assert.equal(await main([], { home: fixture(t), interactive: true, prompts: ui, operations: {
    install(agent) { attempted.push(agent.id); if (agent.id === 'claude') throw new Error('CLI unavailable') },
  } }), 1)
  assert.deepEqual(attempted, ['claude', 'codex', 'cursor'])
  assert.ok(ui.messages.some(message => /Claude Code: CLI unavailable/.test(message)))
})

test('noninteractive setup and unsupported agent flags fail before prompting; help works', () => {
  const run = args => spawnSync(process.execPath, [path.join(__dirname, 'setup.js'), ...args], { encoding: 'utf8', timeout: 5000 })
  assert.equal(run(['--help']).status, 0)
  const pipe = run([])
  assert.equal(pipe.status, 1)
  assert.match(pipe.stderr, /interactive terminal/)
  const flags = run(['--agents', 'codex'])
  assert.equal(flags.status, 1)
  assert.match(flags.stderr, /agent selection is interactive/)
})

for (const agent of setup.AGENTS.filter(agent => agent.command)) {
  test(`${agent.name}: a repointed marketplace cannot be overwritten or removed`, t => {
    const home = fixture(t)
    const native = host(agent, home)
    const options = { home, cwd: home, env: {}, execute: native.execute, log() {} }
    setup.install(agent, PRODUCTION, options)
    const root = setup.target(agent, home)
    const before = fs.readFileSync(path.join(root, setup.RECEIPT), 'utf8')
    native.marketplaces[0][agent.id === 'codex' ? 'root' : 'path'] = home
    const count = native.calls.length
    assert.throws(() => setup.install(agent, 'http://localhost:54104/mcp', options), /points elsewhere/)
    assert.throws(() => setup.uninstall(agent, options), /points elsewhere/)
    assert.throws(() => setup.doctor(agent, options), /points elsewhere/)
    assert.equal(fs.readFileSync(path.join(root, setup.RECEIPT), 'utf8'), before)
    assert.ok(native.calls.slice(count).every(args => args.includes('list')))
  })
}

test('Claude project installations are not mistaken for an owned user installation', t => {
  const home = fixture(t)
  const agent = setup.AGENTS[0]
  const native = host(agent, home)
  const options = { home, cwd: home, env: {}, execute: native.execute, log() {} }
  setup.install(agent, PRODUCTION, options)
  native.plugins.push({ ...native.plugins[0], scope: 'project' })
  assert.throws(() => setup.install(agent, PRODUCTION, options), /--scope project/)
})

test('a modified installation cannot prevent other selected agents from installing', async t => {
  const { main } = require('./setup')
  const home = fixture(t)
  const claude = setup.AGENTS[0]
  const native = host(claude, home)
  setup.install(claude, PRODUCTION, { home, cwd: home, env: {}, execute: native.execute, log() {} })
  fs.writeFileSync(path.join(setup.target(claude, home), 'custom.txt'), 'keep')
  const ui = prompts(['claude', 'cursor'])
  const status = await main([], { home, cwd: home, env: {}, interactive: true, prompts: ui, operations: {
    install(agent, url, options) { setup.install(agent, url, { ...options, execute: native.execute }) },
  } })
  assert.equal(status, 1)
  assert.ok(ui.messages.some(message => /Claude Code: Installed files were changed/.test(message)))
  assert.equal(setup.managed(setup.target(setup.AGENTS[2], home), setup.AGENTS[2]).endpoint, 'http://localhost:54104/mcp')
})


for (const agent of setup.AGENTS.filter(agent => agent.command)) {
  function existing(native) {
    const key = agent.id === 'codex' ? 'pluginId' : 'id'
    const oldId = agent.id === 'codex' ? 'in-parallel@personal' : 'in-parallel@in-parallel'
    native.plugins = [
      { [key]: oldId, enabled: true, version: '0.1.2', scope: 'user' },
      { [key]: 'another-plugin@personal', enabled: true, version: '1.0.0', scope: 'user' },
    ]
    native.marketplaces = [{ name: 'personal', root: '/existing/marketplace', path: '/existing/marketplace' }]
    return oldId
  }

  test(`${agent.name}: confirmed replacement verifies the new copy before removing only the old plugin`, async t => {
    const { main } = require('./setup')
    const home = fixture(t)
    const native = host(agent, home)
    const oldId = existing(native)
    const originalMarket = native.marketplaces[0]
    const ui = prompts([agent.id])
    const status = await main([], { home, cwd: home, env: {}, interactive: true, prompts: ui, operations: {
      install(selected, url, options) { setup.install(selected, url, { ...options, execute: native.execute }) },
    } })
    assert.equal(status, 0)
    assert.equal(ui.confirmations.length, 1)
    assert.ok(ui.confirmations[0].message.includes(oldId))
    assert.ok(ui.confirmations[0].message.includes('http://localhost:54104/mcp'))
    assert.equal(setup.managed(setup.target(agent, home), agent).endpoint, 'http://localhost:54104/mcp')
    assert.deepEqual(native.plugins.map(plugin => plugin.pluginId || plugin.id).sort(), ['another-plugin@personal', setup.PLUGIN].sort())
    assert.deepEqual(native.marketplaces[0], originalMarket)
    const installed = native.calls.findIndex(args => ['add', 'install'].includes(args[1]) && args[2] === setup.PLUGIN)
    const removed = native.calls.findIndex(args => ['remove', 'uninstall'].includes(args[1]) && args[2] === oldId)
    assert.ok(installed >= 0 && removed > installed)
    assert.ok(native.calls.slice(installed + 1, removed).some(args => args.join(' ') === 'plugin list --json'))
    assert.deepEqual(native.calls[removed], agent.id === 'codex'
      ? ['plugin', 'remove', oldId]
      : ['plugin', 'uninstall', oldId, '--scope', 'user', '--keep-data'])
    setup.doctor(agent, { home, cwd: home, env: {}, execute: native.execute, log() {} })
  })

  test(`${agent.name}: declined or cancelled replacement preserves the old installation`, async t => {
    const { main } = require('./setup')
    for (const confirmation of [false, Symbol('cancel')]) {
      const home = fixture(t)
      const native = host(agent, home)
      existing(native)
      const before = structuredClone(native.plugins)
      const ui = prompts([agent.id, 'cursor'], undefined, confirmation)
      const status = await main([], { home, cwd: home, env: {}, interactive: true, prompts: ui, operations: {
        install(selected, url, options) { setup.install(selected, url, { ...options, execute: native.execute }) },
      } })
      assert.equal(status, confirmation === false ? 0 : 130)
      assert.deepEqual(native.plugins, before)
      assert.ok(native.calls.every(args => args.includes('list')))
      assert.equal(fs.existsSync(setup.target(agent, home)), false)
      assert.equal(fs.existsSync(setup.target(setup.AGENTS[2], home)), confirmation === false)
    }
  })

  test(`${agent.name}: replacement dry run shows removal without changing either installation`, async t => {
    const { main } = require('./setup')
    const home = fixture(t)
    const native = host(agent, home)
    const oldId = existing(native)
    const ui = prompts([agent.id])
    assert.equal(await main(['--dry-run'], { home, cwd: home, env: {}, interactive: true, prompts: ui, operations: {
      install(selected, url, options) { setup.install(selected, url, { ...options, execute: native.execute }) },
    } }), 0)
    assert.ok(ui.messages.some(message => message.includes(`Would remove ${oldId}`)))
    assert.ok(native.calls.every(args => args.includes('list') || args[0] === '--version'))
    assert.equal(fs.existsSync(setup.target(agent, home)), false)
  })

  test(`${agent.name}: failed or stale replacement leaves the old plugin available`, t => {
    const home = fixture(t)
    const native = host(agent, home)
    const oldId = existing(native)
    const options = { home, cwd: home, env: {}, execute: native.execute, replace: [oldId], log() {} }
    native.failInstall = true
    assert.throws(() => setup.install(agent, 'http://localhost:54104/mcp', options), /Native installation failed/)
    native.failInstall = false
    native.stale = true
    assert.throws(() => setup.install(agent, 'http://localhost:54104/mcp', options), /expected enabled plugin version/)
    assert.ok(native.plugins.some(plugin => (plugin.pluginId || plugin.id) === oldId && plugin.enabled))
    assert.ok(!native.calls.some(args => ['remove', 'uninstall'].includes(args[1])))
  })

  test(`${agent.name}: interrupted cleanup is detected and retry finishes replacement`, t => {
    const home = fixture(t)
    const native = host(agent, home)
    const oldId = existing(native)
    const options = { home, cwd: home, env: {}, execute: native.execute, replace: [oldId], log() {} }
    native.failRemove = true
    assert.throws(() => setup.install(agent, 'http://localhost:54104/mcp', options), /Native removal failed/)
    native.failRemove = false
    native.ignoreRemove = true
    assert.throws(() => setup.install(agent, 'http://localhost:54104/mcp', options), /replacement could not be verified/)
    native.ignoreRemove = false
    setup.install(agent, 'http://localhost:54104/mcp', options)
    assert.deepEqual(native.plugins.map(plugin => plugin.pluginId || plugin.id).sort(), ['another-plugin@personal', setup.PLUGIN].sort())
  })

  test(`${agent.name}: a newly discovered copy requires its own replacement confirmation`, t => {
    const home = fixture(t)
    const native = host(agent, home)
    const oldId = existing(native)
    native.plugins.push({ [agent.id === 'codex' ? 'pluginId' : 'id']: 'in-parallel@new-source', enabled: true, scope: 'user' })
    assert.throws(() => setup.install(agent, 'http://localhost:54104/mcp', {
      home, execute: native.execute, replace: [oldId], log() {},
    }), error => error instanceof setup.ReplacementRequired && error.plugins.includes('in-parallel@new-source'))
    assert.ok(native.calls.every(args => args.includes('list')))
    assert.equal(fs.existsSync(setup.target(agent, home)), false)
  })
}

test('Claude replacement refuses clients that can uninstall the wrong marketplace copy', t => {
  const home = fixture(t)
  const agent = setup.AGENTS[0]
  const native = host(agent, home)
  const old = { id: 'in-parallel@in-parallel', scope: 'user', enabled: true }
  native.plugins = [old]
  for (const version of ['1.9.999 (Claude Code)', '2.0.999 (Claude Code)', '2.1.211 (Claude Code)', 'unknown']) {
    native.claudeVersion = version
    assert.throws(() => setup.install(agent, 'http://localhost:54104/mcp', {
      home, execute: native.execute, replace: [old.id], log() {},
    }), /Update Claude Code to 2.1.212/)
    assert.deepEqual(native.plugins, [old])
    assert.equal(fs.existsSync(setup.target(agent, home)), false)
  }
  native.claudeVersion = '2.1.212 (Claude Code)'
  setup.install(agent, 'http://localhost:54104/mcp', { home, cwd: home, env: {}, execute: native.execute, replace: [old.id], log() {} })
  assert.deepEqual(native.plugins.map(plugin => plugin.id), [setup.PLUGIN])
})


test('Codex verifies the plugin MCP endpoint without creating a duplicate personal entry', t => {
  const home = fixture(t)
  const agent = setup.AGENTS[1]
  const native = host(agent, home)
  setup.install(agent, 'http://localhost:54104/mcp', { home, cwd: home, env: {}, execute: native.execute, log() {} })
  assert.ok(native.calls.some(args => args.join(' ') === 'mcp get in_parallel --json'))
  assert.ok(!native.calls.some(args => args[0] === 'mcp' && args[1] === 'add'))
})

test('Codex preserves the previous plugin when replacement MCP verification fails', t => {
  const home = fixture(t)
  const agent = setup.AGENTS[1]
  const native = host(agent, home)
  const old = { pluginId: 'in-parallel@personal', enabled: true, version: '0.0.0' }
  native.plugins = [old]
  const options = { home, cwd: home, env: {}, execute: native.execute, replace: [old.pluginId], log() {} }
  const url = PRODUCTION
  for (const connection of [
    null,
    { enabled: false, transport: { type: 'streamable_http', url } },
    { enabled: true, transport: { type: 'streamable_http', url: 'https://wrong-environment.test/mcp' } },
  ]) {
    native.missingMcp = connection === null
    native.mcp = connection
    assert.throws(() => setup.install(agent, url, options), /MCP server/)
    assert.deepEqual(native.plugins.find(plugin => plugin.pluginId === old.pluginId), old)
    assert.ok(!native.calls.some(args => args[1] === 'remove'))
  }
  native.missingMcp = false
  native.mcp = undefined
  native.calls = []
  setup.install(agent, url, options)
  const verified = native.calls.findIndex(args => args.join(' ') === 'mcp get in_parallel --json')
  const removed = native.calls.findIndex(args => args.join(' ') === `plugin remove ${old.pluginId}`)
  assert.ok(verified >= 0 && removed > verified)
  assert.deepEqual(native.plugins.map(plugin => plugin.pluginId), [setup.PLUGIN])
})

test('Codex refuses missing, disabled and shadowed MCP configuration without overwriting it', t => {
  const home = fixture(t)
  const agent = setup.AGENTS[1]
  const native = host(agent, home)
  const options = { home, cwd: home, env: {}, execute: native.execute, log() {} }
  const url = 'http://localhost:54104/mcp'
  native.missingMcp = true
  assert.throws(() => setup.install(agent, url, options), /could not discover.*MCP/)
  native.missingMcp = false
  for (const mcp of [
    { enabled: false, transport: { type: 'streamable_http', url } },
    { enabled: true, transport: { type: 'streamable_http', url: PRODUCTION } },
    { enabled: true, transport: { type: 'stdio', command: 'custom-server' } },
  ]) {
    native.mcp = mcp
    assert.throws(() => setup.install(agent, url, options), /does not resolve an enabled.*MCP/)
    assert.throws(() => setup.doctor(agent, options), /does not resolve an enabled.*MCP/)
    assert.deepEqual(native.mcp, mcp)
  }
  native.mcp = undefined
  setup.install(agent, url, options)
  const logs = []
  setup.doctor(agent, { ...options, log: line => logs.push(line) })
  assert.ok(logs.some(line => /authentication not checked/.test(line)))
  assert.ok(!native.calls.some(args => args[0] === 'mcp' && args[1] !== 'get'))
})


for (const agent of [setup.AGENTS[0], setup.AGENTS[2]]) {
  test(`${agent.name}: conflicting user and project MCP definitions stop before writes`, t => {
    const home = fixture(t)
    const cwd = path.join(home, 'project', 'nested')
    fs.mkdirSync(cwd, { recursive: true })
    const native = host(agent, home)
    const options = { home, cwd, env: {}, execute: native.execute, log() {} }
    const url = 'http://localhost:54104/mcp'
    const definitions = agent.id === 'claude' ? [
      [path.join(home, '.claude.json'), { mcpServers: { in_parallel: { type: 'http', url: 'https://production.test/mcp' } } }],
      [path.join(home, '.claude.json'), { projects: { [path.dirname(cwd)]: { mcpServers: { in_parallel: { type: 'http', url: 'https://production.test/mcp' } } } } }],
      [path.join(path.dirname(cwd), '.mcp.json'), { mcpServers: { in_parallel: { type: 'http', url: 'https://production.test/mcp' } } }],
    ] : [
      [path.join(home, '.cursor', 'mcp.json'), { mcpServers: { in_parallel: { url: 'https://production.test/mcp' } } }],
      [path.join(path.dirname(cwd), '.cursor', 'mcp.json'), { mcpServers: { in_parallel: { url: 'https://production.test/mcp' } } }],
    ]
    for (const [file, config] of definitions) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const original = JSON.stringify(config)
      fs.writeFileSync(file, original)
      assert.throws(() => setup.install(agent, url, options), /conflicting or unverifiable In Parallel MCP entry/)
      assert.equal(fs.readFileSync(file, 'utf8'), original)
      assert.equal(fs.existsSync(setup.target(agent, home)), false)
      assert.deepEqual(native.calls, [])
      fs.rmSync(file)
    }
  })

  test(`${agent.name}: legacy server keys require migration even at the selected endpoint`, t => {
    const home = fixture(t)
    const native = host(agent, home)
    const file = agent.id === 'claude' ? path.join(home, '.claude.json') : path.join(home, '.cursor', 'mcp.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const original = JSON.stringify({ mcpServers: { 'in-parallel': { type: 'http', url: 'http://localhost:54104/mcp' } } })
    fs.writeFileSync(file, original)
    assert.throws(() => setup.install(agent, 'http://localhost:54104/mcp', {
      home, cwd: home, env: {}, execute: native.execute, log() {},
    }), /legacy In Parallel MCP entry named in-parallel.*Rename it to in_parallel/)
    assert.equal(fs.readFileSync(file, 'utf8'), original)
    assert.equal(fs.existsSync(setup.target(agent, home)), false)
    assert.deepEqual(native.calls, [])
  })

  test(`${agent.name}: matching expanded endpoints install; doctor detects later conflicts`, t => {
    const home = fixture(t)
    const cwd = path.join(home, 'project')
    fs.mkdirSync(cwd)
    const native = host(agent, home)
    const configDir = path.join(home, 'alternate-claude')
    const env = { CLAUDE_CONFIG_DIR: configDir, MCP_TEST_ENDPOINT: 'http://LOCALHOST:54104/mcp' }
    const options = { home, cwd, env, execute: native.execute, log() {} }
    const file = agent.id === 'claude' ? path.join(configDir, '.claude.json') : path.join(home, '.cursor', 'mcp.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const config = value => JSON.stringify({ mcpServers: { in_parallel: { type: 'http', url: value, headers: { Authorization: 'do-not-print' } } } })
    fs.writeFileSync(file, config(agent.id === 'claude' ? '${MCP_TEST_ENDPOINT:-https://production.test/mcp}' : '${env:MCP_TEST_ENDPOINT}'))
    setup.install(agent, 'http://localhost:54104/mcp', options)
    setup.doctor(agent, options)
    const root = setup.target(agent, home)
    const receipt = setup.managed(root, agent)
    if (agent.id === 'claude') {
      fs.writeFileSync(file, config('${UNSET_ENDPOINT:-http://localhost:54104/mcp}'))
      setup.doctor(agent, options)
      env.UNSET_ENDPOINT = ''
      assert.throws(() => setup.doctor(agent, options), /conflicting or unverifiable/)
      delete env.UNSET_ENDPOINT
      setup.doctor(agent, options)
    }
    fs.writeFileSync(file, config('https://production.test/mcp?token=do-not-print'))
    const before = native.calls.length
    assert.throws(() => setup.doctor(agent, options), error => {
      assert.match(error.message, /conflicting or unverifiable In Parallel MCP entry/)
      assert.doesNotMatch(error.message, /do-not-print/)
      return true
    })
    assert.throws(() => setup.install(agent, 'http://localhost:54104/mcp', options), /conflicting or unverifiable/)
    assert.equal(native.calls.length, before)
    assert.deepEqual(setup.managed(root, agent), receipt)
    fs.writeFileSync(file, config(agent.id === 'claude' ? '${UNSET_ENDPOINT}' : '${env:UNSET_ENDPOINT}'))
    assert.throws(() => setup.install(agent, 'http://localhost:54104/mcp', options), /conflicting or unverifiable/)
    fs.writeFileSync(file, '{invalid-json')
    assert.throws(() => setup.install(agent, 'http://localhost:54104/mcp', options), /Could not read MCP configuration/)
  })
}


test('the source checkout MCP template does not prevent preparing a chosen endpoint', t => {
  const home = fixture(t)
  const agent = setup.AGENTS[0]
  const native = host(agent, home)
  const file = path.join(setup.SOURCE, '.mcp.json')
  const original = fs.readFileSync(file, 'utf8')
  setup.install(agent, 'http://localhost:54104/mcp', { home, cwd: setup.SOURCE, env: {}, execute: native.execute, log() {} })
  assert.equal(setup.managed(setup.target(agent, home), agent).endpoint, 'http://localhost:54104/mcp')
  assert.equal(fs.readFileSync(file, 'utf8'), original)
})
