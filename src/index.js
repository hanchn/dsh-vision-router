import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-vision-router'
export const inject = ['tools', 'attachments', 'llm']

const ProviderConfig = z.object({
  id: z.string().required(),
  type: z.string().default('ollama'),
  baseUrl: z.string().required(),
  model: z.string().default('auto'),
  apiKeyEnv: z.string().default(''),
  priority: z.number().default(0),
})

export const Config = z.object({
  providers: z.array(ProviderConfig).default([{
    id: 'local-auto', type: 'ollama', baseUrl: 'http://127.0.0.1:11434',
    model: 'auto', apiKeyEnv: '', priority: 100,
  }]),
  allowRemoteFallback: z.boolean().default(false),
  automaticAttachments: z.boolean().default(true),
  archiveDirectory: z.string().default('.dsh-vision-router/images'),
  discoveryCacheMs: z.number().min(0).default(300000),
  resultCacheMs: z.number().min(0).default(3600000),
  ollamaKeepAlive: z.string().default('30m'),
  maxVisionTokens: z.number().min(64).default(512),
  timeoutMs: z.number().min(1000).default(180000),
  maxImageBytes: z.number().min(1).default(20 * 1024 * 1024),
})

const DEFAULT_PROMPTS = {
  auto: 'Analyze this image thoroughly. Describe visible content, transcribe important text, and identify details useful for completing the user task. Clearly state uncertainty. Reply in the language used by the user request.',
  describe: 'Describe this image precisely, including objects, people, environment, composition, colors, and important details. Clearly state uncertainty.',
  ocr: 'Transcribe all visible text faithfully. Preserve reading order and structure where possible. Then summarize what the text means.',
  ui: 'Analyze this user interface. Describe its layout, components, visible states, content, usability issues, and actionable implementation details.',
  chart: 'Analyze this chart or data visualization. Identify axes, legends, values, trends, comparisons, anomalies, and the main conclusion. Do not invent unreadable values.',
  code: 'Read the visible code, terminal, or error message. Transcribe the important content and explain the likely technical issue and useful next steps.',
}

function normalizeLocalEndpoint(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Ollama providers must use a local HTTP endpoint')
  }
  return url.origin
}

