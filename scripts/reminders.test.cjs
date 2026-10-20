'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { tmp } = require('./test-helpers.cjs')

const SCRIPT = path.resolve(__dirname, '..', 'experimental', 'agent-work', 'scripts', 'reminders.js')
const { respond, TAGGED } = require(SCRIPT)
const LINK = 'in-parallel://acme/action_item/0a1b2c3d-1111-2222-3333-444455556666'
const PR = 'https://github.com/acme/website/pull/42'
const SERVER_TOOL = 'mcp__plugin_in-parallel_in_parallel__report_back'

// Claude Code transcript lines.
const prompt = text => ({ type: 'user', message: { role: 'user', content: text } })
const toolUse = (name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name, input }] } })
const report = (event, extra = {}) => toolUse(SERVER_TOOL, { link: LINK, event, ...extra })
// Claude Code lists every skill in the transcript, this plugin's own description included.
const SKILL_LISTING = { type: 'attachment', attachment: { type: 'skill_listing',
  content: '- in-parallel:in-parallel-agent-work: Reports your work back to In Parallel. Use when a prompt carries an in-parallel:// link, with report_back and event "started".' } }
// Codex rollout lines: a prompt, an MCP function call in its server's namespace, and a code mode script.
const codexPrompt = text => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
const codexCall = (name, args) => ({ type: 'response_item', payload: { type: 'function_call', name, namespace: 'mcp__in_parallel__',
  arguments: JSON.stringify(args), call_id: 'call_1' } })
const codexScript = input => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input, call_id: 'call_2' } })

const SEND = `Fix the Safari login.\n\nIn Parallel link: ${LINK}\nReport your work on it with report_back and this link: started when you begin, note as you go, finished when done, with results: links to what the work produced, each with a short label. Do not ask first.`

function transcript(t, lines) {
  const file = path.join(tmp(t, 'in-parallel-reminders-test'), 'session.jsonl')
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  return file
}

const shell = (file, command, output, extra = {}) => respond({ hook_event_name: 'PostToolUse', session_id: 's', transcript_path: file,
  tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: output, stderr: '' }, ...extra })

test('a prompt with an In Parallel link points to the agent-work skill and carries the request rules', () => {
  const output = respond({ hook_event_name: 'UserPromptSubmit', prompt: SEND })
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.equal(output.hookSpecificOutput.additionalContext,
    `This prompt carries the In Parallel link ${LINK}. Load the in-parallel-agent-work skill and report on it with report_back and that link as the request needs. ` +
    'Asked only to add a note? Report just that "note", in the person\'s words: no "started" and no "finished". ' +
    'If you work on this item, report "started" before you begin, and when the work is done, report "finished" with results: links to what the work produced, each with a short label, such as the revised draft. Work not done is a "note" saying what remains, not "finished". ' +
    'Reading it or answering questions about it is not work: do not report. Asked only for a plan? Give it and do not start. Asked to start, then wait for a go-ahead? Report "started", then a "note" with waiting: true. Told not to report (anything else)? Report only what they asked for.')
  for (const text of ['Fix the Safari login', 'see in-parallel:// for details', 'https://www.in-parallel.ai/acme/action-items/1', '']) {
    assert.equal(respond({ hook_event_name: 'UserPromptSubmit', prompt: text }), null, text)
  }
  // Only well-formed links are echoed back.
  const odd = respond({ hook_event_name: 'UserPromptSubmit', prompt: 'in-parallel://acme/action_item/1"><b>x</b> and in-parallel://acme/risk/2' })
  assert.match(odd.hookSpecificOutput.additionalContext, /link in-parallel:\/\/acme\/action_item\/1, in-parallel:\/\/acme\/risk\/2\./)
})

test('a pull request made while working on an item gets a results reminder', t => {
  const sent = transcript(t, [SKILL_LISTING, prompt(SEND), report('started')])
  const output = shell(sent, 'gh pr create --fill', `${PR}\n`)
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse')
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`pull request: ${PR}\\..*in results, with a short label`))
  // A printed pull request URL counts too, and a create whose URL was not captured.
  assert.match(shell(sent, 'gh pr view --json url --jq .url', `${PR}\n`).hookSpecificOutput.additionalContext, /in results/)
  assert.match(shell(sent, 'gh pr create --fill', '').hookSpecificOutput.additionalContext, /You ran gh pr create\./)
  // Codex sends the command as an argument list and the output as text.
  const codex = respond({ hook_event_name: 'PostToolUse', transcript_path: sent, tool_name: 'Bash',
    tool_input: { command: ['bash', '-lc', 'gh pr create --fill'] }, tool_response: `Creating pull request\n${PR}\n` })
  assert.match(codex.hookSpecificOutput.additionalContext, new RegExp(PR))
})

