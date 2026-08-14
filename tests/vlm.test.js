// vlm.test.js — unit tests for the generic OpenAI-compatible vision client.
// Runs with node --test; no external dependencies (fetch is mocked).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visionChat, toImageUrl, extractText, stripThink, MIME_BY_EXT } from "../lib/vlm.js";

const OK_RESPONSE = (content, extra = {}) => ({
  ok: true,
  status: 200,
  async text() {
    return JSON.stringify({
      model: "mock-vlm",
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
      ...extra,
    });
  },
});

const makeFetch = (responder) => async (url, init) => {
  lastCall.url = url;
  lastCall.init = init;
  return responder(url, init);
};
const lastCall = {};

test("toImageUrl passes http(s) and data: URLs through untouched", async () => {
  assert.equal(await toImageUrl("https://example.com/a.png", 1024), "https://example.com/a.png");
  assert.equal(await toImageUrl("data:image/png;base64,AAAA", 1024), "data:image/png;base64,AAAA");
});

test("toImageUrl base64-encodes a local file with its MIME type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aimg-"));
  try {
    const file = join(dir, "shot.png");
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const url = await toImageUrl(file, 1024 * 1024);
    assert.match(url, /^data:image\/png;base64,/);
    assert.equal(url.slice("data:image/png;base64,".length), Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("toImageUrl rejects unsupported extensions and missing files", async () => {
  await assert.rejects(() => toImageUrl("/tmp/nope.xyz", 1024), /unsupported image extension/);
  await assert.rejects(() => toImageUrl("/tmp/does-not-exist.png", 1024), /file not found/);
});

test("toImageUrl enforces the size cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aimg-"));
  try {
    const file = join(dir, "big.webp");
    await writeFile(file, Buffer.alloc(2048));
    await assert.rejects(() => toImageUrl(file, 1024), /over the 1024-byte limit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extractText handles string and parts content", () => {
  assert.equal(extractText({ choices: [{ message: { content: "plain" } }] }), "plain");
  assert.equal(
    extractText({
      choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }],
    }),
    "a\nb",
  );
  assert.equal(extractText({ choices: [] }), undefined);
  assert.equal(extractText({}), undefined);
});

test("stripThink removes think blocks and empties think-only responses", () => {
  assert.equal(stripThink("before<think>hidden</think>after"), "beforeafter");
  assert.equal(stripThink("<think>only reasoning</think>"), "");
  assert.equal(stripThink("plain answer"), "plain answer");
});

