'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SCRIPT = path.resolve(__dirname, '..', 'experimental', 'agent-work', 'scripts', 'session.js')
const HOOKS = path.resolve(__dirname, '..', 'experimental', 'agent-work', 'hooks', 'claude.json')
const { respond, REPORT_BACK } = require(SCRIPT)
const TOOL = 'mcp__plugin_in-parallel_in_parallel__report_back'
const ARGS = { link: 'in-parallel://acme/action_item/0a1b2c3d-1111-2222-3333-444455556666', event: 'started', note: 'Fixing the Safari login' }

const preToolUse = (extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: 'session-1', tool_name: TOOL, tool_input: ARGS, ...extra })
const run = input => spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', env: { PATH: process.env.PATH } })

test('report_back gets the session id as client_session, with every other argument kept', () => {
  const { stdout, status } = run(JSON.stringify(preToolUse()))
  assert.equal(status, 0)
  const { hookSpecificOutput } = JSON.parse(stdout)
  assert.deepEqual(hookSpecificOutput, { hookEventName: 'PreToolUse', updatedInput: { ...ARGS, client_session: 'session-1' } })
  // Permission is left to the person's normal rules.
  assert.equal('permissionDecision' in hookSpecificOutput, false)
})

test('the session id replaces a client_session the model wrote', () => {
  const output = respond(preToolUse({ tool_input: { ...ARGS, client_session: 'made-up' } }))
  assert.equal(output.hookSpecificOutput.updatedInput.client_session, 'session-1')
})

test('only In Parallel report_back calls are changed', () => {
  for (const name of [TOOL, 'mcp__in_parallel__report_back', 'mcp__in-parallel__report_back']) assert.ok(respond(preToolUse({ tool_name: name })), name)
  for (const name of ['mcp__plugin_in-parallel_in_parallel__report_back_reminder', 'mcp__plugin_in-parallel_in_parallel__get_action_item',
    'mcp__other__report_back', 'Bash']) assert.equal(respond(preToolUse({ tool_name: name })), null, name)
  // The hook's matcher is the same pattern.
  const [group] = JSON.parse(fs.readFileSync(HOOKS, 'utf8')).hooks.PreToolUse
  assert.equal(group.matcher, REPORT_BACK.source)
})

test('without a session id or arguments, or on bad input, it writes nothing and exits 0', () => {
  assert.equal(respond(preToolUse({ session_id: '' })), null)
  assert.equal(respond(preToolUse({ session_id: undefined })), null)
  assert.equal(respond(preToolUse({ tool_input: null })), null)
  assert.equal(respond(preToolUse({ tool_input: ['a'] })), null)
  assert.equal(respond(preToolUse({ hook_event_name: 'PostToolUse' })), null)
  for (const input of ['', 'not json', 'null', '[]']) {
    const { stdout, status } = run(input)
    assert.equal(status, 0)
    assert.equal(stdout, '')
  }
})
