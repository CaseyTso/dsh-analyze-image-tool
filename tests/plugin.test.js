// plugin.test.js — registration and execution tests for the plugin entry.
// Runs with node --test against the real @deepseek-ai/dsh-tools and schemastery
// (resolved through the project's dev node_modules symlinks), with a stubbed
// cordis ctx and a mocked global fetch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, Config, name, inject } from "../lib/index.js";

/** Build a fake cordis ctx that captures registrations. */
function fakeCtx({
  bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  credential = null,
  apiProxy = undefined,
  llmInfo = undefined,
} = {}) {
  const state = { tool: null, promptSection: null, effects: [], fsCalls: [], listeners: {} };
  const services = {
    apiProxy,
    llm:
      llmInfo === undefined
        ? undefined
        : { async resolveModelInfo() { return llmInfo; } },
  };
  const ctx = {
    state,
    get(name) {
      return services[name];
    },
    effect(fn, label) {
      state.effects.push(label);
      return fn();
    },
    on(name, cb) {
      state.listeners[name] = cb;
      return () => {};
    },
    tools: {
      register(definition) {
        state.tool = definition;
        return () => {};
      },
    },
    systemPrompt: {
      section(entry) {
        state.promptSection = entry;
        return () => {};
      },
    },
    attachments: {
      async validateImage(_input) {},
      async saveImage(input) {
        return {
          attachmentId: `sha256:${Buffer.from(input.data).toString("hex")}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
          ...(input.name === undefined ? {} : { name: input.name }),
        };
      },
      async readImage(ref, _signal) {
        return { ref, data: new Uint8Array(Buffer.from("attachment-bytes")) };
      },
    },
    fs: {
      async resolve(path, opts) {
        state.fsCalls.push({ op: "resolve", path, signal: opts?.signal });
        return { targetKey: path, displayPath: path };
      },
      async readBytes(target, _signal, maxBytes) {
        state.fsCalls.push({ op: "readBytes", target, maxBytes });
        if (bytes.byteLength > maxBytes) throw new Error("fs limit exceeded");
        return bytes;
      },
    },
    credentials: {
      async resolve(ref) {
        if (credential === null) throw new Error("missing credential");
        return credential;
      },
    },
  };
  return ctx;
}

const fetchMock = (responder) => {
  globalThis.fetch = async (url, init) => {
    fetchMock.last = { url, init };
    return responder(url, init);
  };
};

const okResponse = (content) => ({
  ok: true,
  status: 200,
  async text() {
    return JSON.stringify({
      model: "Qwen/Qwen3-VL-32B-Instruct",
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
  },
});

test("exports the expected plugin metadata", () => {
  assert.equal(name, "analyze-image-tool");
  assert.ok(inject.includes("tools"));
  assert.ok(inject.includes("systemPrompt"));
  assert.ok(inject.includes("fs"));
  assert.ok(inject.includes("credentials"));
  assert.ok(inject.includes("attachments"));
});

test("Config carries documented defaults", () => {
  const parsed = Config({});
  assert.equal(parsed.baseURL, "https://api.siliconflow.cn/v1");
  assert.equal(parsed.model, "Qwen/Qwen3-VL-32B-Instruct");
  assert.equal(parsed.maxTokens, 2048);
  assert.equal(parsed.timeoutMs, 60_000);
  assert.equal(parsed.maxImageBytes, 10 * 1024 * 1024);
  assert.equal(parsed.apiKey, "");
});

test("Config accepts any OpenAI-compatible endpoint override", () => {
  const parsed = Config({
    baseURL: "http://localhost:11434/v1",
    model: "qwen3-vl:4b",
    apiKey: "",
    maxTokens: 4096,
    timeoutMs: 120_000,
  });
  assert.equal(parsed.baseURL, "http://localhost:11434/v1");
  assert.equal(parsed.model, "qwen3-vl:4b");
  assert.equal(parsed.maxTokens, 4096);
});

test("apply registers an object-rooted, safely declared analyze_image tool", () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  assert.ok(ctx.state.tool, "tool must be registered");
  const tool = ctx.state.tool;
  assert.equal(tool.name, "analyze_image");
  assert.equal(typeof tool.description, "string");
  assert.ok(tool.description.length > 80);
  // defineTool compiles the parameter spec into an object-rooted JSON Schema,
  // exactly the safe form that guards the #297 tool-schema crash.
  assert.equal(tool.parameters.type, "object");
  assert.equal(tool.parameters.properties.path.type, "string");
  assert.equal(tool.parameters.properties.attachment_id.type, "string");
  assert.ok(!(tool.parameters.required ?? []).includes("path"), "path is optional now (attachment_id is the composer-image alternative)");
  assert.equal(tool.parameters.properties.prompt.type, "string");
  // Output schema root must be a proper JSON Schema object.
  assert.equal(tool.output.schema.type, "object");
  assert.equal(tool.output.schema.additionalProperties, false);
  assert.ok(tool.output.schema.required.includes("text"));
  // A prompt guidance section is installed.
  assert.ok(ctx.state.promptSection);
  assert.match(ctx.state.promptSection.text, /analyze_image/);
});

test("execute analyzes a local image through the fs seam and returns structured text", async () => {
  const ctx = fakeCtx({ bytes: Buffer.from("fake-png-bytes") });
  apply(ctx, { apiKey: "sk-config-key" });
  fetchMock(() => okResponse("A login form with two fields."));
  const exec = { signal: undefined };
  const result = await ctx.state.tool.execute({ path: "/tmp/desktop/shot.png", prompt: "Describe it" }, exec);
  assert.equal(result.text, "A login form with two fields.");
  assert.equal(result.model, "Qwen/Qwen3-VL-32B-Instruct");
  assert.equal(result.usage.promptTokens, 5);
  // The fs seam is addressed by resolved FsTarget, never a raw path string:
  // resolve() gets the raw path, readBytes() gets the resolved target.
  const resolveCall = ctx.state.fsCalls.find((call) => call.op === "resolve");
  assert.equal(resolveCall.path, "/tmp/desktop/shot.png");
  const readCall = ctx.state.fsCalls.find((call) => call.op === "readBytes");
  assert.equal(readCall.target.targetKey, "/tmp/desktop/shot.png");
  assert.equal(readCall.target.displayPath, "/tmp/desktop/shot.png");
  const body = JSON.parse(fetchMock.last.init.body);
  assert.equal(body.messages[0].content[0].image_url.url, "data:image/png;base64,ZmFrZS1wbmctYnl0ZXM=");
  assert.equal(body.messages[0].content[1].text, "Describe it");
});

test("execute supports http(s) URL sources without the fs seam", async () => {
  const ctx = fakeCtx();
  ctx.fs = undefined; // host without the fs service
  apply(ctx, { apiKey: "sk-x" });
  fetchMock(() => okResponse("Chart answer"));
  const result = await ctx.state.tool.execute(
    { path: "https://example.com/chart.png" },
    { signal: undefined },
  );
  assert.equal(result.text, "Chart answer");
  assert.equal(JSON.parse(fetchMock.last.init.body).messages[0].content[0].image_url.url, "https://example.com/chart.png");
});

test("execute resolves the API key from env as a fallback", async () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const previous = process.env.VISION_API_KEY;
  process.env.VISION_API_KEY = "sk-from-env";
  try {
    fetchMock(() => okResponse("env key worked"));
    await ctx.state.tool.execute({ path: "https://example.com/a.png" }, { signal: undefined });
    assert.equal(fetchMock.last.init.headers.authorization, "Bearer sk-from-env");
  } finally {
    if (previous === undefined) delete process.env.VISION_API_KEY;
    else process.env.VISION_API_KEY = previous;
  }
});

test("execute throws a helpful error when no API key and endpoint is remote", async () => {
  const ctx = fakeCtx();
  apply(ctx, {}); // no apiKey config, no env
  delete process.env.VISION_API_KEY;
  delete process.env.SILICONFLOW_API_KEY;
  await assert.rejects(
    () => ctx.state.tool.execute({ path: "https://example.com/a.png" }, { signal: undefined }),
    /no API key/,
  );
});

test("execute allows keyless local endpoints", async () => {
  const ctx = fakeCtx();
  apply(ctx, { baseURL: "http://localhost:11434/v1", model: "qwen3-vl:4b" });
  fetchMock(() => okResponse("local ollama answer"));
  const result = await ctx.state.tool.execute({ path: "https://example.com/a.png" }, { signal: undefined });
  assert.equal(result.text, "local ollama answer");
  assert.equal(fetchMock.last.init.headers.authorization, undefined);
});

test("execute requires path or attachment_id and reports read failures", async () => {
  const ctx = fakeCtx();
  apply(ctx, { apiKey: "sk-x" });
  await assert.rejects(
    () => ctx.state.tool.execute({ path: "" }, { signal: undefined }),
    /provide either `path` or `attachment_id`/,
  );
  await assert.rejects(
    () => ctx.state.tool.execute({ path: "/a.png", attachment_id: "sha256:x" }, { signal: undefined }),
    /provide only one of `path` or `attachment_id`/,
  );

  const badCtx = fakeCtx();
  badCtx.fs.readBytes = async () => {
    throw new Error("sandbox denied");
  };
  apply(badCtx, { apiKey: "sk-x" });
  await assert.rejects(
    () => badCtx.state.tool.execute({ path: "/blocked/x.png" }, { signal: undefined }),
    /cannot read image "\/blocked\/x.png": sandbox denied/,
  );
});

test("inbound transform rewrites composer images for a text-only model and indexes the ref", () => {
  const ctx = fakeCtx();
  apply(ctx, { apiKey: "sk-x" });
  const listener = ctx.state.listeners["apiproxy/prompt-content"];
  assert.ok(listener, "inbound transform listener must be registered");
  const payload = {
    content: [
      { type: "text", text: "看看这张图" },
      { type: "image", attachment: { attachmentId: "sha256:abc123", mediaType: "image/png", bytes: 4, width: 1, height: 1 } },
    ],
    modelInfo: { inputModalities: ["text"] },
  };
  let nextCalled = false;
  listener(payload, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(payload.content.length, 2);
  assert.equal(payload.content[0].type, "text");
  assert.equal(payload.content[1].type, "text");
  assert.match(payload.content[1].text, /sha256:abc123/);
});

test("inbound transform leaves image blocks alone for a vision-capable model", () => {
  const ctx = fakeCtx();
  apply(ctx, { apiKey: "sk-x" });
  const listener = ctx.state.listeners["apiproxy/prompt-content"];
  const imageBlock = { type: "image", attachment: { attachmentId: "sha256:v", mediaType: "image/png", bytes: 4, width: 1, height: 1 } };
  const payload = { content: [imageBlock], modelInfo: { inputModalities: ["text", "image"] } };
  let nextCalled = false;
  listener(payload, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(payload.content[0], imageBlock, "vision model keeps the raw image block");
});

test("execute reads a composer-pasted image by attachment_id", async () => {
  const ctx = fakeCtx();
  apply(ctx, { apiKey: "sk-x" });
  // Populate the ref index the same way the inbound transform does.
  const listener = ctx.state.listeners["apiproxy/prompt-content"];
  const ref = { attachmentId: "sha256:pasted", mediaType: "image/png", bytes: 16, width: 1, height: 1 };
  listener({ content: [{ type: "image", attachment: ref }], modelInfo: { inputModalities: ["text"] } }, () => {});
  fetchMock(() => okResponse("pasted image answer"));
  const result = await ctx.state.tool.execute({ attachment_id: "sha256:pasted" }, { signal: undefined });
  assert.equal(result.text, "pasted image answer");
  const body = JSON.parse(fetchMock.last.init.body);
  assert.match(body.messages[0].content[0].image_url.url, /^data:image\/png;base64,/);
});

test("composer-image bridge rewrites raw pasted images for text-only models", async () => {
  const rawImage = {
    type: "image",
    mediaType: "image/png",
    data: Buffer.from("paste-bytes").toString("base64"),
  };
  const lastRequest = {};
  const sessions = {
    async models({ payload }) {
      assert.equal(payload.sessionId, "s1");
      return { result: { ok: true, value: { current: { provider: "deepseek", model: "deepseek-chat" } } } };
    },
    async prompt(request) {
      lastRequest.request = request;
      return { result: { ok: true, value: { accepted: true } } };
    },
  };
  const originalPrompt = sessions.prompt;
  const ctx = fakeCtx({ apiProxy: { sessions }, llmInfo: { inputModalities: ["text"] } });
  apply(ctx, { apiKey: "sk-x" });

  assert.notEqual(sessions.prompt, originalPrompt, "api-proxy prompt must be wrapped");
  await sessions.prompt({
    payload: {
      sessionId: "s1",
      mode: "queue",
      content: [{ type: "text", text: "看看这张图" }, rawImage],
    },
  });

  const delivered = lastRequest.request.payload.content;
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].type, "text");
  assert.equal(delivered[1].type, "text");
  assert.match(delivered[1].text, /sha256:/);

  // The saved attachment is indexed and can be read back by the tool.
  const attachmentId = `sha256:${Buffer.from("paste-bytes").toString("hex")}`;
  fetchMock(() => okResponse("bridge answer"));
  const result = await ctx.state.tool.execute({ attachment_id: attachmentId }, { signal: undefined });
  assert.equal(result.text, "bridge answer");
  assert.match(JSON.parse(fetchMock.last.init.body).messages[0].content[0].image_url.url, /^data:image\/png;base64,/);
});

test("composer-image bridge preserves content order when the image comes first", async () => {
  const rawImage = {
    type: "image",
    mediaType: "image/png",
    data: Buffer.from("paste-bytes").toString("base64"),
  };
  const lastRequest = {};
  const sessions = {
    async models() {
      return { result: { ok: true, value: { current: { provider: "deepseek", model: "deepseek-chat" } } } };
    },
    async prompt(request) {
      lastRequest.request = request;
      return { result: { ok: true, value: { accepted: true } } };
    },
  };
  const ctx = fakeCtx({ apiProxy: { sessions }, llmInfo: { inputModalities: ["text"] } });
  apply(ctx, {});

  await sessions.prompt({
    payload: { sessionId: "s1", mode: "queue", content: [rawImage, { type: "text", text: "后一句" }] },
  });

  const delivered = lastRequest.request.payload.content;
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].type, "text");
  assert.match(delivered[0].text, /粘贴了一张图片/);
  assert.equal(delivered[1].type, "text");
  assert.equal(delivered[1].text, "后一句");
});

test("composer-image bridge leaves raw images alone for vision-capable models", async () => {
  const rawImage = {
    type: "image",
    mediaType: "image/png",
    data: Buffer.from("paste-bytes").toString("base64"),
  };
  const lastRequest = {};
  const sessions = {
    async models() {
      return { result: { ok: true, value: { current: { provider: "deepseek", model: "vision-pro" } } } };
    },
    async prompt(request) {
      lastRequest.request = request;
      return { result: { ok: true, value: { accepted: true } } };
    },
  };
  const ctx = fakeCtx({ apiProxy: { sessions }, llmInfo: { inputModalities: ["text", "image"] } });
  apply(ctx, {});

  await sessions.prompt({ payload: { sessionId: "s1", mode: "queue", content: [rawImage] } });
  assert.equal(lastRequest.request.payload.content[0], rawImage);
});

test("composer-image bridge falls back to the host path when attachment save fails", async () => {
  const rawImage = {
    type: "image",
    mediaType: "image/png",
    data: Buffer.from("paste-bytes").toString("base64"),
  };
  const lastRequest = {};
  const sessions = {
    async models() {
      return { result: { ok: true, value: { current: { provider: "deepseek", model: "deepseek-chat" } } } };
    },
    async prompt(request) {
      lastRequest.request = request;
      return { result: { ok: true, value: { accepted: true } } };
    },
  };
  const ctx = fakeCtx({ apiProxy: { sessions }, llmInfo: { inputModalities: ["text"] } });
  ctx.attachments.validateImage = async () => {
    throw new Error("storage offline");
  };
  apply(ctx, {});

  await sessions.prompt({ payload: { sessionId: "s1", mode: "queue", content: [rawImage] } });
  // The wrapper caught the storage failure and left the original content alone
  // so the host's own validation/error path can handle it.
  assert.equal(lastRequest.request.payload.content[0], rawImage);
});

test("execute falls back to plain fs resolution when the host has no fs seam", async () => {
  // When imageUrl is not precomputed, visionChat resolves the local file itself.
  const ctx = fakeCtx();
  ctx.fs = undefined;
  apply(ctx, { apiKey: "sk-x" });
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "aimg-plug-"));
  try {
    const file = join(dir, "shot.png");
    await writeFile(file, Buffer.from("png-bytes"));
    fetchMock(() => okResponse("plain fs answer"));
    const result = await ctx.state.tool.execute({ path: file }, { signal: undefined });
    assert.equal(result.text, "plain fs answer");
    assert.match(JSON.parse(fetchMock.last.init.body).messages[0].content[0].image_url.url, /^data:image\/png;base64,/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
