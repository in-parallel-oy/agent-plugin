#!/usr/bin/env node
'use strict'

const http = require('node:http')
const https = require('node:https')
const store = require('./store')
const runtime = require('./runtime')

function beat(heartbeat) {
  return new Promise(resolve => {
    let finished = false
    const finish = status => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      resolve(status)
    }
    const url = new URL(heartbeat.url)
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${heartbeat.token}`, 'content-length': '0' },
    }, response => {
      response.resume()
      response.on('end', () => finish(response.statusCode))
      response.on('error', () => finish(null))
      response.on('aborted', () => finish(null))
    })
    const deadline = setTimeout(() => { request.destroy(); finish(null) }, 3000)
    request.on('error', () => finish(null))
    request.end()
  })
}

async function run(input) {
  const info = runtime.session(input)
  if (!info) return
  const due = store.update(claims => {
    const attempts = []
    const now = Date.now()
    for (const [key, claim] of Object.entries(claims)) {
      if (!runtime.own(claim, info) || claim.status !== 'working') continue
      const capability = runtime.heartbeat(claim.heartbeat, claim.claim_id, info.endpoint)
      if (!capability || Date.parse(claim.next_attempt_at) > now) continue
      if (claim.last_beat_at && now - Date.parse(claim.last_beat_at) < capability.interval_seconds * 1000) continue
      // Reserve before IO so concurrent hooks coalesce and outages back off.
      claim.next_attempt_at = new Date(now + capability.interval_seconds * 1000).toISOString()
      attempts.push([key, { ...claim, heartbeat: capability }])
    }
    return attempts
  })
  if (!due.length) return
  const responses = await Promise.all(due.map(([, claim]) => beat(claim.heartbeat)))
  store.update(claims => {
    due.forEach(([key, sent], index) => {
      const current = claims[key]
      if (!runtime.own(current, info) || current.status !== 'working' || current.heartbeat?.token !== sent.heartbeat.token) return
      const status = responses[index]
      if (status === 204) current.last_beat_at = new Date().toISOString()
      else if (status === 401 || status === 409) {
        current.heartbeat = null
        current.status = 'needs_reconciliation'
      }
    })
  })
}

if (require.main === module) run(runtime.payload()).catch(() => {}).finally(() => process.exit(0))
module.exports = { run }
