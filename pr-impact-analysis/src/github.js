const github = require('@actions/github');
const core = require('@actions/core');

const MAX_DIFF_CHARS = 80000;
const MAX_PATCH_LINES_PER_FILE = 100;

async function getPRData(token) {
  const octokit = github.getOctokit(token);
  const context = github.context;

  const { owner, repo } = context.repo;
  const pullNumber = context.payload.pull_request.number;

  core.info(`Fetching PR #${pullNumber} from ${owner}/${repo}`);

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  const diff = buildDiff(files);

  return {
    title: pr.title,
    body: pr.body || '',
    author: pr.user.login,
    number: pullNumber,
    mergedAt: pr.merged_at,
    repo: `${owner}/${repo}`,
    prUrl: pr.html_url,
    labels: pr.labels.map(l => l.name),
    files: files.map(f => ({ filename: f.filename, status: f.status })),
    diff,
  };
}

function buildDiff(files) {
  let totalChars = 0;
  const parts = [];

  const sorted = [...files].sort((a, b) => {
    const order = { modified: 0, added: 1, removed: 2, renamed: 3 };
    return (order[a.status] ?? 4) - (order[b.status] ?? 4);
  });

  for (const file of sorted) {
    const header = `--- ${file.status}: ${file.filename} ---\n`;
    let patch = file.patch || '(binary or empty)';

    const lines = patch.split('\n');
    if (lines.length > MAX_PATCH_LINES_PER_FILE) {
      patch = lines.slice(0, MAX_PATCH_LINES_PER_FILE).join('\n')
        + `\n... (truncated, ${lines.length - MAX_PATCH_LINES_PER_FILE} more lines)`;
    }

    const chunk = header + patch + '\n\n';

    if (totalChars + chunk.length > MAX_DIFF_CHARS) {
      parts.push(`\n... (diff truncated, ${files.length - parts.length} more files not shown)\n`);
      break;
    }

    parts.push(chunk);
    totalChars += chunk.length;
  }

  return parts.join('');
}

module.exports = { getPRData };
