# PR Impact Analysis

A GitHub Action that automatically analyzes PR code changes via LLM, generates impact assessment and test recommendations, then creates a Jira issue assigned to QA.

## How It Works

```
PR merged → Fetch diff → LLM analysis → Create Jira issue → Assign to QA
```

1. Fetches PR metadata and diff via GitHub API
2. Sends diff to LLM (OpenAI-compatible API) for impact analysis
3. Creates a Jira issue with structured test checklist and risk assessment

## Project Structure

```
pr-impact-analysis/
├── action.yml          # Action metadata (11 inputs, 3 outputs)
├── package.json        # Dependencies: @actions/core, @actions/github, axios
├── dist/index.js       # Bundled output (ncc)
├── src/
│   ├── index.js        # Entry point - orchestrates the flow
│   ├── github.js       # GitHub API - fetch PR info & diff with truncation
│   ├── analyzer.js     # LLM API - build prompt, parse JSON response
│   └── jira.js         # Jira API - create issue with ADF formatting
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
          llm-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          jira-base-url: ${{ secrets.JIRA_BASE_URL }}
          jira-email: ${{ secrets.JIRA_EMAIL }}
          jira-api-token: ${{ secrets.JIRA_API_TOKEN }}
          jira-project-key: 'QA'
          jira-assignee-id: '<jira-account-id>'
```

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `github-token` | yes | — | GitHub token to fetch PR diff |
| `llm-api-key` | yes | — | LLM API key |
| `llm-api-base-url` | no | `https://api.deepseek.com` | LLM API base URL (OpenAI-compatible) |
| `llm-model` | no | `deepseek-chat` | Model name |
| `jira-base-url` | yes | — | Jira instance URL |
| `jira-email` | yes | — | Jira account email |
| `jira-api-token` | yes | — | Jira API token |
| `jira-project-key` | yes | — | Jira project key, e.g. `QA` |
| `jira-issue-type` | no | `Task` | Jira issue type |
| `jira-assignee-id` | no | — | Jira user account ID |
| `custom-prompt` | no | — | Additional prompt context for LLM |

## Outputs

| Name | Description |
|------|-------------|
| `jira-issue-key` | Created Jira issue key, e.g. `QA-123` |
| `jira-issue-url` | URL to the created Jira issue |
| `analysis-summary` | LLM generated impact summary |

## Switching LLM Provider

Uses OpenAI-compatible `/v1/chat/completions` endpoint. Switch by changing inputs:

```yaml
# DeepSeek (default, cost-effective for testing)
llm-api-base-url: https://api.deepseek.com
llm-model: deepseek-chat

# OpenAI
llm-api-base-url: https://api.openai.com
llm-model: gpt-4o

# Groq
llm-api-base-url: https://api.groq.com/openai
llm-model: llama-3.1-70b-versatile
```

## Jira Issue Output

The created Jira issue includes:

- **Change summary** — one-line description of what changed
- **Risk level** — high / medium / low with color indicators
- **Affected modules** — list of impacted areas
- **Test checklist** — actionable test steps (Jira task list format)
- **Regression areas** — what else to regression test
- **PR link** — direct link back to the merged PR
