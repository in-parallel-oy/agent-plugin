# In Parallel agent plugin

One plugin, four clients. It gives your coding agent access to
[In Parallel](https://www.in-parallel.ai) over MCP, two skills that say how to
use it, and three small hooks that keep work claims honest without you having
to remember anything.

The problem it solves is narrow and real: two people, or two agents, starting
the same work an hour apart and finding out at merge time. Announcing work
takes one tool call. This plugin makes that call the obvious thing to do, and
then keeps the claim alive and cleans it up.

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

### Codex

```
codex plugin marketplace add in-parallel-oy/agent-plugin
codex plugin install in-parallel
```

### Cursor

Install from the Cursor marketplace, or add this repository (or a local
checkout of it) as a plugin source in Settings → Customize → Plugins.

### GitHub Copilot

Copilot loads the portable half of the plugin — `skills/` and `mcp.json`, per
[Agent Plugins 1.0](https://agent-plugins.org/specification). The skills and
the MCP server work. **The hooks do not**: Copilot has no hook that can inject
context into a session, so there is no session line and no automatic
heartbeat. Claims still work; they expire on their own if nothing beats them.

## What the hooks do

Three scripts, no daemon, no background process, no state beyond one file.

| Hook | Script | What it does |
| --- | --- | --- |
| SessionStart, UserPromptSubmit | `scripts/context.js` | Emits **one line**: repo, branch, pull request URL if `gh` answers within 3 s, the work claims this machine still has open, and one sentence reminding the agent to announce work and to close what it listed. Once per session, again when the branch changes. |
| PostToolUse / afterMCPExecution on `announce_work` | `scripts/remember-claim.js` | Stores the claim id, description, URI and heartbeat token the server just returned. Deletes the entry when the reply says completed, released or cancelled. |
| Stop | `scripts/heartbeat.js` | POSTs the heartbeat for every stored claim whose last beat is older than the interval the server asked for. Silent, 3 s, no retries. |

And what they do **not** do:

- They do not block, deny, or rewrite anything. `context.js` exits 0 on every
  path, including no git, no `gh`, and unparseable input.
- They do not call the In Parallel API. The only network call any hook makes is
  the heartbeat POST, to the URL the server itself returned.
- They do not read your code, your diff, or your prompts.
- They do not carry credentials. Your MCP session authenticates you; the
  plugin never sees that token. The one secret it stores is the claim-scoped
  heartbeat token described below.
- They do not announce work for you. Announcing is a decision, and the agent
  makes it — the hook only makes sure the agent knows the facts and remembers
  what it claimed.

## Privacy

What leaves your machine, and only when the agent calls a tool or the Stop hook
beats a claim:

- **To In Parallel, in `announce_work` calls the agent makes:** the description
  and URI it chose — typically a repository URL, a branch tree URL or a pull
  request URL — and the reason on complete, release or cancel. These are
  visible to everyone in the workspace. Never put secrets in them.
- **To In Parallel, from the Stop hook:** an empty POST with a claim-scoped
  bearer token. No body, no metadata, no repository contents.
- **Nowhere else.** The session line — repo, branch, pull request URL, open
  claims — is printed into your own agent session. It is not uploaded.

Local state lives in `~/.in-parallel/claims.json` (mode 0600, directory 0700):
one entry per open claim with its id, description, URI, start time, heartbeat
token and last beat. Session markers live beside it and are pruned after seven
days. Delete the directory at any time; the next start rebuilds it.

## Heartbeat and updates

A work claim expires 24 hours after it starts and cannot be renewed through the
tools. That is deliberate: a claim nobody is executing should stop claiming.
But an agent that is genuinely still working needs a way to say so without the
model having to remember to say it — and a model-driven renewal is exactly the
thing that stops happening under load.

So `announce_work` with `action: "start"` returns a heartbeat alongside the
claim:

```json
"heartbeat": {
  "token": "<opaque, scoped to this claim>",
  "url": "https://www.in-parallel.ai/...",
  "interval_seconds": 300
}
```

The Stop hook POSTs that URL with `Authorization: Bearer <token>` and an empty
body. `204` means the claim is still working; `401` means the token is no
longer valid; `409` means the claim is no longer working — someone completed,
released or cancelled it, or it expired. On `401` or `409` the local entry is
deleted, so the next session's context line stops mentioning a claim that no
longer exists. Anything else is left alone: a flaky network must not drop a
live claim, and the next Stop is the retry.

The token is scoped to one claim and does one thing. It cannot read a
workspace, cannot list work, and cannot change a claim's state — the lifecycle
actions all go through authenticated MCP as the person. That is why this
protocol needs no general agent API: everything an agent does is
request/response inside a session it already authenticated, and liveness is the
single exception, handled by one credential that can only say "still here".

## Repository layout

```
plugin.json                     Agent Plugins 1.0 manifest (portable: skills + MCP)
mcp.json                        Agent Plugins MCP config (streamable-http)
.mcp.json                       Claude Code / Codex / Cursor MCP config (http)
.claude-plugin/plugin.json      Claude Code manifest
.claude-plugin/marketplace.json Marketplace listing this repository as the plugin
.codex-plugin/plugin.json       Codex manifest
.cursor-plugin/plugin.json      Cursor manifest
hooks/{claude,codex,cursor}.json  Per-client hook wiring, same three scripts
scripts/context.js              Session facts + reminder
scripts/remember-claim.js       Claim memory
scripts/heartbeat.js            Heartbeat
scripts/store.js                ~/.in-parallel/claims.json read/write
scripts/test.sh                 sh scripts/test.sh
skills/in-parallel/             Using In Parallel through MCP
skills/in-parallel-work/        The work-claims protocol
```

Node 18+ and git; `gh` is optional and only used to look up a pull request URL.

## Tests

```
sh scripts/test.sh
```

Runs each hook script with real hook JSON on stdin against a throwaway `HOME`,
a throwaway git repository, a stub `gh` and a real HTTP server standing in for
the heartbeat endpoint. No network, no side effects outside its temp directory.

## License

MIT — see [LICENSE](LICENSE).
