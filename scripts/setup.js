#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const setup = require('./setup-lib')

async function main(args = process.argv.slice(2), {
  prompts, home, cwd, env, interactive = process.stdin.isTTY && process.stdout.isTTY, operations = setup,
} = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('In Parallel setup\n\n  in-parallel             Choose agents and install interactively\n  in-parallel --dry-run   Preview an interactive installation\n  in-parallel doctor      Check setup-managed installations\n  in-parallel uninstall   Choose agents to remove interactively\n\nFrom a checkout: node scripts/setup.js [command]\nInstalls for your user. Node 20.12+ required; Claude Code and Codex CLI need their CLIs on PATH.\nClaude Desktop Chat/Cowork and ChatGPT: use the app plugin browser; see README.md.\nBuild uploadable bundles: node scripts/package.js --help')
    return 0
  }
  const actions = args.filter(arg => !arg.startsWith('-'))
  const action = actions[0] || 'setup'
  if (actions.length > 1 || !['setup', 'doctor', 'uninstall'].includes(action) ||
      args.some(arg => !['setup', 'doctor', 'uninstall', '--dry-run'].includes(arg))) {
    throw new Error('Unknown argument. Run with --help; agent selection is interactive.')
  }
  const dryRun = args.includes('--dry-run')
  let status = 0
  let skipped = 0
  if (action === 'doctor') {
    for (const agent of setup.AGENTS) {
      try { operations.doctor(agent, { home, cwd, env }) } catch (error) { console.error(`${agent.name}: ${error.message}`); status = 1 }
    }
    return status
  }
  if (!interactive) throw new Error('Run setup in an interactive terminal to select agents. Use --help for commands.')
  const ui = prompts || await import('@clack/prompts')
  ui.intro('In Parallel')
  const selected = await ui.multiselect({
    message: action === 'uninstall' ? 'Remove from which agents?' : 'Install or update for which agents?',
    options: setup.AGENTS.map(agent => ({ value: agent.id, label: agent.name,
      hint: agent.command ? `${agent.command} CLI required` : 'local plugin; reload Cursor' })),
    required: true,
  })
  if (ui.isCancel(selected)) { ui.cancel('Cancelled. No changes made.'); return 130 }
  const agents = setup.AGENTS.filter(agent => selected.includes(agent.id))
  if (!agents.length) throw new Error('Select at least one agent.')
  let url
  if (action === 'setup') {
    const existing = agents.flatMap(agent => {
      // Invalid installations are reported per agent below so other selections can proceed.
      try { return setup.managed(setup.target(agent, home), agent)?.endpoint || [] } catch { return [] }
    })
    const production = JSON.parse(fs.readFileSync(path.join(setup.SOURCE, 'mcp.json'))).mcpServers.in_parallel.url
    const defaultUrl = existing.length && new Set(existing).size === 1 ? existing[0] : production
    const environments = [
      { value: production, label: 'Production', hint: production },
      { value: 'https://www.in-parallel.dev/mcp', label: 'Development', hint: 'https://www.in-parallel.dev/mcp' },
      { value: 'custom', label: 'Custom', hint: 'Localhost or another server' },
    ]
    const initialValue = environments.some(option => option.value === defaultUrl) ? defaultUrl : 'custom'
    const environment = await ui.select({
      message: 'Which In Parallel environment?', options: environments, initialValue,
    })
    if (ui.isCancel(environment)) { ui.cancel('Cancelled. No changes made.'); return 130 }
    if (environment === 'custom') {
      const customDefault = initialValue === 'custom' ? defaultUrl : undefined
      const answer = await ui.text({
        message: 'Custom MCP URL', placeholder: customDefault || 'http://localhost:54104/mcp', defaultValue: customDefault,
        validate(value) {
          try { setup.endpoint(value || customDefault) } catch { return 'Enter an HTTPS MCP URL, or HTTP on localhost, without credentials, query parameters, or a fragment.' }
        },
      })
      if (ui.isCancel(answer)) { ui.cancel('Cancelled. No changes made.'); return 130 }
      url = setup.endpoint(answer || customDefault)
    } else url = setup.endpoint(environment)
  }
  for (const agent of agents) {
    try {
      const options = { home, cwd, env, dryRun, log: line => ui.log.success(line) }
      if (action === 'uninstall') operations.uninstall(agent, options)
      else {
        try { operations.install(agent, url, options) } catch (error) {
          if (!(error instanceof setup.ReplacementRequired)) throw error
          const replace = await ui.confirm({
            message: `${agent.name}: Replace ${error.plugins.join(', ')} with the setup-managed plugin at ${url}?`,
            initialValue: true,
          })
          if (ui.isCancel(replace)) { ui.cancel('Cancelled. Any previously completed installations were kept.'); return 130 }
          if (!replace) { ui.log.info(`${agent.name}: skipped; existing installation kept.`); skipped++; continue }
          operations.install(agent, url, { ...options, replace: error.plugins })
        }
      }
    } catch (error) { ui.log.error(`${agent.name}: ${error.message}`); status = 1 }
  }
  ui.outro(status ? 'Some agents need attention. Fix the errors above and run setup again.'
    : dryRun ? 'Preview complete. No changes made.' : skipped === agents.length ? 'No installations changed.'
      : action === 'uninstall' ? 'Selected integrations removed.' : 'Setup complete. Follow the client steps above to activate hooks and sign in.')
  return status
}

if (require.main === module) main().then(code => { process.exitCode = code }).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})

module.exports = { main }
