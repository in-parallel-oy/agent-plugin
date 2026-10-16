#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { parseArgs } = require('node:util')
const { zipSync } = require('fflate')
const setup = require('./setup-lib')

const CLIENTS = ['claude', 'claude-projects', 'codex', 'chatgpt-desktop', 'chatgpt-web']

function packageFiles(client, { url, appId, source = setup.SOURCE } = {}) {
  if (!CLIENTS.includes(client)) throw new Error(`Choose a client: ${CLIENTS.join(', ')}.`)
  const cloud = client === 'chatgpt-web'
  if (cloud && !/^(asdk_app_|connector_|templated_apps_)[A-Za-z0-9_-]+$/.test(appId || '')) {
    throw new Error('ChatGPT web requires the ID of your existing registered In Parallel app (--app-id).')
  }
  if (!cloud && appId) throw new Error('--app-id is only supported with --client chatgpt-web.')
  if (cloud && url !== undefined) throw new Error('ChatGPT web uses the registered app endpoint; omit --url.')
  const projects = client === 'claude-projects'
  if (projects && url !== undefined) throw new Error('Claude Projects reach In Parallel through the claude.ai connector; omit --url.')
  url = setup.endpoint(url ?? 'https://www.in-parallel.ai/mcp')
  const parsed = new URL(url)
  const hostname = parsed.hostname.replace(/\.$/, '')
  const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname) || hostname === '[::1]' ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname)
  if (client === 'claude' && (parsed.protocol !== 'https:' || loopback)) {
    throw new Error('Claude Chat/Cowork connects from the cloud. Use a publicly reachable HTTPS MCP URL; use interactive setup for local Claude Code.')
  }
  const agent = setup.AGENTS.find(agent => agent.id === (client.startsWith('claude') ? 'claude' : 'codex'))
  // ChatGPT runs no plugin hooks; leave out the Development reminders.
  const files = Object.fromEntries(Object.entries(setup.pluginFiles(client.startsWith('chatgpt') ? { ...agent, hooks: false } : agent, url, source))
    .map(([name, content]) => [name, Buffer.from(content)]))
  if (cloud) {
    for (const name of ['.mcp.json', 'mcp.json']) delete files[name]
    const manifest = JSON.parse(files['.codex-plugin/plugin.json'])
    delete manifest.mcpServers
    delete manifest.apps
    // OpenAI rejects .app.json and any declared MCP server for a plugin that
    // was created through its legacy form; the connection is managed in the
    // OpenAI dashboard. The manifest name must match that existing plugin:
    // `app-<id without asdk_app_>`. Other ID formats fall back to the ID itself.
    manifest.name = appId.startsWith('asdk_app_') ? `app-${appId.slice('asdk_app_'.length)}` : appId
    manifest.version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).version
    files['.codex-plugin/plugin.json'] = Buffer.from(setup.json(manifest))
  }
  if (projects) {
    // Project threads are cloud sessions that get MCP tools from the claude.ai
    // connector, so a plugin server would duplicate it. Ship skills only.
    for (const name of Object.keys(files)) {
      if (/^(hooks|scripts)\//.test(name) || ['.mcp.json', 'mcp.json'].includes(name)) delete files[name]
    }
    const manifest = JSON.parse(files['.claude-plugin/plugin.json'])
    delete manifest.hooks
    delete manifest.mcpServers
    manifest.version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).version
    files['.claude-plugin/plugin.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  }
  return files
}

function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    client: { type: 'string' }, output: { type: 'string' }, url: { type: 'string' },
    'app-id': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } })
  if (values.help) {
    console.log('Build an In Parallel plugin ZIP without installing any client.\n\nnode scripts/package.js --client <claude|claude-projects|codex|chatgpt-desktop|chatgpt-web> [--output file.zip] [--url https://host/mcp]\n\nClaude Projects takes no --url: the archive has skills and manifest only, and threads use the claude.ai connector.\nChatGPT web additionally requires --app-id for an existing registered app. The archive declares no MCP server and no .app.json (OpenAI manages the connection); its manifest name is app-<id without asdk_app_> for asdk_app_ IDs.\nArchives contain plugin files only. Existing output files are never overwritten.')
    return
  }
  const files = packageFiles(values.client, { url: values.url, appId: values['app-id'] })
  const version = JSON.parse(fs.readFileSync(path.join(setup.SOURCE, 'package.json'))).version
  const output = path.resolve(values.output || `dist/in-parallel-${values.client}-${version}.zip`)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, zipSync(files), { flag: 'wx', mode: 0o600 })
  const next = values.client === 'claude'
    ? 'Upload through Customize → Plugins, then connect In Parallel.'
    : values.client === 'claude-projects'
      ? 'Add it in Project settings → Plugins, after connecting In Parallel under claude.ai → Customize → Connectors.'
      : 'Use the local or workspace marketplace flow in README.md, then connect In Parallel.'
  console.log(`Created ${output}\n${next}`)
}

if (require.main === module) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}

module.exports = { packageFiles, main }
