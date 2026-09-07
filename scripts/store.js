'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const DIR = path.join(os.homedir(), '.in-parallel')
const FILE = path.join(DIR, 'claims.json')
const LOCK = path.join(DIR, 'claims.lock')

function read() {
  try {
    const value = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (!value.claims || typeof value.claims !== 'object' || Array.isArray(value.claims)) throw Error('Invalid claim store')
    return value.claims
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

function write(claims) {
  const tmp = `${FILE}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, claims }) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, FILE)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

function reapDeadOwner() {
  const owners = fs.readdirSync(LOCK)
  if (owners.length !== 1) return
  const owner = owners[0]
  const pid = Number(owner.split('-')[0])
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error.code !== 'ESRCH') return
    // Remove only the observed owner. Another contender removing it first
    // causes ENOENT, so this cannot then remove that contender's new lock.
    fs.unlinkSync(path.join(LOCK, owner))
    fs.rmdirSync(LOCK)
  }
}

// The callback is synchronous and only patches local state; network IO must
// happen outside this lock. Every writer rereads the latest committed store.
function update(change) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  fs.chmodSync(DIR, 0o700)
  const owner = `${process.pid}-${crypto.randomUUID()}`
  const prepared = path.join(DIR, `lock-${owner}`)
  fs.mkdirSync(prepared, { mode: 0o700 })
  fs.writeFileSync(path.join(prepared, owner), '', { mode: 0o600 })
  const deadline = Date.now() + 1500
  try {
  while (true) {
    try {
      // A populated lock cannot be replaced; an abandoned empty lock can.
      fs.renameSync(prepared, LOCK)
      break
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
      try { reapDeadOwner() } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error }
      if (Date.now() >= deadline) throw Error('Claim store is busy')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  try {
    const claims = read()
    const result = change(claims)
    write(claims)
    return result
  } finally {
    fs.unlinkSync(path.join(LOCK, owner))
    try { fs.rmdirSync(LOCK) } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error }
  }
  } finally { fs.rmSync(prepared, { recursive: true, force: true }) }
}

module.exports = { DIR, FILE, read, update }
