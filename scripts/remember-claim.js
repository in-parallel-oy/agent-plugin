#!/usr/bin/env node
'use strict'

const store = require('./store')
const runtime = require('./runtime')

function reconcile(claims, claim, info) {
  const key = `${info.endpoint}:${claim.claim_id}`
  const previous = claims[key]
  if (previous && (!runtime.own(previous, info) || previous.version >= claim.version)) return false
  const receipt = {
    claim_id: claim.claim_id, owner: info.owner, endpoint: info.endpoint,
    version: claim.version, status: claim.state,
  }
  // Terminal receipts prevent delayed replies from restoring closed work.
  claims[key] = ['completed', 'cancelled'].includes(claim.state) ? receipt : {
    ...receipt, workspace_id: claim.workspace_id, cwd: info.cwd,
    subject_id: typeof claim.subject_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claim.subject_id) ? claim.subject_id : null,
    title: claim.title || null, reason: claim.reason || null,
    started_at: claim.started_at || null,
  }
  return true
}

function main() {
  const input = runtime.payload()
  const info = runtime.session(input)
  if (!info) return
  const read = runtime.readReply(input) || runtime.linkReply(input)
  const write = runtime.announceReply(input)
  if (!read && (!write || write.session_id !== info.requestPrefix)) return
  const reply = read || write
  if (!runtime.matchesEndpoint(reply, info)) {
    console.error('In Parallel: work reply endpoint is missing or does not match the configured environment; local handles and activation were preserved. Stop reporting, check the connected MCP server and selected plugin URL, and update the server if mcp_endpoint is absent. A completed server write was not undone.')
    return
  }
  const claim = reply.claim
  store.update((claims, state) => {
    const activationKey = store.activationKey(info)
    const observed = read ? 'read_at' : 'report_at'
    state.activation[activationKey] = {
      ...state.activation[activationKey], ...runtime.activation(info), [observed]: new Date().toISOString(),
    }
    // A public read or link correction can refresh known ownership, but cannot establish it.
    if (read && !runtime.own(claims[`${info.endpoint}:${claim.claim_id}`], info)) return
    const changed = reconcile(claims, claim, info)
    if (write && changed) {
      const workspaceKey = store.preferenceKey(info)
      if (typeof claim.workspace_id === 'string' && (!state.preferences[workspaceKey] || input.tool_input?.action === 'start' || claim.version === 1)) {
        state.preferences[workspaceKey] = { workspace_id: claim.workspace_id }
      }
    }
  })
}

try { main() } catch (error) {
  console.error(error.code === 'IN_PARALLEL_STORE_BUSY' ? store.BUSY_MESSAGE : 'In Parallel: could not remember the work reply. Use get_work to check its state before reporting again.')
}
process.exitCode = 0