test("visionChat posts the OpenAI-compatible multipart payload and returns text+model+usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aimg-"));
  try {
    const file = join(dir, "shot.jpeg");
    await writeFile(file, Buffer.from("jpeg-bytes"));
    const result = await visionChat({
      baseURL: "https://vlm.example/v1/",
      apiKey: "sk-secret-123",
      model: "vision-pro",
      source: file,
      question: "What error is shown?",
      maxTokens: 512,
      timeoutMs: 10_000,
      maxImageBytes: 1024 * 1024,
      fetchImpl: makeFetch(() => OK_RESPONSE("It says: TypeError.")),
    });
    assert.equal(result.text, "It says: TypeError.");
    assert.equal(result.model, "mock-vlm");
    assert.equal(result.usage.promptTokens, 11);
    assert.equal(result.usage.completionTokens, 7);
    assert.equal(lastCall.url, "https://vlm.example/v1/chat/completions");
    const body = JSON.parse(lastCall.init.body);
    assert.equal(body.model, "vision-pro");
    assert.equal(body.max_tokens, 512);
    assert.equal(body.messages[0].role, "user");
    assert.match(body.messages[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(body.messages[0].content[1].text, "What error is shown?");
    assert.equal(lastCall.init.headers.authorization, "Bearer sk-secret-123");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visionChat passes through http URL sources and honors imageUrl override", async () => {
  const result = await visionChat({
    baseURL: "https://vlm.example/v1",
    apiKey: "",
    model: "m",
    source: "https://example.com/x.png",
    question: "q",
    maxTokens: 100,
    timeoutMs: 10_000,
    maxImageBytes: 1024,
    fetchImpl: makeFetch(() => OK_RESPONSE("ok")),
  });
  assert.equal(result.text, "ok");
  assert.equal(JSON.parse(lastCall.init.body).messages[0].content[0].image_url.url, "https://example.com/x.png");

  // imageUrl override skips source resolution entirely.
  const result2 = await visionChat({
    baseURL: "https://vlm.example/v1",
    apiKey: "",
    model: "m",
    source: "/does/not/matter.png",
    imageUrl: "data:image/png;base64,QUJD",
    question: "q",
    maxTokens: 100,
    timeoutMs: 10_000,
    maxImageBytes: 1024,
    fetchImpl: makeFetch(() => OK_RESPONSE("ok2")),
  });
  assert.equal(result2.text, "ok2");
  assert.equal(JSON.parse(lastCall.init.body).messages[0].content[0].image_url.url, "data:image/png;base64,QUJD");
});

test("visionChat redacts the API key from error messages", async () => {
  await assert.rejects(
    () =>
      visionChat({
        baseURL: "https://vlm.example/v1",
        apiKey: "sk-topsecret-9",
        model: "m",
        source: "https://example.com/x.png",
        question: "q",
        maxTokens: 100,
        timeoutMs: 10_000,
        maxImageBytes: 1024,
        fetchImpl: makeFetch(() => ({ ok: false, status: 401, async text() { return "unauthorized sk-topsecret-9 leak"; } })),
      }),
    (error) => error.message.includes("sk-topsecret-9") === false && /returned 401/.test(error.message),
  );
});

test("visionChat strips think blocks and reports reasoning-only responses", async () => {
  const ok = await visionChat({
    baseURL: "https://vlm.example/v1",
    apiKey: "",
    model: "m",
    source: "https://example.com/x.png",
    question: "q",
    maxTokens: 100,
    timeoutMs: 10_000,
    maxImageBytes: 1024,
    fetchImpl: makeFetch(() => OK_RESPONSE("<think>hmm</think>Answer here.")),
  });
  assert.equal(ok.text, "Answer here.");

  await assert.rejects(
    () =>
      visionChat({
        baseURL: "https://vlm.example/v1",
        apiKey: "",
        model: "m",
        source: "https://example.com/x.png",
        question: "q",
        maxTokens: 100,
        timeoutMs: 10_000,
        maxImageBytes: 1024,
        fetchImpl: makeFetch(() => OK_RESPONSE("<think>all reasoning</think>")),
      }),
    /only reasoning/,
  );
});

test("visionChat surfaces HTTP and non-JSON errors with context", async () => {
  await assert.rejects(
    () =>
      visionChat({
        baseURL: "https://vlm.example/v1",
        apiKey: "",
        model: "m",
        source: "https://example.com/x.png",
        question: "q",
        maxTokens: 100,
        timeoutMs: 10_000,
        maxImageBytes: 1024,
        fetchImpl: makeFetch(() => ({ ok: false, status: 429, async text() { return "rate limited"; } })),
      }),
    /returned 429: rate limited/,
  );
  await assert.rejects(
    () =>
      visionChat({
        baseURL: "https://vlm.example/v1",
        apiKey: "",
        model: "m",
        source: "https://example.com/x.png",
        question: "q",
        maxTokens: 100,
        timeoutMs: 10_000,
        maxImageBytes: 1024,
        fetchImpl: makeFetch(() => ({ ok: true, status: 200, async text() { return "<html>oops</html>"; } })),
      }),
    /non-JSON body/,
  );
});

test("MIME_BY_EXT covers the documented formats", () => {
  assert.equal(MIME_BY_EXT[".png"], "image/png");
  assert.equal(MIME_BY_EXT[".jpg"], "image/jpeg");
  assert.equal(MIME_BY_EXT[".jpeg"], "image/jpeg");
  assert.equal(MIME_BY_EXT[".webp"], "image/webp");
  assert.equal(MIME_BY_EXT[".gif"], "image/gif");
});
