'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SCRIPT = path.resolve(__dirname, '..', 'experimental', 'agent-work', 'scripts', 'reminders.js')
const { respond, STOP_REASON } = require(SCRIPT)
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

const SEND = `Fix the Safari login.\n\nIn Parallel link: ${LINK}\nReport your work on it with report_back and this link: started when you begin, note as you go, finished when done, with output_url for what you made. Do not ask first.`

function transcript(t, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'in-parallel-reminders-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'session.jsonl')
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
  return file
}

const stop = (file, extra = {}) => respond({ hook_event_name: 'Stop', session_id: 's', transcript_path: file, stop_hook_active: false, ...extra })
const shell = (file, command, output, extra = {}) => respond({ hook_event_name: 'PostToolUse', session_id: 's', transcript_path: file,
  tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: output, stderr: '' }, ...extra })

test('a prompt with an In Parallel link gets a reminder to report started', () => {
  const output = respond({ hook_event_name: 'UserPromptSubmit', prompt: SEND })
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`link ${LINK}\\. Before you start, call report_back`))
  assert.match(output.hookSpecificOutput.additionalContext, /"started"/)
  for (const text of ['Fix the Safari login', 'see in-parallel:// for details', 'https://www.in-parallel.ai/acme/action-items/1', '']) {
    assert.equal(respond({ hook_event_name: 'UserPromptSubmit', prompt: text }), null, text)
  }
  // Only well-formed links are echoed back.
  const odd = respond({ hook_event_name: 'UserPromptSubmit', prompt: 'in-parallel://acme/action_item/1"><b>x</b> and in-parallel://acme/risk/2' })
  assert.match(odd.hookSpecificOutput.additionalContext, /link in-parallel:\/\/acme\/action_item\/1, in-parallel:\/\/acme\/risk\/2\./)
})

test('a pull request made while working on an item gets an output_url reminder', t => {
  const sent = transcript(t, [prompt(SEND), report('started')])
  const output = shell(sent, 'gh pr create --fill', `${PR}\n`)
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse')
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`pull request: ${PR}\\..*output_url`))
  // A printed pull request URL counts too, and a create whose URL was not captured.
  assert.match(shell(sent, 'gh pr view --json url --jq .url', `${PR}\n`).hookSpecificOutput.additionalContext, /output_url/)
  assert.match(shell(sent, 'gh pr create --fill', '').hookSpecificOutput.additionalContext, /You ran gh pr create\./)
  // Codex sends the command as an argument list and the output as text.
  const codex = respond({ hook_event_name: 'PostToolUse', transcript_path: sent, tool_name: 'Bash',
    tool_input: { command: ['bash', '-lc', 'gh pr create --fill'] }, tool_response: `Creating pull request\n${PR}\n` })
  assert.match(codex.hookSpecificOutput.additionalContext, new RegExp(PR))
})

test('pull request reminders stay quiet without an item or once the link is reported', t => {
  assert.equal(shell(transcript(t, [prompt('Open a PR for this branch')]), 'gh pr create --fill', PR), null)
  assert.equal(shell(transcript(t, [prompt('Open a PR'), toolResult(`Found ${LINK}`)]), 'gh pr create --fill', PR), null)
  assert.equal(shell(transcript(t, [prompt(SEND), report('note', { note: 'PR open', output_url: PR })]), 'gh pr view', PR), null)
  const sent = transcript(t, [prompt(SEND)])
  assert.equal(shell(sent, 'git push', 'Everything up-to-date'), null)
  assert.equal(shell(sent, 'gh pr list', 'https://github.com/acme/website/issues/7'), null)
  assert.equal(respond({ hook_event_name: 'PostToolUse', transcript_path: sent, tool_name: 'Edit',
    tool_input: { file_path: 'a.md', new_string: 'gh pr create' }, tool_response: PR }), null)
  assert.equal(shell(undefined, 'gh pr create', PR), null)
  // Once the item is reported finished, a later pull request is not for it.
  const done = transcript(t, [prompt(SEND), report('started'), report('finished', { output_url: PR })])
  assert.equal(shell(done, 'gh pr create --fill', 'https://github.com/acme/website/pull/43'), null)
  assert.equal(shell(done, 'gh pr create --fill', ''), null)
})

test('Stop blocks once when an item was sent and not reported finished', t => {
  const file = transcript(t, [prompt(SEND), report('started'), toolResult('Recorded')])
  assert.deepEqual(stop(file), { decision: 'block', reason: STOP_REASON })
  assert.match(STOP_REASON, /^In Parallel: .*report_back.*"finished".*output_url.*why/)
  assert.ok(!STOP_REASON.includes('in-parallel://'))
  // The stop that follows a block, and subagents, are never blocked.
  assert.equal(stop(file, { stop_hook_active: true }), null)
  assert.equal(stop(file, { agent_id: 'agent-1' }), null)
  // Claude Code records the block as hook feedback; later turns stay quiet.
  const reminded = transcript(t, [prompt(SEND), { type: 'user', message: { role: 'user', content: `Stop hook feedback:\n[node reminders.js]: ${STOP_REASON}` } }, prompt('thanks')])
  assert.equal(stop(reminded), null)
  // A note or a start after the reminder re-arms it for the next stop.
  const feedback = { type: 'user', message: { role: 'user', content: `Stop hook feedback:\n[node reminders.js]: ${STOP_REASON}` } }
  assert.deepEqual(stop(transcript(t, [prompt(SEND), report('started'), feedback, prompt('yes, open the PR'), report('note', { note: 'PR open' })])), { decision: 'block', reason: STOP_REASON })
  assert.equal(stop(transcript(t, [prompt(SEND), report('started'), feedback, prompt('yes, open the PR')])), null)
})