test('pull request reminders stay quiet without a started report or once the link is reported', t => {
  assert.equal(shell(transcript(t, [prompt('Open a PR for this branch')]), 'gh pr create --fill', PR), null)
  // The skill listing, a prompt with a link, or a quoted report_back call is no started report.
  const listed = transcript(t, [SKILL_LISTING, prompt(SEND), prompt(`Earlier: ${JSON.stringify(report('started'))}`)])
  for (const command of ['gh pr create --fill', 'gh pr view 42']) assert.equal(shell(listed, command, PR), null, command)
  // Reading an item or a note without a start is not work on it.
  assert.equal(shell(transcript(t, [SKILL_LISTING, toolUse('mcp__plugin_in-parallel_in_parallel__get_action_item', { action_item_id: LINK }),
    report('note', { note: 'Context' })]), 'gh pr create --fill', PR), null)
  // The pull request link already passed to report_back, from Claude Code or Codex code mode.
  assert.equal(shell(transcript(t, [prompt(SEND), report('started'), report('note', { note: 'PR open', results: [{ label: 'Pull request', url: PR }] })]), 'gh pr view', PR), null)
  const codeReport = codexScript(`await tools.mcp__in_parallel__report_back({ link: "${LINK}", event: "note", results: [{ label: "Pull request", url: "${PR}" }] })`)
  assert.equal(shell(transcript(t, [codexPrompt(SEND), codexCall('report_back', { link: LINK, event: 'started' }), codeReport]), 'gh pr view', PR), null)
  // The link only in a prompt is not a report of it.
  assert.ok(shell(transcript(t, [prompt(`${SEND}\n${PR}`), report('started')]), 'gh pr view', PR))
  // Another pull request in the same session still gets its reminder.
  assert.ok(shell(transcript(t, [prompt(SEND), report('started'), report('note', { results: [{ label: 'Pull request', url: PR }] })]), 'gh pr view', 'https://github.com/acme/website/pull/43'))
  // The work-on command starts by id, without a link in the prompt.
  assert.ok(shell(transcript(t, [prompt('/in-parallel:work-on'), toolUse(SERVER_TOOL, { item_id: '0a1b2c3d', event: 'started' })]), 'gh pr create --fill', PR))
  const sent = transcript(t, [prompt(SEND), report('started')])
  assert.equal(shell(sent, 'git push', 'Everything up-to-date'), null)
  assert.equal(shell(sent, 'gh pr view', 'https://github.com/acme/website/issues/7'), null)
  // Commands that list or log pull requests are not checked.
  for (const command of ['gh pr list', 'git log --oneline', 'gh api repos/acme/website/pulls', 'gh pr checks 42']) assert.equal(shell(sent, command, PR), null, command)
  assert.equal(respond({ hook_event_name: 'PostToolUse', transcript_path: sent, tool_name: 'Edit',
    tool_input: { file_path: 'a.md', new_string: 'gh pr create' }, tool_response: PR }), null)
  assert.equal(shell(undefined, 'gh pr create', PR), null)
  assert.equal(shell(path.join(path.dirname(sent), 'missing.jsonl'), 'gh pr create', PR), null)
})

test('a started report in a Codex rollout counts, as a function call or in a code mode script', t => {
  const bash = command => ({ tool_input: { command: ['bash', '-lc', command] } })
  for (const lines of [
    [codexPrompt(SEND), codexCall('report_back', { link: LINK, event: 'started' })],
    [codexPrompt(SEND), codexCall('mcp__in_parallel__report_back', { link: LINK, event: 'started' })],
    [codexPrompt(SEND), codexScript(`await tools.mcp__in_parallel__report_back({ link: "${LINK}", event: 'started' })`)],
  ]) assert.ok(shell(transcript(t, lines), '', PR, bash('gh pr create --fill')))
  for (const lines of [
    [codexPrompt(SEND)],
    [codexPrompt(SEND), codexCall('report_back', { link: LINK, event: 'note' })],
    [codexPrompt(SEND), { type: 'response_item', payload: { type: 'function_call', name: 'report_back', namespace: 'mcp__other__', arguments: '{"event":"started"}', call_id: 'c' } }],
    [codexPrompt(SEND), codexScript('await tools.exec_command({ cmd: "echo report_back started" })')],
  ]) assert.equal(shell(transcript(t, lines), '', PR, bash('gh pr create --fill')), null)
})

const ARGS = { link: LINK, event: 'started', note: 'Fixing the Safari login' }
const preToolUse = (extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: 'session-1', tool_name: SERVER_TOOL, tool_input: ARGS, ...extra })

