import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FigmaSelection } from '../types'
import { bandText, chipText, contextText, signature } from './format'

const PLUGIN = 'tether'
const POLL_MS = 1000
const RESPAWN_EVERY_MS = 30_000
// How often to ask the bridge whether an update is out (it asks GitHub itself,
// at most twice a day).
const HEALTH_EVERY_POLLS = 60

type UpdateStatus = { current: string; latest: string | null; available: boolean }
type Health = { version: string | null; update: UpdateStatus | null }

// Bump the shape when FigmaSelection's fields change, so a stored value from
// an older version is declined instead of misread.
const current = atom({ plugin: 'tether', key: 'current' } as const, null, { shape: 'selection-2' })
const lastSent = atom({ plugin: 'tether', key: 'lastSent' } as const, null)

async function dirOf($: EngineInterface): Promise<string> {
  return `${(await $.env.get('HOME')) ?? ''}/.tether`
}

// Asks the bridge for the live selection; null when nothing is selected,
// the plugin is closed, or the bridge is down (`isUp` tells which).
async function fetchSelection($: EngineInterface): Promise<{ isUp: boolean; selection: FigmaSelection | null }> {
  try {
    const res = await $.http.fetch('http://bridge/selection', { socketPath: `${await dirOf($)}/bridge.sock` })
    if (!res.ok) return { isUp: false, selection: null }
    const { selection } = JSON.parse(res.text) as { selection: FigmaSelection | null }
    return { isUp: true, selection: selection && selection.count > 0 ? selection : null }
  } catch {
    return { isUp: false, selection: null }
  }
}

// Starts the shared bridge detached, so it outlives this session and serves
// the others. A second copy exits on its own if one is already running.
async function startBridge($: EngineInterface): Promise<void> {
  const dir = await dirOf($)
  await $.process
    .run(
      ['/bin/sh', '-c', 'mkdir -p "$2" && chmod 700 "$2" && nohup node "$1" >>"$2/bridge.log" 2>&1 </dev/null &', 'sh', `${$.plugin.root}/bridge/daemon.mjs`, dir],
      { timeoutMs: 5000 },
    )
    .catch(err => $.ui.log(`${PLUGIN}: could not start the bridge: ${String(err)}`, { to: 'debug' }))
}

