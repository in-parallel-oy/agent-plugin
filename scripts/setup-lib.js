'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const AGENTS = [
  { id: 'claude', name: 'Claude Code', command: 'claude' },
  { id: 'codex', name: 'Codex', command: 'codex' },
  { id: 'cursor', name: 'Cursor', command: null },
]
const SOURCE = path.resolve(__dirname, '..')
const PRODUCTION = JSON.parse(fs.readFileSync(path.join(SOURCE, 'mcp.json'), 'utf8')).mcpServers.in_parallel.url
// Features the server still gates per company. Store listings ship without
// them; setup adds each experimental/<feature> folder for the Development environment only:
// its skills, and its hooks/<agent>.json with its scripts where that client has hooks.
const EXPERIMENTAL = ['agent-work']
// A local server runs the newest code, so it gets them too.
const DEVELOPMENT_HOSTS = ['www.in-parallel.dev', 'in-parallel.dev', 'localhost', '127.0.0.1', '[::1]']
// Receipts without an experimental list predate it and installed the retired work journal.
const RETIRED = ['work-claims']
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
  try {
    if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f]/.test(value)) throw new Error()
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error()
    return url.href
  } catch {
    throw new Error('Use an HTTPS MCP URL without credentials, query parameters, or a fragment. HTTP is allowed for localhost.')
  }
}

const experimentalFor = url => DEVELOPMENT_HOSTS.includes(new URL(endpoint(url)).hostname) ? EXPERIMENTAL : []

// The retired work journal's local cache. setup/ beside it holds managed installs.
function removeJournalCache(home = os.homedir(), log = console.log) {
  const dir = path.join(home, '.in-parallel')
  let names = []
  try { names = fs.readdirSync(dir) } catch {}
  const stale = names.filter(name => /^(contributions\.(json|lock)|contributions\.json\..+\.tmp|sessions|lock-.+)$/.test(name))
  for (const name of stale) fs.rmSync(path.join(dir, name), { recursive: true, force: true })
  if (stale.length) log(`Removed the retired work journal cache from ${dir}.`)
}

// Resolve a URL from the user's own client MCP configuration the way that client
// documents, so setup can compare it with the selected endpoint. Looks up only
// the variables that configuration names. A set-but-empty Claude variable stays
// empty: only an unset variable uses its fallback.
function expandEndpoint(value, client, env) {
  return value.replace(/\$\{([^}]+)\}/g, (_match, variable) => {
    if (client === 'claude') {
      const [key, fallback] = variable.split(/:-(.*)/s)
      if (env[key] !== undefined) return env[key]
      if (fallback !== undefined) return fallback
    } else if (client === 'cursor' && variable.startsWith('env:') && env[variable.slice(4)] !== undefined) {
      return env[variable.slice(4)]
    }
    throw new Error('Unresolved In Parallel endpoint variable')
  })
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
  const changed = Object.keys(files).filter(name => name in receipt.files && receipt.files[name] !== digest(files[name]))
  const added = Object.keys(files).filter(name => !(name in receipt.files))
  const missing = Object.keys(receipt.files).filter(name => !(name in files))
  if (changed.length || added.length || missing.length) {
    // A large tree dropped into the folder would otherwise name every file, on every doctor run.
    const names = list => list.slice(0, 10).join(', ') + (list.length > 10 ? ` and ${list.length - 10} more` : '')
    const list = [['changed', changed], ['added', added], ['missing', missing]]
      .filter(([, names]) => names.length).map(([kind, files]) => `${kind}: ${names(files)}`).join('; ')
    throw new Error(`Installed files were changed in ${root} (${list}).${credentials(root, changed)} Preserve your changes before updating or removing this copy.`)
  }
  return receipt
}

// A changed MCP config that gained an Authorization header holds a credential: say so, never print it.
function credentials(root, changed) {
  const authorized = value => value && typeof value === 'object' &&
    Object.entries(value).some(([key, inner]) => /^authorization$/i.test(key) || authorized(inner))
  const files = changed.filter(name => ['.mcp.json', 'mcp.json'].includes(path.basename(name))).filter(name => {
    try { return authorized(JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))) } catch { return false }
  })
  return files.length ? ` A credential header (Authorization) was added to ${files.join(', ')}; its value is not printed.` : ''
}

