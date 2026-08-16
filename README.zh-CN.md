# DeepSeek Harness Vision Router

[English](README.md)

这是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的零配置、多 Provider 视觉工具。它只向 Agent 暴露一个 `inspect_image` 工具，把模型发现、路由、隐私策略和失败回退隐藏在轻量 Cordis 插件内部。

## 为什么需要 Vision Router？

DeepSeek 继续负责推理、规划和操作；Vision Router 把图片感知交给本地或显式配置的多模态模型，再将文字证据返回给 DeepSeek。默认链路只使用本机模型，不需要填写模型名或端口。

## 功能

- 根据 Ollama 模型元数据零配置发现视觉模型
- 原生支持 DSH 拖拽和剪贴板图片，并自动调用本地视觉模型
- 本地优先，默认禁止远程自动回退
- 支持多个带优先级的 Provider
- 支持 Ollama 与 OpenAI-compatible 视觉接口
- 支持任务显式选择 Provider
- 支持 PNG、JPEG、WebP、GIF 和图片 Data URL
- 提供通用描述、OCR、UI、图表、代码/错误截图预设
- API Key 仅从环境变量读取，不进入插件配置

## 环境要求

- Node.js 22.19+
- DeepSeek Harness `0.1.0-rc.6`
- 默认链路需要：运行于 `127.0.0.1:11434` 的 Ollama 和至少一个多模态模型

## 安装

在本仓库目录执行：

```bash
cp .env.example .env
# 只在本机编辑 .env 并填写 DEEPSEEK_API_KEY，切勿提交 .env。
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add .
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

打开 `http://127.0.0.1:3080`，把图片拖进输入框（或按 `Cmd/Ctrl+V` 粘贴），然后直接提问。Vision Router 会先分析附件，再把文字结果交给不支持视觉的 DeepSeek 主模型。

对于文件系统中的图片，也可以继续显式调用工具：

```text
使用 inspect_image 分析 /绝对路径/screenshot.png，然后解释这个 UI 的问题。
```

## 零配置工作方式

默认 Provider 调用 Ollama `/api/tags` 获取模型，再使用 `/api/show` 检查每个候选。只有 `model_info` 包含 `.vision.` 元数据的模型才会被采用。插件不会仅根据模型名称猜测是否支持视觉。

## 多 Provider 配置

在 DSH profile patch 中修改插件配置：

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

只有在允许图片自动离开本机时，才应设置 `allowRemoteFallback: true`。任务也可以通过 Provider `id` 显式选择某个已配置后端，此时不受自动回退策略影响。

启用 `automaticAttachments: true` 后，插件会先向 DSH 的请求准入层声明“已路由的视觉能力”，再在 `agent/pre-step` 阶段通过附件服务读取当前会话授权的图片，路由给视觉模型，并在纯文本主模型调用前把图片替换为带 Provider/模型信息的可审计文字结果。设为 `false` 可关闭自动处理，只保留显式的 `inspect_image` 工具。

## 隐私与安全

- 除非开启 `allowRemoteFallback`，自动路由只使用本地 Provider。
- Ollama 地址必须是通过 HTTP 访问的 `localhost` 或 `127.0.0.1`。
- 远程密钥只读取 `apiKeyEnv` 指定的环境变量。
- 真实密钥只能保存在已忽略的本地 `.env`；仓库只提交值为空的 `.env.example`。
- 不要把 API Key 写入 `cordis.patch.yml`、提示词、Issue、日志、截图或 Git 提交。
- 开启远程回退意味着图片数据可能发送给所配置的远程 Provider；启用前请确认其隐私政策。
- 上传图片只通过 DSH 附件服务读取，内部存储路径不会暴露给模型。
- 只有 Agent 调用 `inspect_image` 时才会读取文件系统图片路径。
- 每次结果都会记录 Provider 和模型，便于审计与复现。

### 本地密钥配置

```bash
cp .env.example .env
chmod 600 .env
```

然后只在本机编辑 `.env`：

```dotenv
DEEPSEEK_API_KEY=
```

仓库的 `.gitignore` 会排除 `.env` 和 `.env.*`，并仅允许提交值为空的 `.env.example` 模板。

## 工具参数

```text
inspect_image({
  image_path: "/path/image.png",
  prompt: "这个 UI 有什么问题？",
  mode: "ui",
  provider: "local-auto"
})
```

`mode` 支持 `auto`、`describe`、`ocr`、`ui`、`chart` 和 `code`。`prompt`、`mode`、`provider` 均可省略。

## 故障排查

- **没有发现视觉模型：**运行 `ollama list`，再确认 `/api/show` 返回 `.vision.` 元数据。
- **无法连接 Ollama：**确认 `curl http://127.0.0.1:11434/api/tags` 成功。
- **缺少远程密钥：**在启动 DSH 前导出 `apiKeyEnv` 配置的环境变量。
- **调用超时：**增大 `timeoutMs`；模型首次加载通常较慢。
- **图片格式不支持：**转换为 PNG、JPEG、WebP 或 GIF。
- **主模型仍提示不支持视觉：**确认 `automaticAttachments: true`，修改插件后重启 DSH，并检查 `vision-router` 已挂载。

## 开发

```bash
pnpm install
pnpm check
```

DeepSeek Harness 当前仍处于 Developer Preview，插件接口可能发生破坏性变化。本版本针对 `0.1.0-rc.6`。

## 许可证

MIT
