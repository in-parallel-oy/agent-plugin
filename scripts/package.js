#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { parseArgs } = require('node:util')
const { zipSync } = require('fflate')
const setup = require('./setup-lib')

const CLIENTS = ['claude', 'codex', 'chatgpt-desktop', 'chatgpt-web']

function packageFiles(client, { url, appId, source = setup.SOURCE } = {}) {
  if (!CLIENTS.includes(client)) throw new Error(`Choose a client: ${CLIENTS.join(', ')}.`)
  const cloud = client === 'chatgpt-web'
  if (cloud && !/^(asdk_app_|connector_|templated_apps_)[A-Za-z0-9_-]+$/.test(appId || '')) {
    throw new Error('ChatGPT web requires the ID of your existing registered In Parallel app (--app-id).')
  }
  if (!cloud && appId) throw new Error('--app-id is only supported with --client chatgpt-web.')
  if (cloud && url !== undefined) throw new Error('ChatGPT web uses the registered app endpoint; omit --url.')
  url = setup.endpoint(url ?? 'https://www.in-parallel.ai/mcp')
  const parsed = new URL(url)
  const hostname = parsed.hostname.replace(/\.$/, '')
  const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname) || hostname === '[::1]' ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname)
  if (client === 'claude' && (parsed.protocol !== 'https:' || loopback)) {
    throw new Error('Claude Chat/Cowork connects from the cloud. Use a publicly reachable HTTPS MCP URL; use interactive setup for local Claude Code.')
  }
  const agent = setup.AGENTS.find(agent => agent.id === (client === 'claude' ? 'claude' : 'codex'))
  const prepared = setup.bundle(agent, url, source)
  const prefix = 'plugins/in-parallel/'
  const files = Object.fromEntries(Object.entries(prepared.files)
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, content]) => [name.slice(prefix.length), Buffer.from(content)]))
  if (cloud) {
    for (const name of Object.keys(files)) {
      if (name.startsWith('hooks/') || name.startsWith('scripts/') || ['.mcp.json', 'mcp.json'].includes(name)) delete files[name]
    }
    const manifest = JSON.parse(files['.codex-plugin/plugin.json'])
    delete manifest.hooks
    delete manifest.mcpServers
    manifest.apps = './.app.json'
    // Cloud bundles carry no local MCP or hook configuration: either would
    // change the supported install surface or depend on a local runtime.
    manifest.version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).version
    files['.codex-plugin/plugin.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
    files['.app.json'] = Buffer.from(JSON.stringify({ apps: { in_parallel: { id: appId, required: true } } }, null, 2) + '\n')
    const hash = crypto.createHash('sha256').update(JSON.stringify(
      Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => [name, content.toString()]),
    )).digest('hex').slice(0, 12)
    manifest.version += `+app.${hash}`
    files['.codex-plugin/plugin.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  }
  return files
}

function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    client: { type: 'string' }, output: { type: 'string' }, url: { type: 'string' },
    'app-id': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } })
  if (values.help) {
    console.log('Build an In Parallel plugin ZIP without installing any client.\n\nnode scripts/package.js --client <claude|codex|chatgpt-desktop|chatgpt-web> [--output file.zip] [--url https://host/mcp]\n\nChatGPT web additionally requires --app-id for an existing registered app.\nArchives contain plugin files only. Existing output files are never overwritten.')
    return
  }
  const files = packageFiles(values.client, { url: values.url, appId: values['app-id'] })
  const version = JSON.parse(fs.readFileSync(path.join(setup.SOURCE, 'package.json'))).version
  const output = path.resolve(values.output || `dist/in-parallel-${values.client}-${version}.zip`)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, zipSync(files), { flag: 'wx', mode: 0o600 })
  const next = values.client === 'claude'
    ? 'Upload through Customize → Plugins, then connect In Parallel.'
    : 'Use the local or workspace marketplace flow in README.md, then connect In Parallel.'
  console.log(`Created ${output}\n${next}`)
}

if (require.main === module) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}

module.exports = { packageFiles, main }