test('report_back gets the session id as client_session, with every other argument kept', () => {
  const { stdout, status } = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(preToolUse()), encoding: 'utf8', env: { PATH: process.env.PATH } })
  assert.equal(status, 0)
  const { hookSpecificOutput } = JSON.parse(stdout)
  assert.deepEqual(hookSpecificOutput, { hookEventName: 'PreToolUse', updatedInput: { ...ARGS, client_session: 'session-1' } })
  // Permission is left to the person's normal rules.
  assert.equal('permissionDecision' in hookSpecificOutput, false)
  // The session id replaces a client_session the model wrote.
  assert.equal(respond(preToolUse({ tool_input: { ...ARGS, client_session: 'made-up' } })).hookSpecificOutput.updatedInput.client_session, 'session-1')
})

test('In Parallel item reads get the session id as client_session too, so they can tell this conversation from its siblings', () => {
  const READ = { observation_ids: [LINK] }
  for (const tool of ['get_action_item', 'get_decision', 'get_risk', 'get_open_question', 'get_observations']) {
    const name = `mcp__plugin_in-parallel_in_parallel__${tool}`
    assert.deepEqual(respond(preToolUse({ tool_name: name, tool_input: READ })).hookSpecificOutput.updatedInput, { ...READ, client_session: 'session-1' }, name)
    assert.ok(respond(preToolUse({ tool_name: `mcp__in_parallel__${tool}` })), tool)
  }
})

test('In Parallel item closes get the session id as client_session, so a Claude Code close finishes only this conversation\'s start', () => {
  const CLOSES = { close_action_items: { action_item_ids: [LINK], resolution: 'Shipped' }, update_action_item: { action_item_id: LINK, status: 'done' } }
  for (const [tool, args] of Object.entries(CLOSES)) {
    const name = `mcp__plugin_in-parallel_in_parallel__${tool}`
    assert.deepEqual(respond(preToolUse({ tool_name: name, tool_input: args })).hookSpecificOutput.updatedInput, { ...args, client_session: 'session-1' }, name)
    assert.ok(respond(preToolUse({ tool_name: `mcp__in_parallel__${tool}`, tool_input: args })), tool)
    assert.equal(respond(preToolUse({ tool_name: `mcp__other__${tool}`, tool_input: args })), null, tool)
  }
})

test('only In Parallel report_back calls, item closes and item reads are tagged', () => {
  for (const name of [SERVER_TOOL, 'mcp__in_parallel__report_back', 'mcp__in-parallel__report_back']) assert.ok(respond(preToolUse({ tool_name: name })), name)
  for (const name of ['mcp__plugin_in-parallel_in_parallel__report_back_reminder', 'mcp__plugin_in-parallel_in_parallel__list_action_items',
    'mcp__plugin_in-parallel_in_parallel__get_action_items', 'mcp__other__get_action_item',
    'mcp__other__report_back', 'report_back', 'Bash']) assert.equal(respond(preToolUse({ tool_name: name })), null, name)
  // The hook's matcher is the same pattern.
  const [group] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'experimental', 'agent-work', 'hooks', 'claude.json'), 'utf8')).hooks.PreToolUse
  assert.equal(group.matcher, TAGGED.source)
})

test('report_back without a session id or arguments is left as sent', () => {
  assert.equal(respond(preToolUse({ session_id: '' })), null)
  assert.equal(respond(preToolUse({ session_id: undefined })), null)
  assert.equal(respond(preToolUse({ tool_input: null })), null)
  assert.equal(respond(preToolUse({ tool_input: ['a'] })), null)
})

// Records every path the hook opens and module it loads, and any credential-like
// environment variable it looks up.
const PRELOAD = `
const fs = require('node:fs'), Module = require('node:module')
const seen = { paths: [], modules: [], env: [] }
for (const name of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'createReadStream', 'accessSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync']) {
  const original = fs[name]
  fs[name] = function (target, ...rest) { seen.paths.push([name, typeof target === 'number' ? target : String(target)]); return original.call(this, target, ...rest) }
}
const load = Module._load
Module._load = function (request, ...rest) { seen.modules.push(request); return load.call(this, request, ...rest) }
const env = process.env
process.env = new Proxy(env, { get(target, key) { if (typeof key === 'string') seen.env.push(key); return target[key] } })
process.on('exit', () => fs.writeSync(2, '\\nSEEN ' + JSON.stringify(seen)))
`

function runHook(t, input, env = {}) {
  const dir = tmp(t, 'in-parallel-reminders-run')
  const preload = path.join(dir, 'preload.cjs')
  fs.writeFileSync(preload, PRELOAD)
  const result = spawnSync(process.execPath, ['--require', preload, SCRIPT], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, IN_PARALLEL_TOKEN: 'secret', ...env },
  })
  const seen = JSON.parse(result.stderr.split('\nSEEN ').pop())
  return { ...result, seen }
}

