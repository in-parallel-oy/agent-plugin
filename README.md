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

The plugin has three parts: two skills, a connection to the In Parallel server,
and two small hook scripts. Claude Desktop chat and ChatGPT run no hooks, so
only the skills and the connection apply there.

### Hooks

In Claude Code and Codex, `scripts/context.js` runs when a session starts,
when you send a message, and when a subagent starts. `scripts/remember-claim.js`
runs after your assistant calls the In Parallel `announce_work`, `get_work` or
`link_work_subject` tools.

In Cursor, `scripts/context.js` runs when a session starts and after shell, file
write, file delete, task and MCP tool calls. `scripts/remember-claim.js` runs
after each MCP tool call and ignores every server except In Parallel.

Each hook has a 10-second limit and never blocks your session. Neither script
connects to In Parallel.

### What `context.js` reads and writes

- It reads the checkout's `origin` remote URL and current branch with `git`.
  Any user name or password in the remote URL is dropped.
- If the GitHub CLI `gh` is installed, it asks GitHub for a pull request on the
  current branch. `gh` uses your existing GitHub sign-in.
- It reads the local cache described below, and the MCP URL from the plugin's
  own `.mcp.json` or `mcp.json`.
- It adds one line of context to the conversation: the repository URL, branch,
  pull request URL, In Parallel server URL, a session ID, a workspace hint, and
  the titles and status of this session's open work entries.
- It writes a small marker in `~/.in-parallel/sessions/` so the line is only
  repeated when something changes, and notes the time in the local cache.
  Markers older than seven days are deleted.

### What `remember-claim.js` writes

It reads the In Parallel tool's reply and saves a handle for your own work
entries in `~/.in-parallel/contributions.json`: the entry ID, version, status,
title, latest update note, workspace ID, linked outcome ID, start time and the
folder you were working in. Finished or cancelled entries keep only their ID,
version, status and server. It also records when context, reads and reports
last happened, so `doctor` can check the setup.

The folder is readable only by you. The scripts send none of it anywhere; the
titles and workspace hint appear in the context line above.

### What is sent to In Parallel

Only what your assistant sends through the In Parallel connection
(`https://www.in-parallel.ai/mcp` unless you chose another environment during
setup). The skills ask your assistant to:

- read team context, such as briefings, meetings, decisions and wiki pages
- record findings you want to share with your team
- report the tasks it works on without being asked each time: a short title, a
  one to three sentence description, progress notes, and links such as the
  repository or pull request URL

### Sign-in

You sign in through your assistant app's connection sign-in, which opens In
Parallel in your browser. The app keeps the sign-in. The plugin's scripts never
see, read or store a password or token.

### The setup command

`npx -y github:in-parallel-oy/agent-plugin` downloads this repository and its
two setup dependencies. It copies the plugin to `~/.in-parallel/setup/` for
Claude Code and Codex, or `~/.cursor/plugins/local/in-parallel` for Cursor, and
registers it with the `claude` or `codex` command. It writes your chosen server
URL into that copy.

Before it installs, it reads your existing MCP settings to find a conflicting
In Parallel entry: `~/.claude.json` (or the one in `CLAUDE_CONFIG_DIR`),
`.mcp.json` in the current project, and `~/.cursor/mcp.json` and
`.cursor/mcp.json`. It never changes those files.

### Uninstall

If you used the setup command, run:

```sh
npx -y github:in-parallel-oy/agent-plugin uninstall
```

If you installed from a plugin browser, remove **In Parallel** there. Then
delete `~/.in-parallel` to remove the local cache.

## Need help?

Ask your assistant: **“Check my In Parallel connection.”**

If you can't install the plugin or access your workspace, ask your workspace
administrator for help.

## License

[Apache-2.0](LICENSE).
