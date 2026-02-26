const core = require('@actions/core');
const { getPRData } = require('./github');
const { analyze } = require('./analyzer');
const { createIssue } = require('./jira');

async function run() {
  try {
    // 1. Read inputs
    const githubToken = core.getInput('github-token', { required: true });
    const llmApiKey = core.getInput('llm-api-key', { required: true });
    const llmBaseUrl = core.getInput('llm-api-base-url') || 'https://api.deepseek.com';
    const llmModel = core.getInput('llm-model') || 'deepseek-chat';
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

    // 3. Analyze via LLM
    core.info('Step 2/3: Analyzing impact via LLM...');
    const analysis = await analyze({
      prData,
      apiKey: llmApiKey,
      baseUrl: llmBaseUrl,
      model: llmModel,
      customPrompt,
    });
    core.info(`Analysis complete. Risk: ${analysis.risk_level}, ${analysis.test_checklist.length} test items`);

    // 4. Create Jira issue
    core.info('Step 3/3: Creating Jira issue...');
    const { issueKey, issueUrl } = await createIssue({
      analysis,
      prData,
      config: jiraConfig,
    });

    // 5. Set outputs
    core.setOutput('jira-issue-key', issueKey);
    core.setOutput('jira-issue-url', issueUrl);
    core.setOutput('analysis-summary', analysis.change_summary);

    core.info(`Done! Jira issue created: ${issueKey} — ${issueUrl}`);
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