// The receipt as written, without checking the files: what doctor still lists against
// when the files changed.
function readReceipt(root, agent) {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(root, RECEIPT), 'utf8'))
    return receipt?.format === 1 && receipt.agent === agent.id && receipt.files && typeof receipt.endpoint === 'string' ? receipt : null
  } catch { return null }
}

function target(agent, home = os.homedir()) {
  return agent.id === 'cursor'
    ? path.join(home, '.cursor', 'plugins', 'local', 'in-parallel')
    : path.join(home, '.in-parallel', 'setup', agent.id)
}

// Setup never passes experimental; scripts/e2e-bundle.js does, for a loopback endpoint.
function bundle(agent, url, source = SOURCE, experimental = experimentalFor(url)) {
  const files = {}
  const prefix = agent.id === 'cursor' ? '' : 'plugins/in-parallel/'
  const manifestPath = `.${agent.id}-plugin/plugin.json`
  const manifest = JSON.parse(fs.readFileSync(path.join(source, manifestPath)))
  for (const root of ['', ...experimental.map(feature => path.join('experimental', feature))]) {
    for (const [name, content] of Object.entries(tree(path.join(source, root, 'skills')))) files[`${prefix}skills/${name}`] = content
    const hooks = path.join(source, root, 'hooks', `${agent.id}.json`)
    if (!root || !fs.existsSync(hooks)) continue
    if (manifest.hooks) throw new Error(`Only one experimental feature can add ${agent.name} hooks.`)
    manifest.hooks = `./hooks/${agent.id}.json`
    files[`${prefix}hooks/${agent.id}.json`] = fs.readFileSync(hooks)
    for (const [name, content] of Object.entries(tree(path.join(source, root, 'scripts')))) files[`${prefix}scripts/${name}`] = content
  }
  for (const name of ['LICENSE', 'NOTICE']) files[`${prefix}${name}`] = fs.readFileSync(path.join(source, name))
  // The Codex manifest's interface icons point at ./assets/logo.png.
  if (agent.id === 'codex') files[`${prefix}assets/logo.png`] = fs.readFileSync(path.join(source, 'assets', 'logo.png'))
  // Write the literal endpoint, including for Claude. Never alter the source checkout.
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
      metadata: { description: `In Parallel skills${manifest.hooks ? ', hooks' : ''} and MCP configured by interactive setup.` },
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
  const receipt = { format: 1, agent: agent.id, endpoint: endpoint(url), version: manifest.version, experimental,
    files: Object.fromEntries(Object.entries(sorted).map(([name, content]) => [name, digest(content)])) }
  return { files: { ...sorted, [RECEIPT]: json(receipt) }, receipt }
}

