const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REQUEST_BYTES = 256_000;
const MAX_ERROR_LENGTH = 500;

export function chatCompletionsUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

export function modelsUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) return normalized.replace(/\/chat\/completions$/i, "/models");
  if (/\/models$/i.test(normalized)) return normalized;
  return `${normalized}/models`;
}

export async function discoverModels(settings, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 环境不支持 fetch");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.llmTimeoutSeconds * 1_000);
  const headers = {};
  if (settings.llmApiKey) headers.authorization = `Bearer ${settings.llmApiKey}`;
  let response;
  let text;
  try {
    response = await fetchImpl(modelsUrl(settings.llmBaseUrl), { headers, signal: controller.signal });
    text = await readBoundedResponseText(response);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`发现模型请求超过 ${settings.llmTimeoutSeconds} 秒`);
    if (error?.message === "LLM 响应超过 1 MB") throw error;
    throw new Error(`无法获取模型列表：${boundedText(error?.message || error, settings.llmApiKey)}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`模型列表 API 返回 HTTP ${response.status}：${boundedText(text || response.statusText, settings.llmApiKey)}`);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("模型列表 API 返回的响应不是有效 JSON");
  }
  const source = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const models = [...new Set(source.map((item) => typeof item === "string" ? item : item?.id || item?.name).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
  if (!models.length) throw new Error("模型列表为空或响应中缺少 data[].id");
  return { models };
}

export async function analyzeDailyReview(report, settings, options = {}) {
  const content = await callChatCompletion(settings, [
    {
      role: "system",
      content: `你是 Codex 使用复盘分析器。只根据输入中的聚合统计和脱敏样例判断，不得编造事实。
使用场景名称可以由你重新归纳，不受规则分类名称限制。重点识别用户最常用 Codex 做什么、在各场景中使用哪些工具、Skill 和 MCP，以及长期习惯和可执行改进建议。
只返回一个 JSON 对象，不要使用 Markdown。结构必须是：
{"overview":"总体总结","scenarios":[{"name":"场景名","summary":"场景说明","evidence":["依据"],"tools":["工具"],"skills":["Skill 或 MCP"]}],"habits":["习惯"],"recommendations":["建议"]}`,
    },
    {
      role: "user",
      content: JSON.stringify(buildAnalysisInput(report)),
    },
  ], options);
  return {
    status: "completed",
    model: settings.llmModel,
    generatedAtUnixMs: Date.now(),
    ...normalizeAnalysis(parseJsonObject(content)),
  };
}

export async function testLlmConnection(settings, options = {}) {
  const startedAt = Date.now();
  await callChatCompletion(settings, [
    { role: "system", content: "你是连接测试助手。请简短回复 OK。" },
    { role: "user", content: "测试 OpenAI 兼容接口是否可用。" },
  ], options);
  return { ok: true, model: settings.llmModel, latencyMs: Date.now() - startedAt };
}

async function callChatCompletion(settings, messages, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 环境不支持 fetch");
  const body = JSON.stringify({ model: settings.llmModel, messages });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) throw new Error("LLM 分析输入超过 256 KB");
  const timeoutMs = settings.llmTimeoutSeconds * 1_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { "content-type": "application/json" };
  if (settings.llmApiKey) headers.authorization = `Bearer ${settings.llmApiKey}`;
  let response;
  let text;
  try {
    response = await fetchImpl(chatCompletionsUrl(settings.llmBaseUrl), {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    text = await readBoundedResponseText(response);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`LLM 请求超过 ${settings.llmTimeoutSeconds} 秒`);
    if (error?.message === "LLM 响应超过 1 MB") throw error;
    throw new Error(`无法连接 LLM API：${boundedText(error?.message || error, settings.llmApiKey)}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`LLM API 返回 HTTP ${response.status}：${boundedText(text || response.statusText, settings.llmApiKey)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("LLM API 返回的响应不是有效 JSON");
  }
  const content = messageContent(payload?.choices?.[0]?.message?.content);
  if (!content) throw new Error("LLM API 响应中缺少 choices[0].message.content");
  return content;
}

async function readBoundedResponseText(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("LLM 响应超过 1 MB");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("LLM 响应超过 1 MB");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("LLM 响应超过 1 MB");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function buildAnalysisInput(report) {
  return {
    date: report.date,
    summary: report.summary,
    ruleBasedHabits: report.habits,
    ruleBasedScenarios: Object.entries(report.scenarioUsage || {})
      .sort(([, left], [, right]) => right.sessions - left.sessions)
      .slice(0, 12)
      .map(([name, value]) => ({
        name,
        sessions: value.sessions,
        modelCalls: value.modelCalls,
        toolCalls: value.toolCalls,
        tools: topEntries(value.tools, 8),
        skills: topEntries(value.skills, 8),
        examples: (value.examples || []).slice(0, 3),
      })),
    tools: topEntries(report.toolUsage || report.toolKinds, 30),
    skills: topEntries(report.skillUsage, 30),
    mcpServers: topEntries(report.mcpUsage, 30),
    models: topEntries(report.models, 12),
    projects: topEntries(report.projects, 12).map((item) => ({ ...item, name: displayName(item.name) })),
    hourlyStarts: report.hourlyStarts,
    inactiveItems: (report.cleanupRecommendations || []).slice(0, 30).map(({ type, id, lastUsed, inactiveDays }) => ({
      type, id: displayName(id), lastUsed, inactiveDays,
    })),
  };
}

function topEntries(record, limit) {
  return Object.entries(record || {})
    .sort(([, left], [, right]) => right - left)
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function displayName(value) {
  const normalized = String(value).replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).at(-1) || normalized;
}

function messageContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part?.text || "").join("").trim();
}

function parseJsonObject(content) {
  const unfenced = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("LLM 分析结果中没有有效 JSON 对象");
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    throw new Error("LLM 分析结果的 JSON 无法解析");
  }
}

function normalizeAnalysis(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("LLM 分析结果必须是 JSON 对象");
  return {
    overview: limitedString(value.overview, 2_000) || "模型未提供总体总结。",
    scenarios: (Array.isArray(value.scenarios) ? value.scenarios : []).slice(0, 10).map((scenario) => ({
      name: limitedString(scenario?.name, 120) || "未命名场景",
      summary: limitedString(scenario?.summary, 800),
      evidence: stringArray(scenario?.evidence, 6, 500),
      tools: stringArray(scenario?.tools, 10, 120),
      skills: stringArray(scenario?.skills, 10, 120),
    })),
    habits: stringArray(value.habits, 12, 800),
    recommendations: stringArray(value.recommendations, 12, 800),
  };
}

function stringArray(value, limit, length) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => limitedString(item, length)).filter(Boolean).slice(0, limit);
}

function limitedString(value, length) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > length ? `${normalized.slice(0, length - 1)}…` : normalized;
}

function boundedText(value, apiKey = "") {
  let normalized = String(value || "未知错误").replace(/\s+/g, " ").trim();
  if (apiKey) normalized = normalized.replaceAll(apiKey, "[已隐藏密钥]");
  normalized = normalized.replace(/sk-[a-z0-9_-]{8,}/gi, "[已隐藏密钥]");
  return normalized.length > MAX_ERROR_LENGTH ? `${normalized.slice(0, MAX_ERROR_LENGTH - 1)}…` : normalized;
}
