#!/usr/bin/env node
'use strict'

// Stop hook.
//
// Beats the heartbeat of every remembered claim whose last beat is older than
// the interval the server asked for. One POST per due claim, 3 s, no retries:
// the next Stop is the retry. 204 keeps the claim, 401 and 409 mean the token
// or the claim is gone and the entry is dropped, and anything else is left
// alone so a transient failure cannot lose a live claim.
//
// It prints nothing and always exits 0.

const http = require('node:http')
const https = require('node:https')

const store = require('./store')

const TIMEOUT_MS = 3000
const DEFAULT_INTERVAL_SECONDS = 900

function due(claim, now) {
  const heartbeat = claim && claim.heartbeat
  if (!heartbeat || typeof heartbeat.url !== 'string' || typeof heartbeat.token !== 'string') return false
  if (!/^https?:\/\//.test(heartbeat.url)) return false
  const last = Date.parse(claim.last_beat_at)
  if (!Number.isFinite(last)) return true
  const interval = Number(heartbeat.interval_seconds)
  const seconds = Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_SECONDS
  return now - last >= seconds * 1000
}

// Resolves to the HTTP status, or null when the request never completed.
function beat(heartbeat) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(heartbeat.url)
    } catch {
      resolve(null)
      return
    }
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request(
      url,
      {
        method: 'POST',
        headers: {
          // The only credential this plugin ever sends, and only to the URL
          // the server returned with it.
          authorization: `Bearer ${heartbeat.token}`,
          'content-length': '0',
          accept: 'application/json',
          'user-agent': 'in-parallel-agent-plugin',
        },
        timeout: TIMEOUT_MS,
      },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      },
    )
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(null))
    request.end()
  })
}

async function main() {
  const claims = store.read()
  const now = Date.now()
  const pending = Object.keys(claims).filter((id) => due(claims[id], now))
  if (pending.length === 0) return

  const results = await Promise.all(pending.map((id) => beat(claims[id].heartbeat)))

  let changed = false
  pending.forEach((id, index) => {
    const status = results[index]
    if (status === 204 || status === 200) {
      claims[id].last_beat_at = new Date().toISOString()
      changed = true
    } else if (status === 401 || status === 409) {
      delete claims[id]
      changed = true
    }
  })

  if (changed) store.write(claims)
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
