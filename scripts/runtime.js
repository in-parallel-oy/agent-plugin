'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function payload() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')) || {} } catch { return {} }
}

function endpoint(client = process.env.IN_PARALLEL_CLIENT || 'claude') {
  const file = client === 'claude' ? '.mcp.json' : 'mcp.json'
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  const configured = config.mcpServers['in-parallel'].url
  const expanded = client === 'claude' ? configured.replace(
    /\$\{(\w+)(?::-([^}]*))?\}/g,
    (_match, name, fallback) => process.env[name] ?? fallback ?? '',
  ) : configured
  const url = new URL(expanded)
  if (url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Invalid In Parallel MCP endpoint configuration')
  }
  return url
}

function session(input) {
  const cursor = typeof input.conversation_id === 'string'
  const id = cursor ? input.conversation_id : input.session_id
  if (typeof id !== 'string' || !id) return null
  const cwd = input.cwd || input.workspace_roots?.[0]
  if (typeof cwd !== 'string' || !cwd) return null
  const client = cursor ? 'cursor' : input.client || process.env.IN_PARALLEL_CLIENT || 'claude'
  const owner = `${client}:${id}:${input.agent_id || 'main'}`
  const url = endpoint(client)
  return {
    owner, cwd: path.resolve(cwd), endpoint: url.href,
    requestPrefix: crypto.createHash('sha256').update(`${url.href}:${owner}`).digest('hex').slice(0, 24),
  }
}

function announceReply(input) {
  if (input.hook_event_name === 'afterMCPExecution') {
    if (input.tool_name !== 'announce_work' || input.mcp_server_name !== 'in-parallel') return null
  } else if (!/^mcp__in[-_]parallel__announce_work$/.test(input.tool_name || '')) return null
  let result = input.tool_response ?? input.result_json
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { return null }
  }
  let reply = result?.structuredContent ?? result?.structured_content
  if (!reply && Array.isArray(result?.content)) {
    for (const part of result.content) {
      if (part.type !== 'text') continue
      try {
        const value = JSON.parse(part.text)
        if (value?.claim && value?.outcome) { reply = value; break }
      } catch {}
    }
  }
  reply ||= result
  return reply?.claim && typeof reply.claim.claim_id === 'string' &&
    ['created', 'started', 'blocked', 'completed', 'released', 'cancelled'].includes(reply.outcome) ? reply : null
}

function heartbeat(raw, claimId, configuredEndpoint) {
  if (!raw || typeof raw.token !== 'string' || !raw.token || typeof raw.url !== 'string') return null
  try {
    const configured = new URL(configuredEndpoint)
    const url = new URL(raw.url)
    if (url.origin !== configured.origin || url.username || url.password || url.search || url.hash) return null
    if (url.pathname !== `/api/v1/work-claims/${encodeURIComponent(claimId)}/heartbeat`) return null
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null
    return { url: url.href, token: raw.token, interval_seconds: Math.max(60, Math.min(Number(raw.interval_seconds) || 300, 3600)) }
  } catch { return null }
}

function own(claim, info) {
  return info && claim?.owner === info.owner && claim.endpoint === info.endpoint
}

module.exports = { payload, endpoint, session, announceReply, heartbeat, own }