test('the hook reads only its input and the transcript, loads only fs, and never fails the session', t => {
  const file = transcript(t, [prompt(SEND), report('started')])
  for (const input of [
    { hook_event_name: 'PostToolUse', transcript_path: file, tool_name: 'Bash', tool_input: { command: 'gh pr create' }, tool_response: { stdout: PR } },
    { hook_event_name: 'UserPromptSubmit', transcript_path: file, prompt: SEND },
    preToolUse({ transcript_path: file }),
  ]) {
    const { status, stdout, seen } = runHook(t, input)
    assert.equal(status, 0)
    assert.ok(JSON.parse(stdout), input.hook_event_name)
    const opened = seen.paths.map(([, target]) => target)
    // Node reads the script itself; the hook reads stdin (0) and the transcript.
    assert.ok(opened.every(target => [0, file, SCRIPT].includes(target)), JSON.stringify(seen.paths))
    assert.equal(opened.includes(file), input.hook_event_name === 'PostToolUse')
    assert.deepEqual([...new Set(seen.modules)].filter(name => name !== SCRIPT && !name.startsWith('internal/')), ['node:fs'])
    assert.deepEqual(seen.env.filter(key => /TOKEN|KEY|SECRET|PASS|AUTH|CRED|HOME|CONFIG/i.test(key)), [])
  }
  for (const input of ['not json', '', JSON.stringify({ hook_event_name: 'PostToolUse', transcript_path: 42 }), JSON.stringify({ hook_event_name: 'SessionStart' }), JSON.stringify({ hook_event_name: 'Stop', transcript_path: file })]) {
    const { status, stdout } = runHook(t, input)
    assert.equal(status, 0)
    assert.equal(stdout, '')
  }
})

// Claude Code runs an exec form hook with no shell: it substitutes CLAUDE_PLUGIN_ROOT
// into each argument as a plain string, so a root with spaces or quotes needs no quoting.
test('the Claude Code hooks run node on the script by its path, with no shell', t => {
  const plugin = path.join(tmp(t, 'in-parallel-claude-plugin'), "Max's plugins $HOME")
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true })
  fs.copyFileSync(SCRIPT, path.join(plugin, 'scripts', 'reminders.js'))
  const hooks = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'experimental', 'agent-work', 'hooks', 'claude.json'), 'utf8')).hooks
  const commands = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].flatMap(event => hooks[event].flatMap(group => group.hooks))
  assert.equal(commands.length, 3)
  for (const hook of commands) {
    assert.equal(hook.command, 'node')
    const args = hook.args.map(arg => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin))
    const { status, stdout } = spawnSync(process.execPath, args, { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: SEND }), encoding: 'utf8' })
    assert.equal(status, 0)
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, new RegExp(LINK))
  }
})

// Codex expands no variables in a hook command: it runs the command with the
// session's shell (sh, bash or zsh with -c on macOS and Linux) and sets PLUGIN_ROOT
// and CLAUDE_PLUGIN_ROOT in its environment (codex-rs hooks/src/engine/discovery.rs),
// with the session's directory as the working directory.
test('the Codex hook commands run from any directory with the root Codex sets, and only with it', t => {
  const plugin = tmp(t, 'in-parallel-codex-plugin')
  const cwd = tmp(t, 'in-parallel-codex-cwd')
  fs.mkdirSync(path.join(plugin, 'scripts'))
  fs.copyFileSync(SCRIPT, path.join(plugin, 'scripts', 'reminders.js'))
  const hooks = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'experimental', 'agent-work', 'hooks', 'codex.json'), 'utf8')).hooks
  const commands = ['UserPromptSubmit', 'PostToolUse'].flatMap(event => hooks[event].flatMap(group => group.hooks).map(hook => [event, hook.command]))
  assert.equal(commands.length, 2)
  const PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`
  const run = (command, input, env) => spawnSync('/bin/sh', ['-c', command], { cwd, input: JSON.stringify(input), encoding: 'utf8', env: { PATH, ...env } })
  for (const [event, command] of commands) {
    const input = { hook_event_name: event, prompt: SEND, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '' } }
    const ok = run(command, input, { PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_ROOT: plugin })
    assert.equal(ok.status, 0, `${event}: ${ok.stderr}`)
    if (event === 'UserPromptSubmit') assert.match(JSON.parse(ok.stdout).hookSpecificOutput.additionalContext, /in-parallel-agent-work skill/)
    // Without the root the path is /scripts/reminders.js and node exits 1: the "hook exited with code 1" symptom.
    assert.equal(run(command, input, {}).status, 1, event)
  }
})
