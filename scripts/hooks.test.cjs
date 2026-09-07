'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

async function harness(t, handle = (_req, res) => { res.writeHead(204); res.end() }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'in-parallel-hooks-'))
  const plugin = path.join(root, 'plugin with spaces')
  fs.mkdirSync(plugin)
  fs.cpSync(path.join(__dirname), path.join(plugin, 'scripts'), { recursive: true })
  const server = http.createServer(handle)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const endpoint = `${origin}/mcp`
  for (const file of ['.mcp.json', 'mcp.json']) {
    fs.writeFileSync(path.join(plugin, file), JSON.stringify({ mcpServers: { 'in-parallel': { url: endpoint } } }))
  }
  const preload = path.join(root, 'home.cjs')
  fs.writeFileSync(preload, `require('node:os').homedir = () => ${JSON.stringify(root)};`)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  for (const name of ['git', 'gh']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const stateDir = path.join(root, '.in-parallel')
  const file = path.join(stateDir, 'claims.json')
  const diagnostics = []
  const launch = (command, args, input, env = {}, shell = false) => new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root, shell,
      env: { ...process.env, NODE_OPTIONS: `--require ${preload}`, IN_PARALLEL_CLIENT: 'claude', ...env, PATH: `${bin}:${process.env.PATH}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data; diagnostics.push(String(data)) })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(stdout) : reject(Error(`${command}: ${code}: ${stderr}`)))
    child.stdin.end(JSON.stringify(input ?? {}))
  })
  const run = (script, input, source, env) => launch(process.execPath,
    source ? ['-e', source] : [path.join(plugin, 'scripts', script)], input, env)
  const runHook = (command, input) => launch(command, [], input,
    { CURSOR_PLUGIN_ROOT: plugin, IN_PARALLEL_CLIENT: 'cursor' }, true)
  const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)).claims : {}
  const write = claims => { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ version: 2, claims })) }
  const input = (session = 'A', event = 'PostToolUse') => ({ session_id: session, cwd: root, hook_event_name: event })
  const key = id => `${endpoint}:${id}`
  const claim = (id, session = 'A') => ({ claim_id: id, version: 1, workspace_id: 'workspace', user_id: 'person', owner: `claude:${session}:main`, endpoint, cwd: root, description: `Work ${id}`, status: 'working', started_at: new Date().toISOString(), heartbeat: { url: `${origin}/api/v1/work-claims/${id}/heartbeat`, token: `token-${id}`, interval_seconds: 300 } })
  const reply = (id, outcome = 'started') => ({ outcome, claim: { ...claim(id), state: outcome === 'started' ? 'working' : outcome, creator: { user_id: 'person' }, assignee: { user_id: 'person' } }, heartbeat: outcome === 'started' ? claim(id).heartbeat : null })
  const remember = (id, session = 'A', outcome = 'started') => run('remember-claim.js', { ...input(session), tool_name: 'mcp__in-parallel__announce_work', tool_response: { structuredContent: reply(id, outcome) } })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, plugin, stateDir, origin, endpoint, run, runHook, diagnostics, input, key, claim, reply, remember, read, write }
}

test('the first successful start immediately heartbeats only its own session', async t => {
  const requests = []
  const h = await harness(t, (req, res) => { requests.push(req.url); res.writeHead(204); res.end() })
  h.write({ [h.key('B')]: h.claim('B', 'B') })
  await h.remember('A')
  assert.deepEqual(requests, ['/api/v1/work-claims/A/heartbeat'])
  assert.ok(h.read()[h.key('A')].last_beat_at)
  assert.equal(h.read()[h.key('B')].last_beat_at, undefined)
  assert.equal(fs.statSync(path.join(h.stateDir, 'claims.json')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(h.stateDir).mode & 0o777, 0o700)
})

test('a late heartbeat does not resurrect a completed claim or lose another new claim', async t => {
  let receive, release
  const received = new Promise(resolve => { receive = resolve })
  const h = await harness(t, (_req, res) => { release = () => { res.writeHead(204); res.end() }; receive() })
  h.write({ [h.key('A')]: h.claim('A') })
  const pending = h.run('heartbeat.js', h.input())
  await received
  await h.remember('A', 'A', 'completed')
  await h.remember('C', 'C', 'created')
  release()
  await pending
  assert.equal(h.read()[h.key('A')], undefined)
  assert.equal(h.read()[h.key('C')].status, 'created')
})

test('concurrent and consecutive hook events coalesce attempts and back off an outage', async t => {
  let requests = 0
  const h = await harness(t, (_req, res) => { requests++; res.writeHead(503); res.end() })
  h.write({ [h.key('A')]: h.claim('A') })
  await Promise.all([h.run('heartbeat.js', h.input()), h.run('heartbeat.js', h.input())])
  await h.run('heartbeat.js', h.input())
  assert.equal(requests, 1)
  const state = h.read()
  assert.equal(state[h.key('A')].last_beat_at, undefined)
  state[h.key('A')].next_attempt_at = new Date(0).toISOString()
  h.write(state)
  await h.run('heartbeat.js', h.input())
  assert.equal(requests, 2)
})

test('invalid or expired capability retains the claim for authenticated reconciliation', async t => {
  const h = await harness(t, (_req, res) => { res.writeHead(409); res.end() })
  await h.remember('A')
  const row = h.read()[h.key('A')]
  assert.equal(row.status, 'needs_reconciliation')
  assert.equal(row.heartbeat, null)
  assert.match(await h.run('context.js', h.input('A', 'SessionStart')), /list_work\(mine: true\)/)
})

test('foreign tools, foreign origins, and mismatched heartbeat paths cannot send a token', async t => {
  let requests = 0
  const h = await harness(t, (_req, res) => { requests++; res.end() })
  await h.run('remember-claim.js', { ...h.input(), tool_name: 'mcp__other__announce_work', tool_response: h.reply('A') })
  const foreign = h.reply('A')
  foreign.heartbeat.url = 'https://other.example/api/v1/work-claims/A/heartbeat'
  await h.run('remember-claim.js', { ...h.input(), tool_name: 'mcp__in-parallel__announce_work', tool_response: foreign })
  const mismatch = h.reply('B')
  mismatch.heartbeat.url = `${h.origin}/api/v1/work-claims/A/heartbeat`
  await h.run('remember-claim.js', { ...h.input(), tool_name: 'mcp__in-parallel__announce_work', tool_response: mismatch })
  assert.equal(requests, 0)
  assert.equal(h.read()[h.key('A')].heartbeat, null)
  assert.equal(h.read()[h.key('B')].heartbeat, null)
  assert.equal(h.read()[h.key('A')].status, 'needs_reconciliation')
  assert.equal(h.read()[h.key('B')].status, 'needs_reconciliation')
  assert.match(h.diagnostics.join(''), /heartbeat capability rejected.*MCP endpoint matches the selected environment/)
  assert.doesNotMatch(h.diagnostics.join(''), /token-A|token-B/)
})

test('Cursor records only its named MCP server and refreshes context through supported events', async t => {
  const h = await harness(t)
  const input = { conversation_id: 'cursor-chat', workspace_roots: [h.root], hook_event_name: 'afterMCPExecution', tool_name: 'announce_work', mcp_server_name: 'other', result_json: JSON.stringify(h.reply('C')) }
  await h.run('remember-claim.js', input)
  assert.deepEqual(h.read(), {})
  await h.run('remember-claim.js', { ...input, mcp_server_name: 'in-parallel' })
  assert.equal(h.read()[h.key('C')].owner, 'cursor:cursor-chat:main')
  assert.equal(await h.run('context.js', { ...input, hook_event_name: 'beforeSubmitPrompt' }), '')
  const context = JSON.parse(await h.run('context.js', { ...input, hook_event_name: 'postToolUse' }))
  assert.match(context.additional_context, /Work C/)
  assert.equal(await h.run('context.js', { ...input, hook_event_name: 'postToolUse' }), '')
})

test('resume and compact restore only owned claims and prescribe fresh random request identities', async t => {
  const h = await harness(t)
  h.write({ [h.key('A')]: h.claim('A'), [h.key('B')]: h.claim('B', 'B'), legacy: { claim_id: 'legacy-work' } })
  const initial = await h.run('context.js', h.input('A', 'SessionStart'))
  assert.match(initial, /Work A/)
  assert.doesNotMatch(initial, /Work B/)
  assert.match(initial, /legacy claim/)
  assert.match(initial, /new random UUID/)
  assert.equal(await h.run('context.js', h.input('A', 'UserPromptSubmit')), '')
  const resumed = await h.run('context.js', { ...h.input('A', 'SessionStart'), source: 'resume' })
  const compacted = await h.run('context.js', { ...h.input('A', 'SessionStart'), source: 'compact' })
  assert.ok(resumed)
  assert.equal(initial.match(/request_prefix=(\w+)/)[1], compacted.match(/request_prefix=(\w+)/)[1])
  const child = JSON.parse(await h.run('context.js', { ...h.input('A', 'SubagentStart'), agent_id: 'child' }))
  assert.equal(child.hookSpecificOutput.hookEventName, 'SubagentStart')
  assert.doesNotMatch(child.hookSpecificOutput.additionalContext, /Work A/)
})

test('the store recovers empty and dead-owner locks without losing concurrent updates', async t => {
  const h = await harness(t)
  fs.mkdirSync(path.join(h.stateDir, 'claims.lock'), { recursive: true })
  const script = id => `require(${JSON.stringify(path.join(h.plugin, 'scripts/store.js'))}).update(claims => { claims[${JSON.stringify(id)}] = { claim_id: ${JSON.stringify(id)} }; });`
  await h.run('store', {}, script('empty-recovered'))
  fs.mkdirSync(path.join(h.stateDir, 'claims.lock'))
  fs.writeFileSync(path.join(h.stateDir, 'claims.lock', '2147483647-dead'), '')
  await Promise.all(Array.from({ length: 8 }, (_, i) => h.run('store', {}, script(`writer-${i}`))))
  assert.equal(Object.keys(h.read()).length, 9)
})

test('malformed state is preserved and missing session identity never renews claims', async t => {
  const h = await harness(t)
  h.write({ [h.key('A')]: h.claim('A') })
  await h.run('heartbeat.js', {})
  assert.equal(h.read()[h.key('A')].last_beat_at, undefined)
  const file = path.join(h.stateDir, 'claims.json')
  fs.writeFileSync(file, '{broken')
  await h.remember('B')
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
})

test('Codex text-content replies retain their own owner and terminal replies clear only that claim', async t => {
  const h = await harness(t)
  const payload = { ...h.input(), client: 'codex', tool_name: 'mcp__in_parallel__announce_work', tool_response: { content: [{ type: 'text', text: JSON.stringify(h.reply('codex')) }] } }
  await h.run('remember-claim.js', payload)
  assert.equal(h.read()[h.key('codex')].owner, 'codex:A:main')
  await h.run('remember-claim.js', { ...payload, tool_response: h.reply('codex', 'completed') })
  assert.equal(h.read()[h.key('codex')], undefined)
})

test('retrying creation of work since started elsewhere does not adopt its heartbeat', async t => {
  const h = await harness(t)
  h.write({ [h.key('B')]: h.claim('B', 'B') })
  await h.run('remember-claim.js', { ...h.input(), tool_name: 'mcp__in-parallel__announce_work', tool_response: { ...h.reply('B'), outcome: 'created' } })
  assert.equal(h.read()[h.key('B')].owner, 'claude:B:main')
})

test('client manifests agree on public identity and reference shipped entry points', () => {
  const root = path.join(__dirname, '..')
  const portable = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json')))
  for (const client of ['claude', 'codex', 'cursor']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, `.${client}-plugin/plugin.json`)))
    assert.equal(manifest.name, portable.name)
    assert.equal(manifest.version, portable.version)
    assert.equal(manifest.description, portable.description)
    assert.ok(fs.existsSync(path.join(root, manifest.hooks)))
    assert.ok(fs.existsSync(path.join(root, manifest.mcpServers)))
  }
})


test('blocked work retains its dependency without heartbeat and resumes the same claim immediately', async t => {
  let requests = 0
  const h = await harness(t, (_req, res) => { requests++; res.writeHead(204); res.end() })
  await h.remember('A')
  const blocked = h.reply('A', 'blocked')
  blocked.claim.reason = 'Waiting for scope confirmation'
  blocked.claim.version = 2
  blocked.heartbeat = h.claim('A').heartbeat
  await h.run('remember-claim.js', { ...h.input(), tool_name: 'mcp__in-parallel__announce_work', tool_response: blocked })
  const row = h.read()[h.key('A')]
  assert.equal(row.status, 'blocked')
  assert.equal(row.reason, blocked.claim.reason)
  assert.equal(row.version, 2)
  assert.equal(row.heartbeat, null)
  await h.run('heartbeat.js', h.input())
  assert.equal(requests, 1)
  const context = await h.run('context.js', h.input('A', 'SessionStart'))
  assert.match(context, /Waiting for scope confirmation/)
  assert.match(context, /version=2/)
  assert.match(context, /verify that its dependency is resolved/)
  blocked.claim.reason = 'Waiting for revised input'
  await h.run('remember-claim.js', { ...h.input(), tool_name: 'mcp__in-parallel__announce_work', tool_response: blocked })
  assert.match(await h.run('context.js', h.input('A', 'UserPromptSubmit')), /Waiting for revised input/)
  await h.remember('A')
  assert.equal(h.read()[h.key('A')].status, 'working')
  assert.equal(h.read()[h.key('A')].reason, null)
  assert.equal(requests, 2)
})

test('a late heartbeat cannot renew the local schedule after work becomes blocked', async t => {
  let receive, release
  const received = new Promise(resolve => { receive = resolve })
  const h = await harness(t, (_req, res) => { release = () => { res.writeHead(204); res.end() }; receive() })
  h.write({ [h.key('A')]: h.claim('A') })
  const pending = h.run('heartbeat.js', h.input())
  await received
  await h.remember('A', 'A', 'blocked')
  release()
  await pending
  assert.equal(h.read()[h.key('A')].status, 'blocked')
  assert.equal(h.read()[h.key('A')].heartbeat, null)
  assert.equal(h.read()[h.key('A')].next_attempt_at, null)
})

test('Claude expands the endpoint while other clients keep their literal configuration', async t => {
  const h = await harness(t)
  const fallback = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.mcp.json'), 'utf8')).mcpServers['in-parallel'].url
  fs.writeFileSync(path.join(h.plugin, '.mcp.json'), JSON.stringify({ mcpServers: { 'in-parallel': { url: fallback } } }))
  const runtimePath = JSON.stringify(path.join(h.plugin, 'scripts/runtime.js'))
  const resolve = env => h.run('runtime', {}, `const r=require(${runtimePath}); console.log(JSON.stringify(['claude','codex','cursor'].map(c=>r.endpoint(c).href)))`, env)
  const portable = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mcp.json'), 'utf8')).mcpServers['in-parallel'].url
  const defaults = JSON.parse(await resolve({ IN_PARALLEL_MCP_URL: undefined }))
  assert.equal(defaults[0], portable)
  assert.deepEqual(defaults.slice(1), [h.endpoint, h.endpoint])
  const configured = JSON.parse(await resolve({ IN_PARALLEL_MCP_URL: 'https://example.dev/mcp' }))
  assert.deepEqual(configured, ['https://example.dev/mcp', h.endpoint, h.endpoint])
  for (const client of ['codex', 'cursor']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `.${client}-plugin/plugin.json`), 'utf8'))
    assert.equal(manifest.mcpServers, './mcp.json')
  }
})

test('environment switching partitions ownership and sends capabilities only to that environment', async t => {
  let prodRequests = 0, devRequests = 0
  const prod = await harness(t, (_req, res) => { prodRequests++; res.writeHead(204); res.end() })
  const dev = await harness(t, (_req, res) => { devRequests++; res.writeHead(204); res.end() })
  const url = '${IN_PARALLEL_MCP_URL:-' + prod.endpoint + '}'
  fs.writeFileSync(path.join(prod.plugin, '.mcp.json'), JSON.stringify({ mcpServers: { 'in-parallel': { url } } }))
  prod.write({ [prod.key('A')]: prod.claim('A') })
  const env = { IN_PARALLEL_MCP_URL: dev.endpoint }
  await prod.run('remember-claim.js', { ...prod.input(), tool_name: 'mcp__in-parallel__announce_work', tool_response: dev.reply('A') }, null, env)
  assert.equal(devRequests, 1)
  assert.equal(prodRequests, 0)
  assert.equal(Object.keys(prod.read()).length, 2)
  assert.ok(prod.read()[dev.key('A')].last_beat_at)
  assert.equal(prod.read()[prod.key('A')].last_beat_at, undefined)
  await prod.run('heartbeat.js', prod.input(), null, { IN_PARALLEL_MCP_URL: undefined })
  assert.equal(prodRequests, 1)
  assert.equal(devRequests, 1)
  await prod.run('remember-claim.js', { ...prod.input(), tool_name: 'mcp__in-parallel__announce_work', tool_response: dev.reply('A', 'completed') }, null, env)
  assert.equal(prod.read()[dev.key('A')], undefined)
  assert.ok(prod.read()[prod.key('A')])
})

test('Cursor manifest commands run with a plugin root containing spaces', async t => {
  const h = await harness(t)
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks/cursor.json'), 'utf8')).hooks
  const input = { conversation_id: 'cursor-command', workspace_roots: [h.root], hook_event_name: 'sessionStart' }
  const context = JSON.parse(await h.runHook(hooks.sessionStart[0].command, input))
  assert.match(context.additional_context, /request_prefix=/)
  await h.runHook(hooks.afterMCPExecution[0].command, {
    ...input, hook_event_name: 'afterMCPExecution', tool_name: 'announce_work',
    mcp_server_name: 'in-parallel', result_json: JSON.stringify(h.reply('C')),
  })
  assert.equal(h.read()[h.key('C')].owner, 'cursor:cursor-command:main')
  assert.ok(h.read()[h.key('C')].last_beat_at)
})
