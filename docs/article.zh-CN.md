# 基于 DeepSeek Harness、Ollama、Gemma 与 Qwen3-TTS 构建本地视觉和实时语音插件

> 用 DeepSeek 负责推理与执行，用本地 Gemma 负责“看见”和“听见”，用 Qwen3-TTS 负责“说话”，再通过 DeepSeek Harness 组合成隐私优先、可扩展的多模态 Agent。

## 一、为什么要给 Agent 增加本地视觉与声音能力？

代码 Agent 已经可以搜索文件、执行命令、修改代码，但真实开发工作中仍然存在大量只能通过图片表达的信息：

- 产品和设计稿截图；
- 浏览器报错、终端异常和监控面板；
- 流程图、架构图和数据图表；
- 扫描文档和图片中的文字；
- 无法直接复制内容的桌面应用界面。

如果主模型没有视觉能力，或者图片包含不适合上传到云端的内部信息，Agent 就缺少了一双“眼睛”。而只有文字输入输出，也无法提供类似 GPT 的连续人机语音对话。

一个更合理的组合方式是：

```text
用户任务
   │
   ▼
DeepSeek Agent ──规划、推理、工具选择──┐
                                      │ 自动附件桥接 / inspect_image
                                      ▼
                            DSH Vision Router
                       ┌──────────────┴──────────────┐
                       ▼                             ▼
               本地 Ollama/Gemma             MLX-Audio/Qwen3-TTS
             图片理解 / 音频转文字              文字转自然语音
                       │                             │
                       └──────────文字上下文────────┘
                                      │
                                      ▼
                            DeepSeek 继续推理和执行
```

在这个架构中，Gemma 不替代 DeepSeek。Gemma 负责图片和音频输入，DeepSeek 负责理解任务、规划步骤和生成回答；由于 Gemma 4 是音频输入、文字输出，Qwen3-TTS 再把最终回答转换为声音。

## 二、为什么选择 DeepSeek Harness？

DeepSeek Harness（DSH）的核心理念是 Everything is a Plugin。模型适配器、工具、存储、Agent 循环和 Web UI 都通过 Cordis 插件组合，而不是写死在一个不可拆分的核心中。

这意味着视觉能力不需要修改 DSH 源码，只需要注册一个标准工具：

```text
inspect_image({
  image_path: "/path/to/screenshot.png",
  prompt: "分析这个界面的交互问题",
  mode: "ui"
})
```

Agent 可以像调用文件读取、Shell 或网页搜索一样调用它。插件卸载后，注册效果也会随 Cordis 生命周期自动撤销。

本文对应的开源项目是：

<https://github.com/hanchn/dsh-vision-router>

## 三、项目目标：默认黑盒，进阶可配置

Vision Router 的设计目标不是要求用户先理解模型标签、推理端口和 API 协议，而是提供尽可能简单的默认体验：

```text
安装插件 → 选择是否下载音色 → 自动发现模型能力 → 图片或连续语音对话
```

同时，专业用户仍然可以配置多个后端：

- 本地 Ollama；
- OpenAI-compatible 视觉 API；
- 企业内部部署的多模态模型；
- 按优先级排列的多个备用 Provider。

因此，插件既支持稳定的 `inspect_image` 工具，也能透明接管 DSH 原生图片附件；对内统一负责模型发现、路由、隐私策略和故障回退。

## 四、项目结构

当前版本保持了非常小的代码表面积：

```text
dsh-vision-router/
├── src/
│   ├── index.js                 # Cordis 插件、Provider、音频路由与服务托管
│   ├── client.js                # Web 端实时录音、停顿检测、打断与播放
│   └── cli.js                   # 可选 Qwen3-TTS 运行时安装器
├── test/
│   ├── model-discovery.test.mjs # 图片/音频模型能力发现测试
│   ├── realtime-audio.test.mjs  # 实时语音服务路由测试
│   ├── attachment-bridge.test.mjs # 原生附件自动桥接测试
│   └── real-tool-chain.test.mjs # 真实 DSH ToolRuntime 调用测试
├── cordis.patch.yml             # DSH bundle 配置
├── .env.example                 # 空密钥模板
├── README.md                    # 英文文档
├── README.zh-CN.md              # 中文文档
└── package.json
```

