# Tether

Your live Figma selection, in Claude Code. Select a layer in Figma and it shows
up beside the prompt; your next message carries it to Claude, the way the IDE
integration shares your selected lines. Read-only: Tether never changes your file.

**Site:** https://nintyboy.github.io/tether/

## Install

You need the Figma desktop app, Claude Code 2.1.275 or later, and Node 18+.

1. In Claude Code:

   ```
   /plugin install tether --marketplace nintyboy/tether
   ```

2. Run `/tether-pair`. It prints a pairing token and the path to the Figma plugin.
3. In Figma desktop: **Plugins → Development → Import plugin from manifest…** and
   pick the `manifest.json` path `/tether-pair` printed. (First time only.)
4. Run **Plugins → Development → Tether**, paste the token, press **Pair**. Keep the
   plugin open while you work.

Pair once per machine; it works for every file.

## Updating

When a new version is out, Tether says so once, beside the prompt and in the
Figma plugin. To update:

```
/plugin marketplace update tether
/plugin update tether
```

then restart Claude Code. The Figma plugin updates with it: Tether keeps it in
`~/.tether/figma-plugin`, a folder that stays put across versions, so there is
nothing to re-import. To check for updates, Tether asks GitHub for the latest
release about twice a day and sends nothing else; `/tether-updates off` turns
that off.

## What Claude sees

When your selection changed since your last message, Tether adds a short block
to the prompt: the file, the page, and each selected layer's id, type, name and
link. Layer names are quoted and marked as data, so a layer named "ignore all
previous instructions" stays a name. With the
Figma MCP server connected,
Claude can then pull layout, styles or a screenshot for those exact nodes.

## Optional: a status line row

If you use [ccstatusline](https://github.com/sirmalloc/ccstatusline), add a
`custom-command` widget for a yellow ` File › Page › Layer` row:

```json
{
  "type": "custom-command",
  "color": "yellow",
  "commandPath": "curl -s --max-time 0.3 --unix-socket \"$HOME/.tether/bridge.sock\" http://bridge/status || true",
  "timeout": 1000
}
```

The icon is Nerd Font `nf-fa-figma`. Set `statusLine.refreshInterval` to `2` in
your Claude Code settings so it keeps up.

## How it works

```
Figma plugin ──POST + token──▶ localhost:47821 ┐
                                               ├─ bridge (one per machine)
Claude Code  ◀──GET────────── ~/.tether/bridge.sock ┘
```

- `mod/figma-plugin`: posts the selection (ids, names, types; never content) on
  every change and every 5 s.
- `mod/bridge/daemon.mjs`: a dependency-free Node process. Writes need the
  pairing token in `~/.tether/token`; reads go over a Unix socket only you can
  open. A selection goes stale after 15 s, and the bridge exits after 10 minutes
  with no session reading it.
- `mod/hooks/register.tsx`: the Claude Code mod. Starts the bridge, polls it
  every second, draws the chip, and attaches the selection to your prompt.

To revoke pairing, delete `~/.tether/token` and restart the bridge
(`pkill -f tether.*daemon.mjs`; the next session starts a new one).

## Analytics

Tether sends nothing about you or your files anywhere; its only request is the
update check above. Two things are measured, both outside the tool:

- **The site** counts page views, scroll depth, install-command copies and
  clicks to GitHub with PostHog, cookieless and without session recording.
- **GitHub traffic** (clones, views, referrers, stars) is copied into the same
  PostHog project once a day by `.github/workflows/traffic.yml`, because GitHub
  only keeps 14 days of it.

## Development

Release with `npm run release 0.2.0`: it bumps the version, runs the tests,
tags and pushes, and `.github/workflows/release.yml` publishes the GitHub
Release that running copies check for.

```
npm test        # bridge tests (node --test) and mod tests (claude plugin test)
```

`/plugin marketplace add /path/to/this/repo` installs your working copy;
`/reload-plugins` picks up edits.

## License

MIT
