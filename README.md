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
conflicting entry says what it conflicts with and why, and a legacy entry named
`in-parallel` comes with how to fix it. Changed installed files are named; when
an installed `.mcp.json` gained an `Authorization` header, `doctor` says a
credential header was added without printing it. It always shows the endpoint
setup installed, even when a check fails. Without a setup copy, `doctor` lists
any project copy setup did not install, says it can stay, and gives the command
that removes it. It checks what is installed, not that it works: to check that,
ask your agent "Check my In Parallel connection". `doctor` changes nothing.

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
`~/.in-parallel`. Setup deletes that cache, and `doctor` asks you to run setup
again if the work journal is still installed.

## Experimental features

Features the In Parallel server has not yet enabled for every team live in
`experimental/`. Plugin browsers never install them. The setup command adds them
only when you choose the Development environment
(`https://www.in-parallel.dev/mcp`) or a server on localhost, never for Production or another
server.

### Reporting work back (`experimental/agent-work`)

Lets your assistant report its work on an In Parallel item back to that item,
with the In Parallel `report_back` tool: when it starts, notes as it goes, and
when it finishes, with links to what the work produced. It adds:

- the `in-parallel-agent-work` skill, which holds the reporting rules: see
  [its SKILL.md](experimental/agent-work/skills/in-parallel-agent-work/SKILL.md);
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
conversation; Codex names its conversation thread itself. The script reads only
what your assistant passes it and, after a pull request, the newest part of the
session's local transcript. It never reads your sign-in, connects to In
Parallel or anything else, or writes files.

Before your assistant stops, its `Stop` hook asks In Parallel's
`report_back_reminder` tool, through your assistant's own In Parallel
connection, whether it has an item it reported started and not yet finished.
When your company does not have the feature yet, or the hook gets no answer
within 30 seconds, your assistant stops as usual. When you are signed out, your
client may show its own hook-error notice at each stop.

Codex asks you to trust the hooks in `/hooks` first, and again after they
change. Cursor gets the skill and the command but no reminders.

To try the feature against a local In Parallel server,
`node scripts/e2e-bundle.js --agent claude|codex --url <loopback MCP URL> --out <dir> [--token-env NAME]`
writes a plugin directory for `claude --plugin-dir`, or a local marketplace for
Codex. With `--token-env`, the client reads a personal access token from that
environment variable; the token itself is never written.

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
