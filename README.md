# dokku

A GitHub Action that automatically keeps your README in sync with your code. When a PR is opened or code is pushed to `main`, dokku diffs the source files, asks Claude whether any user-facing changes warrant a README update, and either commits the update directly or opens a PR — depending on the mode.

## How it works

1. A workflow generates a `diff.txt` of changed source files
2. dokku sends the diff and current README to Claude (`claude-sonnet-4-20250514`)
3. Claude decides whether any user-facing changes (new CLI flags, env vars, config options, API endpoints, install steps, new features) need documenting
4. If yes — dokku writes the updated README, commits it, and posts a PR comment (or opens a new PR if running on `main`)
5. If no — dokku posts a comment explaining why no update was needed and exits cleanly
6. dokku never fails your CI — all errors are warnings

## Setup

### 1. Add the Anthropic API key secret

In your repository, go to **Settings → Secrets and variables → Actions → New repository secret** and add:

- **Name:** `ANTHROPIC_API_KEY`
- **Value:** your Anthropic API key (get one at [console.anthropic.com](https://console.anthropic.com))

`GITHUB_TOKEN` is provided automatically by GitHub Actions — no setup needed.

### 2. Add the workflow

Copy the workflow below into `.github/workflows/dokku.yml` in your repository:

```yaml
name: dokku

on:
  pull_request:
    types: [opened, synchronize]
  push:
    branches: [main]
    paths: ['**.ts', '**.js', '**.py', '**.go', '**.rs']

jobs:
  sync-readme:
    runs-on: ubuntu-latest
    if: github.actor != 'github-actions[bot]'
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event_name == 'pull_request' && github.head_ref || github.ref }}
          fetch-depth: ${{ github.event_name == 'pull_request' && 0 || 2 }}
      - name: get diff
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            git diff origin/${{ github.base_ref }}...HEAD -- '*.ts' '*.js' '*.py' '*.go' '*.rs' ':!**/*.test.*' ':!**/tests/**' ':!.github/**' > diff.txt
          else
            git diff HEAD~1 HEAD -- '*.ts' '*.js' '*.py' '*.go' '*.rs' ':!**/*.test.*' ':!**/tests/**' > diff.txt
          fi
      - name: run dokku
        uses: your-org/dokku@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          mode: ${{ github.event_name == 'pull_request' && 'pr' || 'open-pr' }}
          pr-number: ${{ github.event.pull_request.number }}
          base-branch: main
```

Replace `your-org/dokku@v1` with the actual repository reference once published.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `anthropic-api-key` | yes | — | Anthropic API key for Claude |
| `github-token` | yes | — | GitHub token for posting comments and opening PRs |
| `mode` | yes | — | `pr` — commit to the PR branch; `open-pr` — open a new PR |
| `diff-file` | no | `diff.txt` | Path to the git diff file |
| `readme-path` | no | `README.md` | Path to the README to update |
| `pr-number` | no | — | PR number (required in `pr` mode) |
| `base-branch` | no | `main` | Base branch for the new PR (used in `open-pr` mode) |

## Modes

### `pr` mode (pull requests)
When triggered by a `pull_request` event, dokku commits the updated README directly to the PR branch and posts a comment listing what changed.

### `open-pr` mode (pushes to main)
When triggered by a `push` to `main`, dokku creates a new branch (`dokku/patch-{sha}`), commits the updated README, pushes it, and opens a PR against `base-branch`.

### `audit` mode (one-time catch-up for existing repos)
Diffs the entire git history (first commit → HEAD) to find user-facing features that were never documented. Opens a PR with any needed README updates.

This is intended to run **once** on repos with an existing codebase. Add [`.github/workflows/dokku-audit.yml`](.github/workflows/dokku-audit.yml) to your repo and trigger it manually via **Actions → dokku-audit → Run workflow**. Remove or keep the workflow file after — it only runs on `workflow_dispatch` so it will never fire automatically.

## What dokku updates (and what it skips)

dokku instructs Claude to **only** update the README for user-facing changes:
- New CLI flags or commands
- New environment variables
- New configuration options
- New API endpoints
- Changed installation steps
- New features users interact with directly

dokku **never** updates the README for internal changes like refactors, bug fixes, test updates, CI changes, or code style.

## Building from source

```bash
npm install
npm run build   # produces dist/index.js via ncc
```

The `dist/` directory should be committed so the action runs without requiring `npm install` at runtime.
