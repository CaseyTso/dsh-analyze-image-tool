// analyze-image-tool — a vision bridge for text-only DeepSeek Harness models.
//
// Registers one model-facing tool, `analyze_image`, that answers questions
// about an image via ANY OpenAI-compatible vision/multimodal endpoint. The
// endpoint is fully configurable (baseURL + apiKey + model); no vendor is
// hard-coded. Local files are read through the sandboxed fs seam when the host
// provides one, base64-encoded, and sent as an image_url content part; the
// vision model's textual answer comes back as the tool result.
//
// Trust: one outbound HTTPS call per invocation to the configured endpoint,
// authorized with the resolved API key (config → env → credentials seam).
// Never writes files. Error messages redact the API key.
//
// Tool schema is declared through `defineTool`'s parameter spec, which the
// harness converts into an object-rooted JSON Schema (`type: object`), so the
// plugin is safe against the tool-schema crash reported in community issue #297.

import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { extname } from "node:path";
import { visionChat, MIME_BY_EXT } from "./vlm.js";

export const name = "analyze-image-tool";
export const inject = ["tools", "systemPrompt", "fs", "credentials", "attachments"];

const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "Qwen/Qwen3-VL-32B-Instruct";
const DEFAULT_QUESTION =
  "Describe this image thoroughly. Include any visible text verbatim, the overall layout, and notable details.";

export const Config = z.object({
  baseURL: z
    .string()
    .default(DEFAULT_BASE_URL)
    .description(
      "OpenAI-compatible base URL (/chat/completions is appended). Any vision-capable endpoint works, e.g. SiliconFlow (https://api.siliconflow.cn/v1), DashScope compatible-mode (https://dashscope.aliyuncs.com/compatible-mode/v1), Zhipu (https://open.bigmodel.cn/api/paas/v4), OpenRouter (https://openrouter.ai/api/v1), or a local Ollama (http://localhost:11434/v1).",
    ),
  apiKey: z
    .string()
    .role("secret")
    .default("")
    .description(
      "API key for the endpoint. Resolved in order: this config value, $VISION_API_KEY, $SILICONFLOW_API_KEY, then the credentials seam (VISION_API_KEY, SILICONFLOW_API_KEY). Local endpoints need none.",
    ),
  model: z
    .string()
    .default(DEFAULT_MODEL)
    .description(
      "Vision/multimodal model id at the endpoint, e.g. Qwen/Qwen3-VL-32B-Instruct (SiliconFlow), qwen3-vl-flash (DashScope), glm-4.6v-flash (Zhipu, free), google/gemini-2.5-flash (OpenRouter), qwen3-vl:4b (Ollama).",
    ),
  maxTokens: z
    .number()
    .step(1)
    .min(1)
    .max(65_536)
    .default(2048)
    .description("Completion token budget for the vision call."),
  timeoutMs: z
    .number()
    .step(1)
    .min(1_000)
    .max(300_000)
    .default(60_000)
    .description("Per-request timeout in milliseconds."),
  maxImageBytes: z
    .number()
    .step(1)
    .min(1)
    .default(10 * 1024 * 1024)
    .description("Size cap for local image files (base64 overhead included by most endpoints' limits)."),
});

const PROMPT_TEXT = `## Vision (analyze_image)
The chat model itself cannot see images, but the analyze_image tool can. Whenever an image matters — a screenshot the user mentions, a local image path, an image URL, a chart, a UI mockup, or a pasted composer image referenced by an attachment id — call analyze_image instead of guessing or refusing. Pass the image via \`path\` (absolute local path, http(s) URL, or data: URL) or via \`attachment_id\` (a composer-pasted image the host converted into a text note). Ask a specific question: extract text verbatim, count objects, read a chart, describe the layout. It answers arbitrary questions, not just captions. Prefer one focused call per thing you need to know; ask a follow-up rather than one vague question.`;

const isLocalEndpoint = (baseURL) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(baseURL);

