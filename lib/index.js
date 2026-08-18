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
const DEFAULT_COMPOSER_NOTE_TEMPLATE =
  "用户在这条消息里粘贴了一张图片（附件 ID: {attachment_id}）。" +
  "要查看图片内容，请调用 analyze_image 并传入该附件 ID（attachment_id 参数）。";
const DEFAULT_TEST_QUESTION = "Reply with exactly: ok";
const SETTINGS_NS = "analyze-image-tool";
const SETTINGS_API = "/api/analyze-image-tool/settings";
const TEST_API = "/api/analyze-image-tool/test";
const TEST_IMAGE_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfbOAYzjCH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBHxJB0nnzFu4AAAAASUVORK5CYII=";

const PROFILE_FIELD_SCHEMAS = {
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
      "API key for the endpoint. Resolved in order: panel setting, plugin config, $VISION_API_KEY, $SILICONFLOW_API_KEY, then the credentials seam. Local endpoints need none.",
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
  defaultQuestion: z
    .string()
    .default(DEFAULT_QUESTION)
    .description("Default question sent to the vision endpoint when analyze_image is called without a prompt."),
  composerNoteTemplate: z
    .string()
    .default(DEFAULT_COMPOSER_NOTE_TEMPLATE)
    .description(
      "Template for the text note that replaces a composer-pasted image for text-only models. Placeholders: {attachment_id}, {image_index}.",
    ),
};

export const Config = z.object(PROFILE_FIELD_SCHEMAS);

const ProfileSchema = z.object({
  name: z.string().default(""),
  ...PROFILE_FIELD_SCHEMAS,
});

const SettingsSchema = z.object({
  ...PROFILE_FIELD_SCHEMAS,
  activeProfile: z.string().default("default"),
  profiles: z.dict(ProfileSchema).default({}),
});

const PROMPT_TEXT = `## Vision (analyze_image)
The chat model itself cannot see images, but the analyze_image tool can. Whenever an image matters — a screenshot the user mentions, a local image path, an image URL, a chart, a UI mockup, or a pasted composer image referenced by an attachment id — call analyze_image instead of guessing or refusing. Pass the image via \`path\` (absolute local path, http(s) URL, or data: URL) or via \`attachment_id\` (a composer-pasted image the plugin converted into a text note). Ask a specific question: extract text verbatim, count objects, read a chart, describe the layout. It answers arbitrary questions, not just captions. Prefer one focused call per thing you need to know; ask a follow-up rather than one vague question.`;

const isLocalEndpoint = (baseURL) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(baseURL);

/** Resolve the API key: settings/config → env → credentials seam. Empty = keyless (local only). */
async function resolveApiKey(settings, ctx) {
  const direct = typeof settings.apiKey === "string" ? settings.apiKey.trim() : "";
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

/** Marker for the api-proxy prompt wrapper installed below. */
const PROMPT_WRAPPED = Symbol.for("analyze-image-tool.prompt-wrapped");

/** Render the composer image note from the configured template. */
function renderComposerNote(template, attachmentId, imageIndex) {
  const text =
    typeof template === "string" && template.trim() !== ""
      ? template
      : DEFAULT_COMPOSER_NOTE_TEMPLATE;
  return text
    .replaceAll("{attachment_id}", String(attachmentId))
    .replaceAll("{image_index}", String(imageIndex));
}

/** Canonical base64 decode, matching the host's wire validation. */
function decodeBase64(data) {
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("Image upload is not canonical base64.");
  }
  const decoded = Buffer.from(data, "base64");
  if (decoded.toString("base64") !== data) {
    throw new Error("Image upload is not canonical base64.");
  }
  return new Uint8Array(decoded);
}

/**
 * Resolve the session-local current model via the api-proxy's own
 * `session.models` route, so the decision matches the gate exactly.
 * Returns undefined when the model cannot be determined; callers should then
 * leave the prompt untouched and let the host run its normal behavior.
 */
async function currentSessionModel(sessions, sessionId) {
  if (typeof sessions?.models !== "function" || typeof sessionId !== "string" || sessionId === "") {
    return undefined;
  }
  try {
    const response = await sessions.models({ payload: { sessionId } });
    if (response?.result?.ok !== true) return undefined;
    const current = response.result.value?.current;
    if (typeof current?.provider !== "string" || typeof current?.model !== "string") {
      return undefined;
    }
    return { provider: current.provider, model: current.model };
  } catch {
    return undefined;
  }
}

