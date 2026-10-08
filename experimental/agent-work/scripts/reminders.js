#!/usr/bin/env node
'use strict'

// Reporting reminders for the agent-work feature.
//
// Reads only the hook input on stdin and the local session transcript it names.
// Never reads credentials or settings, never connects to anything, never writes
// files, and always exits 0 so a reminder can never break a session.

const fs = require('node:fs')

const LINK = /in-parallel:\/\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)+/g
const PULL_REQUEST = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/
const CREATE_PR = /\bgh\s+pr\s+create\b/
// Codex code mode calls tools from JavaScript: tools.mcp__in_parallel__report_back({ event: "finished", ... }).
const CODE_CALL = /report_back\s*\(\s*\{[^}]*?\bevent\b["'\\\s:]{0,8}(started|finished)\b[^}]*\}/g
const OUTPUT_URL = /output_url["'\\\s:=]{0,8}(https?:\/\/[^\s"'\\,)}]+)/g
const MAX_TRANSCRIPT = 32 * 1024 * 1024
const STOP_REASON = 'In Parallel: you have not reported the In Parallel item you are working on as finished. ' +
  'Call report_back with event "finished" and output_url for what you made, or tell the person why the work is not finished.'

function readTranscript(file) {
  if (typeof file !== 'string' || !file) return null
  try {
    const size = fs.statSync(file).size
    if (size <= MAX_TRANSCRIPT) return fs.readFileSync(file, 'utf8')
    // Keep the newest part of a very long session.
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(MAX_TRANSCRIPT)
      fs.readSync(fd, buffer, 0, MAX_TRANSCRIPT, size - MAX_TRANSCRIPT)
      return buffer.toString('utf8')
    } finally { fs.closeSync(fd) }
  } catch {
    return null
  }
}

// Text a person typed: Claude Code user messages and Codex user input, never tool results.
function userTexts(entry) {
  const texts = []
  for (const node of [entry, entry?.message, entry?.payload]) {
    if (!node || typeof node !== 'object') continue
    if (node.role === 'user') {
      if (typeof node.content === 'string') texts.push(node.content)
      else if (Array.isArray(node.content)) {
        for (const block of node.content) {
          if (['text', 'input_text'].includes(block?.type) && typeof block.text === 'string') texts.push(block.text)
        }
      }
    }
    if (node.type === 'user_message' && typeof node.message === 'string') texts.push(node.message)
  }
  return texts
}

const parseArgs = value => {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

// report_back calls: structured tool calls (Claude Code, Codex MCP items) or
// code that calls the tool (Codex code mode). Other text naming it is not a call.
function reportCalls(node, found = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return found
  if (Array.isArray(node)) {
    for (const item of node) reportCalls(item, found, depth + 1)
    return found
  }
  const name = typeof node.name === 'string' ? node.name : typeof node.tool === 'string' ? node.tool : ''
  if (/(^|[_.:/])report_back$/.test(name)) {
    const args = parseArgs(node.input) || parseArgs(node.arguments) || {}
    found.push({ event: args.event, text: JSON.stringify(args) })
  } else if (node.type === 'custom_tool_call' && typeof node.input === 'string') {
    for (const match of node.input.matchAll(CODE_CALL)) found.push({ event: match[1], text: match[0] })
  }
  for (const value of Object.values(node)) if (value && typeof value === 'object') reportCalls(value, found, depth + 1)
  return found
}

// What the transcript says about the In Parallel item this session works on: one
// sent as a link in a prompt, or one the agent reported started (as /work-on does).
function scan(transcript) {
  const state = { sent: false, finished: false, reminded: false, reported: new Set() }
  if (!transcript) return state
  for (const line of transcript.split('\n')) {
    const link = line.includes('in-parallel://')
    const report = line.includes('report_back')
    const reminder = line.includes(STOP_REASON.slice(0, 60))
    if (!link && !report && !reminder) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (link && userTexts(entry).some(text => text.match(LINK))) {
      // A newly sent item needs its own report.
      Object.assign(state, { sent: true, finished: false, reminded: false })
    }
    if (reminder && state.sent) state.reminded = true
    if (report) {
      for (const call of reportCalls(entry)) {
        // A start after a finish is new work on an item.
        if (call.event === 'started' && (!state.sent || state.finished)) Object.assign(state, { sent: true, finished: false, reminded: false })
        if (call.event === 'finished' && state.sent) state.finished = true
        for (const match of call.text.matchAll(OUTPUT_URL)) state.reported.add(match[1])
      }
    }
  }
  return state
}

function commandText(input) {
  const command = input?.command ?? input?.cmd
  if (Array.isArray(command)) return command.join(' ')
  return typeof command === 'string' ? command : ''
}

function context(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
}

function respond(input) {
  if (!input || typeof input !== 'object') return null
  const event = input.hook_event_name
  if (event === 'UserPromptSubmit') {
    const links = [...new Set(String(input.prompt || '').match(LINK) || [])].slice(0, 3)
    if (!links.length) return null
    return context(event, `This prompt carries the In Parallel link ${links.join(', ')}. ` +
      'Before you start, call report_back with that link and event "started". When you are done, report "finished" with output_url for what you made.')
  }
  if (event === 'PostToolUse') {
    const command = commandText(input.tool_input)
    if (!command) return null
    const url = (JSON.stringify(input.tool_response ?? '').match(PULL_REQUEST) || [])[0]
    if (!url && !CREATE_PR.test(command)) return null
    const state = scan(readTranscript(input.transcript_path))
    if (!state.sent || (url && state.reported.has(url))) return null
    return context(event, url
      ? `You have a pull request: ${url}. If it is for the In Parallel item you are working on, pass it as output_url when you call report_back.`
      : 'You ran gh pr create. If it made a pull request for the In Parallel item you are working on, pass its link as output_url when you call report_back.')
  }
  if (event === 'Stop') {
    // Block once: stop_hook_active means this stop already follows a block.
    if (input.stop_hook_active || input.agent_id || input.agent_type) return null
    const state = scan(readTranscript(input.transcript_path))
    if (!state.sent || state.finished || state.reminded) return null
    return { decision: 'block', reason: STOP_REASON }
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

module.exports = { respond, scan, STOP_REASON }