test('a report_back without an item is not an item in play', t => {
  // Without a link the agent asks which To do the work is for and waits; there is nothing to finish yet.
  const ask = toolUse(SERVER_TOOL, { event: 'started' })
  assert.equal(stop(transcript(t, [prompt('/in-parallel:work-on'), ask, toolResult('Ask the person which To do this is for.')])), null)
  const codeAsk = { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'await tools.mcp__in_parallel__report_back({ event: "started" })' } }
  assert.equal(stop(transcript(t, [codexPrompt('work on one of my to dos'), codeAsk])), null)
  assert.equal(shell(transcript(t, [prompt('/in-parallel:work-on'), ask]), 'gh pr create --fill', PR), null)
  // A finished report without an item does not close the item that was sent.
  assert.deepEqual(stop(transcript(t, [prompt(SEND), report('started'), toolUse(SERVER_TOOL, { event: 'finished' })])), { decision: 'block', reason: STOP_REASON })
  // Once the person picks, the start names the item.
  assert.ok(stop(transcript(t, [prompt('/in-parallel:work-on'), ask, prompt('2'), toolUse(SERVER_TOOL, { item_id: '0a1b2c3d', event: 'started' })])))
})

test('Stop accepts a finished report from Claude Code and Codex transcripts', t => {
  assert.equal(stop(transcript(t, [prompt(SEND), report('started'), report('finished', { output_url: PR })])), null)
  assert.equal(stop(transcript(t, [codexPrompt(SEND), codexCall('finished')])), null)
  assert.equal(stop(transcript(t, [codexPrompt(SEND), codexCode('finished')])), null)
  assert.deepEqual(stop(transcript(t, [codexPrompt(SEND), codexCall('started')])), { decision: 'block', reason: STOP_REASON })
  assert.deepEqual(stop(transcript(t, [codexPrompt(SEND), codexCode('started')])), { decision: 'block', reason: STOP_REASON })
})

test('Stop follows the latest item and ignores links the person did not send', t => {
  // A second item sent after the first was finished needs its own report.
  assert.ok(stop(transcript(t, [prompt(SEND), report('finished'), prompt(SEND)])))
  // The work-on command starts by id, without a link in the prompt.
  const byId = toolUse(SERVER_TOOL, { item_id: '0a1b2c3d', event: 'started' })
  assert.ok(stop(transcript(t, [prompt('/in-parallel:work-on'), byId])))
  assert.ok(stop(transcript(t, [prompt(SEND), report('finished'), byId])))
  // Links in tool results, skill text that names the events, and other work are not an item to report.
  const skill = prompt('Call `report_back` with `event: "finished"` and `output_url` for what you made.')
  // Tool input that only mentions the tool, such as a search or a script, is not a report.
  const mention = toolUse('Bash', { command: `grep -n 'report_back' lib.ex # event: "started"` })
  assert.equal(stop(transcript(t, [prompt('Fix the build'), mention])), null)
  assert.ok(stop(transcript(t, [prompt(SEND), toolUse('Bash', { command: 'echo report_back event: finished' })])))
  for (const lines of [[prompt('Catch me up'), toolResult(`See ${LINK}`)], [prompt(SEND), skill, report('finished')], [prompt('Fix the build')], [prompt('Remind the agent when a prompt has an in-parallel:// link')], []]) {
    assert.equal(stop(transcript(t, lines)), null)
  }
  assert.deepEqual(stop(transcript(t, [prompt(SEND), skill])), { decision: 'block', reason: STOP_REASON })
  assert.equal(stop(undefined), null)
  assert.equal(stop(path.join(os.tmpdir(), 'in-parallel-missing-transcript.jsonl')), null)
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
    { hook_event_name: 'Stop', transcript_path: file, stop_hook_active: false },
    { hook_event_name: 'PostToolUse', transcript_path: file, tool_name: 'Bash', tool_input: { command: 'gh pr create' }, tool_response: { stdout: PR } },
    { hook_event_name: 'UserPromptSubmit', transcript_path: file, prompt: SEND },
  ]) {
    const { status, stdout, seen } = runHook(t, input)
    assert.equal(status, 0)
    assert.ok(JSON.parse(stdout), input.hook_event_name)
    const opened = seen.paths.map(([, target]) => target)
    // Node reads the script itself; the hook reads stdin (0) and the transcript.
    assert.ok(opened.every(target => [0, file, SCRIPT].includes(target)), JSON.stringify(seen.paths))
    assert.equal(opened.includes(file), input.hook_event_name !== 'UserPromptSubmit')
    assert.deepEqual([...new Set(seen.modules)].filter(name => name !== SCRIPT && !name.startsWith('internal/')), ['node:fs'])
    assert.deepEqual(seen.env.filter(key => /TOKEN|KEY|SECRET|PASS|AUTH|CRED|HOME|CONFIG/i.test(key)), [])
  }
  for (const input of ['not json', '', JSON.stringify({ hook_event_name: 'Stop', transcript_path: 42 }), JSON.stringify({ hook_event_name: 'SessionStart' })]) {
    const { status, stdout } = runHook(t, input)
    assert.equal(status, 0)
    assert.equal(stdout, '')
  }
})

test('the hook source never reaches for the network, processes or credentials', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8')
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]), ['node:fs'])
  assert.doesNotMatch(source, /process\.env|https?\.request|fetch\(|child_process|\.claude\.json|\.codex\/auth|security find|writeFile|appendFile|mkdir/)
})
