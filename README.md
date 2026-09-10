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

## Need help?

Ask your assistant: **“Check my In Parallel connection.”**

If you can't install the plugin or access your workspace, ask your workspace
administrator for help.

## License

[Apache-2.0](LICENSE).
