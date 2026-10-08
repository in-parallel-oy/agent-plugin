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
URL into that copy. For the Development environment, it also adds the
[experimental features](#experimental-features).

Before it installs, it reads your existing MCP settings to find a conflicting
In Parallel entry: `~/.claude.json` (or the one in `CLAUDE_CONFIG_DIR`),
`.mcp.json` in the current project, and `~/.cursor/mcp.json` and
`.cursor/mcp.json`. It never changes those files.

### Uninstall

If you used the setup command, run:

```sh
npx -y github:in-parallel-oy/agent-plugin uninstall
```

If you installed from a plugin browser, remove **In Parallel** there.

Earlier versions had an experimental work journal that kept a local cache in
`~/.in-parallel`. Setup, `doctor` and `uninstall` delete that cache, and `doctor`
asks you to run setup again if the work journal is still installed.

## Experimental features

Features the In Parallel server has not yet enabled for every team live in
`experimental/`. Plugin browsers never install them. The setup command adds them
only when you choose the Development environment
(`https://www.in-parallel.dev/mcp`), never for Production, localhost or another
server.

### Reporting work back (`experimental/agent-work`)

Adds the `in-parallel-agent-work` skill. When you send an In Parallel item to
your assistant with Send to AI, the prompt carries the item's In Parallel link.
The skill asks your assistant to report its work back on that item with the In
Parallel `report_back` tool: when it starts, short notes as it goes, and when it
finishes, with a link to what it made, such as a pull request. Starting moves a
To do to Doing and finishing moves it to Done. Before finishing, your assistant
reads the item again to see what people changed while it worked. When In
Parallel says people outside your company can read the item, your assistant
writes its notes for them and leaves out internal details.

Your assistant never becomes the item's owner or assignee and never notifies
anyone. Work that isn't about an item is not recorded.

To start without Send to AI, run the `work-on` command (`/in-parallel:work-on`
in Claude Code; the `work-on` skill in Codex and Cursor). Your assistant lists your open To dos,
you pick one, and it reports starting on it.

In Claude Code and Codex, the feature adds `scripts/reminders.js` as a hook
that nudges your assistant to report:

- when your message carries an In Parallel link, to report that it started;
- after it opens or prints a pull request while working on an item, to pass
  the pull request as the link to what it made;
- before it stops, once, if it was sent an item and has not reported it
  finished. It can still stop by saying why the work isn't finished.

The hook reads only what your assistant passes it and the session's local
transcript. It never reads your sign-in, connects to In Parallel or anything
else, or writes files. Codex asks you to trust the hook in `/hooks` first. Cursor
gets the command but no reminders.

## Need help?

Ask your assistant: **“Check my In Parallel connection.”**

If you can't install the plugin or access your workspace, ask your workspace
administrator for help.

## License

[Apache-2.0](LICENSE).