/** True when the model declares image input, or when the host cannot tell us. */
async function modelSupportsImage(ctx, model) {
  const llm = ctx?.get?.("llm") ?? ctx?.llm;
  if (typeof llm?.resolveModelInfo !== "function") return true;
  try {
    const info = await llm.resolveModelInfo(model.provider, model.model);
    return info?.inputModalities === undefined || info.inputModalities.includes("image");
  } catch {
    return true;
  }
}

/**
 * Persist raw composer image blocks and rewrite them into text notes carrying
 * the durable attachment id, mirroring the host's `apiproxy/prompt-content`
 * seam at the raw API boundary. Two-phase validate-then-save avoids partial
 * durable writes when one of several images is invalid.
 */
async function rewriteComposerImages(ctx, content, template) {
  const attachments = ctx?.get?.("attachments") ?? ctx?.attachments;
  if (typeof attachments?.validateImage !== "function" || typeof attachments?.saveImage !== "function") {
    throw new Error("attachments service lacks image persistence methods");
  }
  const prepared = [];
  for (const part of content) {
    if (part?.type === "image") {
      if (typeof part.data !== "string" || typeof part.mediaType !== "string") {
        throw new Error("invalid composer image block");
      }
      const data = decodeBase64(part.data);
      prepared.push({
        kind: "image",
        input: {
          data,
          mediaType: part.mediaType,
          ...(typeof part.name === "string" && part.name !== "" ? { name: part.name } : {}),
        },
      });
    } else if (part?.type === "text") {
      prepared.push({ kind: "text", text: typeof part.text === "string" ? part.text : "" });
    } else {
      prepared.push({ kind: "part", part });
    }
  }

  // Enforce the host's aggregate image policy before touching storage, so the
  // bridge never accepts a prompt the host itself would reject.
  const limits = attachments.imageLimits;
  const imageItems = prepared.filter((item) => item.kind === "image");
  if (limits !== undefined && limits !== null) {
    if (
      typeof limits.maxImagesPerMessage === "number" &&
      imageItems.length > limits.maxImagesPerMessage
    ) {
      throw new Error("prompt exceeds the configured image-count limit");
    }
    if (typeof limits.maxMessageImageBytes === "number") {
      const totalBytes = imageItems.reduce((sum, item) => sum + item.input.data.byteLength, 0);
      if (totalBytes > limits.maxMessageImageBytes) {
        throw new Error("prompt exceeds the configured aggregate image-byte limit");
      }
    }
  }

  // Validate every image before saving any (same batch semantics as the host).
  for (const item of prepared) {
    if (item.kind === "image") await attachments.validateImage(item.input);
  }
  // Save and rewrite in the original content order.
  const blocks = [];
  let imageIndex = 0;
  for (const item of prepared) {
    if (item.kind === "text") {
      blocks.push({ type: "text", text: item.text });
      continue;
    }
    if (item.kind === "part") {
      blocks.push(item.part);
      continue;
    }
    const ref = await attachments.saveImage(item.input);
    refsByAttachmentId.set(ref.attachmentId, ref);
    imageIndex += 1;
    blocks.push({ type: "text", text: renderComposerNote(template, ref.attachmentId, imageIndex) });
  }
  return blocks;
}

/**
 * Install the in-process composer-image bridge on hosts that expose the
 * api-proxy service. This wraps `api.sessions.prompt` so a text-only model
 * receives a text note (and the plugin indexes the saved attachment) instead
 * of being rejected by the host's image gate. On hosts that already ship the
 * `apiproxy/prompt-content` seam, the wrapper simply runs first and the seam
 * becomes a no-op for the rewritten content; on hosts without the seam this
 * wrapper is what makes "install the plugin and paste an image" work.
 */
