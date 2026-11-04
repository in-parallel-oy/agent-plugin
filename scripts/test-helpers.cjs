'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// The skills a bundle ships.
const SKILLS = ['in-parallel']

// A fresh temporary folder, removed when the test ends.
function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

module.exports = { SKILLS, tmp }
