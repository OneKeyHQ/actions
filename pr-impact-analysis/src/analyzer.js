const axios = require('axios');
const core = require('@actions/core');

const SYSTEM_PROMPT = `你是一个资深 QA 工程师，负责判断代码变更是否需要 QA 测试，如果需要则制定测试计划。

## 输出格式
输出严格的 JSON（不要包含 markdown 代码块标记）：

{
  "skip_qa": true | false,
  "skip_reason": "跳过原因（skip_qa 为 true 时必填）",
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

## 不需要 QA 的变更（skip_qa: true）
以下类型的变更通常不影响用户可见行为，不需要创建 QA 任务：
- **国际化 (i18n)**：纯翻译文件的增删改（locale 相关），除非涉及关键业务文案的逻辑变更
- **依赖变更**：package.json、lock 文件变更，除非是核心依赖的大版本升级
- **Patch 文件**：patches/ 目录下的变更
- **纯工程改动**：CI/CD 配置、lint 规则、tsconfig、构建脚本、开发工具配置、Dockerfile 等
- **文档**：README、CHANGELOG、注释、JSDoc
- **代码格式化**：纯 formatting、import 排序等不影响运行时行为的变更
- **纯类型定义**：仅 TypeScript 类型修改，不影响运行时逻辑
- **测试代码**：仅修改测试文件，不涉及源码变更

## 需要 QA 的变更（skip_qa: false）
- 用户可见的 UI / 交互变更
- 业务逻辑修改
- API 调用或数据流变更
- 数据处理 / 存储逻辑变更
- 权限 / 安全相关变更
- 核心依赖的大版本升级

## 原则
- 说人话，QA 能直接照着测
- test_checklist 要具体到操作步骤，不要笼统的"测试XX功能"
- risk_level 基于变更范围、是否涉及核心逻辑、是否有数据变更来判断
- 如果 diff 被截断，基于文件名和可见部分做合理推断，并在 notes 里说明
- 当 skip_qa 为 true 时，test_checklist 可以为空数组，但仍需填写 change_summary 和 risk_level`;

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
    const required = ['risk_level', 'change_summary', 'test_checklist'];
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
      test_checklist: toArray(parsed.test_checklist),
      regression_areas: toArray(parsed.regression_areas),
      notes: parsed.notes || '',
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
      test_checklist: ['手动检查 PR 变更内容并制定测试计划'],
      regression_areas: [],
      notes: `原始 LLM 输出:\n${content}`,
    };
  }
}

module.exports = { analyze };
