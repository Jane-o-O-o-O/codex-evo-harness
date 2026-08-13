import assert from "node:assert/strict";
import test from "node:test";

import { analyzeDailyReview, chatCompletionsUrl, discoverModels, modelsUrl, testLlmConnection } from "./llm-review.mjs";

const settings = {
  llmBaseUrl: "https://example.test/v1/",
  llmApiKey: "secret-key",
  llmModel: "test-model",
  llmTimeoutSeconds: 30,
};

test("chat completions URL accepts a base URL or full endpoint", () => {
  assert.equal(chatCompletionsUrl("https://example.test/v1/"), "https://example.test/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://example.test/v1/chat/completions"), "https://example.test/v1/chat/completions");
});

test("model discovery resolves the Models endpoint and returns selectable model ids", async () => {
  assert.equal(modelsUrl("https://example.test/v1/"), "https://example.test/v1/models");
  assert.equal(modelsUrl("https://example.test/v1/chat/completions"), "https://example.test/v1/models");
  let request;
  const result = await discoverModels(settings, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: [{ id: "gpt-5-mini" }, { id: "gpt-5" }, { id: "gpt-5" }] }), { status: 200 });
    },
  });
  assert.equal(request.url, "https://example.test/v1/models");
  assert.equal(request.options.headers.authorization, "Bearer secret-key");
  assert.deepEqual(result.models, ["gpt-5", "gpt-5-mini"]);
});

test("LLM review uses the OpenAI-compatible chat completions protocol", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      choices: [{ message: { content: "```json\n{\"overview\":\"主要用于代码审查\",\"scenarios\":[{\"name\":\"质量保障\",\"summary\":\"集中检查风险\",\"evidence\":[\"审查会话最多\"],\"tools\":[\"exec_command\"],\"skills\":[\"code-review\"]}],\"habits\":[\"偏好先检查再修改\"],\"recommendations\":[\"增加测试覆盖\"]}\n```" } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const analysis = await analyzeDailyReview({
    date: "2026-08-06",
    summary: { sessions: 2 },
    habits: [], scenarioUsage: {}, toolUsage: {}, skillUsage: {}, mcpUsage: {}, models: {}, projects: {}, hourlyStarts: [], cleanupRecommendations: [],
  }, settings, { fetchImpl });
  assert.equal(request.url, "https://example.test/v1/chat/completions");
  assert.equal(request.options.headers.authorization, "Bearer secret-key");
  assert.deepEqual(JSON.parse(request.options.body).model, "test-model");
  assert.deepEqual(analysis.scenarios[0], {
    name: "质量保障", summary: "集中检查风险", evidence: ["审查会话最多"], tools: ["exec_command"], skills: ["code-review"],
  });
});

test("connection test supports endpoints without an API key", async () => {
  let authorization;
  const result = await testLlmConnection({ ...settings, llmApiKey: "" }, {
    fetchImpl: async (_url, options) => {
      authorization = options.headers.authorization;
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
    },
  });
  assert.equal(authorization, undefined);
  assert.equal(result.ok, true);
});

test("LLM errors include the HTTP status without exposing request credentials", async () => {
  let capturedError;
  await assert.rejects(() => analyzeDailyReview({
    date: "2026-08-06", summary: {}, habits: [], scenarioUsage: {}, toolUsage: {}, skillUsage: {}, mcpUsage: {}, models: {}, projects: {}, hourlyStarts: [], cleanupRecommendations: [],
  }, settings, {
    fetchImpl: async () => new Response("invalid model for secret-key", { status: 400 }),
  }), (error) => {
    capturedError = error;
    return /HTTP 400.*invalid model/.test(error.message);
  });
  assert.doesNotMatch(capturedError.message, /secret-key/);
});

test("LLM responses are rejected when they exceed the size limit", async () => {
  await assert.rejects(() => testLlmConnection(settings, {
    fetchImpl: async () => new Response("x".repeat(1_000_001), { status: 200 }),
  }), /响应超过 1 MB/);
});

test("LLM timeout also covers reading the response body", async () => {
  await assert.rejects(() => testLlmConnection({ ...settings, llmTimeoutSeconds: 0.01 }, {
    fetchImpl: async (_url, options) => {
      const body = new ReadableStream({
        start(controller) {
          options.signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    },
  }), /请求超过 0.01 秒/);
});