function writeBundle(root, files, agent, expected = null) {
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
    // Compare and swap: the copy being replaced must still be the one preflight checked.
    if (JSON.stringify(managed(root, agent)) !== JSON.stringify(expected)) {
      throw new Error(`${root} changed while setup was running. Nothing was replaced; run setup again.`)
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

// Setup acts on the user scope only. A copy at project or local scope belongs to
// that project: report it with the one command that removes it, never touch it.
// conflict: false when no setup-managed copy competes with it, so it can stay.
function projectScope(plugin, cwd, conflict = true) {
  const scope = plugin.scope || 'project'
  const dir = plugin.projectPath || cwd
  const keep = conflict ? 'changes only your user installation and leaves it in place' : 'does not need it removed; it can be left in place'
  return `Found ${pluginId(plugin)} installed at ${scope} scope for ${dir}. Setup did not install it and ${keep}. To remove it, run: cd ${JSON.stringify(dir)} && claude plugin uninstall ${pluginId(plugin)} --scope ${scope}`
}

// The client's In Parallel copies and the setup marketplace, from its own inventory.
function survey(agent, root, execute, receipt) {
  const state = inventory(agent, execute)
  const existing = state.plugins.filter(plugin => pluginId(plugin).split('@')[0] === 'in-parallel')
  const foreign = existing.filter(plugin => !receipt || pluginId(plugin) !== PLUGIN ||
    (agent.id === 'claude' && plugin.scope !== 'user'))
  const market = state.marketplaces.find(item => item.name === MARKETPLACE)
  let elsewhere = false
  if (market && receipt) {
    const location = agent.id === 'codex' ? market.root : market.path
    try { elsewhere = fs.realpathSync(location) !== fs.realpathSync(root) } catch { elsewhere = true }
  }
  return { receipt, existing, foreign, market, elsewhere,
    installed: receipt ? existing.find(plugin => pluginId(plugin) === PLUGIN && (agent.id !== 'claude' || plugin.scope === 'user')) : undefined,
    registered: Boolean(market && receipt), replacements: foreign.map(pluginId) }
}

const elsewhereError = agent => new Error(`The ${MARKETPLACE} marketplace points elsewhere in ${agent.name}; refusing to change it.`)

// keep: report other copies instead of refusing, for uninstall.
function preflight(agent, root, execute = run, replace = [], { cwd = process.cwd(), keep = false } = {}) {
  const receipt = managed(root, agent)
  const state = survey(agent, root, execute, receipt)
  const { existing, foreign, market, replacements } = state
  const project = foreign.find(plugin => agent.id === 'claude' && plugin.scope !== 'user')
  if (project && !keep) throw new Error(projectScope(project, cwd))
  if (market && !receipt && !keep) throw new Error(`The ${MARKETPLACE} marketplace already exists in ${agent.name}; refusing to replace it.`)
  if (state.elsewhere) throw elsewhereError(agent)
  if (!receipt && !keep && existing.some(plugin => pluginId(plugin) === PLUGIN)) {
    throw new Error(`Existing ${PLUGIN} has no setup receipt at ${root}. Remove that native installation before running setup again.`)
  }
  if (!keep && replacements.some(id => !replace.includes(id))) throw new ReplacementRequired(replacements)
  if (!keep && agent.id === 'claude' && replacements.length) {
    // Older clients can uninstall the same-named plugin from the wrong marketplace.
    const version = execute('claude', ['--version'], { capture: 'text' }).match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$)/)
    const [major, minor, patch] = version ? version.slice(1).map(Number) : []
    if (!version || major < 2 || (major === 2 && (minor < 1 || (minor === 1 && patch < 212)))) {
      throw new Error('Update Claude Code to 2.1.212 or newer before replacing a plugin from another marketplace. Existing installations were kept.')
    }
  }
  return state
}

// The folders a client reads project settings from: the current directory up to
// the project root (the nearest .git) or the home folder.
function projectFolders(home, cwd) {
  const folders = []
  for (let folder = path.resolve(cwd); ; folder = path.dirname(folder)) {
    folders.push(folder)
    if (folder === path.resolve(home) || fs.existsSync(path.join(folder, '.git')) || folder === path.dirname(folder)) break
  }
  return folders
}

// Inspect documented local files without connecting or reading CLI health output.
// Session-only flags, managed policy and other checkouts still need runtime verification.
// Returns every location checked: found, not found, or conflicting with a message.
// Without a url (no setup-managed copy) an entry is only found, not found or
// unreadable: a file setup never relied on is reported, not an error.
// report: list an unreadable file instead of throwing, so doctor shows every location first.
const UNREADABLE = Symbol('unreadable')

const UNVERIFIABLE = 'its URL is empty or not a plain HTTPS MCP URL (it has credentials, query parameters or a fragment), so setup cannot verify it'
const DIFFERENT = 'it points to a different server than the one setup installed'

// Why an in_parallel entry does not match the setup URL, without printing its URL or headers.
function mismatch(agent, server, url, env) {
  if (server.command) return 'it starts a local command instead of connecting to a URL'
  const transport = agent.id === 'claude' ? ['http', 'streamable-http'] : [undefined, 'http', 'streamable-http']
  if (!transport.includes(server.type)) return 'it is not an HTTP connection'
  let expanded
  try { expanded = expandEndpoint(String(server.url ?? ''), agent.id, env) } catch {
    return 'its URL uses a variable that is not set, so setup cannot tell which server it points to'
  }
  try { if (endpoint(expanded) === url) return null } catch { return UNVERIFIABLE }
  return DIFFERENT
}

