const axios = require('axios');
const core = require('@actions/core');

const SYSTEM_PROMPT = `你是一个资深 QA 工程师，负责分析代码变更的影响范围并制定测试计划。

## 要求
分析代码变更，输出严格的 JSON（不要包含 markdown 代码块标记）：

{
  "risk_level": "high" | "medium" | "low",
  "affected_modules": ["模块名"],
  "change_summary": "一句话说清楚改了什么",
  "impact_analysis": "哪些功能可能受影响，为什么",
  "test_checklist": [
    "具体的测试步骤1",
    "具体的测试步骤2"
  ],
  "regression_areas": ["需要回归测试的区域"],
  "notes": "其他 QA 需要注意的事项"
}

## 原则
- 说人话，QA 能直接照着测
- test_checklist 要具体到操作步骤，不要笼统的"测试XX功能"
- risk_level 基于变更范围、是否涉及核心逻辑、是否有数据变更来判断
- 如果 diff 被截断，基于文件名和可见部分做合理推断，并在 notes 里说明`;

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === 'string') return value ? [value] : [];
  return [String(value)];
}

async function analyze({ prData, apiKey, baseUrl, model, customPrompt }) {
  const systemPrompt = customPrompt
    ? `${SYSTEM_PROMPT}\n\n## 项目补充信息\n${customPrompt}`
    : SYSTEM_PROMPT;

  const userMessage = `## PR 信息
- 标题: ${prData.title}
- 描述: ${prData.body || '无'}
- 作者: ${prData.author}
- 标签: ${prData.labels.join(', ') || '无'}

## 变更文件列表
${prData.files.map(f => `- [${f.status}] ${f.filename}`).join('\n')}

## Diff 内容
${prData.diff}`;

  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;

  core.info(`Calling LLM: ${model} at ${baseUrl}`);

  const response = await callLLM(url, apiKey, model, systemPrompt, userMessage);

  return parseLLMResponse(response);
}

async function callLLM(url, apiKey, model, systemPrompt, userMessage) {
  const payload = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  };

  const { data } = await axios.post(url, payload, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 120000,
  });

  return data.choices[0].message.content;
}

function parseLLMResponse(raw) {
  let content = raw.trim();
  // Strip markdown code fences if present
  content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');

  try {
    const parsed = JSON.parse(content);

    // Validate required fields
    const required = ['risk_level', 'change_summary', 'test_checklist'];
    for (const field of required) {
      if (!(field in parsed)) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    return {
      risk_level: parsed.risk_level || 'medium',
      affected_modules: toArray(parsed.affected_modules),
      change_summary: parsed.change_summary || '',
      impact_analysis: parsed.impact_analysis || '',
      test_checklist: toArray(parsed.test_checklist),
      regression_areas: toArray(parsed.regression_areas),
      notes: parsed.notes || '',
    };
  } catch (error) {
    core.warning(`Failed to parse LLM response: ${error.message}`);
    core.warning(`Raw response: ${content.substring(0, 500)}`);

    // Fallback: return raw content as change_summary
    return {
      risk_level: 'medium',
      affected_modules: [],
      change_summary: content.substring(0, 500),
      impact_analysis: 'LLM 响应解析失败，请查看原始输出',
      test_checklist: ['手动检查 PR 变更内容并制定测试计划'],
      regression_areas: [],
      notes: `原始 LLM 输出:\n${content}`,
    };
  }
}

module.exports = { analyze };