async function ollamaJson(endpoint, path, init = {}, timeoutMs = 10000) {
  const signal = AbortSignal.timeout(timeoutMs)
  const response = await fetch(`${endpoint}${path}`, { ...init, signal })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ollama ${path} failed with HTTP ${response.status}`)
  return data
}

async function openAICompatible(provider, prompt, image, timeoutMs) {
  const baseUrl = new URL(provider.baseUrl).toString().replace(/\/$/, '')
  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined
  if (provider.apiKeyEnv && !apiKey) throw new Error(`Missing API key environment variable ${provider.apiKeyEnv}`)
  if (!provider.model || provider.model === 'auto') throw new Error(`Provider ${provider.id} requires an explicit model`)
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.1,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } },
        ],
      }],
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error?.message || `Provider ${provider.id} failed with HTTP ${response.status}`)
  const analysis = data.choices?.[0]?.message?.content?.trim()
  if (!analysis) throw new Error(`Provider ${provider.id} returned no text`)
  return { model: provider.model, analysis }
}

function visionScore(model) {
  const details = model.details ?? {}
  const size = Number(model.size ?? Number.MAX_SAFE_INTEGER)
  const family = String(details.family ?? '').toLowerCase()
  let score = 0
  if (/gemma4|gemma3|qwen.*vl|llava|minicpm|vision/.test(family)) score += 100
  if (/gemma4|gemma3|qwen.*vl|llava|minicpm|vision/.test(String(model.name).toLowerCase())) score += 30
  score -= Math.log2(Math.max(size, 1))
  return score
}

const discoveryCache = new Map()
const resultCache = new Map()

async function discoverVisionModelsUncached(endpoint, timeoutMs) {
  const tags = await ollamaJson(endpoint, '/api/tags', {}, timeoutMs)
  const candidates = await Promise.all((tags.models ?? []).map(async listed => {
    try {
      const shown = await ollamaJson(endpoint, '/api/show', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: listed.name }),
      }, timeoutMs)
      const keys = Object.keys(shown.model_info ?? {})
      return keys.some(key => key.includes('.vision.')) ? { ...listed, shown } : undefined
    } catch {
      // A single broken model must not prevent discovery of the remaining local models.
      return undefined
    }
  }))
  return candidates.filter(Boolean).sort((a, b) => visionScore(b) - visionScore(a))
}

async function discoverVisionModels(endpoint, timeoutMs, cacheMs = 300000) {
  const cached = discoveryCache.get(endpoint)
  if (cached && Date.now() - cached.createdAt < cacheMs) return cached.value
  const pending = discoverVisionModelsUncached(endpoint, timeoutMs)
  discoveryCache.set(endpoint, { createdAt: Date.now(), value: pending })
  try {
    return await pending
  } catch (error) {
    discoveryCache.delete(endpoint)
    throw error
  }
}

function mimeFor(path) {
  const ext = extname(path).toLowerCase()
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' })[ext]
}

async function loadImage(imagePath, maxImageBytes) {
  if (imagePath.startsWith('data:image/')) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(imagePath)
    if (!match) throw new Error('Unsupported image data URL')
    const bytes = Buffer.from(match[2], 'base64')
    if (bytes.length > maxImageBytes) throw new Error(`Image exceeds ${maxImageBytes} bytes`)
    return { base64: match[2], mime: match[1], label: 'inline image' }
  }
  const absolute = resolve(imagePath)
  const mime = mimeFor(absolute)
  if (!mime) throw new Error('Supported image types: PNG, JPEG, WebP, and GIF')
  const info = await stat(absolute)
  if (!info.isFile()) throw new Error('Image path is not a file')
  if (info.size > maxImageBytes) throw new Error(`Image exceeds ${maxImageBytes} bytes`)
  const bytes = await readFile(absolute)
  return { base64: bytes.toString('base64'), mime, label: absolute }
}

const MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

async function archiveImage(data, mediaType, directory) {
  if (!directory) return
  const extension = MIME_EXTENSIONS[mediaType]
  if (!extension) return
  const targetDirectory = resolve(directory)
  const digest = createHash('sha256').update(data).digest('hex')
  await mkdir(targetDirectory, { recursive: true })
  await writeFile(join(targetDirectory, `${digest}${extension}`), data, { flag: 'wx' }).catch(error => {
    if (error.code !== 'EEXIST') throw error
  })
}

async function routeVision(config, image, prompt, requestedProvider) {
  const cacheKey = createHash('sha256')
    .update(image.base64)
    .update('\0').update(prompt)
    .update('\0').update(requestedProvider ?? '')
    .update('\0').update(JSON.stringify(config.providers))
    .digest('hex')
  const cached = resultCache.get(cacheKey)
  if (cached && Date.now() - cached.createdAt < config.resultCacheMs) return cached.value
  const providers = [...config.providers].sort((a, b) => b.priority - a.priority)
  const selected = requestedProvider
    ? providers.filter(provider => provider.id === requestedProvider)
    : providers.filter(provider => provider.type === 'ollama' || config.allowRemoteFallback)
  if (selected.length === 0) {
    throw new Error(requestedProvider ? `Unknown provider ${requestedProvider}` : 'No eligible vision provider configured')
  }
  const failures = []
  for (const provider of selected) {
    try {
      if (provider.type === 'ollama') {
        const endpoint = normalizeLocalEndpoint(provider.baseUrl)
        let model = provider.model
        if (model === 'auto') {
          const models = await discoverVisionModels(endpoint, Math.min(config.timeoutMs, 30000), config.discoveryCacheMs)
          if (models.length === 0) throw new Error('no local model with vision metadata was found')
          model = models[0].name
        }
        const data = await ollamaJson(endpoint, '/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model, stream: false, keep_alive: config.ollamaKeepAlive,
            messages: [{ role: 'user', content: prompt, images: [image.base64] }],
            options: { temperature: 0.1, num_predict: config.maxVisionTokens },
          }),
        }, config.timeoutMs)
        const analysis = data.message?.content?.trim()
        if (!analysis) throw new Error(`model ${model} returned no text`)
        const result = { model: `${provider.id}/${model}`, analysis }
        resultCache.set(cacheKey, { createdAt: Date.now(), value: result })
        return result
      }
      if (provider.type === 'openai-compatible') {
        const result = await openAICompatible(provider, prompt, image, config.timeoutMs)
        const routed = { model: `${provider.id}/${result.model}`, analysis: result.analysis }
        resultCache.set(cacheKey, { createdAt: Date.now(), value: routed })
        return routed
      }
      throw new Error(`unsupported provider type ${provider.type}`)
    } catch (error) {
      failures.push(`${provider.id}: ${error.message}`)
    }
  }
  throw new Error(`All eligible vision providers failed: ${failures.join('; ')}`)
}

export async function replaceImageAttachments(attachments, config, messages, signal) {
  if (!config.automaticAttachments) return messages
  const rewritten = []
  for (const message of messages) {
    if (!message.content.some(block => block.type === 'image')) {
      rewritten.push(message)
      continue
    }
    const userText = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    const content = []
    for (const block of message.content) {
      signal?.throwIfAborted()
      if (block.type !== 'image') {
        content.push(block)
        continue
      }
      try {
        const stored = await attachments.readImage(block.attachment, signal)
        if (stored.data.byteLength > config.maxImageBytes) {
          throw new Error(`image exceeds ${config.maxImageBytes} bytes`)
        }
        const bytes = Buffer.from(stored.data)
        await archiveImage(bytes, stored.ref.mediaType, config.archiveDirectory)
        const image = {
          base64: bytes.toString('base64'),
          mime: stored.ref.mediaType,
          label: stored.ref.name ?? String(stored.ref.attachmentId),
        }
        const prompt = `${DEFAULT_PROMPTS.auto}\n\nThe user's accompanying request is:\n${userText || '(no text provided)'}`
        const result = await routeVision(config, image, prompt)
        content.push({
          type: 'text',
          text: `\n\n### Local vision context (analysis complete)\n\n- Image: ${image.label}\n- Vision model: ${result.model}\n- Instruction: Treat the analysis below as the available visual evidence. Do not search for the image file or call another vision tool unless the user explicitly requests verification.\n\n${result.analysis}\n`,
        })
      } catch (error) {
        content.push({
          type: 'text',
          text: `\n\n[Vision Router could not analyze the attached image: ${error.message}]\n`,
        })
      }
    }
    rewritten.push({ ...message, content })
  }
  return rewritten
}