插件以 DSH bundle 的形式发布。`package.json` 中的关键声明如下：

```json
{
  "name": "@hanchn/dsh-vision-router",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

安装依赖后，DSH 会识别 `dsh.bundle.patch`，把对应配置层加入 profile。

## 五、注册一个真正的 DSH 工具

一个 DSH 工具插件至少要提供插件名称、依赖注入声明、配置 Schema 和 `apply` 生命周期入口：

```js
export const name = 'dsh-vision-router'
export const inject = ['tools', 'attachments']

export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'inspect_image',
    description: 'Inspect an image with a local or configured vision model.',
    parameters: {
      image_path: {
        type: 'string',
        required: true,
      },
      prompt: {
        type: 'string',
      },
      mode: {
        type: 'string',
        enum: ['auto', 'describe', 'ocr', 'ui', 'chart', 'code'],
      },
      provider: {
        type: 'string',
      },
    },
    async execute(args) {
      // 读取图片、选择 Provider、执行视觉推理并返回结构化结果。
    },
  }))
}
```

工具描述非常重要。它不仅是给开发者看的说明，也是主模型决定何时调用工具的上下文。描述中应该明确图片、截图、图表、OCR 和 UI 分析等适用场景。

## 六、根据运行时元数据识别图片和音频能力

本地模型常见的标签包括 `latest`、`q4`、`vision` 或自定义名称。仅依赖名字判断能力并不可靠。

Vision Router 采用两步发现方式：

1. 调用 Ollama `/api/tags` 枚举本地模型；
2. 对候选逐一调用 `/api/show`，检查 `model_info`。

插件优先读取 `/api/show` 返回的 `capabilities`，并兼容 `.vision.` 与 `.audio.` 模型元数据。对已知 Gemma 4 规格使用严格回退规则：

```js
Gemma 4 E2B / E4B / 12B → text + image + audio
Gemma 4 26B / 31B       → text + image
```

在实际测试环境中，本地 Gemma 模型返回了类似下面的字段：

```text
gemma4.vision.block_count
gemma4.vision.embedding_length
gemma4.vision.patch_size
gemma4.vision.projector.scale_factor
```

26B 和 31B 会明确移除误报的音频能力；其他模型不会仅凭名字猜测能力。这样既兼容元数据不完整的 Gemma 4 包，也不会给未知模型误开麦克风。

## 七、通过 Ollama 完成视觉推理

Ollama 的 `/api/chat` 支持在消息中携带 Base64 图片：

```js
const response = await fetch('http://127.0.0.1:11434/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: selectedModel,
    stream: false,
    messages: [{
      role: 'user',
      content: prompt,
      images: [imageBase64],
    }],
    options: {
      temperature: 0.1,
    },
  }),
})
```

视觉提取任务更强调事实一致性，因此插件使用了较低温度。同时，工具设置了图片大小上限、调用超时和格式检查，避免把错误输入直接交给模型。

当前支持：

- PNG；
- JPEG；
- WebP；
- GIF；
- Base64 图片 Data URL。

## 八、多 Provider 与隐私感知路由

插件配置不是单一的 `endpoint + model`，而是一个带优先级的 Provider 列表：

```yaml
- id: vision-router
  name: '@hanchn/dsh-vision-router'
  config:
    automaticAttachments: true
    archiveDirectory: .dsh-vision-router/images
    cacheDirectory: .dsh-vision-router/cache
    discoveryCacheMs: 300000
    resultCacheMs: 3600000
    resultCacheMaxEntries: 64
    ollamaKeepAlive: 2m
    ollamaIdleUnloadMs: 60000
    transcriptionLocale: zh-CN
    maxVisionTokens: 256
    providers:
      - id: local-auto
        type: ollama
        baseUrl: http://127.0.0.1:11434
        model: auto
        apiKeyEnv: ''
        priority: 100

      - id: company-vlm
        type: openai-compatible
        baseUrl: https://vision.example.com/v1
        model: qwen-vl
        apiKeyEnv: COMPANY_VLM_KEY
        priority: 50

    allowRemoteFallback: false
    timeoutMs: 180000
    maxImageBytes: 20971520
    realtimeAudio: true
    audioChunkMs: 1500
    maxAudioSeconds: 30
    maxAudioBytes: 10485760
    tts:
      enabled: true
      autoStart: true
      baseUrl: http://127.0.0.1:8000
      model: mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit
      voice: Serena
      responseFormat: wav
      browserFallback: false
      maxTextCharacters: 8000
      keepAliveMs: 300000
