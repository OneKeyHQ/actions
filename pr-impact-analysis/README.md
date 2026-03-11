# PR Impact Analysis

A GitHub Action that analyzes PR code changes and creates Jira QA issues. All analysis logic runs on a Cloudflare Worker — this action is a thin client that collects PR data and delegates.

## How It Works

```
PR merged → Fetch diff → POST to Worker → Worker returns result → Set outputs
```

1. Fetches PR metadata and diff via GitHub API
2. Sends data to a Cloudflare Worker which handles:
   - OK-XXXX Jira key detection (skip if already linked)
   - GitHub → Jira user mapping + dedup search
   - LLM impact analysis with duplicate detection
   - Jira issue creation (if needed)

## Project Structure

```
pr-impact-analysis/
├── action.yml          # Action metadata (3 inputs, 4 outputs)
├── package.json        # Dependencies: @actions/core, @actions/github, axios
├── dist/index.js       # Bundled output (ncc)
├── src/
│   ├── index.js        # Thin client: collect PR data → POST to Worker → set outputs
│   └── github.js       # GitHub API: fetch PR info & diff with truncation
└── yarn.lock
```

## Usage

```yaml
on:
  pull_request:
    types: [closed]

jobs:
  impact-analysis:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - name: Analyze PR Impact
        uses: OneKeyHQ/actions/pr-impact-analysis@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          worker-url: ${{ secrets.PR_ANALYSIS_WORKER_URL }}
          worker-secret: ${{ secrets.PR_ANALYSIS_WORKER_SECRET }}
```

## Inputs

| Name | Required | Description |
|------|----------|-------------|
| `github-token` | yes | GitHub token to fetch PR diff |
| `worker-url` | yes | Cloudflare Worker endpoint URL |
| `worker-secret` | yes | Shared secret for Worker authentication |

## Outputs

| Name | Description |
|------|-------------|
| `jira-issue-key` | Created Jira issue key, e.g. `OK-123` (empty if skipped) |
| `jira-issue-url` | URL to the created Jira issue (empty if skipped) |
| `analysis-summary` | LLM generated impact summary |
| `skipped` | Whether QA was skipped (`true`/`false`) |

## Worker Configuration

LLM, Jira, and user mapping configuration lives in the Cloudflare Worker, not in this action. See the Worker project for setup details.
