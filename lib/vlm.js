// vlm.js — generic OpenAI-compatible vision client (dependency-free).
//
// One request shape covers every vision/multimodal backend that speaks the
// OpenAI chat/completions protocol (SiliconFlow, DashScope compatible-mode,
// Zhipu, OpenRouter, Volcengine, Ollama, OpenAI, ...):
//   POST {baseURL}/chat/completions  with an `image_url` content part.
//
// Local image files are base64-encoded into `data:` URLs; http(s) and data:
// sources pass through untouched. The API key is redacted from every error
// message. No vendor-specific code lives here.

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

export const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
};

/**
 * Resolve `source` to a URL the endpoint accepts: pass http(s)/data: URLs
 * through, base64-encode local files (after a size check).
 */
export async function toImageUrl(source, maxImageBytes) {
  if (/^(https?|data):/.test(source)) return source;
  const mime = MIME_BY_EXT[extname(source).toLowerCase()];
  if (mime === undefined) {
    const supported = Object.keys(MIME_BY_EXT).join(" ");
    throw new Error(
      `analyze_image: unsupported image extension in ${JSON.stringify(source)} ` +
        `(supported: ${supported}, or pass an http(s)/data: URL)`,
    );
  }
  const info = await stat(source).catch(() => {
    throw new Error(`analyze_image: file not found: ${source}`);
  });
  if (info.size > maxImageBytes) {
    throw new Error(
      `analyze_image: image is ${info.size} bytes, over the ${maxImageBytes}-byte ` +
        `limit (raise maxImageBytes in the analyze-image-tool config)`,
    );
  }
  const bytes = await readFile(source);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Pull assistant text out of an OpenAI-compatible response payload. */
export function extractText(payload) {
  if (typeof payload !== "object" || payload === null) return undefined;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const content = choices[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) =>
        typeof part === "object" && part !== null && typeof part.text === "string"
          ? part.text
          : "",
      )
      .filter((text) => text !== "");
    if (parts.length > 0) return parts.join("\n");
  }
  return undefined;
}

/**
 * Thinking-mode VLMs (e.g. glm-4.1v-thinking-flash) inline reasoning as
 * <think>…</think> inside content. Strip it; a response that is ONLY an
 * unterminated think block (reasoning ate the token budget) becomes empty.
 */
export function stripThink(text) {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  if (closed !== text) return closed.trim();
  if (/^\s*<think>/.test(text)) return "";
  return text.trim();
}

/**
 * Ask a vision/multimodal model one question about one image.
 * Returns `{ text, model, usage }` or throws with an apiKey-redacted message.
 *
 * @param {object} request
 * @param {string} request.baseURL        OpenAI-compatible base URL (/chat/completions is appended)
 * @param {string} request.apiKey         Bearer token; "" is allowed for keyless local endpoints
 * @param {string} request.model          Model id at the endpoint
 * @param {string} request.source         Local file path, http(s) URL, or data: URL
 * @param {string} [request.imageUrl]     Precomputed image URL (overrides source resolution; used when the caller already read the file through the sandboxed fs seam)
 * @param {string} request.question       What to ask about the image
 * @param {number} request.maxTokens      Completion token budget
 * @param {number} request.timeoutMs      Request timeout
 * @param {number} request.maxImageBytes  Size cap for local image files
 * @param {AbortSignal} [request.signal]  Caller abort signal
 * @param {typeof fetch} [request.fetchImpl]  Injectable fetch (test seam)
 */
export async function visionChat(request) {
  const doFetch = request.fetchImpl ?? fetch;
  const url = `${request.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const imageUrl = request.imageUrl ?? (await toImageUrl(request.source, request.maxImageBytes));
  const redact = (text) =>
    request.apiKey === "" ? text : text.replaceAll(request.apiKey, "***");

  const signals = [AbortSignal.timeout(request.timeoutMs)];
  if (request.signal !== undefined) signals.push(request.signal);

  let response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(request.apiKey === "" ? {} : { authorization: `Bearer ${request.apiKey}` }),
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: imageUrl } },
              { type: "text", text: request.question },
            ],
          },
        ],
      }),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(redact(`analyze_image: request to ${url} failed: ${reason}`));
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      redact(`analyze_image: ${url} returned ${response.status}: ${body.slice(0, 500)}`),
    );
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(
      redact(`analyze_image: ${url} returned non-JSON body: ${body.slice(0, 200)}`),
    );
  }
  const text = extractText(payload);
  if (text === undefined) {
    throw new Error(
      redact(`analyze_image: no assistant text in response: ${body.slice(0, 300)}`),
    );
  }
  const cleaned = stripThink(text);
  if (cleaned === "") {
    throw new Error(
      "analyze_image: model returned only reasoning and no answer (try raising maxTokens)",
    );
  }
  const usage = payload.usage;
  return {
    text: cleaned,
    ...(typeof payload.model === "string" ? { model: payload.model } : {}),
    ...(typeof usage === "object" && usage !== null
      ? {
          usage: {
            ...(typeof usage.prompt_tokens === "number" ? { promptTokens: usage.prompt_tokens } : {}),
            ...(typeof usage.completion_tokens === "number"
              ? { completionTokens: usage.completion_tokens }
              : {}),
          },
        }
      : {}),
  };
}