function mcpLocations(agent, url, { home = os.homedir(), cwd = process.cwd(), env = process.env, source = SOURCE, report = false } = {}) {
  const folders = projectFolders(home, cwd)
  const unreadable = file => {
    if (!url || report) return UNREADABLE
    throw new Error(`Could not read MCP configuration at ${file}. Existing settings were preserved.`)
  }
  const text = file => {
    try { return fs.readFileSync(file, 'utf8') } catch (error) {
      return error.code === 'ENOENT' ? null : unreadable(file)
    }
  }
  const read = file => {
    const content = text(file)
    if (content === null) return {}
    if (content === UNREADABLE) return content
    try {
      const config = JSON.parse(content)
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid configuration')
      return config
    } catch {
      return unreadable(file)
    }
  }
  const check = (config, location) => {
    if (config === UNREADABLE) return { location, status: 'unreadable' }
    const servers = config?.mcpServers || {}
    if ('in-parallel' in servers) return { location, status: 'conflicting: a legacy entry named in-parallel', fix: true, message: `Legacy In Parallel MCP entry named in-parallel in ${location}. Rename it to in_parallel or remove it to use the plugin-provided connection, then rerun setup. Existing settings were preserved.` }
    const server = servers.in_parallel
    if (!server) return { location, status: 'not found' }
    const reason = url ? mismatch(agent, server, url, env) : null
    return !reason ? { location, status: 'found' } : { location, status: `conflicting: ${reason}`,
      message: `Conflicting In Parallel MCP entry in ${location}: ${reason}. It has the same name, in_parallel, as the connection the In Parallel plugin brings, so ${agent.name} may connect through this entry instead of the plugin's. Match it to the selected URL or remove that entry, then rerun setup. Existing settings were preserved; no URLs or credentials were printed.` }
  }
  const locations = []
  if (agent.id === 'claude') {
    const file = env.CLAUDE_CONFIG_DIR ? path.join(path.resolve(env.CLAUDE_CONFIG_DIR), '.claude.json') : path.join(home, '.claude.json')
    const config = read(file)
    locations.push(check(config, `${file} (user scope)`))
    for (const folder of folders) {
      locations.push(check(config === UNREADABLE ? config : config.projects?.[folder], `${file} (local scope for ${folder})`))
      const project = path.join(folder, '.mcp.json')
      // This checkout's file is the distribution template, rewritten by bundle().
      if (path.resolve(project) !== path.resolve(source, '.mcp.json')) locations.push(check(read(project), `${project} (project scope)`))
    }
  } else if (agent.id === 'cursor') {
    const personal = path.join(home, '.cursor', 'mcp.json')
    locations.push(check(read(personal), `${personal} (user scope)`))
    for (const folder of folders) {
      const project = path.join(folder, '.cursor', 'mcp.json')
      if (project !== personal) locations.push(check(read(project), `${project} (project scope)`))
    }
  } else {
    // Codex resolves these itself; verifyMcp asks it. Here only report what each file names.
    const personal = path.join(env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex'), 'config.toml')
    const files = [[personal, 'user scope'], ...folders.map(folder => [path.join(folder, '.codex', 'config.toml'), 'project scope'])]
    for (const [file, scope] of files.filter(([file], index) => index === 0 || file !== personal)) {
      const location = `${file} (${scope})`
      const content = text(file)
      if (content === UNREADABLE) { locations.push({ location, status: 'unreadable' }); continue }
      const sections = (content || '').split(/^\[/m)
      const table = sections.find(section => /^mcp_servers\.(["']?)in_parallel\1\]/.test(section))
      if (table === undefined) {
        // Dotted keys and inline tables name the server too; only the table form is parsed.
        const named = /^\s*mcp_servers\.(["']?)in_parallel\1\s*[.=]/m.test(sections[0]) ||
          sections.some(section => /^mcp_servers\]/.test(section) && /^\s*(["']?)in_parallel\1\s*[.=]/m.test(section))
        locations.push({ location, status: named ? 'present (not parsed)' : 'not found' })
        continue
      }
      const value = table.match(/^\s*url\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/m)
      if (!value) { locations.push({ location, status: url ? 'present (not parsed)' : 'found' }); continue }
      let reason = null
      if (url) try { if (endpoint(value[1] ?? value[2]) !== url) reason = DIFFERENT } catch { reason = UNVERIFIABLE }
      locations.push({ location, status: reason ? `conflicting: ${reason}` : 'found' })
    }
  }
  return locations
}

function preflightMcp(agent, url, options) {
  if (!['claude', 'cursor'].includes(agent.id)) return
  const conflict = mcpLocations(agent, url, options).find(location => location.message)
  if (conflict) throw new Error(conflict.message)
}

// Where the client registers plugins, from its own inventory: each copy with its
// scope, the project it belongs to and its files. With a setup-managed copy, any
// other In Parallel copy conflicts with it.
function registrationLocations(agent, root, state, cwd) {
  if (!agent.command) return [{ location: `${root} (user plugin folder)`, status: fs.existsSync(root) ? 'found' : 'not found' }]
  if (!state) return [{ location: `${agent.name} plugin registrations`, status: `not checked: the ${agent.command} CLI did not answer` }]
  const scopes = agent.id === 'claude' ? ['user', 'project', 'local'] : ['user']
  const project = plugin => path.resolve(plugin.projectPath || cwd)
  const describe = plugin => `${pluginId(plugin)}${plugin.installPath ? ` (files at ${plugin.installPath})` : ''}`
  const locations = []
  for (const scope of scopes) {
    const rows = state.existing.filter(plugin => (plugin.scope || 'user') === scope)
    // The current project is always listed; other projects only where a copy is installed.
    const folders = scope === 'user' ? [null] : [...new Set([path.resolve(cwd), ...rows.map(project)])]
    for (const folder of folders) {
      const here = folder ? rows.filter(plugin => project(plugin) === folder) : rows
      const location = `${agent.name} plugin registration (${scope} scope${folder ? ` for ${folder}` : ''})`
      if (!here.length) { locations.push({ location, status: 'not found' }); continue }
      const conflicting = state.receipt && here.some(plugin => state.foreign.includes(plugin))
      locations.push({ location, status: `${conflicting ? 'conflicting' : 'found'}: ${here.map(describe).join(', ')}` })
    }
  }
  locations.push({ location: `${agent.name} marketplace ${MARKETPLACE}`,
    status: !state.market ? 'not found' : state.receipt ? 'found' : 'conflicting: not created by this setup' })
  return locations
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

const hooked = receipt => Object.keys(receipt.files).some(name => /(^|\/)hooks\//.test(name))

function instructions(agent, hooks) {
  if (agent.id === 'codex') return `Restart Codex, authenticate with codex mcp login in_parallel${hooks ? ', then review and trust the In Parallel hooks in /hooks' : ''}. Start a new thread.`
  if (agent.id === 'claude') return `Restart Claude Code and authenticate In Parallel through /mcp.${hooks ? ' Check its hooks with /hooks.' : ''}`
  return 'Reload Cursor, then check In Parallel in Customize and authenticate MCP. Local plugin imports must be allowed; an installed marketplace copy takes precedence.'
}

const verify = experimental => `ask your agent: Check my In Parallel connection.${experimental.length ? '\nTo try reporting back, send an In Parallel To do to your agent with Send to AI, or pick one with the work-on command.' : ''}`

// What the experimental features installed, from the receipt's file list.
function features(receipt) {
  const names = Object.keys(receipt.files)
  const skills = [...new Set(names.map(name => name.match(/(?:^|\/)skills\/([^/]+)\//)?.[1]).filter(Boolean))]
  const commands = skills.filter(skill => skill === 'work-on')
  const lines = [`Experimental: ${receipt.experimental.join(', ')}`]
  if (commands.length) lines.push(`Commands: ${commands.join(', ')}`)
  lines.push(hooked(receipt) ? 'Reminder hooks: on prompts with an In Parallel link, after pull requests, and before stopping' : 'Reminder hooks: not available for this client')
  return lines.join('\n')
}

function install(agent, url, { home, source, cwd, env, execute = run, dryRun = false, log = console.log, replace = [] } = {}) {
  url = endpoint(url)
  preflightMcp(agent, url, { home, cwd, env, source })
  const root = target(agent, home)
  const state = preflight(agent, root, execute, replace, { cwd })
  const prepared = bundle(agent, url, source)
  if (dryRun) {
    log(`Would install ${agent.name} for this user at ${root}\nMCP: ${prepared.receipt.endpoint}`)
    if (state.replacements.length) log(`Would remove ${state.replacements.join(', ')} after verifying the new installation.`)
    return
  }
  writeBundle(root, prepared.files, agent, state.receipt)
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
        throw new Error(`Replacement could not be verified. Run setup again to finish; do not activate duplicate copies.`)
      }
    }
  }
  removeJournalCache(home, log)
  const { experimental } = prepared.receipt
  log(`${agent.name}: ${agent.command ? 'installed' : 'files prepared'} at ${root}${experimental.length ? `\n${features(prepared.receipt)}` : ''}\n${instructions(agent, hooked(prepared.receipt))}\nThen ${verify(experimental)}`)
}

function uninstall(agent, { home = os.homedir(), cwd, execute = run, dryRun = false, log = console.log } = {}) {
  const root = target(agent, home)
  const state = preflight(agent, root, execute, [], { cwd, keep: true })
  if (!dryRun) removeJournalCache(home, log)
  const kept = state.foreign.filter(plugin => !(state.receipt && pluginId(plugin) === PLUGIN && plugin.scope === 'user'))
    .map(plugin => agent.id === 'claude' && plugin.scope !== 'user'
      ? `${agent.name}: kept ${pluginId(plugin)}. ${projectScope(plugin, cwd || process.cwd(), false)}`
      : `${agent.name}: kept ${pluginId(plugin)}; setup did not install it.`)
  if (!state.receipt) { log([`${agent.name}: no setup-managed installation.`, ...kept].join('\n')); return }
  const names = [...Object.keys(state.receipt.files), RECEIPT]
  if (dryRun) {
    log([state.installed && `Would uninstall ${PLUGIN} from ${agent.name} (user scope)`,
      state.registered && `Would remove the ${MARKETPLACE} marketplace from ${agent.name}`,
      `Would back up and remove the ${names.length} files setup wrote at ${root}`, ...kept].filter(Boolean).join('\n'))
    return
  }
  const expected = { ...state.receipt.files, [RECEIPT]: digest(fs.readFileSync(path.join(root, RECEIPT))) }
  const backup = path.join(home, '.in-parallel', 'setup', 'backups', `${agent.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  const lines = []
  try {
    for (const name of names) {
      fs.mkdirSync(path.dirname(path.join(backup, name)), { recursive: true, mode: 0o700 })
      fs.copyFileSync(path.join(root, name), path.join(backup, name))
    }
    lines.push(`${agent.name}: backed up ${root} to ${backup}`)
    // Compare and swap: refuse if anything changed since preflight read it.
    if (JSON.stringify(managed(root, agent)) !== JSON.stringify(state.receipt)) throw new Error(`${root} changed while uninstall was running. Nothing was removed.`)
    if (state.installed) {
      execute(agent.command, ['plugin', agent.id === 'codex' ? 'remove' : 'uninstall', PLUGIN, ...(agent.id === 'claude' ? ['--scope', 'user'] : [])])
      lines.push(`${agent.name}: uninstalled ${PLUGIN} (user scope)`)
    }
    if (state.registered) {
      execute(agent.command, ['plugin', 'marketplace', 'remove', MARKETPLACE])
      lines.push(`${agent.name}: removed the ${MARKETPLACE} marketplace`)
    }
    for (const name of names) {
      const file = path.join(root, name)
      if (digest(fs.readFileSync(file)) !== expected[name]) {
        // The native registrations are gone, so neither setup nor uninstall can finish this copy.
        throw new Error(`${file} changed after uninstall checked it; it was kept and uninstall stopped. To finish, keep your changed file elsewhere, then delete ${root} by hand. ${backup} holds every file as setup wrote it.`)
      }
      fs.rmSync(file)
      lines.push(`${agent.name}: removed ${file}`)
    }
    // Remove the folders left empty; keep any holding files setup did not write.
    const prune = folder => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) if (entry.isDirectory()) prune(path.join(folder, entry.name))
      if (fs.readdirSync(folder).length) lines.push(`${agent.name}: kept ${folder}; it holds files setup did not write`)
      else fs.rmdirSync(folder)
    }
    prune(root)
    lines.push(...kept)
  } finally { if (lines.length) log(lines.join('\n')) }
}

const LAST_CHECK = home => path.join(home, '.in-parallel', 'setup', 'last-check.json')

function lastChecks(home) {
  try { return JSON.parse(fs.readFileSync(LAST_CHECK(home), 'utf8')) } catch { return {} }
}

function recordCheck(home, agent, error) {
  const checks = lastChecks(home)
  if (error) checks[agent.id] = { error, at: new Date().toISOString() }
  else if (checks[agent.id]) delete checks[agent.id]
  else return
  fs.mkdirSync(path.dirname(LAST_CHECK(home)), { recursive: true, mode: 0o700 })
  fs.writeFileSync(LAST_CHECK(home), json(checks), { mode: 0o600 })
}

// Doctor reports installed state: files, registrations and settings it can read.
// Whether In Parallel actually reaches the agent only the agent can check.
function doctor(agent, { home = os.homedir(), cwd = process.cwd(), env = process.env, source, execute = run, log = console.log } = {}) {
  removeJournalCache(home, log)
  const previous = lastChecks(home)[agent.id]
  try {
    diagnose(agent, { home, cwd, env, source, execute, log }, previous)
    recordCheck(home, agent, null)
  } catch (error) {
    recordCheck(home, agent, error.message)
    throw error
  }
}

// Every location is listed before the first error is thrown, so an error never hides them.
function diagnose(agent, { home, cwd, env, source, execute, log }, previous) {
  const root = target(agent, home)
  let failure = null
  let receipt = null
  // Changed files are an error, but the receipt still says what to list against.
  try { receipt = managed(root, agent) } catch (error) { failure = error; receipt = readReceipt(root, agent) }
  let state = null
  if (agent.command) {
    try { state = survey(agent, root, execute, receipt) } catch (error) { if (receipt) failure ||= error }
  }
  const locations = [...registrationLocations(agent, root, state, cwd), ...mcpLocations(agent, receipt?.endpoint, { home, cwd, env, source, report: true })]
  // Without a setup-managed copy, a project copy is reported here; with one, it is an error below.
  const notes = !receipt && agent.id === 'claude' && state
    ? state.existing.filter(plugin => plugin.scope && plugin.scope !== 'user').map(plugin => projectScope(plugin, cwd, false)) : []
  log([`${agent.name}: checked`, ...(receipt ? [`  Setup-managed MCP endpoint: ${receipt.endpoint}`] : []),
    ...locations.flatMap(({ location, status, fix, message }) => [`  ${location}: ${status}`, ...(fix ? [`    ${message}`] : [])]),
    ...notes.map(note => `  ${note}`)].join('\n'))
  if (failure) throw failure
  const lastFailure = previous ? `\nLast failed check: ${previous.at}: ${previous.error}` : ''
  if (!receipt) { log(`${agent.name}: no setup-managed installation.${lastFailure}`); return }
  if (state?.elsewhere) throw elsewhereError(agent)
  const installedFeatures = receipt.experimental || RETIRED
  if (installedFeatures.join() !== experimentalFor(receipt.endpoint).join()) {
    throw new Error(`Installed with ${installedFeatures.some(feature => RETIRED.includes(feature)) ? 'the retired work journal' : `experimental features that ${receipt.endpoint} no longer gets`}. Run setup again to update.`)
  }
  // Files added to the plugin since this copy was installed also need setup again.
  const missing = Object.keys(bundle(agent, receipt.endpoint, source).receipt.files)
    .filter(name => /(^|\/)(hooks|scripts)\/|(^|\/)skills\//.test(name))
    .some(name => !(name in receipt.files))
  if (missing) throw new Error('Installed with outdated files. Run setup again to update.')
  preflightMcp(agent, receipt.endpoint, { home, cwd, env, source })
  if (agent.command) {
    const { installed, registered, foreign } = state
    const project = foreign.find(plugin => agent.id === 'claude' && plugin.scope !== 'user')
    if (project) throw new Error(projectScope(project, cwd))
    if (foreign.length) throw new ReplacementRequired(foreign.map(pluginId))
    if (!registered) throw new Error('The setup marketplace is not registered. Run setup again.')
    if (!installed || installed.version !== receipt.version || installed.enabled !== true) throw new Error('Prepared files do not match an enabled native installation. Run setup again.')
  }
  verifyMcp(agent, receipt.endpoint, execute)
  log(`${agent.name} installed: files match the setup receipt${agent.command ? `; ${agent.name} reports version ${receipt.version} enabled` : '; Cursor discovers the folder when it reloads'}.\nMCP: ${receipt.endpoint}${agent.id === 'codex' ? ' (enabled connection configuration verified; authentication not checked)' : ' (included in the user plugin; no conflicting entry in the locations above; runtime connection not checked)'}${installedFeatures.length ? `\n${features(receipt)}` : ''}\n${agent.name} working: not verified by setup. To verify, ${verify(installedFeatures)}${lastFailure}\n${instructions(agent, hooked(receipt))}`)
}

module.exports = { AGENTS, SOURCE, PRODUCTION, EXPERIMENTAL, MARKETPLACE, PLUGIN, RECEIPT, ReplacementRequired, endpoint, target, bundle, managed, install, uninstall, doctor }
