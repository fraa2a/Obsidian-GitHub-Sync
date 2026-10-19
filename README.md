# Obsidian GitHub Sync

A lightweight desktop [Obsidian](https://obsidian.md/) plugin that commits your vault to a Git repository and synchronizes it with GitHub. Works with private or public repositories and HTTPS or SSH remotes.

## Installation

1. Open the [latest GitHub release](https://github.com/fraa2a/Obsidian-GitHub-Sync/releases/latest).
2. Download `main.js`, `manifest.json`, and `styles.css`.
3. Place these three files in `<your-vault>/.obsidian/plugins/github-sync/`.
4. Restart Obsidian, open **Settings > Community plugins**, and enable **GitHub Sync**.

When updating an existing installation, replace the same three files with those from the new release.

## Features

- Sync manually from the ribbon icon or the **Sync with Remote** command.
- Choose automatic sync every N minutes or after saving a file.
- Save mode also syncs when files or folders are created, renamed, or deleted.
- Group rapid file changes into a single sync (2 second debounce).
- Preserve empty vault folders in Git with `.gitkeep` placeholders.
- Include new files, dotfiles, and deletions when committing.
- Optionally check for remote changes and sync when Obsidian starts.
- Configure notice verbosity or hide successful sync notifications.

This plugin requires **Obsidian desktop** and a local Git installation. It uses the `main` branch and does not support selecting another branch.

## Setup

1. Install Git and configure authentication with GitHub. SSH keys or a credential manager are recommended.
2. Create an empty GitHub repository for your notes. A **private** repository is recommended for personal vaults.
3. Open a terminal in your vault folder and initialize Git if needed:

   ```bash
   git init
   git branch -M main
   git add --all
   git commit -m "Initial vault backup"
   git remote add origin git@github.com:USERNAME/REPOSITORY.git
   git push -u origin main
   ```

   If the vault is already a Git repository with a working remote, you can skip the initialization steps. Replace the example remote with your own HTTPS or SSH URL.
4. In **Obsidian Settings > Community plugins > GitHub Sync**, paste the repository URL in **Remote URL**.
5. Click the GitHub ribbon icon or run **Sync with Remote** from the command palette.

Git must be available on your system `PATH`. If it is not, configure **Git binary location** with the directory containing `git` or `git.exe`.

## Automatic sync

Under **Automatic sync mode**, choose one of the following:

| Mode | Behavior |
| --- | --- |
| **Disabled** | Sync only on command, ribbon click, or the optional startup sync. |
| **Every N minutes** | Syncs on a configurable timer while Obsidian is open. |
| **On file save** | Syncs after Obsidian reports a saved change, including creation, rename, and deletion events. |

The save mode waits 2 seconds after the most recent change before running. This reduces duplicate commits and network requests during bursts of edits. Changes made during an active sync trigger another pass afterward.

You can change modes without restarting Obsidian. Users upgrading from an older version keep their existing interval setting automatically.

Each sync stages local changes, commits them when needed, fetches and pulls from `origin/main`, then pushes to `origin/main`. A sync also retries pushing local commits left unpushed after a previous error.

## Empty folders

Git does not store empty directories. Before each sync, this plugin adds an empty `.gitkeep` file to any vault folder without other direct files, including a folder containing only subfolders.

Folders excluded by `.gitignore` are respected. Existing `.gitkeep` files are not deleted, even if a folder later gains files.

## Notifications and startup behavior

- **Notice level**: `ALL`, `WARNING`, or `ERROR`.
- **Hide success message**: Suppress success notifications.
- **Check status on startup**: Check if the vault is behind the remote.
- **Auto sync on startup**: If behind, sync automatically instead of only showing a warning.

## Security and conflicts

Avoid storing GitHub personal access tokens directly in the remote URL. Plugin settings are saved inside the vault, which may itself be synchronized. Use SSH or a system credential manager instead.

Review your vault's `.gitignore` before the first push. For example, you may wish to exclude workspace state, machine-specific settings, or sensitive files.

If Git reports a merge conflict, the plugin lists and opens the affected files. **Resolve the conflicts manually before syncing again.** The plugin does not force-push or silently choose one side.

## Troubleshooting

- **Git cannot be found**: Install Git, ensure it is on `PATH`, or set the Git binary directory in the plugin settings.
- **Not a Git repository**: Run `git init` in the vault folder, then make an initial commit.
- **Authentication failed**: Check your SSH keys or configured HTTPS credential helper by running `git push` in a terminal.
- **Branch not found**: The plugin uses `main`. Ensure that your local and remote repositories both have a `main` branch.
- **Files missing on GitHub**: Check your `.gitignore` and the error notices in Obsidian.

Source code and issues: https://github.com/fraa2a/Obsidian-GitHub-Sync
