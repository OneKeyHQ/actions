const core = require('@actions/core');
const { getPRData } = require('./github');
const axios = require('axios');

async function run() {
  try {
    const githubToken = core.getInput('github-token', { required: true });
    const workerUrl = core.getInput('worker-url', { required: true });
    const workerSecret = core.getInput('worker-secret', { required: true });

    // 1. Fetch PR data
    core.info('Step 1/2: Fetching PR data...');
    const prData = await getPRData(githubToken);
    core.info(`PR #${prData.number}: ${prData.title} (${prData.files.length} files changed)`);

    // 2. Send to Worker
    core.info('Step 2/2: Sending to analysis worker...');
    const { data } = await axios.post(workerUrl, prData, {
      headers: {
        'Authorization': `Bearer ${workerSecret}`,
        'Content-Type': 'application/json',
      },
      timeout: 180000,
    });

    if (!data.success) {
      throw new Error(`Worker error: ${data.error}`);
    }

    // 3. Set outputs
    core.setOutput('jira-issue-key', data.jiraIssueKey || '');
    core.setOutput('jira-issue-url', data.jiraIssueUrl || '');
    core.setOutput('analysis-summary', data.analysisSummary || '');
    core.setOutput('skipped', String(data.skipped));

    if (data.skipped) {
      core.info(`Skipped (${data.skipReason}): ${data.analysisSummary}`);
    } else {
      core.info(`Done! Jira issue created: ${data.jiraIssueKey} — ${data.jiraIssueUrl}`);
    }
  } catch (error) {
    if (error.response) {
      core.error(`Worker HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`);
    }
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
