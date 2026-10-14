'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SCRIPT = path.resolve(__dirname, '..', 'experimental', 'agent-work', 'scripts', 'reminders.js')
const { respond, scan, REPORT_BACK } = require(SCRIPT)
const LINK = 'in-parallel://acme/action_item/0a1b2c3d-1111-2222-3333-444455556666'
const PR = 'https://github.com/acme/website/pull/42'
const SERVER_TOOL = 'mcp__plugin_in-parallel_in_parallel__report_back'

// Claude Code transcript lines.
const prompt = text => ({ type: 'user', message: { role: 'user', content: text } })
const toolUse = (name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name, input }] } })
const toolResult = text => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] } })
const report = (event, extra = {}) => toolUse(SERVER_TOOL, { link: LINK, event, ...extra })
// Codex rollout lines.
const codexPrompt = text => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
const codexCall = (event, extra = {}) => ({ type: 'response_item', payload: { type: 'function_call', name: 'mcp__in_parallel__report_back', arguments: JSON.stringify({ link: LINK, event, ...extra }) } })
const codexCode = event => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: `await tools.mcp__in_parallel__report_back({ link: "${LINK}", event: "${event}" })` } })

const SEND = `Fix the Safari login.\n\nIn Parallel link: ${LINK}\nReport your work on it with report_back and this link: started when you begin, note as you go, finished when done, with results: links to what the work produced, each with a short label. Do not ask first.`

function transcript(t, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'in-parallel-reminders-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'session.jsonl')
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  return file
}

const stop = (file, extra = {}) => respond({ hook_event_name: 'Stop', session_id: 's', transcript_path: file, stop_hook_active: false, ...extra })
// Whether the transcript has an item in play that is not reported finished, as the pull request reminder reads it.
const inPlay = file => { const state = scan(file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null); return state.sent && !state.finished }
const shell = (file, command, output, extra = {}) => respond({ hook_event_name: 'PostToolUse', session_id: 's', transcript_path: file,
  tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: output, stderr: '' }, ...extra })

test('a prompt with an In Parallel link gets a reminder to report started if it works on the item', () => {
  const output = respond({ hook_event_name: 'UserPromptSubmit', prompt: SEND })
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`link ${LINK}\\. If you work on this item, call report_back`))
  assert.match(output.hookSpecificOutput.additionalContext, /answering questions about it is not work/)
  assert.match(output.hookSpecificOutput.additionalContext, /"started"/)
  for (const text of ['Fix the Safari login', 'see in-parallel:// for details', 'https://www.in-parallel.ai/acme/action-items/1', '']) {
    assert.equal(respond({ hook_event_name: 'UserPromptSubmit', prompt: text }), null, text)
  }
  // Only well-formed links are echoed back.
  const odd = respond({ hook_event_name: 'UserPromptSubmit', prompt: 'in-parallel://acme/action_item/1"><b>x</b> and in-parallel://acme/risk/2' })
  assert.match(odd.hookSpecificOutput.additionalContext, /link in-parallel:\/\/acme\/action_item\/1, in-parallel:\/\/acme\/risk\/2\./)
})

test('a pull request made while working on an item gets a results reminder', t => {
  const sent = transcript(t, [prompt(SEND), report('started')])
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

test('pull request reminders stay quiet without an item or once the link is reported', t => {
  assert.equal(shell(transcript(t, [prompt('Open a PR for this branch')]), 'gh pr create --fill', PR), null)
  assert.equal(shell(transcript(t, [prompt('Open a PR'), toolResult(`Found ${LINK}`)]), 'gh pr create --fill', PR), null)
  assert.equal(shell(transcript(t, [prompt(SEND), report('note', { note: 'PR open', results: [{ label: 'Pull request', url: PR }] })]), 'gh pr view', PR), null)
  // Any of several results counts, from a Claude Code tool call or Codex code mode.
  const second = 'https://github.com/acme/website/pull/44'
  assert.equal(shell(transcript(t, [prompt(SEND), report('note', { results: [{ label: 'Docs', url: 'https://docs.acme.test/a' }, { label: 'Pull request', url: second }] })]), 'gh pr view', second), null)
  const codeReport = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: `await tools.mcp__in_parallel__report_back({ link: "${LINK}", event: "note", results: [{ label: "Pull request", url: "${second}" }] })` } }
  assert.equal(shell(transcript(t, [codexPrompt(SEND), codeReport]), 'gh pr view', second), null)
  const code = input => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } })
  const codeSecond = code(`await tools.mcp__in_parallel__report_back({ link: "${LINK}", event: "note", results: [{ label: "Docs", url: "https://docs.acme.test/a" }, { label: "Pull request", url: "${second}" }] })`)
  assert.equal(shell(transcript(t, [codexPrompt(SEND), codeSecond]), 'gh pr view', second), null)
  // A finish with results before the event still ends the item, so a later pull request is not for it.
  const codeFinish = code(`await tools.mcp__in_parallel__report_back({ link: "${LINK}", results: [{ label: "Pull request", url: "${PR}" }], event: "finished" })`)
  assert.equal(shell(transcript(t, [codexPrompt(SEND), codeFinish]), 'gh pr create --fill', 'https://github.com/acme/website/pull/43'), null)
  // A link in the note is not a result, even when the note follows the results or says "results:".
  const docs = { label: 'Docs', url: 'https://docs.acme.test/a' }
  assert.ok(shell(transcript(t, [prompt(SEND), report('note', { results: [docs], note: `PR at ${second}` })]), 'gh pr view', second))
  assert.ok(shell(transcript(t, [prompt(SEND), report('note', { note: `Test results: ${second}` })]), 'gh pr view', second))
  // A link in the note is not a result.
  assert.ok(shell(transcript(t, [prompt(SEND), report('note', { note: `The results are in ${second}` })]), 'gh pr view', second))
  const sent = transcript(t, [prompt(SEND)])
  assert.equal(shell(sent, 'git push', 'Everything up-to-date'), null)
  assert.equal(shell(sent, 'gh pr list', 'https://github.com/acme/website/issues/7'), null)
  assert.equal(respond({ hook_event_name: 'PostToolUse', transcript_path: sent, tool_name: 'Edit',
    tool_input: { file_path: 'a.md', new_string: 'gh pr create' }, tool_response: PR }), null)
  assert.equal(shell(undefined, 'gh pr create', PR), null)
  // Once the item is reported finished, a later pull request is not for it.
  const done = transcript(t, [prompt(SEND), report('started'), report('finished', { results: [{ label: 'Pull request', url: PR }] })])
  assert.equal(shell(done, 'gh pr create --fill', 'https://github.com/acme/website/pull/43'), null)
  assert.equal(shell(done, 'gh pr create --fill', ''), null)
})

