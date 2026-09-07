# In Parallel agent plugin

Connect your coding agent to In Parallel, announce shared work, spot exact
subject overlaps, and leave useful handoffs. Skills and MCP are portable;
automatic context and heartbeat behavior depend on the client.

## Install

### Claude Code

```
/plugin marketplace add in-parallel-oy/agent-plugin
/plugin install in-parallel@in-parallel
```

To dogfood a local checkout, point the marketplace at the directory instead —
the marketplace lists this repository itself as the plugin source (`"./"`), so
a path works exactly like the remote:

```
/plugin marketplace add ~/Projects/agent-plugin
/plugin install in-parallel@in-parallel
```

or from a shell, `claude plugin marketplace add ~/Projects/agent-plugin`.
Re-run `/plugin marketplace update in-parallel` after editing local files.

Claude Code defaults to production. To use another environment, set its MCP URL
before launching Claude:

```sh
IN_PARALLEL_MCP_URL=https://your-environment.example/mcp claude
```

The Claude MCP config and hooks expand the same `${IN_PARALLEL_MCP_URL:-...}`
value. Keep the server name `in-parallel`; install one plugin and select the
environment before starting the session. Restart the client after switching and
authenticate to that environment. Claims are stored separately by endpoint.

### Codex

```
codex plugin marketplace add in-parallel-oy/agent-plugin
codex plugin install in-parallel
```

### Cursor

Install from the Cursor marketplace, or add this repository (or a local
checkout of it) as a plugin source in Settings → Customize → Plugins.

### GitHub Copilot

For hosts supporting [Agent Plugins 1.0](https://agent-plugins.org/specification),
use the portable `plugin.json`, `skills/`, and `mcp.json`. This plugin supplies
no Copilot hook adapter; use explicit lifecycle calls and the fallback lease.

## Client support

| Client | MCP + skills | Automatic tracking and renewal | Context recovery |
| --- | --- | --- | --- |
| Claude Code | Yes | Successful tool replies; prompt, tool, and stop events | Session start, resume/compact, prompt changes, subagent start |
| Codex with plugin hooks | Yes | Successful tool replies; prompt, tool, and stop events | Session start, resume/compact, prompt changes, subagent start |
| Cursor IDE | Yes | `afterMCPExecution`; prompt, tool, and stop events | New conversations and changed context after tools |
| Cursor Cloud | Host-dependent | Not verified in this host | Do not assume IDE parity |
| GitHub Copilot / other portable hosts | Host-dependent | No adapter supplied | Skills only; explicit lifecycle calls |

These adapters follow the published [Claude hook contract](https://code.claude.com/docs/en/hooks),
[Codex hook contract](https://developers.openai.com/codex/hooks/), and
[Cursor hook contract](https://cursor.com/docs/hooks), checked 2026-09-07.
Older clients may lack these events. The [portable plugin specification](https://agent-plugins.org/specification)
does not make client-specific hooks portable.

The table describes adapter coverage, not an end-to-end certification of each
host. Tests execute Cursor's actual manifest commands with a plugin directory
containing spaces. Cursor 3.19.13's installed hook runner also expands
`${CURSOR_PLUGIN_ROOT}` in plugin commands; IDE and Cloud event dispatch have
not been tested end to end.

## Environment configuration

Claude uses `.mcp.json`, whose environment override follows the published
[Claude MCP expansion contract](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson).
Codex, Cursor, and portable hosts use `mcp.json`, with a literal production URL.
The [Agent Plugins 1.0 specification](https://agent-plugins.org/specification)
forbids variable expansion in HTTP URLs and headers. The Claude override does
not affect these other clients.

For local dogfooding in Codex or Cursor, edit the literal URL in `mcp.json` in
the checkout used by that client, then reload the plugin. Its hooks read that
same file. HTTPS is required outside loopback development. Tests keep the
portable URL and Claude's default aligned. A mismatched heartbeat capability
is rejected with a diagnostic; the agent must reconcile through `list_work`.

## What happens during work

1. Context hooks provide repo/branch facts, an optional PR URL, a session request
   prefix, and claims owned by the current client session and subagent. Other
   sessions are mentioned only as a count; their work is never automatically renewed.
2. The agent announces work using a stable issue or work-record URI and a fresh
   request ID. Retrying the same request refers to the same episode. Opening a PR
   does not change the subject. Exact matching can miss differently named work.
3. The reply hook records the claim and immediately attempts a heartbeat. Later
   prompt/tool/stop events attempt renewal when due. Attempts are reserved atomically,
   so concurrent events coalesce and failures back off until the next interval.
4. Block pauses work awaiting a dependency, decision, or input, with a required
   note. It keeps its assignee and has no active lease. Start with the same claim
   ID resumes it once the dependency is resolved.
5. Complete/cancel records an outcome. Release requires a handoff note; pickup
   creates one successor while retaining that note in history.

There is no daemon or background timer. A Stop event is an opportunity to report,
not proof of continuous execution. Work starts with a 24-hour fallback lease;
each successful heartbeat sets a two-hour lease. A quiet or unsupported client
can expire even while work continues. Explicit outcomes remain the clearest signal.

Heartbeat POSTs have an empty body, a three-second deadline, no redirects, and a
claim-scoped token. The URL must match the configured MCP origin and exact claim
heartbeat path. `204` records success; `401`/`409` retains the ID with
`needs_reconciliation` and drops the capability. Other failures retain state and
wait for the next due event. Reconcile through authenticated `list_work` before
resuming uncertain or legacy work.

## Local state and privacy

`~/.in-parallel/claims.json` is mode 0600 inside a mode 0700 directory. It holds
claim IDs, workspace/person IDs, the owning client/session/subagent, checkout,
MCP endpoint, subject, lifecycle state, heartbeat capability, and attempt times.
All writers lock, reread, and atomically patch the latest store. Late heartbeat
responses cannot resurrect a closed claim or overwrite another session's new work.
Malformed stores are preserved for recovery. Old ownerless entries are never
silently adopted. Session context markers are pruned after seven days.

The local store is a cache; the server remains authoritative. Deleting it stops
automatic renewal and loses local ownership context. Reconcile rather than
blindly reannouncing work. Changing MCP accounts requires reconciling open claims
before adopting them under the new account.

The agent's MCP writes expose the selected description, URI, and handoff note to
the workspace. Heartbeats send only the claim-scoped bearer and an empty POST.
The context hook reads local git metadata and optionally calls `gh pr list`,
which can contact GitHub for the PR URL. It does not upload the context line or
read source files. Hooks do not receive the MCP OAuth credential; their stored
capability can only renew its single claim.

## Repository layout and tests

Portable manifests/config: `plugin.json`, `mcp.json`. Client manifests live in
`.claude-plugin`, `.codex-plugin`, `.cursor-plugin`. Claude selects `.mcp.json`;
Codex and Cursor select `mcp.json`. They share skills and the Node scripts through
`hooks/{claude,codex,cursor}.json`.
`runtime.js` owns client identity and payload/capability validation; `store.js`
owns locking and atomic persistence. The three entry points are `context.js`,
`remember-claim.js`, and `heartbeat.js`.

Node 18+ and git are required; `gh` is optional. No runtime dependencies.

```
sh scripts/test.sh
```

Behavior tests run real hook processes in isolated temporary homes against a
local HTTP stub. They cover session isolation, delayed-response races, concurrent
writers, abandoned locks, outage backoff, context restoration, client payloads,
environment switching, manifest commands, and capability destination checks.
They do not contact In Parallel or GitHub.

## License

MIT — see [LICENSE](LICENSE).
