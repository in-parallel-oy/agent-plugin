#!/usr/bin/env node
'use strict'

// Claude Code PreToolUse hook for In Parallel's report_back: adds this
// conversation's session id as client_session, so In Parallel scopes the stop
// reminder to the conversation that reported, as the Stop hook does with the
// same id. Every other argument is kept as sent.
//
// Reads only the hook input on stdin. Never decides permission, so the call
// goes through the person's normal permission rules. Never reads files or
// credentials, never connects to anything, and always exits 0.

const fs = require('node:fs')

// The plugin's server, or an In Parallel server configured on its own.
const REPORT_BACK = /^mcp__(plugin_in-parallel_in_parallel|in_parallel|in-parallel)__report_back$/

function respond(input) {
  if (!input || typeof input !== 'object' || input.hook_event_name !== 'PreToolUse') return null
  if (typeof input.tool_name !== 'string' || !REPORT_BACK.test(input.tool_name)) return null
  const args = input.tool_input
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  if (typeof input.session_id !== 'string' || !input.session_id) return null
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...args, client_session: input.session_id } } }
}

function main() {
  try {
    const output = respond(JSON.parse(fs.readFileSync(0, 'utf8')))
    if (output) process.stdout.write(JSON.stringify(output))
  } catch {}
}

if (require.main === module) main()

module.exports = { respond, REPORT_BACK }