/** Resolve the API key: plugin config → env → credentials seam. Empty = keyless (local only). */
async function resolveApiKey(config, ctx) {
  const direct = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  if (direct !== "") return direct;
  for (const envName of ["VISION_API_KEY", "SILICONFLOW_API_KEY"]) {
    const fromEnv = process.env[envName];
    if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  }
  if (ctx?.credentials?.resolve) {
    for (const envName of ["VISION_API_KEY", "SILICONFLOW_API_KEY"]) {
      try {
        const credential = await ctx.credentials.resolve(credentialRef(envName));
        if (credential && typeof credential.value === "string" && credential.value !== "") {
          return credential.value;
        }
      } catch {
        // Try the next source; a missing credential reference must not fail the chain.
      }
    }
  }
  return "";
}

/** In-process index of composer-pasted image refs (attachmentId -> ImageAttachmentRef). */
const refsByAttachmentId = new Map();

const toBase64 = (bytes) => Buffer.from(bytes).toString("base64");

export function apply(ctx, config = {}) {
  const resolved = {
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    model: config.model ?? DEFAULT_MODEL,
    maxTokens: config.maxTokens ?? 2048,
    timeoutMs: config.timeoutMs ?? 60_000,
    maxImageBytes: config.maxImageBytes ?? 10 * 1024 * 1024,
  };
  const local = isLocalEndpoint(resolved.baseURL);

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "analyze_image",
        description:
          "Analyze or read an image with an external vision/multimodal model and answer a question about it. " +
          "Use this whenever a task requires visual recognition — reading text inside an image, describing its content, " +
          "identifying objects or layout — and the current model cannot see images itself. " +
          "Accepts an absolute local file path, an http(s) URL, a data: URL, or a composer-pasted image by attachment id.",
        parameters: {
          path: {
            type: "string",
            description:
              "The image: absolute local file path, http(s) URL, or data: URL (PNG/JPEG/WebP/GIF/BMP/TIFF/HEIC). Mutually exclusive with attachment_id.",
          },
          attachment_id: {
            type: "string",
            description:
              "The attachment id of a composer-pasted image (e.g. sha256:…), as named in the text note the host injected when a text-only model received a pasted image. Mutually exclusive with path.",
          },
          prompt: {
            type: "string",
            description:
              "What to find out about the image. Be specific (extract text verbatim, count objects, read the chart, describe the layout). Default: a thorough description including any visible text.",
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: {
                type: "string",
                required: true,
                description: "The vision model's textual answer.",
              },
              model: {
                type: "string",
                description: "The model id that produced the answer.",
              },
              usage: {
                type: "object",
                additionalProperties: false,
                properties: {
                  promptTokens: { type: "integer", description: "Prompt token count." },
                  completionTokens: { type: "integer", description: "Completion token count." },
                },
              },
            },
          },
          render: (_args, value) => [{ type: "text", text: value.text }],
        },
        timeoutMs: resolved.timeoutMs + 5_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const path = typeof args.path === "string" ? args.path : "";
          const attachmentId =
            typeof args.attachment_id === "string" ? args.attachment_id : "";
          if (path === "" && attachmentId === "") {
            throw new Error("analyze_image: provide either `path` or `attachment_id`");
          }
          if (path !== "" && attachmentId !== "") {
            throw new Error("analyze_image: provide only one of `path` or `attachment_id`");
          }
          const question =
            typeof args.prompt === "string" && args.prompt.trim() !== ""
              ? args.prompt.trim()
              : DEFAULT_QUESTION;

          const apiKey = await resolveApiKey(config, ctx);
          if (apiKey === "" && !local) {
            throw new Error(
              "analyze_image: no API key. Set the apiKey in the analyze-image-tool plugin config, " +
                "or export VISION_API_KEY (or SILICONFLOW_API_KEY) in ~/.dsh/.env, or add it to the " +
                "credentials seam. Keyless local endpoints (e.g. Ollama) need no key.",
            );
          }

          // Local path on a host with the sandboxed fs seam: read through the
          // seam so the session's path policy applies. Otherwise let the VLM
          // client resolve it (node:fs) — which also covers http(s)/data: URLs.
          // The fs seam addresses files by resolved FsTarget, not raw strings,
          // so resolve the path first (targetKey/displayPath), then read bytes.
          let imageUrl;
          let source = path;
          if (attachmentId !== "") {
            // Composer-pasted image: read the durable attachment bytes by id.
            const ref = refsByAttachmentId.get(attachmentId);
            if (ref === undefined) {
              throw new Error(
                `analyze_image: attachment "${attachmentId}" is not available in this process. ` +
                  "Re-paste the image so the inbound transform can index it, or pass a local path/URL instead.",
              );
            }
            let stored;
            try {
              stored = await ctx.attachments.readImage(ref, exec.signal);
            } catch (error) {
              throw new Error(
                `analyze_image: cannot read attachment "${attachmentId}": ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            imageUrl = `data:${ref.mediaType};base64,${toBase64(stored.data)}`;
            source = attachmentId;
          } else if (
            !/^(https?|data):/.test(path) &&
            typeof ctx.fs?.resolve === "function" &&
            typeof ctx.fs?.readBytes === "function"
          ) {
            const mime = MIME_BY_EXT[extname(path).toLowerCase()];
            if (mime === undefined) {
              throw new Error(
                `analyze_image: unsupported image extension in ${JSON.stringify(path)} ` +
                  `(supported: ${Object.keys(MIME_BY_EXT).join(" ")}, or pass an http(s)/data: URL)`,
              );
            }
            let target;
            try {
              target = await ctx.fs.resolve(path, { signal: exec.signal });
            } catch (error) {
              throw new Error(
                `analyze_image: cannot resolve image "${path}": ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            let bytes;
            try {
              bytes = await ctx.fs.readBytes(target, exec.signal, resolved.maxImageBytes);
            } catch (error) {
              throw new Error(
                `analyze_image: cannot read image "${path}": ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            if (bytes.byteLength === 0) throw new Error(`analyze_image: "${path}" is empty`);
            if (bytes.byteLength > resolved.maxImageBytes) {
              throw new Error(
                `analyze_image: image is ${bytes.byteLength} bytes, over the ${resolved.maxImageBytes}-byte limit (raise maxImageBytes in the analyze-image-tool config)`,
              );
            }
            imageUrl = `data:${mime};base64,${bytes.toString("base64")}`;
          }

          return visionChat({
            ...resolved,
            apiKey,
            imageUrl,
            source,
            question,
            signal: exec.signal,
          });
        },
      }),
    ),
    "analyze-image-tool.tool",
  );

  // Inbound transform seam: for a text-only model, rewrite composer image
  // blocks into a text note carrying the attachment id, and index the full ref
  // so analyze_image can read the bytes back by id.
  ctx.on("apiproxy/prompt-content", (payload, next) => {
    const { content, modelInfo } = payload;
    if (!Array.isArray(content)) return next();
    const supportsImage =
      modelInfo === undefined ||
      modelInfo.inputModalities === undefined ||
      modelInfo.inputModalities.includes("image");
    if (supportsImage) return next();
    payload.content = content.map((part) => {
      if (part?.type !== "image" || typeof part.attachment !== "object" || part.attachment === null) {
        return part;
      }
      refsByAttachmentId.set(part.attachment.attachmentId, part.attachment);
      return {
        type: "text",
        text:
          `用户在这条消息里粘贴了一张图片（附件 ID: ${part.attachment.attachmentId}）。` +
          "要查看图片内容，请调用 analyze_image 并传入该附件 ID（attachment_id 参数）。",
      };
    });
    return next();
  });

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: "tool:analyze-image-tool",
      order: 116,
      text: PROMPT_TEXT,
    }),
    "analyze-image-tool.prompt",
  );
}
