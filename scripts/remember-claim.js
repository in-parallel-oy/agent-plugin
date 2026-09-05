#!/usr/bin/env node
'use strict'

// PostToolUse / afterMCPExecution hook for announce_work.
//
// Remembers the claim id the server just handed back, so the next session can
// be told about it and the Stop hook can beat its heartbeat. Nothing else in
// the reply is stored, and a terminal outcome removes the entry.
//
// Reply shapes differ per client and per MCP transport — structured content,
// a content array of text parts, a JSON string, or the bare object — so the
// reply is located by shape rather than by path.

const fs = require('node:fs')

const store = require('./store')

const OUTCOMES = new Set(['created', 'started', 'completed', 'released', 'cancelled'])
const TERMINAL = new Set(['completed', 'released', 'cancelled'])
const MAX_DEPTH = 8

function readPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}

function isReply(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false
  if (typeof node.outcome === 'string' && OUTCOMES.has(node.outcome)) return true
  return Boolean(node.claim && typeof node.claim === 'object' && node.claim.claim_id)
}

function findReply(node, depth = 0) {
  if (depth > MAX_DEPTH || node == null) return null
  if (typeof node === 'string') {
    const trimmed = node.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
    try {
      return findReply(JSON.parse(trimmed), depth + 1)
    } catch {
      return null
    }
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findReply(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (isReply(node)) return node
  for (const value of Object.values(node)) {
    const found = findReply(value, depth + 1)
    if (found) return found
  }
  return null
}

function heartbeatOf(reply, claim) {
  const raw = reply.heartbeat || claim.heartbeat
  if (!raw || typeof raw !== 'object') return null
  const { url, token } = raw
  if (typeof url !== 'string' || typeof token !== 'string' || url === '' || token === '') return null
  const interval = Number(raw.interval_seconds)
  return {
    url,
    token,
    interval_seconds: Number.isFinite(interval) && interval > 0 ? Math.round(interval) : 900,
  }
}

function text(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

function main() {
  const payload = readPayload()
  const toolName = payload.tool_name
  // Claude Code and Codex name it mcp__<server>__announce_work; Cursor passes
  // the bare tool name alongside mcp_server_name. An absent name means the
  // client did not tell us, which is not a reason to drop the reply.
  if (typeof toolName === 'string' && !toolName.includes('announce_work')) return

  const reply = findReply(payload.tool_response ?? payload.result_json ?? payload.result ?? payload.output ?? payload)
  if (!reply) return

  const claim = reply.claim && typeof reply.claim === 'object' ? reply.claim : reply
  const claimId = text(claim.claim_id) || text(claim.id)
  if (!claimId) return

  const claims = store.read()

  if (TERMINAL.has(reply.outcome)) {
    if (!(claimId in claims)) return
    delete claims[claimId]
    store.write(claims)
    return
  }

  const existing = claims[claimId] || {}
  const heartbeat = heartbeatOf(reply, claim) || existing.heartbeat || null
  const startedAt = text(claim.started_at) || existing.started_at || null

  claims[claimId] = {
    claim_id: claimId,
    description: text(claim.description) || existing.description || null,
    uri: text(claim.uri) || existing.uri || null,
    started_at: startedAt,
    heartbeat,
    // The server has just seen this claim, so the next beat is one interval away.
    last_beat_at: heartbeat ? new Date().toISOString() : existing.last_beat_at || null,
  }

  store.write(claims)
}

try {
  main()
} catch {
  // Claim memory is a convenience; a failure here must not fail the tool call.
}
process.exit(0)