test('the script never answers Stop: the stop reminder comes from In Parallel', t => {
  const feedback = { type: 'user', message: { role: 'user', content: 'Stop hook feedback: report it finished' } }
  for (const lines of [[prompt(SEND), report('started'), toolResult('Recorded')], [prompt(SEND)], [codexPrompt(SEND), codexCall('started')],
    [prompt(SEND), report('started'), feedback, report('note', { note: 'PR open' })]]) {
    const file = transcript(t, lines)
    for (const extra of [{}, { stop_hook_active: true }, { agent_id: 'agent-1' }]) assert.equal(stop(file, extra), null)
  }
  assert.equal(stop(undefined), null)
  assert.equal(respond({ hook_event_name: 'SubagentStop', stop_hook_active: false }), null)
  assert.doesNotMatch(fs.readFileSync(SCRIPT, 'utf8'), /'Stop'|decision|STOP_REASON|reminded/)
})

test('a report_back without an item is not an item in play', t => {
  // Without an item the reply lists To dos and records nothing; there is nothing to finish yet.
  const ask = toolUse(SERVER_TOOL, { event: 'started' })
  assert.equal(inPlay(transcript(t, [prompt('/in-parallel:work-on'), ask, toolResult('Ask the person which To do this is for.')])), false)
  const codeAsk = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'await tools.mcp__in_parallel__report_back({ event: "started" })' } }
  assert.equal(inPlay(transcript(t, [codexPrompt('work on one of my to dos'), codeAsk])), false)
  assert.equal(shell(transcript(t, [prompt('/in-parallel:work-on'), ask]), 'gh pr create --fill', PR), null)
  // Asking the person in place still names no item.
  assert.equal(inPlay(transcript(t, [prompt('/in-parallel:work-on'), ask, toolUse(SERVER_TOOL, { event: 'started', ask: true })])), false)
  // A finished report without an item does not close the item that was sent.
  assert.equal(inPlay(transcript(t, [prompt(SEND), report('started'), toolUse(SERVER_TOOL, { event: 'finished' })])), true)
  // Once the person picks, the start names the item.
  assert.equal(inPlay(transcript(t, [prompt('/in-parallel:work-on'), ask, prompt('2'), toolUse(SERVER_TOOL, { item_id: '0a1b2c3d', event: 'started' })])), true)
})

test('a finished report from Claude Code and Codex transcripts ends the item in play', t => {
  assert.equal(inPlay(transcript(t, [prompt(SEND), report('started'), report('finished', { results: [{ label: 'Pull request', url: PR }] })])), false)
  assert.equal(inPlay(transcript(t, [codexPrompt(SEND), codexCall('finished')])), false)
  assert.equal(inPlay(transcript(t, [codexPrompt(SEND), codexCode('finished')])), false)
  assert.equal(inPlay(transcript(t, [codexPrompt(SEND), codexCall('started')])), true)
  assert.equal(inPlay(transcript(t, [codexPrompt(SEND), codexCode('started')])), true)
})

test('a released start from Claude Code and Codex transcripts ends the item in play', t => {
  assert.equal(inPlay(transcript(t, [prompt(SEND), report('started'), report('released')])), false)
  assert.equal(inPlay(transcript(t, [codexPrompt(SEND), codexCall('started'), codexCall('released')])), false)
  assert.equal(inPlay(transcript(t, [codexPrompt(SEND), codexCode('started'), codexCode('released')])), false)
  // A start after a release is new work on the item.
  assert.equal(inPlay(transcript(t, [prompt(SEND), report('started'), report('released'), report('started')])), true)
})

