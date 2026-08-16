# Vision Router for DeepSeek Harness

[简体中文](README.zh-CN.md)

A zero-config, multi-provider vision tool for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It adds one model-facing tool, `inspect_image`, while keeping model discovery, routing, privacy policy, and provider fallback behind a small Cordis plugin.

## Why Vision Router?

DeepSeek remains the reasoning agent. Vision Router delegates image perception to a local or explicitly configured multimodal model, then returns text evidence to the agent. The default path is private and requires no model name or endpoint configuration.

## Features

- Zero-config discovery of vision-capable Ollama models via model metadata
- Native DSH drag-and-drop and clipboard image intake with automatic local analysis
- Original thumbnails remain visible in chat; images are archived locally by content hash
- Local-first routing with remote fallback disabled by default
- Multiple prioritized providers
- Ollama and OpenAI-compatible vision APIs
- Explicit provider selection when a task needs it
- PNG, JPEG, WebP, GIF, and image data URL inputs
- Presets for general description, OCR, UI, charts, and visible code/errors
- API keys read from environment variables, never stored in the plugin config

## Requirements

- Node.js 22.19+
- DeepSeek Harness `0.1.0-rc.6`
- For the default path: Ollama on `127.0.0.1:11434` and a multimodal model

## Install

From this repository:

```bash
cp .env.example .env
# Edit .env locally and set DEEPSEEK_API_KEY. Never commit .env.
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add .
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

Then open `http://127.0.0.1:3080`, drag an image into the composer (or paste it with `Cmd/Ctrl+V`), and ask a question. Vision Router analyzes the attachment before a text-only DeepSeek model receives the turn.

The explicit tool also remains available for filesystem images:

```text
Use inspect_image to analyze /absolute/path/to/screenshot.png, then explain the UI issue.
```

## Zero-config behavior

The bundled default provider queries Ollama `/api/tags`, inspects candidates with `/api/show`, and accepts only models whose `model_info` contains `.vision.` metadata. It then selects the strongest eligible local candidate. Model names are not treated as proof of vision support.

## Multiple providers

Edit the plugin row in your DSH profile patch:

```yaml
- id: vision-router
  name: '@hanchn/dsh-vision-router'
  config:
    automaticAttachments: true
    archiveDirectory: .dsh-vision-router/images
    discoveryCacheMs: 300000
    resultCacheMs: 3600000
    ollamaKeepAlive: 30m
    maxVisionTokens: 512
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

Set `allowRemoteFallback: true` only when images may leave the machine automatically. A prompt can explicitly select a configured provider by passing its `id`, regardless of fallback policy.

With `automaticAttachments: true`, the plugin exposes a routed vision capability to DSH's admission layer and reads authorized attachments through its attachment service. The original message and thumbnail stay intact; only the provider-bound request is converted to formatted text at the adapter boundary. Set it to `false` to use only the explicit `inspect_image` tool.

`archiveDirectory` stores a content-addressed local copy of every automatically processed image. The default `.dsh-vision-router/images` directory is ignored by Git. Set it to an empty string to disable the extra archive; DSH's attachment store still supplies the chat preview.

Discovery results are cached for five minutes and identical image/prompt analyses for one hour. `ollamaKeepAlive` avoids repeated model reloads, while `maxVisionTokens` bounds latency and output size. Set either cache duration to `0` to disable that cache.

## Privacy and security

- Automatic routing is local-only unless `allowRemoteFallback` is enabled.
- Ollama endpoints must resolve to `localhost` or `127.0.0.1` over HTTP.
- Remote credentials are read from the environment variable named by `apiKeyEnv`.
- Store real secrets only in the ignored local `.env`; commit only `.env.example` with empty values.
- Never paste API keys into `cordis.patch.yml`, prompts, issues, logs, screenshots, or commits.
- Enabling remote fallback permits image bytes to be sent to the configured remote provider. Review its privacy policy first.
- Uploaded images are read through DSH's attachment service; internal storage paths are never exposed to the model.
- Archived filenames contain only a SHA-256 digest and image extension, not the original filename.
- Filesystem image paths are read only when the agent calls `inspect_image`.
- Provider/model identity is included in every result for auditability.

### Local secret setup

```bash
cp .env.example .env
chmod 600 .env
```

Then edit `.env` locally:

```dotenv
DEEPSEEK_API_KEY=
```

The repository `.gitignore` excludes `.env` and `.env.*`, while explicitly allowing the empty `.env.example` template.

## Tool contract

```text
inspect_image({
  image_path: "/path/image.png",
  prompt: "What is wrong with this UI?",
  mode: "ui",
  provider: "local-auto"
})
```

`mode` may be `auto`, `describe`, `ocr`, `ui`, `chart`, or `code`. `prompt`, `mode`, and `provider` are optional.

## Troubleshooting

- **No local vision model:** run `ollama list`, then verify `/api/show` includes `.vision.` metadata.
- **Ollama unavailable:** confirm `curl http://127.0.0.1:11434/api/tags` succeeds.
- **Missing remote key:** export the exact environment variable configured in `apiKeyEnv` before starting DSH.
- **Timeout:** increase `timeoutMs`; first model load can be slow.
- **Slow first image:** a 26B model can take several seconds to load and infer. Keep `ollamaKeepAlive` enabled; repeated images use the result cache.
- **Unsupported image:** convert it to PNG, JPEG, WebP, or GIF.
- **The main model says it cannot see images:** confirm `automaticAttachments: true`, restart DSH after changing the plugin, and verify that `vision-router` is mounted.

## Development

```bash
pnpm install
pnpm check
```

DeepSeek Harness is in Developer Preview and may introduce breaking plugin API changes. This release targets `0.1.0-rc.6`.

## License

MIT
