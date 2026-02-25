const axios = require('axios');
const core = require('@actions/core');

async function createIssue({ analysis, prData, config }) {
  const { baseUrl, email, apiToken, projectKey, issueType, assigneeId } = config;

  const summary = `[影响分析] ${prData.title} #${prData.number}`;
  const description = buildADF(analysis, prData);

  const riskLabel = `risk-${analysis.risk_level}`;
  const labels = ['auto-analysis', riskLabel];

  const payload = {
    fields: {
      project: { key: projectKey },
      summary,
      description,
      issuetype: { name: issueType },
      labels,
    },
  };

  if (assigneeId) {
    payload.fields.assignee = { accountId: assigneeId };
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/rest/api/3/issue`;
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

  core.info(`Creating Jira issue in project ${projectKey}`);

  const { data } = await axios.post(url, payload, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  });

  const issueKey = data.key;
  const issueUrl = `${baseUrl.replace(/\/+$/, '')}/browse/${issueKey}`;

  core.info(`Created Jira issue: ${issueKey} (${issueUrl})`);

  return { issueKey, issueUrl };
}

function buildADF(analysis, prData) {
  const riskEmoji = { high: '🔴 高', medium: '🟡 中', low: '🟢 低' };
  const risk = riskEmoji[analysis.risk_level] || '🟡 中';

  // Jira Cloud uses Atlassian Document Format (ADF)
  return {
    version: 1,
    type: 'doc',
    content: [
      heading('变更概述'),
      paragraph(analysis.change_summary),
      paragraph(`PR: ${prData.repo}#${prData.number} | 作者: ${prData.author} | 合并时间: ${prData.mergedAt || 'N/A'}`),
      rule(),

      heading('影响范围'),
      paragraph(`风险等级: ${risk}`),
      heading('受影响模块', 3),
      bulletList(analysis.affected_modules.length > 0
        ? analysis.affected_modules
        : ['无特定模块']),
      heading('影响分析', 3),
      paragraph(analysis.impact_analysis || '无'),
      rule(),

      heading('测试 Checklist'),
      taskList(analysis.test_checklist),
      rule(),

      heading('回归测试范围'),
      bulletList(analysis.regression_areas.length > 0
        ? analysis.regression_areas
        : ['无']),
      rule(),

      heading('备注'),
      paragraph(analysis.notes || '无'),
      rule(),
      paragraph(`由 GitHub Action 自动创建 | 查看 PR: ${prData.prUrl}`),
    ],
  };
}

// --- ADF helper functions ---

function heading(text, level = 2) {
  return {
    type: 'heading',
    attrs: { level },
    content: [{ type: 'text', text }],
  };
}

function paragraph(text) {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  };
}

function rule() {
  return { type: 'rule' };
}

function bulletList(items) {
  return {
    type: 'bulletList',
    content: items.map(item => ({
      type: 'listItem',
      content: [paragraph(item)],
    })),
  };
}

function taskList(items) {
  return {
    type: 'taskList',
    attrs: { localId: 'checklist' },
    content: items.map((item, i) => ({
      type: 'taskItem',
      attrs: { localId: `task-${i}`, state: 'TODO' },
      content: [{ type: 'text', text: item }],
    })),
  };
}

module.exports = { createIssue };
