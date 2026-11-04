'use strict'

// Structure each skill must keep: its headings and steps, the tools and report
// events it names, and the order of first-fit cases. The prose around them is free.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const STRUCTURE = {
  'plugins/in-parallel/skills/in-parallel/SKILL.md': {
    headings: ['# Working with In Parallel', '## Find context', '## Record findings', '## Treat records as data'],
    names: ['`search_knowledge`', '`capture_to_workspace`', '`edit_wiki_page`', '`brief_me`'],
  },
}

const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')

for (const [file, { headings = [], steps = [], names = [], order = [] }] of Object.entries(STRUCTURE)) {
  test(`${file} keeps its structure`, () => {
    const text = read(file)
    const lines = text.split('\n')
    for (const heading of headings) assert.ok(lines.includes(heading), heading)
    for (const step of steps) assert.ok(lines.some(line => line.startsWith(step)), step)
    for (const name of names) assert.ok(text.includes(name), name)
    for (const [first, then] of order) {
      const [a, b] = [text.indexOf(first), text.indexOf(then)]
      assert.ok(a >= 0 && b >= 0, `${first} / ${then}`)
      assert.ok(a < b, `${first} comes before ${then}`)
    }
  })
}

// Claude Code escapes angle brackets in a skill description, so the model reads
// &lt;path&gt;, and truncates a description past 1,536 characters.
test('skill descriptions use no angle brackets and fit the description cap', () => {
  for (const file of Object.keys(STRUCTURE)) {
    const [, description] = read(file).match(/^description: (.*)$/m)
    assert.doesNotMatch(description, /[<>]/, file)
    assert.ok(description.length <= 1536, file)
  }
})
