const axios = require('axios');
const core = require('@actions/core');

const SYSTEM_PROMPT = `你是资深 QA，判断代码变更是否需要测试。输出严格 JSON：

{
  "skip_qa": true | false,
  "skip_reason": "跳过原因（skip_qa=true 时必填）",
  "risk_level": "high" | "medium" | "low",
  "affected_modules": ["模块名"],
  "change_summary": "一句话概括变更",
  "impact_analysis": "受影响功能及原因"
}

## 不需要 QA（skip_qa: true）
i18n 纯翻译、依赖/lock 文件、patches/、CI/lint/tsconfig/构建配置、文档/注释、纯格式化、纯类型定义、仅测试文件变更。

## 需要 QA（skip_qa: false）
UI/交互变更、业务逻辑、API/数据流、存储逻辑、权限/安全、核心依赖大版本升级。

## 原则
- risk_level 基于变更范围和是否涉及核心逻辑判断
- diff 被截断时基于文件名合理推断，在 impact_analysis 中说明`;

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
${prData.diff}

请按要求输出 JSON。`;

  const url = baseUrl.replace(/\/+$/, '');

  core.info(`Calling LLM: ${model}`);

  const response = await callLLM(url, apiKey, model, systemPrompt, userMessage);

  return parseLLMResponse(response);
}

async function callLLM(url, apiKey, model, systemPrompt, userMessage) {
  const payload = {
    model,
    instructions: systemPrompt,
    input: userMessage,
    temperature: 0.3,
    text: { format: { type: 'json_object' } },
  };

  try {
    const { data } = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    });

    return data.output_text || data.output[0].content[0].text;
  } catch (error) {
    if (error.response) {
      const { status, data } = error.response;
      const detail = typeof data === 'string' ? data : JSON.stringify(data);
      throw new Error(`LLM API error ${status}: ${detail}`);
    }
    throw error;
  }
}

function parseLLMResponse(raw) {
  let content = raw.trim();
  // Strip markdown code fences if present
  content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');

  try {
    const parsed = JSON.parse(content);

    // Validate required fields
    const required = ['risk_level', 'change_summary'];
    for (const field of required) {
      if (!(field in parsed)) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    return {
      skip_qa: Boolean(parsed.skip_qa),
      skip_reason: parsed.skip_reason || '',
      risk_level: parsed.risk_level || 'medium',
      affected_modules: toArray(parsed.affected_modules),
      change_summary: parsed.change_summary || '',
      impact_analysis: parsed.impact_analysis || '',
    };
  } catch (error) {
    core.warning(`Failed to parse LLM response: ${error.message}`);
    core.warning(`Raw response: ${content.substring(0, 500)}`);

    // Fallback: return raw content as change_summary
    return {
      skip_qa: false,
      skip_reason: '',
      risk_level: 'medium',
      affected_modules: [],
      change_summary: content.substring(0, 500),
      impact_analysis: 'LLM 响应解析失败，请查看原始输出',
    };
  }
}

module.exports = { analyze };
