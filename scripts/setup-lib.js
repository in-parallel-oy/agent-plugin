'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { endpointURL, expandEndpoint } = require('./runtime')

const AGENTS = [
  { id: 'claude', name: 'Claude Code', command: 'claude' },
  { id: 'codex', name: 'Codex', command: 'codex' },
  { id: 'cursor', name: 'Cursor', command: null },
]
const SOURCE = path.resolve(__dirname, '..')
const MARKETPLACE = 'in-parallel-setup'
const PLUGIN = `in-parallel@${MARKETPLACE}`
const RECEIPT = '.in-parallel-setup.json'
const json = value => JSON.stringify(value, null, 2) + '\n'
const digest = value => crypto.createHash('sha256').update(value).digest('hex')

class ReplacementRequired extends Error {
  constructor(plugins) {
    super(`Existing In Parallel installation: ${plugins.join(', ')}. Run setup interactively to replace it.`)
    this.plugins = plugins
  }
}

const pluginId = plugin => plugin.pluginId || plugin.id || ''

function endpoint(value) {
  try { return endpointURL(value).href } catch {
    throw new Error('Use an HTTPS MCP URL without credentials, query parameters, or a fragment. HTTP is allowed for localhost.')
  }
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8', timeout: capture ? 20_000 : 120_000,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}.`)
  }
  return capture === 'text' ? result.stdout.trim() : capture ? JSON.parse(result.stdout) : null
}

function tree(root) {
  const files = {}
  function visit(dir, relative = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error(`Refusing to change a directory containing a symlink: ${path.join(root, name)}`)
      if (entry.isDirectory()) visit(path.join(dir, entry.name), name)
      else if (entry.isFile()) files[name] = fs.readFileSync(path.join(root, name))
      else throw new Error(`Unsupported file: ${path.join(root, name)}`)
    }
  }
  visit(root)
  return files
}

