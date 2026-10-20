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
  'experimental/agent-work/skills/in-parallel-agent-work/SKILL.md': {
    headings: ['## Report', '## Without a link', '## Offer once', '## Do not'],
    steps: ['1. **Start.**', '2. **Note.**', '3. **Re-read before finishing.**', '4. **Finish.**', '5. **Pause.**', '6. **Wait.**', '7. **Release.**'],
    names: ['`report_back`', '`get_action_item`', '`get_decision`', '`get_risk`', '`get_open_question`', '`close_action_items`',
      '`update_action_item`', '`list_action_items`', '`create_action_item`', '`started`', '`note`', '`finished`', '`released`'],
    // The stop reminder's cases apply first-fit, so a case must come before the cases it overrides.
    order: [
      // "Stop and wait for my go-ahead" both stops and waits: the waiting note must win.
      ['- **Waiting on the person', '- **Told to stop for now'],
      // A done report-only request needs nothing awaited, so "report started and wait" still falls to the waiting note.
      ['- **Asked only to report', '- **Waiting on the person'],
      ['- **Asked only to report', '- **Work done'],
      ['- **Asked only to report', '- **Told to stop for now'],
    ],
  },
  'experimental/agent-work/skills/work-on/SKILL.md': {
    headings: ['# Work on one of your To dos'],
    names: ['`in-parallel-agent-work`', '`list_action_items`', '`get_action_item`', '`report_back`'],
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