function installComposerImageBridge(ctx, getSettings) {
  if (typeof ctx?.get !== "function") return false;
  const apiProxy = ctx.get("apiProxy");
  if (apiProxy === undefined || apiProxy === null) return false;
  const sessions = apiProxy.sessions;
  if (sessions === undefined || sessions === null || typeof sessions.prompt !== "function") return false;
  if (sessions.prompt[PROMPT_WRAPPED] === true) return true;

  const originalPrompt = sessions.prompt;
  sessions.prompt = async function prompt(request) {
    const payload = request?.payload;
    if (
      payload !== undefined &&
      payload !== null &&
      Array.isArray(payload.content) &&
      payload.content.some((part) => part?.type === "image")
    ) {
      const model = await currentSessionModel(sessions, payload.sessionId);
      if (model !== undefined && !(await modelSupportsImage(ctx, model))) {
        const settings = getSettings();
        const template = settings?.composerNoteTemplate ?? DEFAULT_COMPOSER_NOTE_TEMPLATE;
        try {
          payload.content = await rewriteComposerImages(ctx, payload.content, template);
        } catch {
          // Fall back to the host's own path. With the seam installed that
          // still bridges the image; without it the host's image gate will
          // reject exactly as it did before this plugin was installed.
        }
      }
    }
    return originalPrompt.call(sessions, request);
  };
  sessions.prompt[PROMPT_WRAPPED] = true;
  return true;
}

/** Write one JSON response. */
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Reject non-matching HTTP methods. */
function requireMethod(req, res, method) {
  if (req.method === method) return true;
  json(res, 405, { ok: false, error: "method-not-allowed" });
  return false;
}

