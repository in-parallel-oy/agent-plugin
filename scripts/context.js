#!/usr/bin/env node
'use strict'

// SessionStart / UserPromptSubmit hook.
//
// Emits one line of facts the agent cannot cheaply look up itself — the repo,
// the branch, the pull request if there is one, and the In Parallel work
// claims this machine still has open — plus one sentence of reminder.
//
// It reads only local git state and the local claim store. It never prompts,
// never authenticates, never writes anything but its own session marker, and
// always exits 0: a coordination hook that can break a session is worse than
// no hook.

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const store = require('./store')

const GIT_TIMEOUT_MS = 3000
const GH_TIMEOUT_MS = 3000
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_DESCRIPTION = 80
const MAX_CLAIMS_LISTED = 5

function readPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}

function run(command, args, cwd, timeout) {
  const result = spawnSync(command, args, { cwd, timeout, encoding: 'utf8' })
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') return null
  const value = result.stdout.trim()
  return value === '' ? null : value
}

// git@host:org/repo.git, ssh://git@host/org/repo.git and https://user:pw@host/org/repo.git
// all normalize to https://host/org/repo — credentials are dropped, never printed.
function normalizeRemote(remote) {
  if (!remote) return null
  const value = remote.trim().replace(/\.git$/, '')
  const scp = value.match(/^[^@/]+@([^:/]+):(.+)$/)
  if (scp) return `https://${scp[1]}/${scp[2]}`
  try {
    const url = new URL(value)
    if (!/^(https?|ssh|git):$/.test(url.protocol)) return null
    return `https://${url.host}${url.pathname}`
  } catch {
    return null
  }
}

function repoInfo(cwd) {
  const remote = normalizeRemote(run('git', ['-C', cwd, 'remote', 'get-url', 'origin'], cwd, GIT_TIMEOUT_MS))
  // --show-current is correct on an unborn branch, where rev-parse fails.
  const branch =
    run('git', ['-C', cwd, 'branch', '--show-current'], cwd, GIT_TIMEOUT_MS) ||
    run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], cwd, GIT_TIMEOUT_MS)
  return { remote, branch }
}

function pullRequestUrl(cwd, branch) {
  if (!branch) return null
  const output = run('gh', ['pr', 'list', '--head', branch, '--json', 'url', '--limit', '1'], cwd, GH_TIMEOUT_MS)
  if (!output) return null
  try {
    const rows = JSON.parse(output)
    const url = Array.isArray(rows) && rows[0] && rows[0].url
    return typeof url === 'string' && url !== '' ? url : null
  } catch {
    return null
  }
}

// Claim text is untrusted workspace-visible text written by other people, and
// this line is injected into the agent's context: keep it to one flat line.
function oneLine(value, limit) {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function age(iso, now) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 90) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function claimSummary(claims, now) {
  const entries = Object.values(claims).filter((claim) => claim && claim.claim_id)
  if (entries.length === 0) return 'no open work claims'
  const listed = entries.slice(0, MAX_CLAIMS_LISTED).map((claim) => {
    const subject = oneLine(claim.description, MAX_DESCRIPTION) || oneLine(claim.uri, MAX_DESCRIPTION) || 'no description'
    const started = claim.started_at ? `started ${age(claim.started_at, now) || 'at an unknown time'}` : 'not started'
    const beat = claim.heartbeat && claim.last_beat_at ? `, heartbeat ${age(claim.last_beat_at, now) || 'unknown'}` : ''
    return `${claim.claim_id} "${subject}" ${started}${beat}`
  })
  const more = entries.length > listed.length ? ` (+${entries.length - listed.length} more)` : ''
  return `open work claims (${entries.length}): ${listed.join('; ')}${more}`
}

// SessionStart and UserPromptSubmit run the same script; the marker keeps the
// line to once per session, and re-emits it when the branch moves under the
// session, which is exactly when the facts stopped being true.
function shouldEmit(sessionId, branch) {
  const dir = path.join(store.DIR, 'sessions')
  const file = path.join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (marker && marker.branch === branch) return false
  } catch {
    // No marker, or an unreadable one: emit and rewrite it.
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, `${JSON.stringify({ branch, at: new Date().toISOString() })}\n`, { mode: 0o600 })
    pruneMarkers(dir)
  } catch {
    // A marker we cannot write only costs a repeated line.
  }
  return true
}

function pruneMarkers(dir) {
  const cutoff = Date.now() - MARKER_TTL_MS
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name)
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file)
    } catch {
      // Ignore: pruning is hygiene, not correctness.
    }
  }
}

function main() {
  const payload = readPayload()
  const cwd =
    (typeof payload.cwd === 'string' && payload.cwd) ||
    (Array.isArray(payload.workspace_roots) && typeof payload.workspace_roots[0] === 'string' && payload.workspace_roots[0]) ||
    process.cwd()
  const sessionId =
    (typeof payload.session_id === 'string' && payload.session_id) ||
    (typeof payload.conversation_id === 'string' && payload.conversation_id) ||
    'unknown-session'

  const { remote, branch } = repoInfo(cwd)
  if (!shouldEmit(sessionId, branch)) return

  const now = Date.now()
  const facts = ['[in-parallel]']
  if (remote) facts.push(`repo=${remote}`)
  if (branch) facts.push(`branch=${branch}`)
  const pr = pullRequestUrl(cwd, branch)
  if (pr) facts.push(`pr=${pr}`)

  const line = [
    facts.join(' '),
    claimSummary(store.read(), now),
    'Call announce_work start (In Parallel MCP) with a short description and a URI before substantive work on a new subject, and complete or release any claim listed above when you stop working on it.',
  ].join(' | ')

  // Cursor injects only the JSON `additional_context` field; Claude Code and
  // Codex inject plain stdout.
  const cursor = payload.hook_event_name === 'sessionStart' || typeof payload.conversation_id === 'string'
  process.stdout.write(cursor ? `${JSON.stringify({ additional_context: line })}\n` : `${line}\n`)
}

try {
  main()
} catch {
  // Never fail a session over context.
}
process.exit(0)