```

这里最关键的默认值是：

```yaml
allowRemoteFallback: false
```

当它为 `false` 时，自动路由只使用本地 Provider。只有用户明确选择远程 Provider，或者主动打开远程回退，图片才可能离开本机。

每次工具结果还会返回实际使用的 Provider 和模型，例如：

```text
local-auto/gemma4:26b
```

这样可以审计一次结果究竟来自哪里。

## 九、密钥管理：真实密钥绝不能进入 Git

仓库只提供空模板：

```dotenv
DEEPSEEK_API_KEY=
# COMPANY_VLM_KEY=
```

本地使用时复制模板：

```bash
cp .env.example .env
chmod 600 .env
```

然后只在本机填写真实值。`.gitignore` 必须排除 `.env` 和其他环境文件：

```gitignore
.env
.env.*
!.env.example
```

不要把 API Key 写入：

- `cordis.patch.yml`；
- README 示例；
- Prompt；
- Issue；
- 截图；
- 日志；
- Git 提交。

如果密钥曾经出现在聊天、日志或公开位置，应立即在服务商控制台轮换。

## 十、安装并启动完整应用

Qwen3-TTS 不是 Ollama 模型，而是由 MLX-Audio 运行。插件把它声明为可选依赖，安装时让用户选择，默认不下载：

```bash
brew install uv
npx @hanchn/dsh-vision-router setup-tts
```

选择启用后，插件自动管理本地服务；第一次语音回答下载约 2GB 的 0.6B 8-bit 模型。选择不下载则不开放语音对话入口，也不使用系统音色代替，但图片能力保持可用。点击麦克风会提前解锁专用浏览器音频通道，避免 TTS 冷启动较慢时被浏览器自动播放策略拦截；界面分别显示“正在生成语音”和“正在朗读”。

首先安装插件到 DSH Web profile：

```bash
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add .
```

然后启动 DSH：

```bash
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

默认地址：

```text
http://127.0.0.1:3080
```

进入“设置 → 插件 → 插件列表”，可以看到：

```text
vision-router，已挂载，已启用
```

之后可以直接拖入或粘贴图片并提问，也可以显式让 Agent 调用：

```text
请使用 inspect_image 分析 /Users/example/Desktop/screenshot.png，
提取界面中的文字，并指出可能的交互问题。
```

## 十一、如何验证它不是“看起来能运行”？

只测试 Ollama HTTP 接口还不够。插件必须经过真实的 DSH 工具运行时。

项目中的端到端测试执行了以下链路：

```text
官方 Cordis Context
  → 官方 DSH SystemPrompt
  → 官方 DSH ToolRuntime
  → 挂载 Vision Router
  → ctx.tools.execute(inspect_image)
  → Ollama
  → Gemma 视觉分析
  → 结构化 Tool Result
```

运行测试：

```bash
pnpm install
pnpm check
```

开发时的真实环境测试结果包括：

- 自动发现本地视觉模型：通过；
- `inspect_image` 注册到官方 ToolRuntime：通过；
- Gemma 对真实 PNG 图片完成分析：通过；
- DSH 原生图片附件在主模型调用前自动转换为视觉文字：通过；
- `dsh web` 启动：通过；
- DSH Web 插件列表显示已挂载、已启用：通过；
- npm 打包 dry-run：通过。
- Gemma 4 E4B 音频转写与简体中文规范化：通过；
- MLX-Audio/Qwen3-TTS 中文语音生成：通过；
- 语音能力、TTS 状态门控与浏览器播放通道：通过。

## 十二、原生附件桥接：让拖图真正可用

