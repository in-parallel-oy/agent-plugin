'use strict'

// The rules each skill must keep, as key phrases. Wording around them may change.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const RULES = {
  'skills/in-parallel/SKILL.md': [
    'such as "Update In Parallel" after a task, load the `in-parallel-agent-work` skill',
    'Load it too when work in the conversation, yours or theirs, may finish one of their To dos',
    'including work they only mention as done, such as "the notes are in <path>"',
    'For a specific question, call `search` directly',
  ],
  'experimental/agent-work/skills/in-parallel-agent-work/SKILL.md': [
    '1. **Start.**', '2. **Note.**', '3. **Re-read before finishing.**', '4. **Finish.**',
    '5. **Pause.**', '6. **Wait.**', '7. **Release.**', '## Without a link', '## Do not',
    'Read it again before any later start',
    'That is the person in this conversation unless they say otherwise',
    'When the person says not to report, do not report; when you stop, tell them why',
    'Never move it to Done or Cancelled unless they ask',
    'Waiting does not override a handover',
    'A handover is when the item\'s `since_you_last_checked` shows a new owner',
    'When the person asks you to pause, use Pause instead',
    'When the work looks incomplete',
    'One rule for start, plan and stop: start only when you are going to do the work',
    'give the plan and do not start. If you had already started, report `released`',
    'When the person asks you to put the item down or hand it on, report `released` too',
    '`released` is for putting the work down, not for ending your turn',
    'they mean end this turn, so your start stays open',
    'Not when the person only ends your turn, such as "then stop": your start stays open',
    'Work not done is never a `finished`, with `close: false` or without',
    "the item's own work remains with nobody doing it",
    'report a `note` saying what remains, with `waiting: true` when it waits on the person, and leave your start open',
    'When the person asks you only to add a note, report just that `note`, in their words: no `started` and no `finished`',
    'When the work is shared and your share of it is genuinely done while others still do the rest, finish with `close: false`',
    'It puts back the status your start changed',
    'finish with a `note` naming its path and leave `results` empty',
    'offer once to record it in In Parallel',
    '## Offer once',
    'plausibly finishes one of their To dos, even when nobody asks to report it',
    'A file written, a draft done or a fix made is work, whether you did it or the person tells you they did',
    'When you were sent the item, report without asking instead',
    'If the lookup finds no To do for the work, offer once to create a To do for it, as **Without a link** says: create it, and report on it, only once they agree',
    'that lookup records nothing, and a lookup\'s "report on it" waits for their yes',
    'When the person skips In Parallel\'s question, none of the choices is the work',
    'including when the person only mentions it as done or hands over a result, such as "the notes are in <path>", "I fixed it" or "draft\'s done"',
    'This holds when they only mention it as done or hand you the result',
    'that is work they did, not reading',
    'they do not cancel the offer',
    '`close: false` when a part of the work is genuinely finished',
    'A part of the work still to come, such as a quote or a reply the work waits for, is a note, never a `finished`',
    'The item stays started: if you stop there, answer the stop reminder by saying what remains, with `waiting: true` when it waits on the person',
    'report a `note` saying what remains and do not finish yet',
    'When they did only part of it and the rest is still to come',
    'part done with the rest still to come takes a `note`',
    'To close an item on your own reported work, also once you finished an earlier share with `close: false` and the rest is now done, report `finished` with `report_back`, not `close_action_items` or `update_action_item`',
    'report the work with `report_back`, closing included',
    'When a stop reminder names an item you worked on, answer it once, by the first case that fits',
    '**Told to stop for now or to do nothing more, with nothing awaited from the person**, such as "then stop" or "don\'t do anything else": send no report, not even a note, and do not release; tell the person what remains, and stop',
    '**Waiting on the person**, such as for a go-ahead, an approval or an answer, also when they told you to stop and wait: report a `note` with `waiting: true`, unless you already sent one',
    'tell them what remains, and send no other report. When they also say to wait for them, such as "stop and wait for my go-ahead", report the waiting note **Wait** describes before you stop',
  ],
  'experimental/agent-work/skills/work-on/SKILL.md': [
    '**Start.** Read the picked To do with `get_action_item`, then call `report_back` with `event: "started"`',
    'Read it again before any later start',
    'report as the `in-parallel-agent-work` skill says, from its Report step 2 on',
  ],
}

// The stop reminder's cases apply first-fit, so a case must come before the cases it overrides.
const ORDER = {
  'experimental/agent-work/skills/in-parallel-agent-work/SKILL.md': [
    // "Stop and wait for my go-ahead" both stops and waits: the waiting note must win.
    ['- **Waiting on the person', '- **Told to stop for now'],
  ],
}

// Wording a skill must not bring back.
const RETIRED = {
  // The search tool's name since the server renamed it; the old one is an unlisted alias.
  'skills/in-parallel/SKILL.md': [
    'search_knowledge',
  ],
  'experimental/agent-work/skills/in-parallel-agent-work/SKILL.md': [
    'usually the person you are talking to',
    '**Put down.**',
    '`possible`',
    'might still be it',
    'pull request: `[{"label": "Pull request"',
    'When others still work on the item, finish only your part',
    'drop the item',
    'finish only your part with `close: false` and say in a note what remains',
    '`close: false` when only your part is done',
    'When the person tells you to stop here',
    'when the person tells you to stop here',
    'When your part is done but the To do is not',
    'Only change the status with `update_action_item` or similar',
    'the stop reminder handles the rest',
    'send nothing more',
  ],
  'experimental/agent-work/skills/work-on/SKILL.md': [
    'put down',
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

for (const [file, pairs] of Object.entries(ORDER)) {
  test(`${file} keeps its first-fit order`, () => {
    const text = read(file)
    for (const [first, then] of pairs) {
      const [a, b] = [text.indexOf(first), text.indexOf(then)]
      assert.ok(a >= 0 && b >= 0, `${first} / ${then}`)
      assert.ok(a < b, `${first} comes before ${then}`)
    }
  })
}
