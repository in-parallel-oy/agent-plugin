'use strict'

// The rules each skill must keep, as key phrases. Wording around them may change.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const RULES = {
  'skills/in-parallel/SKILL.md': [
    'such as "Update In Parallel" after a task, load the `in-parallel-agent-work` skill',
  ],
  'experimental/agent-work/skills/in-parallel-agent-work/SKILL.md': [
    '1. **Start.**', '2. **Note.**', '3. **Re-read before finishing.**', '4. **Finish.**',
    '5. **Put down.**', '6. **Pause.**', '7. **Wait.**', '8. **Release.**', '## Without a link', '## Do not',
    'Read it again before any later start',
    'That is the person in this conversation unless they say otherwise',
    'When the person says not to report, do not report; when you stop, tell them why',
    'never to Done or Cancelled unless they ask',
    'Waiting does not override a handover',
    'A handover is when the item\'s `since_you_last_checked` shows a new owner',
    'When the person asks to pause or to drop the item, use Pause or Put down instead',
    'When the work looks incomplete',
  ],
  'experimental/agent-work/skills/work-on/SKILL.md': [
    '**Start.** Read the picked To do with `get_action_item`, then call `report_back` with `event: "started"`',
    'Read it again before any later start',
    'report as the `in-parallel-agent-work` skill says, from its Report step 2 on',
  ],
}

// Wording a skill must not bring back.
const RETIRED = {
  'experimental/agent-work/skills/in-parallel-agent-work/SKILL.md': [
    'usually the person you are talking to',
  ],
}

const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8').replace(/\s+/g, ' ')

for (const [file, phrases] of Object.entries(RULES)) {
  test(`${file} keeps its rules`, () => {
    const text = read(file)
    for (const phrase of phrases) assert.ok(text.includes(phrase), phrase)
    for (const phrase of RETIRED[file] ?? []) assert.ok(!text.includes(phrase), `retired: ${phrase}`)
  })
}
