# Reporting work back (experimental)

This feature is not yet enabled for every team. Plugin browsers never install
it. The setup command adds it only when you choose the Development environment
(`https://www.in-parallel.dev/mcp`) or a server on localhost, never for
Production or another server.

Lets your assistant report its work on an In Parallel item back to that item,
with the In Parallel `report_back` tool: when it starts, notes as it goes, and
when it finishes, with links to what the work produced. It adds:

- the `in-parallel-agent-work` skill, which holds the reporting rules: see
  [its SKILL.md](skills/in-parallel-agent-work/SKILL.md);
- the `work-on` command (`/in-parallel:work-on` in Claude Code; the `work-on`
  skill in Codex and Cursor), which lists your open To dos, lets you pick one
  and starts on it;
- in Claude Code and Codex, reminder hooks.

To try it, send an In Parallel To do to your assistant with Send to AI, or pick
one with the `work-on` command.

The hooks run `scripts/reminders.js`, which points your assistant to the skill
when your message carries an In Parallel link, and after `gh pr create` or
`gh pr view` in a conversation that reported an In Parallel item started,
reminds it to pass the pull request in `results`. In Claude Code it also adds the conversation's
session id as `client_session` to In Parallel's `report_back`, item close and
item read calls, so reminders, closes and reads are scoped to this
conversation; Codex names its conversation thread itself. In Parallel
connected through claude.ai is not tagged, so disable that connector in Claude
Code's `/mcp` to keep reminders per conversation. The script reads only
what your assistant passes it and, after a pull request, the newest part of the
session's local transcript. It never reads your sign-in, connects to In
Parallel or anything else, or writes files.

Before your assistant stops, its `Stop` hook asks In Parallel's
`report_back_reminder` tool, through your assistant's own In Parallel
connection, whether it has an item it reported started and not yet finished.
When your company does not have the feature yet, or the hook gets no answer
within 10 seconds, your assistant stops as usual. When you are signed out, your
client may show its own hook-error notice at each stop.

Codex asks you to trust the hooks in `/hooks` first, and again after they
change. Cursor gets the skill and the command but no reminders.

To try the feature against a local In Parallel server,
`node scripts/e2e-bundle.js --agent claude|codex --url <loopback MCP URL> --out <dir> [--token-env NAME]`
writes a plugin directory for `claude --plugin-dir`, or a local marketplace for
Codex. With `--token-env`, the client reads a personal access token from that
environment variable; the token itself is never written.

Setup also deletes the local cache an earlier experimental work journal kept
in `~/.in-parallel`, and `doctor` asks you to run setup again if that journal
is still installed.
