# 基于 DeepSeek Harness、Ollama 与 Gemma 构建本地视觉插件

> 用 DeepSeek 负责推理与执行，用本地 Gemma 负责“看见”，再通过 DeepSeek Harness 把二者组合成一个隐私优先、可扩展的视觉 Agent。

## 一、为什么要给 Agent 增加本地视觉能力？

代码 Agent 已经可以搜索文件、执行命令、修改代码，但真实开发工作中仍然存在大量只能通过图片表达的信息：

- 产品和设计稿截图；
- 浏览器报错、终端异常和监控面板；
- 流程图、架构图和数据图表；
- 扫描文档和图片中的文字；
- 无法直接复制内容的桌面应用界面。

如果主模型没有视觉能力，或者图片包含不适合上传到云端的内部信息，Agent 就缺少了一双“眼睛”。

一个更合理的组合方式是：

```text
用户任务
   │
   ▼
DeepSeek Agent ──规划、推理、工具选择──┐
                                      │ 自动附件桥接 / inspect_image
                                      ▼
                            DSH Vision Router
                                      │ 自动发现与路由
                         ┌────────────┴────────────┐
                         ▼                         ▼
                  本地 Ollama/Gemma       远程视觉 API（可选）
                         │                         │
                         └────────视觉分析────────┘
                                      │
                                      ▼
                            DeepSeek 继续推理和执行
```

在这个架构中，Gemma 不替代 DeepSeek。Gemma 负责感知图片，DeepSeek 负责理解任务、规划步骤和执行后续操作。

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
安装插件 → 提供图片 → 自动发现本地模型 → 返回视觉结果
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
│   └── index.js                 # Cordis 插件、Provider 与工具实现
├── test/
│   ├── model-discovery.test.mjs # 本地视觉模型发现测试
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

## 六、不要通过模型名称猜测视觉能力

本地模型常见的标签包括 `latest`、`q4`、`vision` 或自定义名称。仅依赖名字判断能力并不可靠。

Vision Router 采用两步发现方式：

1. 调用 Ollama `/api/tags` 枚举本地模型；
2. 对候选逐一调用 `/api/show`，检查 `model_info`。

只有元数据中存在 `.vision.` 字段的模型才会进入候选列表：

```js
const keys = Object.keys(shown.model_info ?? {})
const supportsVision = keys.some(key => key.includes('.vision.'))
```

在实际测试环境中，本地 Gemma 模型返回了类似下面的字段：

```text
gemma4.vision.block_count
gemma4.vision.embedding_length
gemma4.vision.patch_size
gemma4.vision.projector.scale_factor
```

这比根据 `gemma4` 或 `vision` 字符串猜测可靠得多。

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

## 十二、原生附件桥接：让拖图真正可用

DSH Web 支持把图片直接拖入页面，或者把剪贴板图片粘贴到输入框。Vision Router 注入 DSH 的 `attachments` 服务，在 `agent/pre-step` 阶段完成下面的链路：

```text
拖入/粘贴图片 → DSH attachment store → 授权读取图片字节
              → Ollama/Gemma 分析 → 文字结果替换图片块 → DeepSeek
```

关键点是通过附件服务读取，而不是把 DSH 内部存储路径暴露给模型：

```js
ctx.on('agent/pre-step', async ({ messages, signal }, next) => {
  const decision = await next()
  if (decision?.kind === 'reject') return decision
  const rewritten = await replaceImageAttachments(ctx.attachments, config, messages, signal)
  return { kind: 'enter', value: { messages: rewritten } }
})
```

`automaticAttachments: true` 默认开启。插件还会让 DSH 的图片准入检查识别到“路由后的视觉能力”，避免请求在进入 Agent 之前就被纯文本模型能力校验拦截。视觉成功时，DeepSeek 收到带 Provider 和模型标识的文字证据；视觉失败时，插件也会把失败原因变成文字，避免把不受支持的图片继续传给纯文本模型。显式的 `inspect_image` 仍可用于本地路径或 Data URL。

## 十三、下一步演进方向

这个项目还可以继续扩展：

1. **保留原始附件展示**：在模型请求层转换内容，同时让会话历史继续显示原图缩略图；
2. **托管 llama.cpp runner**：没有 Ollama 时自动拉起本地推理服务；
3. **MLX 后端**：针对 Apple Silicon 优化；
4. **更智能的路由**：OCR、UI、图表分别选择更合适的模型；
5. **图片预处理**：自动缩放、分块、EXIF 方向修正；
6. **结构化输出**：为 OCR、UI 元素和图表数据定义稳定 Schema；
7. **Provider 健康状态**：熔断、延迟统计和失败恢复；
8. **视觉结果缓存**：使用图片哈希避免重复推理。

## 十四、总结

构建视觉 Agent 并不意味着必须把所有能力塞进同一个大模型。一个更工程化的方式是拆分职责：

- DeepSeek 负责推理、规划和工具调用；
- Gemma 负责本地视觉感知；
- Ollama 提供本地推理运行时；
- DeepSeek Harness 负责插件组合、生命周期和 Agent 工具链；
- Vision Router 负责模型发现、图片输入、路由和隐私策略。

最终得到的是一个小而清晰的组合：

```text
DeepSeek + DSH + Vision Router + Local Gemma
```

它既能保留云端大模型的推理能力，也能让敏感图片优先在本机完成处理。更重要的是，所有组件都可以替换：今天使用 Ollama 和 Gemma，未来也可以接入 llama.cpp、MLX 或企业内部视觉模型，而无需改变 Agent 使用视觉工具的方式。

项目地址：<https://github.com/hanchn/dsh-vision-router>