/** Read a bounded JSON request body. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("body-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("bad-json"));
      }
    });
    req.on("error", reject);
  });
}

/** Mask an API key for browser display: keep the first 4 and last 3 chars. */
function maskApiKey(key) {
  if (key === "") return "";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-3)}`;
}

/** The masked settings view returned to the browser panel. */
function profileView(profile, id) {
  const apiKey = typeof profile?.apiKey === "string" ? profile.apiKey : "";
  return {
    id,
    name: typeof profile?.name === "string" && profile.name.trim() !== "" ? profile.name.trim() : id,
    baseURL: profile?.baseURL ?? DEFAULT_BASE_URL,
    apiKeySet: apiKey !== "",
    apiKeyMasked: maskApiKey(apiKey),
    model: profile?.model ?? DEFAULT_MODEL,
    maxTokens: profile?.maxTokens ?? 2048,
    timeoutMs: profile?.timeoutMs ?? 60_000,
    maxImageBytes: profile?.maxImageBytes ?? 10 * 1024 * 1024,
    defaultQuestion: profile?.defaultQuestion ?? DEFAULT_QUESTION,
    composerNoteTemplate: profile?.composerNoteTemplate ?? DEFAULT_COMPOSER_NOTE_TEMPLATE,
  };
}

function settingsView(settings) {
  const apiKey = typeof settings.apiKey === "string" ? settings.apiKey : "";
  const profiles = settings.profiles !== undefined && settings.profiles !== null && typeof settings.profiles === "object"
    ? settings.profiles
    : {};
  return {
    ok: true,
    activeProfile: settings.activeProfile ?? "default",
    baseURL: settings.baseURL,
    apiKeySet: apiKey !== "",
    apiKeyMasked: maskApiKey(apiKey),
    model: settings.model,
    maxTokens: settings.maxTokens,
    timeoutMs: settings.timeoutMs,
    maxImageBytes: settings.maxImageBytes,
    defaultQuestion: settings.defaultQuestion,
    composerNoteTemplate: settings.composerNoteTemplate,
    profiles: Object.entries(profiles).map(([id, profile]) => profileView(profile, id)),
  };
}

/** Parse a profile payload from the panel, applying schema defaults/validation. */
function parseProfilePayload(fields) {
  return ProfileSchema({
    name: typeof fields.name === "string" ? fields.name.trim() : "",
    baseURL: typeof fields.baseURL === "string" && fields.baseURL.trim() !== "" ? fields.baseURL.trim() : DEFAULT_BASE_URL,
    apiKey: typeof fields.apiKey === "string" ? fields.apiKey : "",
    model: typeof fields.model === "string" && fields.model.trim() !== "" ? fields.model.trim() : DEFAULT_MODEL,
    maxTokens: typeof fields.maxTokens === "number" && Number.isFinite(fields.maxTokens) ? Math.floor(fields.maxTokens) : 2048,
    timeoutMs: typeof fields.timeoutMs === "number" && Number.isFinite(fields.timeoutMs) ? Math.floor(fields.timeoutMs) : 60_000,
    maxImageBytes: typeof fields.maxImageBytes === "number" && Number.isFinite(fields.maxImageBytes) ? Math.floor(fields.maxImageBytes) : 10 * 1024 * 1024,
    defaultQuestion: typeof fields.defaultQuestion === "string" && fields.defaultQuestion.trim() !== "" ? fields.defaultQuestion : DEFAULT_QUESTION,
    composerNoteTemplate: typeof fields.composerNoteTemplate === "string" && fields.composerNoteTemplate.trim() !== "" ? fields.composerNoteTemplate : DEFAULT_COMPOSER_NOTE_TEMPLATE,
  });
}

/**
 * Register the browser panel's HTTP surface on hosts that expose a webserver:
 * GET/POST the settings view, and POST a connectivity test that uses the same
 * chat/completions path as analyze_image.
 */
function installSettingsApi(ctx, getSettings) {
  if (typeof ctx?.inject !== "function") return false;
  ctx.inject(["webServer"], (wctx) => {
    wctx.effect(() => {
      const settings = () => wctx.get("settings");
      const currentView = () => {
        const cfg = getSettings();
        return cfg;
      };

      const settingsHandler = async (req, res) => {
        const s = settings();
        if (s === undefined) {
          json(res, 503, { ok: false, error: "settings service unavailable" });
          return;
        }
        if (req.method === "GET") {
          json(res, 200, settingsView(currentView()));
          return;
        }
        if (req.method === "POST") {
          let body;
          try {
            body = await readJsonBody(req);
          } catch (error) {
            json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
            return;
          }

          const patch = {};
          try {
            if (body.mode === "saveProfile") {
              const profileId =
                (typeof body.profileId === "string" && body.profileId.trim() !== "")
                  ? body.profileId.trim()
                  : (typeof body.profileName === "string" && body.profileName.trim() !== "")
                    ? body.profileName.trim()
                    : "";
              if (profileId === "") {
                json(res, 400, { ok: false, error: "profileId or profileName is required" });
                return;
              }
              const fields = body.profile !== undefined && body.profile !== null && typeof body.profile === "object"
                ? body.profile
                : body;
              const currentSettings = s.get(SETTINGS_NS) ?? currentView();
              const profile = parseProfilePayload({
                ...fields,
                // Preserve the currently active key when the panel saved a
                // profile without retyping the masked apiKey.
                apiKey: typeof fields.apiKey === "string" ? fields.apiKey : currentSettings.apiKey,
                name: typeof body.profileName === "string" ? body.profileName : fields.name,
              });
              patch.profiles = { [profileId]: profile };
              patch.activeProfile = profileId;
              Object.assign(patch, {
                baseURL: profile.baseURL,
                apiKey: profile.apiKey,
                model: profile.model,
                maxTokens: profile.maxTokens,
                timeoutMs: profile.timeoutMs,
                maxImageBytes: profile.maxImageBytes,
                defaultQuestion: profile.defaultQuestion,
                composerNoteTemplate: profile.composerNoteTemplate,
              });
            } else if (body.mode === "updateProfile") {
              const profileId = typeof body.profileId === "string" ? body.profileId.trim() : "";
              if (profileId === "") {
                json(res, 400, { ok: false, error: "profileId is required" });
                return;
              }
              const currentSettings = s.get(SETTINGS_NS) ?? currentView();
              const existing = currentSettings.profiles?.[profileId];
              if (existing === undefined) {
                json(res, 404, { ok: false, error: `profile "${profileId}" not found` });
                return;
              }
              const fields = body.profile !== undefined && body.profile !== null && typeof body.profile === "object"
                ? body.profile
                : body;
              const profile = parseProfilePayload({
                ...fields,
                // Preserve the selected profile's key when the panel saved
                // without retyping the masked apiKey.
                apiKey: typeof fields.apiKey === "string" ? fields.apiKey : existing.apiKey,
                name: typeof body.profileName === "string" && body.profileName.trim() !== "" ? body.profileName : existing.name,
              });
              // Update the stored profile only; do not touch the live config.
              patch.profiles = { [profileId]: profile };
            } else if (body.mode === "switchProfile") {
              const profileId = typeof body.profileId === "string" ? body.profileId : "";
              const currentProfiles = s.get(SETTINGS_NS)?.profiles ?? {};
              const profile = currentProfiles[profileId];
              if (profile === undefined) {
                json(res, 404, { ok: false, error: `profile "${profileId}" not found` });
                return;
              }
              Object.assign(patch, {
                baseURL: profile.baseURL,
                apiKey: profile.apiKey ?? "",
                model: profile.model,
                maxTokens: profile.maxTokens,
                timeoutMs: profile.timeoutMs,
                maxImageBytes: profile.maxImageBytes,
                defaultQuestion: profile.defaultQuestion,
                composerNoteTemplate: profile.composerNoteTemplate,
                activeProfile: profileId,
              });
            } else if (body.mode === "deleteProfile") {
              const profileId = typeof body.profileId === "string" ? body.profileId.trim() : "";
              if (profileId === "" || profileId === "default") {
                json(res, 400, { ok: false, error: "cannot delete the default profile" });
                return;
              }
              const currentSettings = s.get(SETTINGS_NS) ?? currentView();
              const currentActive = currentSettings.activeProfile ?? "default";
              if (profileId === currentActive) {
                // Deleting the active profile switches to default first, so the
                // live config always keeps a valid endpoint.
                const fallback = currentSettings.profiles?.default;
                if (fallback === undefined) {
                  json(res, 400, { ok: false, error: "cannot delete the active profile without the default profile" });
                  return;
                }
                await s.update(SETTINGS_NS, {
                  baseURL: fallback.baseURL,
                  apiKey: fallback.apiKey ?? "",
                  model: fallback.model,
                  maxTokens: fallback.maxTokens,
                  timeoutMs: fallback.timeoutMs,
                  maxImageBytes: fallback.maxImageBytes,
                  defaultQuestion: fallback.defaultQuestion,
                  composerNoteTemplate: fallback.composerNoteTemplate,
                  activeProfile: "default",
                });
              }
              await s.mutate(SETTINGS_NS, [{ op: "unset", path: ["profiles", profileId] }]);
              json(res, 200, settingsView(s.get(SETTINGS_NS) ?? currentView()));
              return;
            } else {
              if (typeof body.baseURL === "string" && body.baseURL.trim() !== "") patch.baseURL = body.baseURL.trim();
              if (typeof body.model === "string" && body.model.trim() !== "") patch.model = body.model.trim();
              if (typeof body.maxTokens === "number" && Number.isFinite(body.maxTokens)) patch.maxTokens = Math.floor(body.maxTokens);
              if (typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs)) patch.timeoutMs = Math.floor(body.timeoutMs);
              if (typeof body.maxImageBytes === "number" && Number.isFinite(body.maxImageBytes)) patch.maxImageBytes = Math.floor(body.maxImageBytes);
              if (typeof body.defaultQuestion === "string" && body.defaultQuestion.trim() !== "") patch.defaultQuestion = body.defaultQuestion;
              if (typeof body.composerNoteTemplate === "string" && body.composerNoteTemplate.trim() !== "") patch.composerNoteTemplate = body.composerNoteTemplate;
              if (typeof body.apiKey === "string" && body.apiKey !== "") patch.apiKey = body.apiKey;
              if (body.clearApiKey === true) patch.apiKey = "";
            }

            await s.update(SETTINGS_NS, patch);
          } catch (error) {
            json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
            return;
          }
          json(res, 200, settingsView(s.get(SETTINGS_NS) ?? currentView()));
          return;
        }
        json(res, 405, { ok: false, error: "method-not-allowed" });
      };

      const testHandler = async (req, res) => {
        if (!requireMethod(req, res, "POST")) return;
        const cfg = currentView();
        const apiKey = await resolveApiKey(cfg, ctx);
        if (apiKey === "" && !isLocalEndpoint(cfg.baseURL)) {
          json(res, 400, {
            ok: false,
            error:
              "no API key. Set the apiKey in the panel, or export VISION_API_KEY (or SILICONFLOW_API_KEY), or add it to the credentials seam. Keyless local endpoints need no key.",
          });
          return;
        }
        const started = Date.now();
        try {
          const result = await visionChat({
            ...cfg,
            apiKey,
            imageUrl: TEST_IMAGE_URL,
            source: "connectivity-test",
            question: DEFAULT_TEST_QUESTION,
            // Thinking models may spend most of a tiny budget on reasoning;
            // give the test enough headroom while still capping it for speed.
            maxTokens: Math.min(Math.max(cfg.maxTokens ?? 2048, 256), 1024),
          });
          json(res, 200, {
            ok: true,
            model: result.model,
            latencyMs: Date.now() - started,
            usage: result.usage,
            answer: result.text.slice(0, 200),
          });
        } catch (error) {
          json(res, 200, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      const disposers = [
        wctx.webServer.register({ kind: "exact", path: SETTINGS_API, handler: settingsHandler }),
        wctx.webServer.register({ kind: "exact", path: TEST_API, handler: testHandler }),
      ];
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "analyze-image-tool: settings api");
  });
  return true;
}

export function apply(ctx, config = {}) {
  const flatEntry = {
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
    model: config.model ?? DEFAULT_MODEL,
    maxTokens: config.maxTokens ?? 2048,
    timeoutMs: config.timeoutMs ?? 60_000,
    maxImageBytes: config.maxImageBytes ?? 10 * 1024 * 1024,
    defaultQuestion: config.defaultQuestion ?? DEFAULT_QUESTION,
    composerNoteTemplate: config.composerNoteTemplate ?? DEFAULT_COMPOSER_NOTE_TEMPLATE,
  };
  const entry = {
    ...flatEntry,
    activeProfile: "default",
    profiles: {
      default: {
        name: "默认方案",
        ...flatEntry,
      },
    },
  };

  // Optional settings wiring: when the host mounts ctx.settings, the panel
  // (and any future settings surface) edits the user layer over this entry.
  let current = () => entry;
  if (typeof ctx.inject === "function") {
    ctx.inject(["settings"], (sctx) => {
      const scope = sctx.settings.register(SETTINGS_NS, SettingsSchema, { base: entry });
      current = () => scope.get();
      scope.watch(() => {
        current = () => scope.get();
      });
    });
  }

  // The api-proxy gateway may not have provided `apiProxy` yet when this
  // plugin's apply runs first (rc7 activation order makes that the common
  // case). Install the composer-image bridge both immediately and again once
  // the service arrives; the PROMPT_WRAPPED marker makes the second attempt
  // a no-op when the first one already succeeded.
  if (typeof ctx.inject === "function") {
    ctx.inject(["apiProxy"], (apiCtx) => {
      installComposerImageBridge(apiCtx, () => current());
    });
  }
  installComposerImageBridge(ctx, () => current());
  installSettingsApi(ctx, () => current());

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
              "The attachment id of a composer-pasted image (e.g. sha256:…), as named in the text note the plugin injected when a text-only model received a pasted image. Mutually exclusive with path.",
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
        timeoutMs: 305_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const settings = current();
          const local = isLocalEndpoint(settings.baseURL);
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
              : typeof settings.defaultQuestion === "string" && settings.defaultQuestion.trim() !== ""
                ? settings.defaultQuestion
                : DEFAULT_QUESTION;

          const apiKey = await resolveApiKey(settings, ctx);
          if (apiKey === "" && !local) {
            throw new Error(
              "analyze_image: no API key. Set the apiKey in the analyze-image-tool panel, " +
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
              bytes = await ctx.fs.readBytes(target, exec.signal, settings.maxImageBytes);
            } catch (error) {
              throw new Error(
                `analyze_image: cannot read image "${path}": ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            if (bytes.byteLength === 0) throw new Error(`analyze_image: "${path}" is empty`);
            if (bytes.byteLength > settings.maxImageBytes) {
              throw new Error(
                `analyze_image: image is ${bytes.byteLength} bytes, over the ${settings.maxImageBytes}-byte limit (raise maxImageBytes in the analyze-image-tool settings)`,
              );
            }
            imageUrl = `data:${mime};base64,${bytes.toString("base64")}`;
          }

          return visionChat({
            ...settings,
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
    const template = current().composerNoteTemplate ?? DEFAULT_COMPOSER_NOTE_TEMPLATE;
    let imageIndex = 0;
    payload.content = content.map((part) => {
      if (part?.type !== "image" || typeof part.attachment !== "object" || part.attachment === null) {
        return part;
      }
      refsByAttachmentId.set(part.attachment.attachmentId, part.attachment);
      imageIndex += 1;
      return { type: "text", text: renderComposerNote(template, part.attachment.attachmentId, imageIndex) };
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
