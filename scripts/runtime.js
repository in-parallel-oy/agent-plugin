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
  const configured = config.mcpServers.in_parallel.url
  const expanded = client === 'claude' ? expandEndpoint(configured, client) : configured
  return endpointURL(expanded)
}

// Match the clients' documented URL expansion. A set-but-empty Claude variable
// stays empty: only an unset variable uses its fallback. Never silently switch
// the hooks to production when the client's selected endpoint is invalid.
function expandEndpoint(value, client, env = process.env) {
  return value.replace(/\$\{([^}]+)\}/g, (_match, variable) => {
    if (client === 'claude') {
      const [key, fallback] = variable.split(/:-(.*)/s)
      if (env[key] !== undefined) return env[key]
      if (fallback !== undefined) return fallback
    } else if (client === 'cursor' && variable.startsWith('env:') && env[variable.slice(4)] !== undefined) {
      return env[variable.slice(4)]
    }
    throw new Error('Unresolved In Parallel endpoint variable')
  })
}

function endpointURL(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('Invalid In Parallel MCP endpoint configuration')
  }
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Invalid In Parallel MCP endpoint configuration')
  }
  return url
}

function matchesEndpoint(reply, info) {
  try { return endpointURL(reply.mcp_endpoint).href === info.endpoint } catch { return false }
}

function session(input) {
  const cursor = typeof input.conversation_id === 'string'
  const id = cursor ? input.conversation_id : input.session_id
  if (typeof id !== 'string' || !id) return null
  const cwd = input.cwd || input.workspace_roots?.[0]
  if (typeof cwd !== 'string' || !cwd) return null
  const configuredClient = process.argv.find(arg => /^--client=(claude|codex)$/.test(arg))?.split('=')[1]
  const client = cursor ? 'cursor' : configuredClient || input.client || process.env.IN_PARALLEL_CLIENT || 'claude'
  const owner = `${client}:${id}:${input.agent_id || 'main'}`
  const url = endpoint(client)
  let version = null
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `.${client}-plugin/plugin.json`), 'utf8')).version } catch {}
  return {
    client, version, owner, cwd: path.resolve(cwd), endpoint: url.href,
    requestPrefix: crypto.createHash('sha256').update(`${url.href}:${owner}`).digest('hex').slice(0, 24),
  }
}

function workReply(input, tool) {
  if (input.hook_event_name === 'afterMCPExecution') {
    if (input.tool_name !== tool || input.mcp_server_name !== 'in_parallel') return null
  } else if (![`mcp__in_parallel__${tool}`, `mcp__plugin_in-parallel_in_parallel__${tool}`].includes(input.tool_name)) return null
  let result = input.tool_response ?? input.result_json
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { return null }
  }
  if (result?.isError || result?.is_error) return null
  let reply = result?.structuredContent ?? result?.structured_content
  if (!reply && Array.isArray(result?.content)) {
    for (const part of result.content) {
      if (part.type !== 'text') continue
      try { const value = JSON.parse(part.text); if (value?.claim) { reply = value; break } } catch {}
    }
  }
  reply ||= result
  const claim = reply?.claim
  return claim && typeof claim.claim_id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claim.claim_id) &&
    Number.isSafeInteger(claim.version) && claim.version > 0 &&
    ['working', 'blocked', 'completed', 'cancelled'].includes(claim.state) ? reply : null
}

function announceReply(input) {
  const reply = workReply(input, 'announce_work')
  return typeof reply?.session_id === 'string' ? reply : null
}

function readReply(input) {
  const reply = workReply(input, 'get_work')
  return Array.isArray(reply?.events) ? reply : null
}

function linkReply(input) {
  return workReply(input, 'link_work_subject')
}

function activation(info) {
  return { endpoint: info.endpoint, client: info.client, version: info.version, session: info.requestPrefix }
}

function own(claim, info) {
  return info && claim?.owner === info.owner && claim.endpoint === info.endpoint
}

module.exports = { payload, endpoint, endpointURL, expandEndpoint, matchesEndpoint, session, announceReply, readReply, linkReply, activation, own }
