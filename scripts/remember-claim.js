#!/usr/bin/env node
'use strict'

const store = require('./store')
const runtime = require('./runtime')
const { run: heartbeat } = require('./heartbeat')

async function main() {
  const input = runtime.payload()
  const info = runtime.session(input)
  const reply = runtime.announceReply(input)
  if (!info || !reply) return
  const claim = reply.claim
  // A create retry can return a row since started by another person/session.
  // Only an explicit start/pick_up reply transfers local heartbeat ownership.
  if (reply.outcome === 'created' && claim.state !== 'created') return
  const key = `${info.endpoint}:${claim.claim_id}`
  store.update(claims => {
    if (['completed', 'released', 'cancelled'].includes(reply.outcome)) {
      delete claims[key]
      return
    }
    const previous = claims[key]
    // A retry may recover the same session's claim. Starting a known claim in
    // another session is an explicit transfer through authenticated MCP.
    const capability = claim.state === 'working' ? runtime.heartbeat(reply.heartbeat, claim.claim_id) : null
    const keepSchedule = claim.state === 'working' && previous?.status === 'working' && runtime.own(previous, info)
    claims[key] = {
      claim_id: claim.claim_id,
      workspace_id: claim.workspace_id,
      user_id: claim.assignee?.user_id || claim.creator?.user_id,
      owner: info.owner, cwd: info.cwd, endpoint: info.endpoint,
      description: claim.description || null, uri: claim.uri || null,
      reason: claim.reason || null,
      version: claim.version ?? null,
      started_at: claim.started_at || null,
      status: ['working', 'created', 'blocked'].includes(claim.state) ? claim.state : 'needs_reconciliation',
      heartbeat: capability,
      last_beat_at: keepSchedule ? previous.last_beat_at : null,
      next_attempt_at: keepSchedule ? previous.next_attempt_at : null,
    }
  })
  await heartbeat(input)
}

main().catch(() => {}).finally(() => process.exit(0))
