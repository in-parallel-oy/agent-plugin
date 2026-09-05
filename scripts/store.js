'use strict'

// Local claim memory shared by the three hook scripts.
//
// ~/.in-parallel/claims.json holds one entry per open In Parallel work claim
// this machine knows about. It carries a claim-scoped heartbeat token, so the
// file is written 0600 and the directory 0700, and nothing else is ever put
// in it.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DIR = path.join(os.homedir(), '.in-parallel')
const FILE = path.join(DIR, 'claims.json')

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    const claims = parsed && typeof parsed === 'object' ? parsed.claims : null
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : {}
  } catch {
    return {}
  }
}

function write(claims) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const tmp = `${FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, claims }, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, FILE)
  // rename keeps the temp file's mode, but an older claims.json may predate it.
  fs.chmodSync(FILE, 0o600)
}

module.exports = { DIR, FILE, read, write }
