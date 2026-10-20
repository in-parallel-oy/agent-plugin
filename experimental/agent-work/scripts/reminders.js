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
// the local session transcript it names: Claude Code's session JSONL or Codex's
// rollout. A session without one, such as an ephemeral Codex session, gets no pull
// request reminder.
// Never reads credentials or settings, never connects to anything, never writes
// files, and always exits 0 so a reminder can never break a session.

const fs = require('node:fs')

const LINK = /in-parallel:\/\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)+/g
const PULL_REQUEST = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/
// Only these commands are checked for a pull request link: what lists or logs pull requests is not new work.
const PR_COMMAND = /\bgh\s+pr\s+(create|view)\b/
const CREATE_PR = /\bgh\s+pr\s+create\b/
// In Parallel's server as tool names spell it: the plugin's own, or one configured
// on its own. Claude Code names the plugin's server plugin:in-parallel:in_parallel.
const PLUGIN_SERVER = { tool: 'plugin_in-parallel_in_parallel', name: 'plugin:in-parallel:in_parallel' }
const OWN_SERVERS = ['in_parallel', 'in-parallel']
const SERVER = `(${[PLUGIN_SERVER.tool, ...OWN_SERVERS].join('|')})`
// The In Parallel tools that take client_session; TAGGED is the Claude Code hook matcher too.
const TAGGED_TOOLS = ['report_back', 'close_action_items', 'update_action_item', 'get_action_item', 'get_decision', 'get_risk', 'get_open_question', 'get_observations']
const TAGGED = new RegExp(`^mcp__${SERVER}__(${TAGGED_TOOLS.join('|')})$`)
const REPORT_BACK = new RegExp(`^mcp__${SERVER}__report_back$`)
// The configuration scopes Claude Code reports as a server's source, besides plugin.
const CONFIGURED = ['local', 'user', 'project', 'enterprise', 'managed']
// A report_back call inside a Codex code mode script.
const SCRIPTED_REPORT_BACK = new RegExp(`\\btools\\.mcp__(${OWN_SERVERS.join('|')})__report_back\\s*\\(`)
const SCRIPTED_STARTED = /\bevent\s*:\s*["'`]started["'`]/
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

// The tool calls one transcript line records: Claude Code's tool_use blocks, and
// Codex's function calls and code mode scripts. Anything else on the line, such as
// a skill listing or a prompt quoting a tool name, is not a call.
function toolCalls(line) {
  let entry
  try { entry = JSON.parse(line) } catch { return [] }
  if (entry?.type === 'assistant' && Array.isArray(entry.message?.content)) {
    return entry.message.content.filter(block => block?.type === 'tool_use' && typeof block.name === 'string')
      .map(block => ({ name: block.name, input: block.input }))
  }
  const item = entry?.type === 'response_item' ? entry.payload : null
  if (item?.type === 'function_call' && typeof item.name === 'string') {
    // Codex records an MCP tool as its bare name in an mcp__<server>__ namespace.
    const name = item.namespace && !item.name.startsWith('mcp__')
      ? `${item.namespace.replace(/_+$/, '')}__${item.name.replace(/^_+/, '')}` : item.name
    let input = null
    try { input = JSON.parse(item.arguments) } catch {}
    return [{ name, input }]
  }
  if (item?.type === 'custom_tool_call' && typeof item.input === 'string') return [{ name: item.name, script: item.input }]
  return []
}

// In Parallel report_back calls, each with whether it reported "started".
function reports(line) {
  return toolCalls(line).flatMap(call => {
    if (typeof call.script === 'string') {
      return SCRIPTED_REPORT_BACK.test(call.script) ? [{ started: SCRIPTED_STARTED.test(call.script), text: call.script }] : []
    }
    if (!REPORT_BACK.test(call.name) || !call.input || typeof call.input !== 'object') return []
    return [{ started: call.input.event === 'started', text: JSON.stringify(call.input) }]
  })
}

// Whether this conversation reported an In Parallel item started, and has not yet
// passed this pull request to report_back.
function pullRequestNeedsReport(transcript, url) {
  let started = false
  for (const line of transcript.split('\n')) {
    for (const report of reports(line)) {
      if (url && report.text.includes(url)) return false
      started ||= report.started
    }
  }
  return started
}

function commandText(input) {
  const command = input?.command ?? input?.cmd
  if (Array.isArray(command)) return command.join(' ')
  return typeof command === 'string' ? command : ''
}

function context(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
}

// Whether Claude Code's mcp_server (2.1.274 and later) is the server the tool name
// names: the plugin's own from the plugin, or one configured on its own from a
// configuration scope. A claude.ai connector or an SDK server is neither.
function inParallelServer(segment, server) {
  if (server === undefined) return true
  if (!server || typeof server !== 'object') return false
  if (segment === PLUGIN_SERVER.tool) return server.source === 'plugin' && server.name === PLUGIN_SERVER.name
  return CONFIGURED.includes(server.source) && server.name === segment
}

function tagSession(input) {
  const [, segment] = (typeof input.tool_name === 'string' && input.tool_name.match(TAGGED)) || []
  if (!segment || !inParallelServer(segment, input.mcp_server)) return null
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
    if (!PR_COMMAND.test(command)) return null
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
