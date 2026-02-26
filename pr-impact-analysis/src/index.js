const core = require('@actions/core');
const { getPRData } = require('./github');
const { analyze } = require('./analyzer');
const { createIssue } = require('./jira');

async function run() {
  try {
    // 1. Read inputs
    const githubToken = core.getInput('github-token', { required: true });
    const llmApiKey = core.getInput('llm-api-key', { required: true });
    const llmBaseUrl = core.getInput('llm-api-base-url', { required: true });
    const llmModel = core.getInput('llm-model', { required: true });
    const customPrompt = core.getInput('custom-prompt') || '';

    const jiraConfig = {
      baseUrl: core.getInput('jira-base-url', { required: true }),
      email: core.getInput('jira-email', { required: true }),
      apiToken: core.getInput('jira-api-token', { required: true }),
      projectKey: core.getInput('jira-project-key', { required: true }),
      issueType: core.getInput('jira-issue-type') || '测试 QA',
      assigneeId: core.getInput('jira-assignee-id') || '',
    };

    // 2. Fetch PR data and diff
    core.info('Step 1/3: Fetching PR data...');
    const prData = await getPRData(githubToken);
    core.info(`PR #${prData.number}: ${prData.title} (${prData.files.length} files changed)`);

    // 2.5. Check if Jira issue already exists (branch or title contains OK-XXXX)
    const jiraKeyPattern = /ok[-_]?\d+/i;
    const existingKey = prData.branch.match(jiraKeyPattern)?.[0]
      || prData.title.match(jiraKeyPattern)?.[0];
    if (existingKey) {
      const normalizedKey = 'OK-' + existingKey.replace(/^ok[-_]?/i, '');
      core.info(`Jira issue ${normalizedKey} already linked, skipping analysis and creation.`);
      core.setOutput('jira-issue-key', normalizedKey);
      core.setOutput('jira-issue-url', '');
      core.setOutput('skipped', 'true');
      core.setOutput('analysis-summary', `Linked to existing issue ${normalizedKey}`);
      return;
    }

    // 3. Analyze via LLM
    core.info('Step 2/3: Analyzing impact via LLM...');
    const analysis = await analyze({
      prData,
      apiKey: llmApiKey,
      baseUrl: llmBaseUrl,
      model: llmModel,
      customPrompt,
    });
    core.info(`Analysis complete. Risk: ${analysis.risk_level}, skip_qa: ${analysis.skip_qa}`);

    // 4. Conditionally create Jira issue
    if (analysis.skip_qa) {
      core.info(`Skipped QA: ${analysis.skip_reason}`);
      core.info(`Summary: ${analysis.change_summary}`);
      core.setOutput('jira-issue-key', '');
      core.setOutput('jira-issue-url', '');
      core.setOutput('skipped', 'true');
    } else {
      core.info('Step 3/3: Creating Jira issue...');
      const { issueKey, issueUrl } = await createIssue({
        analysis,
        prData,
        config: jiraConfig,
      });
      core.setOutput('jira-issue-key', issueKey);
      core.setOutput('jira-issue-url', issueUrl);
      core.setOutput('skipped', 'false');
      core.info(`Done! Jira issue created: ${issueKey} — ${issueUrl}`);
    }

    core.setOutput('analysis-summary', analysis.change_summary);
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
