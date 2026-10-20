#!/usr/bin/env node
'use strict'

// Developer tool, not shipped: writes the plugin for a local In Parallel server, for
// end-to-end runs. A loopback endpoint gets the experimental features from setup's
// own rule. Claude Code loads the output with --plugin-dir; Codex installs it from
// the output as a local marketplace.

const fs = require('node:fs')
const path = require('node:path')
const { parseArgs } = require('node:util')
const setup = require('./setup-lib')

const MARKETPLACE = 'in-parallel-e2e'
const MARKER = '.in-parallel-e2e.json'
const USAGE = 'node scripts/e2e-bundle.js --agent claude|codex --url <loopback MCP URL> --out <dir> [--token-env NAME]'

function e2eFiles({ agent: id, url, tokenEnv }) {
  const agent = setup.AGENTS.find(agent => agent.id === id && agent.id !== 'cursor')
  if (!agent) throw new Error(`Choose an agent: claude or codex.\n${USAGE}`)
  url = setup.endpoint(url)
  if (!setup.LOOPBACK_HOSTS.includes(new URL(url).hostname)) throw new Error('Use a loopback MCP URL (localhost, 127.0.0.1 or [::1]).')
  if (tokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error('--token-env takes an environment variable name.')
  let files, config
  if (agent.id === 'claude') {
    // A plugin directory for --plugin-dir: the plugin itself, without the setup marketplace.
    files = setup.pluginFiles(agent, url)
    config = '.mcp.json'
  } else {
    files = setup.bundle(agent, url).files
    // A marketplace of its own, so it never collides with the one setup registers.
    const market = JSON.parse(files['.agents/plugins/marketplace.json'])
    files['.agents/plugins/marketplace.json'] = setup.json({ ...market, name: MARKETPLACE, interface: { displayName: 'In Parallel end-to-end' } })
    config = `${setup.PLUGIN_DIR}mcp.json`
  }
  // Only the variable name is written; each client reads the token from its environment.
  if (tokenEnv) {
    const mcp = JSON.parse(files[config])
    if (agent.id === 'claude') mcp.mcpServers.in_parallel.headers = { Authorization: `Bearer \${${tokenEnv}}` }
    else mcp.mcpServers.in_parallel.bearer_token_env_var = tokenEnv
    files[config] = setup.json(mcp)
  }
  return files
}

function write(out, files, marker) {
  out = path.resolve(out)
  if (fs.existsSync(out)) {
    const entries = fs.readdirSync(out)
    if (entries.length && !entries.includes(MARKER)) throw new Error(`${out} is not empty and was not written by this tool.`)
    fs.rmSync(out, { recursive: true, force: true })
  }
  setup.writeFiles(out, { ...files, [MARKER]: setup.json(marker) })
  return out
}

function main(args = process.argv.slice(2), log = console.log) {
  const { values } = parseArgs({ args, options: {
    agent: { type: 'string' }, url: { type: 'string' }, out: { type: 'string' },
    'token-env': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } })
  if (values.help) return log(USAGE)
  if (!values.out) throw new Error(`--out is required.\n${USAGE}`)
  const options = { agent: values.agent, url: values.url, tokenEnv: values['token-env'] }
  const files = e2eFiles(options)
  const out = write(values.out, files, { agent: options.agent, endpoint: setup.endpoint(options.url), tokenEnv: options.tokenEnv ?? null })
  const token = options.tokenEnv ? ` Export ${options.tokenEnv} first.` : ''
  log(options.agent === 'claude'
    ? `Wrote ${out}\nRun: claude --plugin-dir ${out}${token}`
    : `Wrote ${out}\nRun: codex plugin marketplace add ${out} && codex plugin add in-parallel@${MARKETPLACE}, then trust the hooks in /hooks.${token}`)
}

if (require.main === module) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}

module.exports = { e2eFiles, main, MARKETPLACE }
