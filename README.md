# In Parallel

Bring your team's context into conversations with your AI assistant. Catch up on
priorities, find relevant decisions, and share useful findings with your team.

## Get started

You'll need an In Parallel account with access to your team's workspace.

### Claude Code, Codex, or Cursor

Run the setup command. It asks which assistants to set up, then installs for
your user:

```sh
npx -y github:in-parallel-oy/agent-plugin
```

Needs Node 20.12+. Claude Code and Codex also need their own CLI on your `PATH`.
Cursor users should reload Cursor afterwards.

Later on, the same command takes `doctor` to check the installation and
`uninstall` to remove it. Add `--help` for everything else.

### Claude Desktop or ChatGPT

Open the app's plugin browser and install **In Parallel** from your team's
plugin library. If it isn't listed, add `https://github.com/in-parallel-oy/agent-plugin`
as a plugin source, or ask your administrator to make it available.

### Then

Sign in to In Parallel, choose the workspaces you want to connect, and start a
new conversation with your assistant.

## Try it

- “What needs my attention this week?”
- “Catch me up on [project].”
- “Record this finding for my team: …”

## What the plugin does on your machine

The plugin has two parts: the `in-parallel` skill and a connection to the In
Parallel server. It runs no hooks or scripts on your machine and keeps no local
files. The files under `experimental/`, including their hooks, are not part of
it; see [Experimental features](#experimental-features).

### What is sent to In Parallel

Only what your assistant sends through the In Parallel connection
(`https://www.in-parallel.ai/mcp` unless you chose another environment during
setup). The skill asks your assistant to:

- read team context, such as briefings, meetings, decisions and wiki pages
- record findings you want to share with your team

### Sign-in

You sign in through your assistant app's connection sign-in, which opens In
Parallel in your browser. The app keeps the sign-in. The plugin's scripts never
see, read or store a password or token.

### The setup command

`npx -y github:in-parallel-oy/agent-plugin` downloads this repository and its
two setup dependencies. It copies the plugin to `~/.in-parallel/setup/` for
Claude Code and Codex, or `~/.cursor/plugins/local/in-parallel` for Cursor, and
registers it with the `claude` or `codex` command. It writes your chosen server
URL into that copy. For the Development environment or a server on localhost, it also adds the
[experimental features](#experimental-features).

Before it installs, it reads your existing MCP settings to find a conflicting
In Parallel entry: `~/.claude.json` (or the one in `CLAUDE_CONFIG_DIR`),
`.mcp.json` in the current project, and `~/.cursor/mcp.json` and
`.cursor/mcp.json`. It never changes those files.

Setup and uninstall act on your user installation only. A copy installed for a
single project is left in place; setup names it and the command that removes it.

`doctor` lists every location it checked (your user settings, the project root
and the current directory, and each client's plugin registrations) as found,
not found or conflicting, before it reports any error. For Claude Code it lists
each In Parallel copy with its scope, the project it belongs to and its files,
such as the setup copy for your user and one installed in another project. A
conflicting entry says what it conflicts with and why, and changed installed
files are named. It checks what is installed, not that it works: to check that,
ask your agent "Check my In Parallel connection". When the previous `doctor`
run failed, it shows that error and when.

`doctor` changes no installation or setting, but it is not read-only: it
records the result in `~/.in-parallel/setup/last-check.json` and deletes the
retired work journal cache described below.

### Uninstall

If you used the setup command, run:

```sh
npx -y github:in-parallel-oy/agent-plugin uninstall
```

It removes only the files and registrations setup itself wrote, prints one
line for each, and first backs the files up to `~/.in-parallel/setup/backups/`.
It stops without removing a file that changed since setup wrote it.

If you installed from a plugin browser, remove **In Parallel** there.

Earlier versions had an experimental work journal that kept a local cache in
`~/.in-parallel`. Setup, `doctor` and `uninstall` delete that cache, and `doctor`
asks you to run setup again if the work journal is still installed.

## Experimental features

Features the In Parallel server has not yet enabled for every team live in
`experimental/`. Plugin browsers never install them. The setup command adds them
only when you choose the Development environment
(`https://www.in-parallel.dev/mcp`) or a server on localhost, never for Production or another
server.

### Reporting work back (`experimental/agent-work`)

Adds the `in-parallel-agent-work` skill. When you send an In Parallel item to
your assistant with Send to AI, the prompt carries the item's In Parallel link.
The skill asks your assistant to report its work back on that item with the In
Parallel `report_back` tool: when it starts, short notes as it goes, and when it
finishes, with its results: links to what the work produced, each with a short
label, such as the pull request. Starting moves a To do to Doing and finishing
moves it to Done. When its part is done but the To do is not, such as when
others still work on it, it finishes with `close: false`: that ends its part
and leaves the To do open. Before finishing, your assistant
reads the item again to see what people changed while it worked. When In
Parallel says people outside your company can read the item, your assistant
writes its notes for them and leaves out internal details.

When you ask your assistant to report work without naming an item, it works
out the item itself: it sends `report_back` one short sentence naming the work,
and In Parallel replies "Lookup only, nothing recorded yet" with your open To dos, the ones that fit
marked a strong match. Your assistant reports on the best match, a To do whose
whole title the note covers, and tells you which; if only strong or possible
matches fit, it asks In Parallel to ask you (`ask: true`); if none fits, it
offers to create a To do. Work with no link, such as a local file, is described in the note. When
you say you did the work yourself, it reports only that the item is finished.

Your assistant reports only when it actually works on the item. Reading an
item or answering your questions about it is not work on it, so nothing is
reported, and it never finishes a To do it did not work on unless you ask it to
report that. If you ask it to check with you before reporting, it does. If you
ask it to pause, it reports a note saying so and leaves the item in Doing; if
it is reminded to finish when it stops, it tells you the work is paused.

The general `in-parallel` skill never creates or edits pages or items you did
not ask for, and confirms each write with you except a `report_back` report.

Your assistant never becomes the item's owner or assignee and never notifies
anyone. Work that isn't about an item is not recorded.

To start without Send to AI, run the `work-on` command (`/in-parallel:work-on`
in Claude Code; the `work-on` skill in Codex and Cursor). Your assistant lists your open To dos,
you pick one, and it reports starting on it.

To put a To do down, ask your assistant to drop it. It reports a note saying
why and moves the To do back to To do, never to Done or Cancelled unless you ask.
When others still work on the To do, it finishes its own part with
`close: false` instead, which leaves the To do open for them.

In Claude Code and Codex, the feature adds hooks that nudge your assistant to
report. `scripts/reminders.js` reminds it:

- when your message carries an In Parallel link, to report that it started if it
  works on the item, and not when it only reads it or answers questions about it;
- after it opens or prints a pull request while working on an item, to pass
  the pull request in `results`, labelled, as a link to what the work produced.

That script reads only what your assistant passes it and, after a pull request,
the session's local transcript, because the command and its output stay on your
machine. It never reads your sign-in, connects to In Parallel or anything else,
or writes files.

Before your assistant stops, its `Stop` hook asks In Parallel's
`report_back_reminder` tool, through your assistant's own In Parallel
connection, whether it has an item it reported started and not yet finished.
The plugin's hooks scope reminders to the conversation. In Claude Code, the
`Stop` hook sends whether this stop already follows a reminder and the
conversation's session id, and a `PreToolUse` hook (`scripts/session.js`) adds
the same id as `client_session` to each `report_back` call, so only the
conversation that reported an item started is reminded about it. Neither reads
a transcript, sign-in or setting. Codex names its conversation thread itself,
as it does on every tool call, and In Parallel scopes reminders to that thread
when Codex uses the newest protocol revision; otherwise any of your Codex
sessions may be reminded once about another session's started item. In
Parallel answers from the reports it recorded:

- It reminds once per start: at the first stop after your assistant reports
  starting an item, which may come before the work is done. Your assistant can
  still stop by saying why the work isn't finished.
- Notes never bring the reminder back. Only reporting the item started again
  does, until it is finished.
- It never reminds at the stop right after a reminder.
- An item you sent but your assistant never reported started is not reminded
  about at stop. The prompt reminder still asks it to report that it started.
- A subagent's end is never held up; only the main assistant's stop is hooked.

When your company does not have the feature yet, In Parallel answers with no
reminder and your assistant stops as usual. If the hook gets no answer, because
you are signed out or In Parallel does not reply within 30 seconds, your
assistant also stops as usual. Your client may show its own hook-error notice at
each stop when you are signed out: Codex marks the In Parallel hook as failed.

Codex asks you to trust the hooks in `/hooks` first, and again after they
change. Cursor gets the command but no reminders.

To try the feature against a local In Parallel server,
`node scripts/e2e-bundle.js --agent claude|codex --url <loopback MCP URL> --out <dir> [--token-env NAME]`
writes a plugin directory for `claude --plugin-dir`, or a local marketplace for
Codex. With `--token-env`, the client reads a personal access token from that
environment variable; the token itself is never written.

## Need help?

Ask your assistant: **“Check my In Parallel connection.”**

If you can't install the plugin or access your workspace, ask your workspace
administrator for help.

## License

[Apache-2.0](LICENSE).
