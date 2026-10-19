#!/usr/bin/env node
'use strict'

// Reporting reminders for the agent-work feature: on a prompt carrying an In
// Parallel link, and after a pull request. The stop reminder is not here: the
// Stop hook asks In Parallel's report_back_reminder tool through the client's
// own connection.
//
// Before Claude Code calls In Parallel's report_back, an item close
// (close_action_items, update_action_item) or an item read (get_action_item,
// get_decision, get_risk, get_open_question, get_observations), it adds this
// conversation's session id as client_session, so In Parallel scopes the stop
// reminder to the conversation that reported, as the Stop hook does with the same
// id, a close finishes only this conversation's start, and an item read lists the
// person's other conversations working on the item.
// Every other argument is kept as sent, and permission is left to the person's
// normal rules.
//
// Reads only the hook input on stdin and, after a pull request, the newest part of
// the local session transcript it names.
// Never reads credentials or settings, never connects to anything, never writes
// files, and always exits 0 so a reminder can never break a session.

const fs = require('node:fs')

const LINK = /in-parallel:\/\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)+/g
const PULL_REQUEST = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/
const CREATE_PR = /\bgh\s+pr\s+create\b/
// The In Parallel tools that take client_session, on the plugin's own server or
// one configured on its own; the Claude Code hook matcher too.
const TAGGED = /^mcp__(plugin_in-parallel_in_parallel|in_parallel|in-parallel)__(report_back|close_action_items|update_action_item|get_action_item|get_decision|get_risk|get_open_question|get_observations)$/
// The newest part of the transcript is enough to tell whether In Parallel work is in it.
const TAIL = 4 * 1024 * 1024

function readTail(file) {
  if (typeof file !== 'string' || !file) return ''
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const length = Math.min(size, TAIL)
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, size - length)
      return buffer.toString('utf8')
    } finally { fs.closeSync(fd) }
  } catch {
    return ''
  }
}

// Whether the session works with In Parallel items, and whether this pull request
// was already passed to report_back.
function pullRequestNeedsReport(transcript, url) {
  if (!transcript.includes('in-parallel://') && !transcript.includes('report_back')) return false
  return !url || !transcript.split('\n').some(line => line.includes('report_back') && line.includes(url))
}

function commandText(input) {
  const command = input?.command ?? input?.cmd
  if (Array.isArray(command)) return command.join(' ')
  return typeof command === 'string' ? command : ''
}

function context(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
}

function tagSession(input) {
  if (typeof input.tool_name !== 'string' || !TAGGED.test(input.tool_name)) return null
  const args = input.tool_input
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  if (typeof input.session_id !== 'string' || !input.session_id) return null
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...args, client_session: input.session_id } } }
}

function respond(input) {
  if (!input || typeof input !== 'object') return null
  const event = input.hook_event_name
  if (event === 'PreToolUse') return tagSession(input)
  if (event === 'UserPromptSubmit') {
    const links = [...new Set(String(input.prompt || '').match(LINK) || [])].slice(0, 3)
    if (!links.length) return null
    return context(event, `This prompt carries the In Parallel link ${links.join(', ')}. Load the in-parallel-agent-work skill and report on it with report_back and that link as the request needs. ` +
      'Asked only to add a note? Report just that "note", in the person\'s words: no "started" and no "finished". ' +
      'If you work on this item, report "started" before you begin, and when the work is done, report "finished" with results: links to what the work produced, each with a short label, such as the revised draft. Work not done is a "note" saying what remains, not "finished". ' +
      'Reading it or answering questions about it is not work: do not report. Asked only for a plan? Give it and do not start. Asked to start, then wait for a go-ahead? Report "started", then a "note" with waiting: true. Told not to report (anything else)? Report only what they asked for.')
  }
  if (event === 'PostToolUse') {
    const command = commandText(input.tool_input)
    if (!command) return null
    const url = (JSON.stringify(input.tool_response ?? '').match(PULL_REQUEST) || [])[0]
    if (!url && !CREATE_PR.test(command)) return null
    if (!pullRequestNeedsReport(readTail(input.transcript_path), url)) return null
    return context(event, url
      ? `You have a pull request: ${url}. If it is for the In Parallel item you are working on, pass it in results, with a short label such as "Pull request", when you call report_back.`
      : 'You ran gh pr create. If it made a pull request for the In Parallel item you are working on, pass its link in results, with a short label such as "Pull request", when you call report_back.')
  }
  return null
}

function main() {
  try {
    const output = respond(JSON.parse(fs.readFileSync(0, 'utf8')))
    if (output) process.stdout.write(JSON.stringify(output))
  } catch {}
}

if (require.main === module) main()

module.exports = { respond, TAGGED }
