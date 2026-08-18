# analyze-image-tool

**English** | [中文](README.zh.md)

A vision bridge for text-only DeepSeek Harness models: registers an `analyze_image` tool that answers questions about images via **any OpenAI-compatible vision/multimodal endpoint**. No vendor is hard-coded — bring your own `baseURL` + `apiKey` + `model`.

```
用户: 看下 ~/Desktop/error.png 是什么报错
模型 → analyze_image(path="~/Desktop/error.png", prompt="这个报错的完整文本是什么？")
     ← "TypeError: Cannot read properties of undefined (reading 'map') at …"
模型: 这是一个 … 建议 …
```

## Features

- **Generic endpoint**: One config (`baseURL` + `apiKey` + `model`) covers any OpenAI-compatible endpoint — SiliconFlow, DashScope compatible-mode, Zhipu, OpenRouter, Volcano, local Ollama, OpenAI… zero vendor logic in code.
- **Sandbox-safe reading**: Local images优先走宿主沙箱 fs 通道（`ctx.fs.readBytes`），遵守会话路径策略；没有该通道的宿主自动回退到 Node 原生读取。也支持 http(s) URL 和 data: URL。
- **Schema safety**: Tool parameters compiled via `defineTool` to standard JSON Schema with object root（`type: "object"`）, avoiding the pitfall of "tool schema root is not object causing whole session 400 crash"（[dsh community #297](https://github.com/deepseek-ai/deepseek-harness/discussions/297)）。
- **Robustness**: API key auto-scrubbed in error messages; `</think>` reasoning blocks auto-stripped from thinking models; `</think>`-only responses treated as "reasoning without answer" with actionable prompts.
- **Structured return**: `{ text, model, usage }` with endpoint model id and token counts.
- **Coexistence**: Tool name `analyze_image` doesn't conflict with community's `view_image` / `see_image` / `vision_glance`; works alongside patch bridges like [dsh-image-bridge](https://github.com/deepseek-ai/deepseek-harness/discussions/733).
- **WebUI settings panel**: Small eye icon in web session header corner — edit all settings (baseURL / apiKey / model / call params / prompt template), save/switch multiple configs, built-in connectivity test.

## Install

Requires: DeepSeek Harness (`dsh`) 0.1.x, Node.js ≥ 18.17.

```sh
# Install from main branch (includes runtime bridge for pasted images; switch to matching tag after release)
dsh plugin --profile web add github:CaseyTso/dsh-analyze-image-tool#main
dsh --profile web
```

> Note: The `v0.1.0` tag is an early version supporting only local path/URL image reading, without the paste-image bridge.

`package.json` declares `dsh.bundle.patch` — installed as profile layer automatically, no manual `cordis.patch.yml` editing needed.

## Configuration

Prefer the WebUI panel (recommended), or configure in profile's `cordis.patch.yml` under the plugin id:

```yaml
- id: analyze-image-tool
  config:
    baseURL: https://api.siliconflow.cn/v1     # Any OpenAI-compatible endpoint
    apiKey: ***                                  # Leave empty to use below chain
    model: Qwen/Qwen3-VL-32B-Instruct           # Vision/multimodal model id on the endpoint
    maxTokens: 2048
    timeoutMs: 60000                            # Increase for large images / slow endpoints, e.g. 120000
    maxImageBytes: 10485760
    defaultQuestion: Describe this image thoroughly. Include any visible text verbatim, the overall layout, and notable details.
    composerNoteTemplate: 用户在这条消息里粘贴了一张图片（附件 ID: {attachment_id}）。要查看图片内容，请调用 analyze_image 并传入该附件 ID（attachment_id 参数）。
```

`composerNoteTemplate` supports `{attachment_id}` and `{image_index}` placeholders.

### Endpoint Examples (same config, pick one)

| Use case | baseURL | Model example | Notes |
|---|---|---|---|
| SiliconFlow (default) | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-VL-32B-Instruct` | Requires key, strong vision |
| Alibaba DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-vl-flash` | Compatible mode, cost-effective |
| Zhipu | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6v-flash` | Free tier available |
| OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-2.5-flash` | Multi-model aggregator |
| Local Ollama | `http://localhost:11434/v1` | `qwen3-vl:4b` | No key needed, fully offline |

### API Key Resolution Chain (in order)

1. `apiKey` saved in WebUI panel（`ctx.settings` user layer）
2. Plugin config `apiKey`（`cordis.patch.yml`）
3. Environment variable `VISION_API_KEY`, then `SILICONFLOW_API_KEY`（can be in `~/.dsh/.env` or exported）
4. dsh credential channel（`VISION_API_KEY`, then `SILICONFLOW_API_KEY`）
5. Local endpoint (localhost) requires no key

> Leaving apiKey empty in the panel = no override, continues down the chain.

## WebUI Settings Panel

Two entry points:

- **Session header eye icon** (analyze-image-tool) at top-right of web session header.
- **System settings card (dsh ≥ 0.1.0-rc.7)**: web settings modal → Plugins → Plugin configuration → the `analyze-image-tool` card — the same panel, expandable like the built-in plugin cards.

Click to:

- Edit `baseURL` / `apiKey` / `model` / `maxTokens` / `timeoutMs` / `maxImageBytes`
- Edit `defaultQuestion`（default query when model calls `analyze_image` without `prompt`）
- Edit `composerNoteTemplate`（paste-image-to-text rewrite template, supports `{attachment_id}` and `{image_index}`）
- Save multiple config presets: name current config, switch via dropdown; default from `cordis.patch.yml`
- Click "Test connectivity": sends a real `chat/completions` request with a 64x64 test image to verify endpoint and model availability
- Changes take effect immediately, no restart needed

Panel读写走插件自带的 HTTP API（`/api/analyze-image-tool/settings`、`/api/analyze-image-tool/test`），并持久化到 dsh 的 `ctx.settings` 用户设置中。

## Tool Usage

Model calls `analyze_image` for image-related tasks:

- `path`（mutually exclusive with `attachment_id`）: absolute local path, http(s) URL, or data: URL（支持 PNG/JPEG/WebP/GIF/BMP/TIFF/HEIC，默认上限 10MB）。
- `attachment_id`（mutually exclusive with `path`）: attachment ID of image pasted into composer（形如 `sha256:…`）, see "Paste image recognition" below.
- `prompt`（optional）: specific question, e.g. "extract all visible text verbatim", "count buttons", "describe layout". Default is detailed description including all visible text.

## Paste Image Recognition (composer images)

Text-only models (e.g., deepseek-v4-flash) cannot receive images natively: DSH rejects "image + text-only model" at the `apiproxy` prompt inbound gate（`MODEL_DOES_NOT_SUPPORT_IMAGES`）。This interception point precedes all plugin hooks.

**This plugin now includes a runtime bridge — paste images work out of the box**（无需再打宿主补丁）:

1. **API gateway wrapping**: When loaded in web profile, plugin wraps `apiProxy.sessions.prompt`. On sending messages with images, it first fetches the current session model via `session.models`, then checks image support via `ctx.llm.resolveModelInfo`.
2. **Image block rewrite for text-only models**: If the current model doesn't support images, plugin persists each image using the host's same attachment strategy（`validateImage` → `saveImage`）, then rewrites image blocks to user-visible text "用户粘贴了一张图片（附件 ID: sha256:…），要查看请调用 analyze_image(attachment_id=…)", and indexes the full attachment reference in memory. Vision models pass through untouched, receiving images natively.
3. **Model invocation**: Model sees the prompt and calls `analyze_image(attachment_id="sha256:…")`; plugin reads bytes via `ctx.attachments.readImage` and forwards to the vision endpoint.

**Backward compatible with old host patches**: If host has already applied `apiproxy/prompt-content` seam patch, plugin retains seam listening logic; since runtime bridge runs before seam, both paths won't double-rewrite — host patch becomes fallback path（旧方案见 `docs/adr/0001`，运行时桥接决策见 `docs/adr/0002`）。

> Limitation: Attachment reference index is in-process; after server restart, attachment IDs in historical sessions can't be read back（需重新粘贴）; paste → send → recognize within the same session works fine.

## Development

```sh
npm test        # node --test, no external dependencies (fetch is mocked)
```

## Security

- Each call makes one HTTPS request to **your configured endpoint**; image content sent as base64 — don't send sensitive images you're unwilling to hand to that provider.
- Plugin writes no files, collects no data, manages no credentials; API keys always scrubbed as `***` in error messages.

## License

MIT, authors are analyze-image-tool contributors.