function hasImage(messages) {
  return messages.some(message => message.content.some(block => block.type === 'image'))
}

export function installAdapterBridge(llm, attachments, config) {
  const restorers = new Map()
  const wrap = () => {
    for (const registration of llm.adapters?.values?.() ?? []) {
      const adapter = registration.adapter
      if (restorers.has(adapter)) continue
      const original = adapter.stream
      adapter.stream = function (options) {
        if (!hasImage(options.messages)) return original.call(this, options)
        const owner = this
        return (async function * () {
          const resolved = await owner.resolveModel(options.provider, options.model, options.signal)
          if (resolved.inputModalities?.includes('image')) {
            yield * original.call(owner, options)
            return
          }
          const messages = await replaceImageAttachments(attachments, config, options.messages, options.signal)
          yield * original.call(owner, { ...options, messages })
        })()
      }
      restorers.set(adapter, () => { adapter.stream = original })
    }
  }
  wrap()
  const disposeUpdated = llm.ctx?.on?.('llm/adapters-updated', wrap)
  return () => {
    disposeUpdated?.()
    for (const restore of restorers.values()) restore()
  }
}

export function advertiseRoutedVision(llm) {
  const original = llm.resolveModelInfo
  llm.resolveModelInfo = async function (...args) {
    const info = await original.apply(this, args)
    return {
      ...info,
      inputModalities: [...new Set([...(info.inputModalities ?? []), 'image'])],
    }
  }
  return () => {
    llm.resolveModelInfo = original
  }
}

export function apply(ctx, config) {
  if (config.automaticAttachments) {
    ctx.effect(() => advertiseRoutedVision(ctx.llm), 'vision-router:model-capability-bridge')
    ctx.effect(() => installAdapterBridge(ctx.llm, ctx.attachments, config), 'vision-router:adapter-bridge')
  }
  ctx.tools.register(defineTool({
    name: 'inspect_image',
    description: 'Inspect a local image with an automatically discovered local multimodal model. Use this whenever visual evidence from an image, screenshot, diagram, chart, UI, scanned text, or photographed error is needed. The image stays on the local machine and is sent only to local Ollama.',
    parameters: {
      image_path: {
        type: 'string',
        required: true,
        description: 'Absolute or workspace-relative path to a PNG, JPEG, WebP, or GIF image; a base64 image data URL is also accepted.',
      },
      prompt: {
        type: 'string',
        description: 'Specific question or analysis instruction for the image.',
      },
      mode: {
        type: 'string',
        enum: ['auto', 'describe', 'ocr', 'ui', 'chart', 'code'],
        description: 'Analysis preset. Defaults to auto.',
      },
      provider: {
        type: 'string',
        description: 'Optional configured provider id. Omit for privacy-aware automatic routing.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          image: { type: 'string', required: true },
          analysis: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `## Vision analysis\n\n**Image:** ${value.image}  \n**Model:** ${value.model}\n\n${value.analysis}`,
      }],
    },
    async execute(args) {
      const image = await loadImage(args.image_path, config.maxImageBytes)
      const mode = args.mode ?? 'auto'
      const prompt = args.prompt?.trim() || DEFAULT_PROMPTS[mode] || DEFAULT_PROMPTS.auto
      const result = await routeVision(config, image, prompt, args.provider)
      return { model: result.model, image: image.label, analysis: result.analysis }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Inspect image locally',
      kind: 'read',
      rawInput: { image_path: args.image_path, mode: args.mode ?? 'auto' },
    }),
  }))
}

export { discoverVisionModels }