function managed(root, agent) {
  if (!fs.existsSync(root)) return null
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Refusing to replace a symlink: ${root}`)
  const files = tree(root)
  let receipt
  try { receipt = JSON.parse(files[RECEIPT]) } catch { throw new Error(`Existing directory is not managed by this setup script: ${root}`) }
  if (receipt.format !== 1 || receipt.agent !== agent.id || !receipt.files) {
    throw new Error(`Unrecognized setup receipt: ${root}`)
  }
  delete files[RECEIPT]
  const hashes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)]))
  if (Object.keys(hashes).length !== Object.keys(receipt.files).length ||
      Object.entries(hashes).some(([name, hash]) => receipt.files[name] !== hash)) {
    throw new Error(`Installed files were changed: ${root}. Preserve your changes before updating or removing this copy.`)
  }
  return receipt
}

function target(agent, home = os.homedir()) {
  return agent.id === 'cursor'
    ? path.join(home, '.cursor', 'plugins', 'local', 'in-parallel')
    : path.join(home, '.in-parallel', 'setup', agent.id)
}

function bundle(agent, url, source = SOURCE) {
  const files = {}
  const prefix = agent.id === 'cursor' ? '' : 'plugins/in-parallel/'
  const manifestPath = `.${agent.id}-plugin/plugin.json`
  const manifest = JSON.parse(fs.readFileSync(path.join(source, manifestPath)))
  for (const [name, content] of Object.entries(tree(path.join(source, 'skills')))) files[`${prefix}skills/${name}`] = content
  for (const name of ['context.js', 'remember-claim.js', 'runtime.js', 'store.js']) {
    files[`${prefix}scripts/${name}`] = fs.readFileSync(path.join(source, 'scripts', name))
  }
  files[`${prefix}hooks/${agent.id}.json`] = fs.readFileSync(path.join(source, 'hooks', `${agent.id}.json`))
  for (const name of ['LICENSE', 'NOTICE']) files[`${prefix}${name}`] = fs.readFileSync(path.join(source, name))
  // Use the same literal endpoint for MCP and hooks, including Claude. Never alter the source checkout.
  for (const name of ['.mcp.json', 'mcp.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(source, name), 'utf8'))
    config.mcpServers.in_parallel.url = endpoint(url)
    files[`${prefix}${name}`] = json(config)
  }
  files[`${prefix}${manifestPath}`] = json(manifest)
  const hash = digest(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => `${name}\0${digest(content)}`).join('\n'))
  manifest.version = `${manifest.version.split('+')[0]}+setup.${hash.slice(0, 12)}`
  files[`${prefix}${manifestPath}`] = json(manifest)
  if (agent.id === 'claude') {
    files['.claude-plugin/marketplace.json'] = json({
      name: MARKETPLACE, owner: { name: 'In Parallel' },
      metadata: { description: 'In Parallel skills, MCP, and hooks configured by interactive setup.' },
      plugins: [{ name: 'in-parallel', source: './plugins/in-parallel', version: manifest.version, description: manifest.description }],
    })
  } else if (agent.id === 'codex') {
    files['.agents/plugins/marketplace.json'] = json({
      name: MARKETPLACE, interface: { displayName: 'In Parallel setup' },
      plugins: [{ name: 'in-parallel', source: { source: 'local', path: './plugins/in-parallel' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
    })
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
  const receipt = { format: 1, agent: agent.id, endpoint: endpoint(url), version: manifest.version,
    files: Object.fromEntries(Object.entries(sorted).map(([name, content]) => [name, digest(content)])) }
  return { files: { ...sorted, [RECEIPT]: json(receipt) }, receipt }
}

function writeBundle(root, files, agent) {
  fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 })
  // Cursor discovers each directory inside plugins/local. Keep incomplete and
  // previous bundles outside that directory, while retaining atomic renames.
  const stagingParent = agent.id === 'cursor' ? path.dirname(path.dirname(root)) : path.dirname(root)
  if (fs.statSync(stagingParent).dev !== fs.statSync(path.dirname(root)).dev) {
    throw new Error('Plugin staging and installation must use the same filesystem. Existing installation was preserved.')
  }
  const stage = fs.mkdtempSync(path.join(stagingParent, '.in-parallel-stage-'))
  const backup = `${stage}.previous`
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(stage, name)
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, content, { mode: 0o600 })
    }
    if (fs.existsSync(root)) fs.renameSync(root, backup)
    try { fs.renameSync(stage, root) } catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, root)
      throw error
    }
    fs.rmSync(backup, { recursive: true, force: true })
  } finally { fs.rmSync(stage, { recursive: true, force: true }) }
}

function inventory(agent, execute = run) {
  if (!agent.command) return { plugins: [], marketplaces: [] }
  const plugins = execute(agent.command, ['plugin', 'list', '--json'], { capture: true })
  const markets = execute(agent.command, ['plugin', 'marketplace', 'list', '--json'], { capture: true })
  const pluginRows = agent.id === 'codex' ? plugins.installed : plugins
  const marketplaceRows = agent.id === 'codex' ? markets.marketplaces : markets
  if (!Array.isArray(pluginRows) || !Array.isArray(marketplaceRows)) throw new Error(`Unrecognized ${agent.name} plugin inventory. Update the client before running setup.`)
  return { plugins: pluginRows, marketplaces: marketplaceRows }
}

function preflight(agent, root, execute = run, replace = []) {
  const receipt = managed(root, agent)
  const state = inventory(agent, execute)
  const existing = state.plugins.filter(plugin => pluginId(plugin).split('@')[0] === 'in-parallel')
  const foreign = existing.filter(plugin => !receipt || pluginId(plugin) !== PLUGIN ||
    (agent.id === 'claude' && plugin.scope !== 'user'))
  const project = foreign.find(plugin => agent.id === 'claude' && plugin.scope !== 'user')
  if (project) {
    throw new Error(`Existing ${project.scope || 'unknown'}-scope installation ${pluginId(project)} is outside user setup. Remove it from its project with: claude plugin uninstall ${pluginId(project)} --scope ${project.scope || 'project'}`)
  }
  const market = state.marketplaces.find(item => item.name === MARKETPLACE)
  if (market && !receipt) throw new Error(`The ${MARKETPLACE} marketplace already exists in ${agent.name}; refusing to replace it.`)
  if (market) {
    const location = agent.id === 'codex' ? market.root : market.path
    let matches = false
    try { matches = fs.realpathSync(location) === fs.realpathSync(root) } catch {}
    if (!matches) throw new Error(`The ${MARKETPLACE} marketplace points elsewhere in ${agent.name}; refusing to change it.`)
  }
  if (!receipt && existing.some(plugin => pluginId(plugin) === PLUGIN)) {
    throw new Error(`Existing ${PLUGIN} has no setup receipt at ${root}. Remove that native installation before running setup again.`)
  }
  const replacements = foreign.map(pluginId)
  if (replacements.some(id => !replace.includes(id))) throw new ReplacementRequired(replacements)
  if (agent.id === 'claude' && replacements.length) {
    // Older clients can uninstall the same-named plugin from the wrong marketplace.
    const version = execute('claude', ['--version'], { capture: 'text' }).match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$)/)
    const [major, minor, patch] = version ? version.slice(1).map(Number) : []
    if (!version || major < 2 || (major === 2 && (minor < 1 || (minor === 1 && patch < 212)))) {
      throw new Error('Update Claude Code to 2.1.212 or newer before replacing a plugin from another marketplace. Existing installations were kept.')
    }
  }
  return { receipt, installed: existing.find(plugin => pluginId(plugin) === PLUGIN),
    registered: Boolean(market), replacements }
}

// Inspect documented local files without connecting or reading CLI health output.
// Session-only flags, managed policy and other checkouts still need runtime verification.
function preflightMcp(agent, url, { home = os.homedir(), cwd = process.cwd(), env = process.env, source = SOURCE } = {}) {
  if (!['claude', 'cursor'].includes(agent.id)) return
  const folders = []
  for (let folder = path.resolve(cwd); ; folder = path.dirname(folder)) {
    folders.push(folder)
    if (folder === path.resolve(home) || fs.existsSync(path.join(folder, '.git')) || folder === path.dirname(folder)) break
  }
  const read = file => {
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid configuration')
      return config
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      throw new Error(`Could not read MCP configuration at ${file}. Existing settings were preserved.`)
    }
  }
  const check = (config, location) => {
    for (const [name, server] of Object.entries(config?.mcpServers || {})) {
      if (name === 'in-parallel') throw new Error(`${agent.name}: legacy In Parallel MCP entry named in-parallel in ${location}. Rename it to in_parallel or remove it to use the plugin-provided connection, then rerun setup. Existing settings were preserved.`)
      if (name !== 'in_parallel') continue
      let matches = false
      try {
        const transport = agent.id === 'claude' ? ['http', 'streamable-http'] : [undefined, 'http', 'streamable-http']
        const expanded = expandEndpoint(server.url, agent.id, env)
        matches = transport.includes(server.type) && !server.command && endpoint(expanded) === url
      } catch {}
      if (!matches) throw new Error(`${agent.name}: conflicting or unverifiable In Parallel MCP entry in ${location}. Match it to the selected URL or remove that entry, then rerun setup. Existing settings were preserved; no URLs or credentials were printed.`)
    }
  }
  if (agent.id === 'claude') {
    const file = env.CLAUDE_CONFIG_DIR ? path.join(path.resolve(env.CLAUDE_CONFIG_DIR), '.claude.json') : path.join(home, '.claude.json')
    const config = read(file)
    check(config, `${file} (user scope)`)
    for (const folder of folders) {
      check(config.projects?.[folder], `${file} (local scope for ${folder})`)
      const project = path.join(folder, '.mcp.json')
      // This checkout's file is the distribution template, rewritten by bundle().
      if (path.resolve(project) !== path.resolve(source, '.mcp.json')) check(read(project), `${project} (project scope)`)
    }
  } else {
    const personal = path.join(home, '.cursor', 'mcp.json')
    check(read(personal), `${personal} (user scope)`)
    for (const folder of folders) {
      const project = path.join(folder, '.cursor', 'mcp.json')
      if (project !== personal) check(read(project), `${project} (project scope)`)
    }
  }
}

function verifyMcp(agent, url, execute = run) {
  if (agent.id !== 'codex') return
  let server
  try { server = execute('codex', ['mcp', 'get', 'in_parallel', '--json'], { capture: true }) } catch {
    throw new Error('Codex could not discover the plugin-provided In Parallel MCP server. Update Codex and rerun setup, then inspect codex mcp list. Existing personal MCP settings were preserved.')
  }
  if (server?.enabled !== true || server.transport?.type !== 'streamable_http' || server.transport.url !== url) {
    throw new Error(`Codex does not resolve an enabled In Parallel MCP server at ${url}. Inspect codex mcp get in_parallel; personal or project settings may override the plugin. Correct the conflicting entry and rerun setup. Existing MCP settings were preserved.`)
  }
}

function instructions(agent) {
  if (agent.id === 'codex') return 'Restart Codex, authenticate with codex mcp login in_parallel, then review and trust the In Parallel hooks in /hooks. Start a new thread.'
  if (agent.id === 'claude') return 'Restart Claude Code and authenticate In Parallel through /mcp. Check its hooks with /hooks.'
  return 'Reload Cursor, then check In Parallel in Customize and authenticate MCP. Local plugin imports must be allowed; an installed marketplace copy takes precedence.'
}

function install(agent, url, { home, source, cwd, env, execute = run, dryRun = false, log = console.log, replace = [] } = {}) {
  url = endpoint(url)
  preflightMcp(agent, url, { home, cwd, env, source })
  const root = target(agent, home)
  const state = preflight(agent, root, execute, replace)
  const prepared = bundle(agent, url, source)
  if (dryRun) {
    log(`Would install ${agent.name} for this user at ${root}\nMCP: ${prepared.receipt.endpoint}`)
    if (state.replacements.length) log(`Would remove ${state.replacements.join(', ')} after verifying the new installation.`)
    return
  }
  writeBundle(root, prepared.files, agent)
  if (agent.command) {
    if (!state.registered) execute(agent.command, ['plugin', 'marketplace', 'add', root])
    if (agent.id === 'claude') {
      execute('claude', ['plugin', 'marketplace', 'update', MARKETPLACE])
      execute('claude', ['plugin', state.installed ? 'update' : 'install', PLUGIN, '--scope', 'user'])
    } else execute('codex', ['plugin', 'add', PLUGIN])
    const result = inventory(agent, execute).plugins.find(plugin => pluginId(plugin) === PLUGIN)
    if (!result || result.version !== prepared.receipt.version || result.enabled !== true) {
      throw new Error(`${agent.name} did not report the expected enabled plugin version. Files are prepared at ${root}; rerun setup after checking the client.`)
    }
    // Native registration alone does not establish a usable MCP configuration.
    // Keep the previous plugin available when discovery or endpoint checks fail.
    verifyMcp(agent, prepared.receipt.endpoint, execute)
    for (const id of state.replacements) {
      execute(agent.command, ['plugin', agent.id === 'codex' ? 'remove' : 'uninstall', id,
        ...(agent.id === 'claude' ? ['--scope', 'user', '--keep-data'] : [])])
    }
    if (state.replacements.length) {
      const remaining = inventory(agent, execute).plugins.filter(plugin => pluginId(plugin).split('@')[0] === 'in-parallel')
      if (remaining.length !== 1 || pluginId(remaining[0]) !== PLUGIN ||
          remaining[0].version !== prepared.receipt.version || remaining[0].enabled !== true) {
        throw new Error(`${agent.name}: replacement could not be verified. Run setup again to finish; do not activate duplicate copies.`)
      }
    }
  }
  log(`${agent.name}: ${agent.command ? 'installed' : 'files prepared'} at ${root}\n${instructions(agent)}\nThen ask your agent: Verify my In Parallel work journal setup. Use real work only.`)
}

function uninstall(agent, { home, execute = run, dryRun = false, log = console.log } = {}) {
  const root = target(agent, home)
  const state = preflight(agent, root, execute)
  if (!state.receipt) { log(`${agent.name}: no setup-managed installation.`); return }
  if (dryRun) { log(`Would remove the setup-managed ${agent.name} installation at ${root}`); return }
  if (state.installed) execute(agent.command, ['plugin', agent.id === 'codex' ? 'remove' : 'uninstall', PLUGIN,
    ...(agent.id === 'claude' ? ['--scope', 'user'] : [])])
  if (state.registered) execute(agent.command, ['plugin', 'marketplace', 'remove', MARKETPLACE])
  fs.rmSync(root, { recursive: true })
  log(`${agent.name}: removed. Existing work-claim history and other plugins were preserved.`)
}

function doctor(agent, { home, cwd, env, source, execute = run, log = console.log } = {}) {
  const root = target(agent, home)
  const receipt = managed(root, agent)
  if (!receipt) { log(`${agent.name}: no setup-managed installation.`); return }
  preflightMcp(agent, receipt.endpoint, { home, cwd, env, source })
  if (agent.command) {
    const { installed, registered } = preflight(agent, root, execute)
    if (!registered) throw new Error(`${agent.name}: setup marketplace is not registered. Run setup again.`)
    if (!installed || installed.version !== receipt.version || installed.enabled !== true) throw new Error(`${agent.name}: prepared files do not match an enabled native installation. Run setup again.`)
  }
  verifyMcp(agent, receipt.endpoint, execute)
  if (fs.existsSync(path.join(home || os.homedir(), '.in-parallel', 'contributions.lock'))) {
    log(`${agent.name}: local journal cache lock exists; a writer may be active. If busy errors persist, stop all agent clients and confirm hook processes have exited before removing only ~/.in-parallel/contributions.lock. Keep contributions.json to preserve ownership and delayed-reply protection. Then check known work with get_work before reporting again.`)
  }
  activationStatus(agent, receipt, home, log)
  log(`${agent.name}: files verified${agent.command ? '; native registration verified' : '; runtime discovery needs verification'}.\nMCP: ${receipt.endpoint}${agent.id === 'codex' ? ' (enabled connection configuration verified; authentication not checked)' : ' (included in the user plugin; user/current-project conflict checks passed, runtime connection not checked)'}\nTo verify activation, ask your agent: Verify my In Parallel work journal setup. Use real work only; do not create a test contribution.\n${instructions(agent)}`)
}

function activationStatus(agent, receipt, home = os.homedir(), log = console.log) {
  let sessions = []
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, '.in-parallel', 'contributions.json'), 'utf8'))
    sessions = Object.values(state.activation || {}).filter(item => item.client === agent.id && item.endpoint === receipt.endpoint && item.version === receipt.version)
  } catch (error) {
    if (error.code !== 'ENOENT') log(`${agent.name}: activation history unavailable; local state was preserved.`)
  }
  const complete = sessions.filter(item => item.context_at && item.read_at && item.report_at)
    .sort((a, b) => Date.parse(b.report_at) - Date.parse(a.report_at))[0]
  if (complete) log(`${agent.name}: context delivered, timeline read succeeded, and a work report was remembered in the same session. Last report: ${complete.report_at}. This records a past check; it does not verify current authentication.`)
  else log(`${agent.name}: activation pending. Confirm available tools and session context in the client, then read get_work after your next real contribution report. Run doctor again; no synthetic journal entry is needed.`)
}

module.exports = { AGENTS, SOURCE, MARKETPLACE, PLUGIN, RECEIPT, ReplacementRequired, endpoint, target, bundle, managed, install, uninstall, doctor }
