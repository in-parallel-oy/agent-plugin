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

### Claude Projects

Threads in a Claude project reach In Parallel through your claude.ai connector;
the project conversation itself can't use In Parallel, only its threads can.

1. Connect In Parallel under claude.ai → **Customize → Connectors**.
2. Get the `claude-projects` ZIP from your administrator, or build it from a
   checkout of this repository with `node scripts/package.js --client claude-projects`.
   It holds the skill only, with no MCP server, hooks or scripts.
3. Add it in **Project settings → Plugins**.

If your workspace offers it, **Copy instructions for a Claude project** on the
workspace's What's set up page gives you project instructions to paste in.

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
files. The files under `experimental/` and the hook scripts in `scripts/` are
not part of it; see [Experimental features](#experimental-features).

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
URL into that copy. For the Development environment or a custom server, it also
adds the [experimental features](#experimental-features).

Before it installs, it reads your existing MCP settings to find a conflicting
In Parallel entry: `~/.claude.json` (or the one in `CLAUDE_CONFIG_DIR`),
`.mcp.json` in the current project, and `~/.cursor/mcp.json` and
`.cursor/mcp.json`. It never changes those files.

### Uninstall

If you used the setup command, run:

```sh
npx -y github:in-parallel-oy/agent-plugin uninstall
```

If you installed from a plugin browser, remove **In Parallel** there. If you
used the experimental work journal, also delete `~/.in-parallel` to remove its
local cache.

## Experimental features

Features the In Parallel server has not yet enabled for every team live in
`experimental/`. Plugin browsers never install them. The setup command adds them
only when you choose the Development environment or a custom server, never for
Production.

### Work journal (`experimental/work-claims`)

Adds the `in-parallel-work` skill and two hook scripts. The skill asks your
assistant to report the tasks it works on without being asked each time: a
short title, a one to three sentence description, progress notes, and links
such as the repository or pull request URL.

In Claude Code and Codex, `scripts/context.js` runs when a session starts,
when you send a message, and when a subagent starts. `scripts/remember-claim.js`
runs after your assistant calls the In Parallel `announce_work`, `get_work` or
`link_work_subject` tools.

In Cursor, `scripts/context.js` runs when a session starts and after shell, file
write, file delete, task and MCP tool calls. `scripts/remember-claim.js` runs
after each MCP tool call and ignores every server except In Parallel.

Each hook has a 10-second limit and never blocks your session. Neither script
connects to In Parallel.

`context.js`:

- reads the checkout's `origin` remote URL and current branch with `git`.
  Any user name or password in the remote URL is dropped.
- asks GitHub for a pull request on the current branch, if the GitHub CLI `gh`
  is installed. `gh` uses your existing GitHub sign-in.
- reads the local cache described below, and the MCP URL from the plugin's own
  `.mcp.json` or `mcp.json`.
- adds one line of context to the conversation: the repository URL, branch,
  pull request URL, In Parallel server URL, a session ID, a workspace hint, and
  the titles and status of this session's open work entries.
- writes a small marker in `~/.in-parallel/sessions/` so the line is only
  repeated when something changes, and notes the time in the local cache.
  Markers older than seven days are deleted.

`remember-claim.js` reads the In Parallel tool's reply and saves a handle for
your own work entries in `~/.in-parallel/contributions.json`: the entry ID,
version, status, title, latest update note, workspace ID, linked outcome ID,
start time and the folder you were working in. Finished or cancelled entries
keep only their ID, version, status and server. It also records when context,
reads and reports last happened, so `doctor` can check the setup.

The folder is readable only by you. The scripts send none of it anywhere; the
titles and workspace hint appear in the context line above.

## Need help?

Ask your assistant: **“Check my In Parallel connection.”**

If you can't install the plugin or access your workspace, ask your workspace
administrator for help.

## Publishing to the MCP registry

`server.json` lists the hosted In Parallel MCP server in the official
[MCP registry](https://registry.modelcontextprotocol.io): the context layer
for your company's AI, which gives Claude, ChatGPT, Copilot and other MCP
clients your team's decisions, meetings and plans, with sources and scoped to
each user's permissions. PulseMCP and Glama ingest new entries from the
official registry; Smithery needs its own submission at
[smithery.ai](https://smithery.ai).

Install `mcp-publisher` (`brew install mcp-publisher`) and check the file:

```sh
mcp-publisher validate
```

The name `ai.in-parallel/in-parallel` needs proof that you control
`in-parallel.ai`. Both proofs use an Ed25519 key, which needs OpenSSL 3
(`brew install openssl@3`; macOS LibreSSL lacks Ed25519):

```sh
OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
$OPENSSL genpkey -algorithm Ed25519 -out key.pem
PUBLIC_KEY="$($OPENSSL pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
PRIVATE_KEY="$($OPENSSL pkey -in key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
```

Then pick one:

- **DNS.** Add a TXT record on the `in-parallel.ai` apex (not a subdomain)
  with the value `v=MCPv1; k=ed25519; p=${PUBLIC_KEY}`, wait for
  `dig +short TXT in-parallel.ai` to show it, then run
  `mcp-publisher login dns --domain in-parallel.ai --private-key "$PRIVATE_KEY"`.
- **HTTP.** Serve the single line `v=MCPv1; k=ed25519; p=${PUBLIC_KEY}` as
  `text/plain` at `https://in-parallel.ai/.well-known/mcp-registry-auth`.
  The registry fetches the apex and does not follow redirects, so the
  apex-to-www redirect must skip this path. Then run
  `mcp-publisher login http --domain in-parallel.ai --private-key "$PRIVATE_KEY"`.

After logging in, publish:

```sh
mcp-publisher publish
```

Without domain access, rename the server to `io.github.in-parallel-oy/in-parallel`
and log in with `mcp-publisher login github` as an Owner of the
`in-parallel-oy` GitHub organization.

Keep `key.pem` out of the repo. Each published version is permanent, so bump
the version and publish again when the listing should change. `npm version
<patch|minor|x.y.z>` sets it in `package.json`, `server.json` and every plugin
manifest, and commits the change.

## Repository layout

Plugin directories and marketplaces install `plugins/in-parallel/` only: the skill, the MCP
connection, each client's manifest, `LICENSE` and `NOTICE`. The setup command,
its `package.json` and lockfile, `experimental/` and the build scripts stay at
the repository root, outside the installed plugin. Keep `plugins/in-parallel/LICENSE` and
`plugins/in-parallel/NOTICE` identical to the root copies; the tests check this.

## License

[Apache-2.0](LICENSE).
