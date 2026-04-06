# Obsidian Vault Sync Companion

An Obsidian desktop plugin for a simple two-computer Git workflow.

## What it does

- Pulls the latest changes automatically when Obsidian starts.
- Shows vault Git status inside Obsidian.
- Lets you manually run pull, commit, and push commands from the UI.
- Can attempt an automatic background commit and push when Obsidian closes on Windows.

## Included files

- `main.js`
- `manifest.json`
- `styles.css`
- `versions.json`

## Recommended workflow

1. Open Obsidian and let the plugin pull the latest changes.
2. Work normally in your vault.
3. Use `Vault Sync: Save and push` before switching to another device.
4. Optionally enable auto-sync on close in plugin settings.

## Notes

- The close-sync behavior is best effort.
- If Git reports a rebase or merge conflict, resolve it in your terminal first.
- This plugin is intended for local desktop vaults managed with Git.
- The plugin treats its own `.obsidian/plugins/vault-sync-companion/data.json` settings file as local-only state so it does not keep blocking syncs between computers.
