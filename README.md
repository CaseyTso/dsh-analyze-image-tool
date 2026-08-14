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

## 安装

要求：DeepSeek Harness（`dsh`）0.1.x，Node.js ≥ 18.17。

```sh
dsh plugin --profile web add github:CaseyTso/analyze_image_tool#v0.1.0
dsh --profile web
```

包内 `package.json` 声明了 `dsh.bundle.patch`，安装后会自动作为 profile 层生效，无需手工编辑 `cordis.patch.yml`。

## 配置

在 profile 的 `cordis.patch.yml` 里针对插件 id 配置（或在设置界面/环境变量配置）：

```yaml
- id: analyze-image-tool
  config:
    baseURL: https://api.siliconflow.cn/v1     # 任意 OpenAI 兼容端点
    apiKey: ''                                  # 可留空，走下方解析链
    model: Qwen/Qwen3-VL-32B-Instruct           # 端点上的视觉/多模态模型 id
    maxTokens: 2048
    timeoutMs: 60000                            # 大图/慢端点可调大，如 120000
    maxImageBytes: 10485760
```

### 端点示例（都是同一套配置，任选）

| 场景 | baseURL | model 示例 | 说明 |
|---|---|---|---|
| SiliconFlow（默认） | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-VL-32B-Instruct` | 需 key，视觉能力强 |
| 阿里百炼 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-vl-flash` | 兼容模式，性价比高 |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6v-flash` | 有免费档 |
| OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-2.5-flash` | 多模型聚合 |
| Ollama 本地 | `http://localhost:11434/v1` | `qwen3-vl:4b` | 无需 key，完全离线 |

### API key 解析链（按顺序）

1. 插件配置 `apiKey`
2. 环境变量 `VISION_API_KEY`，其次 `SILICONFLOW_API_KEY`（可写入 `~/.dsh/.env` 或导出）
3. dsh 凭据通道（`VISION_API_KEY`，其次 `SILICONFLOW_API_KEY`）
4. 本地端点（localhost）无需 key

## 工具说明

模型面对图片相关任务时调用 `analyze_image`：

- `path`（与 `attachment_id` 二选一）：图片的绝对本地路径、http(s) URL 或 data: URL（支持 PNG/JPEG/WebP/GIF/BMP/TIFF/HEIC，默认上限 10MB）。
- `attachment_id`（与 `path` 二选一）：粘贴到输入框的图片的附件 ID（形如 `sha256:…`），见下方「粘贴图片识图」。
- `prompt`（可选）：具体问题，如「逐字提取图中文字」「数一下有几个按钮」「描述布局」。默认是包含全部可见文字的详细描述。

## 粘贴图片识图（composer 图片）

纯文本模型（如 deepseek-v4-flash）本身收不到图片：DSH 会在 `apiproxy` 的 `prompt` 入站门禁就拒绝「图片 + 纯文本模型」的发送（`MODEL_DOES_NOT_SUPPORT_IMAGES`）。这个拦截点在所有插件钩子之前，**纯插件绕不过**。

要让粘贴图片在纯文本模型下也能用，需要配合一个**宿主补丁**（给 DSH 加一个入站内容转换 seam），本插件已内置对应的监听逻辑：

1. **宿主补丁**：在 DSH 的 `apiproxy` `prompt` 处理器里、存图之后、图像门禁之前，加一个 `apiproxy/prompt-content` waterfall。补丁 diff、原始备份与幂等重打脚本放在本仓库外的 `dsh-host-patch/` 目录（决策记录见 `docs/adr/0001`）。
2. **插件行为**：宿主补丁就位后，纯文本模型下粘贴图片发送时，插件把图片块改写成用户可见文字「用户粘贴了一张图片（附件 ID: sha256:…），要查看请调用 analyze_image(attachment_id=…)」，并把完整附件引用索引进内存。
3. **模型调用**：模型看到提示后调用 `analyze_image(attachment_id="sha256:…")`，插件经 `ctx.attachments.readImage` 读回字节并转发视觉端点。

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