async function ownVersion($: EngineInterface): Promise<string | null> {
  try {
    return (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

async function bridgeCall($: EngineInterface, path: string, method = 'GET'): Promise<unknown> {
  const res = await $.http.fetch(`http://bridge${path}`, { method, socketPath: `${await dirOf($)}/bridge.sock` })
  if (!res.ok) throw new Error(`bridge ${path}: ${res.status}`)
  return JSON.parse(res.text)
}

async function fetchHealth($: EngineInterface): Promise<Health | null> {
  try {
    const { version, update } = (await bridgeCall($, '/health')) as Partial<Health>
    return { version: version ?? null, update: update ?? null }
  } catch {
    return null
  }
}

// A bridge left running by an older (or newer) install serves the wrong Figma
// plugin files and update status. Ask it to exit, and start ours.
async function replaceStaleBridge($: EngineInterface, health: Health): Promise<boolean> {
  const mine = await ownVersion($)
  if (!mine || health.version === mine) return false
  await bridgeCall($, '/shutdown', 'POST').catch(() => undefined)
  await $.clock.sleep(300)
  await startBridge($)
  return true
}

export function updateNotice(update: UpdateStatus | null): string | undefined {
  if (!update?.available || !update.latest) return undefined
  return `Tether ${update.latest} is out (you have ${update.current}). Run /plugin marketplace update tether, then /plugin update tether and restart.`
}

// Once per new version, not once per session.
async function noticeUpdate($: EngineInterface, health: Health | null): Promise<void> {
  const text = updateNotice(health?.update ?? null)
  if (!text) return
  const latest = health?.update?.latest
  if ((await $.store.get('notifiedVersion')) === latest) return
  await $.store.set('notifiedVersion', latest)
  $.ui.toast(text, { timeoutMs: 12_000 })
}

async function checkBridge($: EngineInterface): Promise<void> {
  const health = await fetchHealth($)
  if (!health) return
  if (await replaceStaleBridge($, health)) return
  await noticeUpdate($, health)
}

async function refresh($: EngineInterface): Promise<{ isUp: boolean; selection: FigmaSelection | null }> {
  const result = await fetchSelection($)
  const sel = result.selection
  // Writing an unchanged value would redraw for nothing every second.
  await update($, current, prev => (JSON.stringify(prev) === JSON.stringify(sel) ? prev : sel))
  if (!sel) await update($, lastSent, () => null)
  return result
}

export const register: Register = on => {
  let lastSpawn = -Infinity

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Earlier versions pinned a footer status line; clear any left behind.
    $.ui.status(undefined)
    await $.command.register({
      name: 'tether-pair',
      description: 'Pair the Tether Figma plugin with this machine',
    })
    await $.command.register({
      name: 'tether-updates',
      description: 'Turn the daily check for new Tether versions on or off',
      argumentHint: 'on | off',
    })

    void (async () => {
      if (!(await refresh($)).isUp) {
        lastSpawn = await $.clock.now()
        await startBridge($)
      }
      await checkBridge($)
      let polls = 0
      $.clock.every(POLL_MS, async () => {
        if (++polls % HEALTH_EVERY_POLLS === 0) await checkBridge($)
        const { isUp } = await refresh($)
        const now = await $.clock.now()
        if (!isUp && now - lastSpawn > RESPAWN_EVERY_MS) {
          lastSpawn = now
          await startBridge($)
        }
      })
    })()

    return started
  })

  on('command.run', { command: 'tether-pair' }, async $ => {
    const dir = await dirOf($)
    if (!(await fetchSelection($)).isUp) {
      await startBridge($)
      await $.clock.sleep(800)
    }
    const token = (await $.fs.read(`${dir}/token`).catch(() => '')).toString().trim()
    if (!/^[0-9a-f]{32}$/.test(token)) {
      return { text: `The bridge has not written a token yet. Check ${dir}/bridge.log, or start it by hand with: node "${$.plugin.root}/bridge/daemon.mjs"` }
    }
    return {
      text: [
        `Pairing token: ${token}`,
        '',
        'First time only, in the Figma desktop app: Plugins → Development → Import plugin from manifest…, and pick',
        `  ${dir}/figma-plugin/manifest.json`,
        '(This folder stays put across Tether updates, so the import keeps working.)',
        'Then run Plugins → Development → Tether, paste the token and press Pair.',
        '',
        `Pair once per machine. To revoke it, delete ${dir}/token and restart the bridge.`,
      ].join('\n'),
    }
  })

  on('command.run', { command: 'tether-updates' }, async ($, e) => {
    const file = `${await dirOf($)}/update-check`
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await $.fs.write(file, `${arg}\n`)
      return {
        text: arg === 'off'
          ? 'Tether will no longer check GitHub for new versions.'
          : 'Tether will check GitHub for new versions about twice a day. It sends nothing about you or your files.',
      }
    }
    const current = (await $.fs.read(file).catch(() => '')).toString().trim()
    return { text: `Update checks are ${current === 'off' ? 'off' : 'on'}. Use /tether-updates on or /tether-updates off.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)

    // Read fresh rather than trusting the last poll: the click may be newer.
    const { selection } = await refresh($)
    if (!selection) return next(e)

    const sig = signature(selection)
    if ((await read($, lastSent)) === sig) return next(e)

    await update($, lastSent, () => sig)
    return next({ ...e, context: [...(e.context ?? []), contextText(selection)] })
    // A bridge hiccup must never stop the prompt: send it on without context.
  }).catch(($, e, next) => next(e))

  // Fullscreen layout: a chip beside the prompt, like a branch name.
  on('ui.render', { component: 'BesidePrompt' }, async ($, e, next) => {
    const sel = await read($, current)
    const text = sel && chipText(sel, e.props.maxColumns)
    if (!text) return next(e)

    const { Text } = $.ui.resolve(e)
    return <Text color="magenta">{text}</Text>
  })

  // Everywhere the chip is not drawn (the main-screen layout, VS Code,
  // mobile): a quiet row above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const sel = await read($, current)
    const hasChip = e.viewport?.isFullscreen === true && (e.surface === 'terminal' || e.surface === 'desktop')
    if (!sel || hasChip || e.props.hasSurvey) return next(e)

    const { Text } = $.ui.resolve(e)
    return <Text dimColor wrap="truncate-end">{bandText(sel)}</Text>
  })
}
