# Verify work journal setup

Use this reference when asked to install, verify or troubleshoot journal reporting.

1. Check for `announce_work`, `list_work` and `get_work`. Reporting requires title,
   session/request IDs, revision checks and the `attach_subject` action. All three
   tools must return `mcp_endpoint`.
2. Read `list_work` in the authorized workspace. Compare its endpoint with the
   configured endpoint from hook context or the user’s configuration. If missing or
   different, stop reporting and resolve the connection. The reply hook protects the
   local cache; it cannot undo a write already sent to the wrong server.
3. Identify the client surface. Claude Chat and ChatGPT Chat/web may have tools and
   skills without lifecycle hooks. Without hooks, generate one UUID for this session
   and retain returned contribution handles in conversation context; never claim
   local persistence is verified. When hooks are available, confirm the context hook
   supplied this session’s `session_id`. When available,
   run `node scripts/setup.js doctor` from the setup checkout to check installation
   and observed hook delivery.
4. Use the next real authorized task to check reporting and read its timeline with
   `get_work`. Do not create synthetic entries or complete real work just to test setup.

Doctor combines context, timeline-read and report-tracking observations only for the
same endpoint, bundle and session. These timestamps establish past delivery, not
current authentication. After an update, reinstall, restart the client and verify
the new bundle. If no task is underway, report reads/context checked and write
tracking pending. Without local doctor evidence, describe hook persistence as unverified.

Hooks retain owned handles and versions. Successful `get_work` reads repair known
handles after a missed receipt, including completed or cancelled work. Reads never
establish ownership of unknown entries. After compaction or an uncertain write,
read the known contribution before reporting again.

Hooks do not infer activity, progress or completion. If an agent vanishes, its entry
keeps its reported state, leaves the seven-day recent board and remains in history.

## Installation differs by surface

- Claude Desktop Chat/Cowork: Customize → Plugins. Claude Code CLI setup does not
  install into these surfaces. Chat does not execute hooks; Cowork delivery must be verified.
- Codex CLI: interactive setup, sign in, then trust hooks. Codex and ChatGPT Desktop
  can also install through their Plugins marketplace without a CLI.
- ChatGPT web/mobile: use the registered-app variant. Bundled MCP configuration
  marks a plugin Desktop only even with an HTTPS endpoint. A browser handoff does
  not carry a desktop connection into a web conversation.
- Missing tools: check plugin availability, GitHub access, workspace policy and
  client-owned sign-in. Do not request tokens or claim a package download proves authentication.
- Cloud clients cannot reach a developer's localhost MCP server.

Read the repository README for the current install steps. Local doctor checks only
setup-managed coding clients; its absence does not mean a desktop/cloud plugin failed.