test('the item in play follows the latest item and ignores links the person did not send', t => {
  // A second item sent after the first was finished needs its own report.
  assert.equal(inPlay(transcript(t, [prompt(SEND), report('finished'), prompt(SEND)])), true)
  // The work-on command starts by id, without a link in the prompt.
  const byId = toolUse(SERVER_TOOL, { item_id: '0a1b2c3d', event: 'started' })
  assert.equal(inPlay(transcript(t, [prompt('/in-parallel:work-on'), byId])), true)
  assert.equal(inPlay(transcript(t, [prompt(SEND), report('finished'), byId])), true)
  // Links in tool results, skill text that names the events, and other work are not an item to report.
  const skill = prompt('Call `report_back` with `event: "finished"` and `results` for what the work produced.')
  // Tool input that only mentions the tool, such as a search or a script, is not a report.
  const mention = toolUse('Bash', { command: `grep -n 'report_back' lib.ex # event: "started"` })
  assert.equal(inPlay(transcript(t, [prompt('Fix the build'), mention])), false)
  assert.equal(inPlay(transcript(t, [prompt(SEND), toolUse('Bash', { command: 'echo report_back event: finished' })])), true)
  for (const lines of [[prompt('Catch me up'), toolResult(`See ${LINK}`)], [prompt(SEND), skill, report('finished')], [prompt('Fix the build')], [prompt('Remind the agent when a prompt has an in-parallel:// link')], []]) {
    assert.equal(inPlay(transcript(t, lines)), false)
  }
  assert.equal(inPlay(transcript(t, [prompt(SEND), skill])), true)
  assert.equal(inPlay(undefined), false)
  assert.equal(inPlay(path.join(os.tmpdir(), 'in-parallel-missing-transcript.jsonl')), false)
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

test('only In Parallel report_back calls are tagged or counted as reports', t => {
  for (const name of [SERVER_TOOL, 'mcp__in_parallel__report_back', 'mcp__in-parallel__report_back']) assert.ok(respond(preToolUse({ tool_name: name })), name)
  for (const name of ['mcp__plugin_in-parallel_in_parallel__report_back_reminder', 'mcp__plugin_in-parallel_in_parallel__get_action_item',
    'mcp__other__report_back', 'Bash']) assert.equal(respond(preToolUse({ tool_name: name })), null, name)
  // The transcript scan agrees: another server's report_back is not a report.
  assert.equal(inPlay(transcript(t, [prompt('Fix the build'), toolUse('mcp__other__report_back', { item_id: '0a1b2c3d', event: 'started' })])), false)
  const other = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: `await tools.mcp__other__report_back({ item_id: "0a1b2c3d", event: "started" })` } }
  assert.equal(inPlay(transcript(t, [codexPrompt('Fix the build'), other])), false)
  // The hook's matcher is the same pattern.
  const [group] = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'experimental', 'agent-work', 'hooks', 'claude.json'), 'utf8')).hooks.PreToolUse
  assert.equal(group.matcher, REPORT_BACK.source)
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'in-parallel-reminders-run-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
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
  for (const input of ['not json', '', JSON.stringify({ hook_event_name: 'PostToolUse', transcript_path: 42 }), JSON.stringify({ hook_event_name: 'SessionStart' })]) {
    const { status, stdout } = runHook(t, input)
    assert.equal(status, 0)
    assert.equal(stdout, '')
  }
  // A Stop input gets no reply and the transcript is never read for it.
  const { status, stdout, seen } = runHook(t, { hook_event_name: 'Stop', transcript_path: file, stop_hook_active: false })
  assert.equal(status, 0)
  assert.equal(stdout, '')
  assert.ok(!seen.paths.some(([, target]) => target === file), JSON.stringify(seen.paths))
})

test('the hook source never reaches for the network, processes or credentials', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8')
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]), ['node:fs'])
  assert.doesNotMatch(source, /process\.env|https?\.request|fetch\(|child_process|\.claude\.json|\.codex\/auth|security find|writeFile|appendFile|mkdir/)
})

// Codex expands no variables in a hook command: it runs the command with the
// session's shell (sh, bash or zsh with -c on macOS and Linux) and sets PLUGIN_ROOT
// and CLAUDE_PLUGIN_ROOT in its environment (codex-rs hooks/src/engine/discovery.rs),
// with the session's directory as the working directory.
test('the Codex hook commands run from any directory with the root Codex sets, and only with it', t => {
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'in-parallel-codex-plugin-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'in-parallel-codex-cwd-'))
  t.after(() => { fs.rmSync(plugin, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }) })
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
    if (event === 'UserPromptSubmit') assert.match(JSON.parse(ok.stdout).hookSpecificOutput.additionalContext, /report_back/)
    // Without the root the path is /scripts/reminders.js and node exits 1: the "hook exited with code 1" symptom.
    assert.equal(run(command, input, {}).status, 1, event)
  }
})