DSH Web 支持把图片直接拖入页面，或者把剪贴板图片粘贴到输入框。Vision Router 注入 DSH 的 `attachments` 服务，并在 Provider 适配器边界完成下面的链路：

```text
拖入/粘贴图片 → DSH attachment store → 会话保留原图缩略图
              → 本地哈希归档 → Ollama/Gemma 分析
              → 仅 Provider 请求替换为格式化文字 → DeepSeek
```

关键点是通过附件服务读取，并包装纯文本模型的 Adapter 请求，而不是修改会话消息或暴露 DSH 内部存储路径：

```js
adapter.stream = function (options) {
  if (!hasImage(options.messages)) return original.call(this, options)
  return routeImagesAtAdapterBoundary(this, original, options)
}
```

`automaticAttachments: true` 默认开启。插件还会让 DSH 的图片准入检查识别到“路由后的视觉能力”，避免请求在进入 Agent 之前就被纯文本模型能力校验拦截。视觉成功时，DeepSeek 收到带标题、图片名、Provider/模型来源和正文的 Markdown 上下文；会话历史仍展示原图。视觉失败时，插件会把失败原因变成文字，避免把不受支持的图片继续传给纯文本模型。显式的 `inspect_image` 仍可用于本地路径或 Data URL，并使用格式化结果卡片。

插件默认把图片按 SHA-256 内容摘要归档到 `.dsh-vision-router/images/`。该目录已加入 `.gitignore`，文件名不包含原始名称；设置 `archiveDirectory: ''` 可以关闭额外归档。

### 延迟优化

视觉链路的总延迟由本地模型发现、模型装载、Gemma 推理和 DeepSeek 推理共同组成。插件并行检查 Ollama 候选并缓存发现结果；图片和语音优先复用 E2B/E4B；单次视觉输出限制为 256 token；最后一次本地推理完成 60 秒后主动卸载 Gemma。自动附件使用“图片内容 + 稳定基础分析 + Provider 配置”作为缓存键，因此同一张图换一种问法仍可复用；显式 `inspect_image` 的自定义问题仍使用独立缓存键。结果在内存中最多保存 64 条，并持久化到 `.dsh-vision-router/cache`，服务重启后仍可命中，默认有效 1 小时。

TTS 采用独立回收策略：Qwen3-TTS 在最后一次朗读完成后保留 5 分钟，兼顾连续对话速度与统一内存回收。首次冷启动仍取决于本机内存带宽和模型大小，这是无法完全消除的成本。

## 十三、下一步演进方向

这个项目还可以继续扩展：

1. **本地图库管理**：提供归档清理、容量上限和可视化管理；
2. **托管 llama.cpp runner**：没有 Ollama 时自动拉起本地推理服务；
3. **更多 TTS 后端**：为非 Apple Silicon 平台提供同等的一键体验；
4. **更智能的路由**：OCR、UI、图表分别选择更合适的模型；
5. **图片预处理**：自动缩放、分块、EXIF 方向修正；
6. **结构化输出**：为 OCR、UI 元素和图表数据定义稳定 Schema；
7. **Provider 健康状态**：熔断、延迟统计和失败恢复；
8. **语音设置界面**：试听音色、语速和打断灵敏度。

## 十四、总结

构建多模态 Agent 并不意味着必须把所有能力塞进同一个大模型。一个更工程化的方式是拆分职责：

- DeepSeek 负责推理、规划和工具调用；
- Gemma 负责本地图片和音频感知；
- Qwen3-TTS 负责高质量本地语音输出；
- Ollama 提供本地推理运行时；
- DeepSeek Harness 负责插件组合、生命周期和 Agent 工具链；
- Vision Router 负责能力发现、实时语音循环、图片输入、路由和隐私策略。

最终得到的是一个小而清晰的组合：

```text
DeepSeek + DSH + Vision Router + Gemma + Qwen3-TTS
```

它既能保留云端大模型的推理能力，也能让敏感图片与声音优先在本机完成处理，并提供可打断、停顿自动发送、回答自动朗读的连续语音体验。各组件仍可独立替换，而插件对普通用户保持黑盒式的一键体验。

项目地址：<https://github.com/hanchn/dsh-vision-router>
