# analyze-image-tool

给纯文本的 DeepSeek Harness 模型加上「眼睛」：注册一个 `analyze_image` 工具，把图片和问题转发给**任意 OpenAI 兼容的视觉/多模态端点**，把答案以文本返回。装上之后，即使主模型本身不支持图片输入，所有 dsh 入口（web、TUI、远程通道）也能识图。

Vision bridge for text-only DeepSeek Harness models: registers an `analyze_image` tool that answers questions about images via **any OpenAI-compatible vision/multimodal endpoint**. No vendor is hard-coded — bring your own `baseURL` + `apiKey` + `model`.

```
用户: 看下 ~/Desktop/error.png 是什么报错
模型 → analyze_image(path="~/Desktop/error.png", prompt="这个报错的完整文本是什么？")
     ← "TypeError: Cannot read properties of undefined (reading 'map') at …"
模型: 这是一个 … 建议 …
```

## 特性

- **通用端点**：一套配置（`baseURL` + `apiKey` + `model`）覆盖任意 OpenAI 兼容端点 —— SiliconFlow、DashScope compatible-mode、智谱、OpenRouter、火山、Ollama 本地、OpenAI……代码里零供应商逻辑。
- **沙箱安全读取**：本地图片优先走宿主提供的沙箱 fs 通道（`ctx.fs.readBytes`），遵守会话路径策略；没有该通道的宿主自动回退到 Node 原生读取。也支持 http(s) URL 和 data: URL。
- **Schema 安全**：工具参数经 `defineTool` 编译为 object 根（`type: "object"`）的标准 JSON Schema，规避了社区踩过的「工具 schema 根不是 object 导致整个会话 400 崩溃」的坑（[dsh 社区 #297](https://github.com/deepseek-ai/deepseek-harness/discussions/297)）。
- **健壮性**：API key 在报错信息中自动脱敏；思考型模型的 `<think>` 推理块自动剥离；`<think>` 独占响应当作「仅推理无答案」处理并给出可操作提示。
- **结构化返回**：`{ text, model, usage }`，附带端点的模型 id 与 token 用量。
- **多插件共存**：工具名 `analyze_image` 与社区的 `view_image` / `see_image` / `vision_glance` 等不冲突，可与 [dsh-image-bridge](https://github.com/deepseek-ai/deepseek-harness/discussions/733) 之类的粘贴桥接补丁搭配使用。
- **WebUI 设置面板**：web 会话头部右上角有一个小眼睛按钮，点开即可编辑全部设置（baseURL / apiKey / model / 调用参数 / 提示词模板）、保存/切换多套配置方案，并内置「测试连通性」。

## 安装

要求：DeepSeek Harness（`dsh`）0.1.x，Node.js ≥ 18.17。

```sh
# 从 main 分支安装（包含粘贴图片运行时桥接；正式发布后也可换成对应 tag）
dsh plugin --profile web add github:CaseyTso/analyze_image_tool#main
dsh --profile web
```

> 注意：仓库里的 `v0.1.0` tag 是早期版本，只支持本地路径/URL 识图，不含本次的粘贴图片桥接。

包内 `package.json` 声明了 `dsh.bundle.patch`，安装后会自动作为 profile 层生效，无需手工编辑 `cordis.patch.yml`。

## 配置

可以在 webui 的小眼睛面板里改（推荐），也可以在 profile 的 `cordis.patch.yml` 里针对插件 id 配置：

```yaml
- id: analyze-image-tool
  config:
    baseURL: https://api.siliconflow.cn/v1     # 任意 OpenAI 兼容端点
    apiKey: ''                                  # 可留空，走下方解析链
    model: Qwen/Qwen3-VL-32B-Instruct           # 端点上的视觉/多模态模型 id
    maxTokens: 2048
    timeoutMs: 60000                            # 大图/慢端点可调大，如 120000
    maxImageBytes: 10485760
    defaultQuestion: Describe this image thoroughly. Include any visible text verbatim, the overall layout, and notable details.
    composerNoteTemplate: 用户在这条消息里粘贴了一张图片（附件 ID: {attachment_id}）。要查看图片内容，请调用 analyze_image 并传入该附件 ID（attachment_id 参数）。
```

`composerNoteTemplate` 支持 `{attachment_id}` 与 `{image_index}` 两个占位符。

### 端点示例（都是同一套配置，任选）

| 场景 | baseURL | model 示例 | 说明 |
|---|---|---|---|
| SiliconFlow（默认） | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-VL-32B-Instruct` | 需 key，视觉能力强 |
| 阿里百炼 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-vl-flash` | 兼容模式，性价比高 |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6v-flash` | 有免费档 |
| OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-2.5-flash` | 多模型聚合 |
| Ollama 本地 | `http://localhost:11434/v1` | `qwen3-vl:4b` | 无需 key，完全离线 |

### API key 解析链（按顺序）

1. webui 面板里保存的 `apiKey`（`ctx.settings` 用户层）
2. 插件配置 `apiKey`（`cordis.patch.yml`）
3. 环境变量 `VISION_API_KEY`，其次 `SILICONFLOW_API_KEY`（可写入 `~/.dsh/.env` 或导出）
4. dsh 凭据通道（`VISION_API_KEY`，其次 `SILICONFLOW_API_KEY`）
5. 本地端点（localhost）无需 key

> 面板里 apiKey 留空 = 不覆盖，继续走后续解析链。

## WebUI 设置面板

web 会话头部右上角有一个小眼睛按钮（`analyze-image-tool`）。点开后可以：

- 编辑 `baseURL` / `apiKey` / `model` / `maxTokens` / `timeoutMs` / `maxImageBytes`
- 编辑 `defaultQuestion`（模型调用 `analyze_image` 未带 `prompt` 时的默认提问）
- 编辑 `composerNoteTemplate`（粘贴图片改写成文字的模板，支持 `{attachment_id}` 和 `{image_index}`）
- 保存多套配置方案：给当前配置起名保存，之后在下拉框里选中并一键切换；默认方案来自 `cordis.patch.yml`
- 点击「测试连通性」：用一张 64x64 测试图走真实 `chat/completions` 请求，验证当前端点与模型是否可用
- 「保存」后即时生效，无需重启

面板读写走插件自带的 HTTP API（`/api/analyze-image-tool/settings`、`/api/analyze-image-tool/test`），并持久化到 dsh 的 `ctx.settings` 用户设置中。

## 工具说明

模型面对图片相关任务时调用 `analyze_image`：

- `path`（与 `attachment_id` 二选一）：图片的绝对本地路径、http(s) URL 或 data: URL（支持 PNG/JPEG/WebP/GIF/BMP/TIFF/HEIC，默认上限 10MB）。
- `attachment_id`（与 `path` 二选一）：粘贴到输入框的图片的附件 ID（形如 `sha256:…`），见下方「粘贴图片识图」。
- `prompt`（可选）：具体问题，如「逐字提取图中文字」「数一下有几个按钮」「描述布局」。默认是包含全部可见文字的详细描述。

## 粘贴图片识图（composer 图片）

纯文本模型（如 deepseek-v4-flash）本身收不到图片：DSH 会在 `apiproxy` 的 `prompt` 入站门禁就拒绝「图片 + 纯文本模型」的发送（`MODEL_DOES_NOT_SUPPORT_IMAGES`）。这个拦截点位于所有插件钩子之前。

**本插件现在内置了运行时桥接，装上即可识别对话框粘贴的图片**（无需再打宿主补丁）：

1. **包装 API 网关**：插件在 web profile 中加载时，会包装 `apiProxy.sessions.prompt`。发送含图片的消息时，先通过 `session.models` 取当前会话模型，再经 `ctx.llm.resolveModelInfo` 判断其是否支持图片输入。
2. **纯文本模型改写图片块**：若当前模型不支持图片，插件把每张图片按宿主同一套附件策略（`validateImage` → `saveImage`）持久化，然后把图片块改写成用户可见文字「用户粘贴了一张图片（附件 ID: sha256:…），要查看请调用 analyze_image(attachment_id=…)」，并把完整附件引用索引进内存。视觉模型则完全不经过改写，原生收图。
3. **模型调用**：模型看到提示后调用 `analyze_image(attachment_id="sha256:…")`，插件经 `ctx.attachments.readImage` 读回字节并转发视觉端点。

**兼容旧的宿主补丁**：如果宿主已经打过 `apiproxy/prompt-content` seam 补丁，本插件仍保留该 seam 的监听逻辑；由于运行时桥接先于 seam 运行，两条路径不会重复改写，宿主补丁成为后备路径（旧方案见 `docs/adr/0001`，运行时桥接决策见 `docs/adr/0002`）。

> 限制：附件引用索引是进程内的，服务器重启后历史会话里的附件 ID 无法再读回（需重新粘贴）；同一次会话内粘贴 → 发送 → 识图不受影响。

## 开发

```sh
npm test        # node --test，无外部依赖（fetch 为 mock）
```

## 安全说明

- 每次调用向**你配置的端点**发起一次 HTTPS 请求，图片内容会以 base64 发给该端点；不要发送你不愿交给该提供方处理的敏感图片。
- 插件不写文件、不收集数据、不代管凭据；报错信息中 API key 一律以 `***` 脱敏。

## 许可

MIT，作者为 analyze-image-tool 贡献者。
