import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import OpenCC from 'opencc-js/t2cn'

export const name = 'dsh-vision-router'
export const inject = ['tools', 'attachments', 'llm']

const traditionalToSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' })

export function normalizeTranscription(text, locale = '') {
  const value = String(text ?? '').trim()
  return /^zh(?:-|$)/i.test(locale) ? traditionalToSimplified(value) : value
}

const ProviderConfig = z.object({
  id: z.string().required(),
  type: z.string().default('ollama'),
  baseUrl: z.string().required(),
  model: z.string().default('auto'),
  apiKeyEnv: z.string().default(''),
  priority: z.number().default(0),
})

const TtsConfig = z.object({
  enabled: z.boolean().default(true),
  autoStart: z.boolean().default(true),
  baseUrl: z.string().default('http://127.0.0.1:8000'),
  model: z.string().default('mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit'),
  voice: z.string().default('Serena'),
  responseFormat: z.string().default('wav'),
  browserFallback: z.boolean().default(false),
  maxTextCharacters: z.number().min(1).default(8000),
  keepAliveMs: z.number().min(0).default(300000),
})

export const Config = z.object({
  providers: z.array(ProviderConfig).default([{
    id: 'local-auto', type: 'ollama', baseUrl: 'http://127.0.0.1:11434',
    model: 'auto', apiKeyEnv: '', priority: 100,
  }]),
  allowRemoteFallback: z.boolean().default(false),
  automaticAttachments: z.boolean().default(true),
  archiveDirectory: z.string().default('.dsh-vision-router/images'),
  cacheDirectory: z.string().default('.dsh-vision-router/cache'),
  discoveryCacheMs: z.number().min(0).default(300000),
  resultCacheMs: z.number().min(0).default(3600000),
  resultCacheMaxEntries: z.number().min(1).default(64),
  ollamaKeepAlive: z.string().default('2m'),
  ollamaIdleUnloadMs: z.number().min(0).default(60000),
  maxVisionTokens: z.number().min(64).default(256),
  timeoutMs: z.number().min(1000).default(180000),
  maxImageBytes: z.number().min(1).default(20 * 1024 * 1024),
  realtimeAudio: z.boolean().default(true),
  transcriptionLocale: z.string().default('zh-CN'),
  audioChunkMs: z.number().min(1000).max(10000).default(1500),
  maxAudioSeconds: z.number().min(1).max(30).default(30),
  maxAudioBytes: z.number().min(1024).default(10 * 1024 * 1024),
  tts: TtsConfig.default({
    enabled: true,
    autoStart: true,
    baseUrl: 'http://127.0.0.1:8000',
    model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit',
    voice: 'Serena',
    responseFormat: 'wav',
    browserFallback: false,
    maxTextCharacters: 8000,
    keepAliveMs: 300000,
  }),
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

const GEMMA4_MODALITY_VARIANTS = [
  { pattern: /(?:^|[:_-])(?:e2b|e4b|12b)(?:$|[-_])/i, modalities: ['text', 'image', 'audio'] },
  { pattern: /(?:^|[:_-])(?:26b|31b)(?:$|[-_])/i, modalities: ['text', 'image'] },
]

/**
 * Resolve input modalities from runtime metadata, with a narrow Gemma 4
 * fallback for Ollama releases/model manifests that omit modality flags.
 * Gemma 4 26B and 31B are explicitly prevented from inheriting audio.
 */
export function modelInputModalities(model, shown = model.shown) {
  const name = String(model.name ?? model.model ?? '').toLowerCase()
  const family = String(shown?.details?.family ?? model.details?.family ?? '').toLowerCase()
  const declared = new Set([
    ...(model.capabilities ?? []),
    ...(shown?.capabilities ?? []),
  ].filter(capability => ['text', 'vision', 'image', 'audio'].includes(capability)))
  const modalities = new Set(['text'])
  if (declared.has('vision') || declared.has('image')) modalities.add('image')
  if (declared.has('audio')) modalities.add('audio')

  if (family === 'gemma4' || name.includes('gemma4')) {
    const variant = GEMMA4_MODALITY_VARIANTS.find(entry => entry.pattern.test(name))
    if (variant) {
      modalities.add('image')
      if (variant.modalities.includes('audio')) modalities.add('audio')
      else modalities.delete('audio')
    }
  }

  const infoKeys = Object.keys(shown?.model_info ?? {})
  if (infoKeys.some(key => key.includes('.vision.'))) modalities.add('image')
  if (infoKeys.some(key => key.includes('.audio.'))) modalities.add('audio')
  return [...modalities]
}

const discoveryCache = new Map()
const resultCache = new Map()
const ollamaUnloadTimers = new Map()
const ttsUnloadTimers = new Map()
const RESULT_CACHE_VERSION = 2

function resetIdleTimer(timers, key, delayMs, callback) {
  const previous = timers.get(key)
  if (previous) clearTimeout(previous)
  if (!delayMs) return timers.delete(key)
  const timer = setTimeout(() => {
    timers.delete(key)
    Promise.resolve(callback()).catch(() => {})
  }, delayMs)
  timer.unref?.()
  timers.set(key, timer)
}

function scheduleOllamaUnload(endpoint, model, delayMs) {
  resetIdleTimer(ollamaUnloadTimers, `${endpoint}\0${model}`, delayMs, () => ollamaJson(endpoint, '/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0 }),
  }, 15000))
}

function scheduleTtsUnload(endpoint, model, delayMs) {
  resetIdleTimer(ttsUnloadTimers, `${endpoint}\0${model}`, delayMs, async () => {
    const response = await fetch(`${endpoint}/v1/models?model_name=${encodeURIComponent(model)}`, {
      method: 'DELETE', signal: AbortSignal.timeout(15000),
    })
    if (!response.ok && response.status !== 404) throw new Error(`TTS unload failed with HTTP ${response.status}`)
  })
}

async function discoverVisionModelsUncached(endpoint, timeoutMs) {
  const tags = await ollamaJson(endpoint, '/api/tags', {}, timeoutMs)
  const candidates = await Promise.all((tags.models ?? []).map(async listed => {
    try {
      const shown = await ollamaJson(endpoint, '/api/show', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: listed.name }),
      }, timeoutMs)
      const candidate = { ...listed, shown }
      return modelInputModalities(candidate).includes('image') ? candidate : undefined
    } catch {
      // A single broken model must not prevent discovery of the remaining local models.
      return undefined
    }
  }))
  return candidates.filter(Boolean).sort((a, b) => visionScore(b) - visionScore(a))
}

export async function discoverAudioModels(endpoint, timeoutMs, cacheMs = 300000) {
  const models = await discoverVisionModels(endpoint, timeoutMs, cacheMs)
  return preferRealtimeAudioModels(models)
}

function preferRealtimeAudioModels(models) {
  return models
    .filter(model => modelInputModalities(model).includes('audio'))
    .sort((a, b) => audioRealtimeScore(b) - audioRealtimeScore(a))
}

function audioRealtimeScore(model) {
  const name = String(model.name ?? model.model ?? '').toLowerCase()
  let score = visionScore(model)
  // Gemma 4's effective-parameter variants are the better realtime choice even
  // when their MoE weight file is larger on disk than the dense 12B package.
  if (/(?:^|[:_-])e2b(?:$|[-_])/.test(name)) score += 300
  else if (/(?:^|[:_-])e4b(?:$|[-_])/.test(name)) score += 250
  else if (/(?:^|[:_-])12b(?:$|[-_])/.test(name)) score += 100
  return score
}

async function resolveAudioProvider(config) {
  const providers = [...config.providers]
    .filter(provider => provider.type === 'ollama')
    .sort((a, b) => b.priority - a.priority)
  const failures = []
  for (const provider of providers) {
    try {
      const endpoint = normalizeLocalEndpoint(provider.baseUrl)
      if (provider.model === 'auto') {
        const models = await discoverAudioModels(endpoint, Math.min(config.timeoutMs, 30000), config.discoveryCacheMs)
        if (models.length > 0) return { provider, endpoint, model: models[0].name }
        failures.push(`${provider.id}: no audio-capable model found`)
        continue
      }
      const shown = await ollamaJson(endpoint, '/api/show', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: provider.model }),
      }, Math.min(config.timeoutMs, 30000))
      if (modelInputModalities({ name: provider.model, shown }).includes('audio')) {
        return { provider, endpoint, model: provider.model }
      }
      failures.push(`${provider.id}/${provider.model}: model does not support audio`)
    } catch (error) {
      failures.push(`${provider.id}: ${error.message}`)
    }
  }
  throw new Error(failures.join('; ') || 'No local Ollama provider configured')
}

async function readRequestBody(req, maxBytes) {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > maxBytes) throw new Error(`Audio exceeds ${maxBytes} bytes`)
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error(`Audio exceeds ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function transcribeWithOllama(endpoint, model, audio, mime, language, timeoutMs) {
  const form = new FormData()
  form.append('model', model)
  form.append('file', new Blob([audio], { type: mime }), 'realtime.wav')
  form.append('response_format', 'json')
  if (language) form.append('language', language)
  const response = await fetch(`${endpoint}/v1/audio/transcriptions`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error?.message || data.error || `Ollama transcription failed with HTTP ${response.status}`)
  return String(data.text ?? '').trim()
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function effectiveTtsConfig(config) {
  return config.tts ?? {
    enabled: true,
    autoStart: true,
    baseUrl: 'http://127.0.0.1:8000',
    model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit',
    voice: 'Serena',
    responseFormat: 'wav',
    browserFallback: false,
    maxTextCharacters: 8000,
  }
}

function installManagedTts(ctx, config) {
  const tts = effectiveTtsConfig(config)
  if (!tts.enabled || !tts.autoStart) return () => {}
  let child
  let disposed = false
  const endpoint = normalizeLocalEndpoint(tts.baseUrl)
  const start = () => {
    if (disposed) return
    const url = new URL(endpoint)
    const installedBinary = join(homedir(), '.local', 'bin', 'mlx_audio.server')
    const command = existsSync(installedBinary) ? installedBinary : 'mlx_audio.server'
    child = spawn(command, ['--host', url.hostname, '--port', url.port || '8000'], {
      stdio: 'ignore',
      env: process.env,
    })
    child.once('error', error => {
      if (error.code !== 'ENOENT') ctx.logger.warn(error)
    })
    child.once('exit', code => {
      if (!disposed && code && code !== 0) ctx.logger.warn(`Managed MLX-Audio exited with code ${code}`)
    })
  }
  fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(1000) })
    .then(response => { if (!response.ok) start() })
    .catch(start)
  return () => {
    disposed = true
    if (child && !child.killed) child.kill('SIGTERM')
  }
}

async function ttsStatus(config) {
  const tts = effectiveTtsConfig(config)
  if (!tts.enabled) return { available: false, browserFallback: tts.browserFallback }
  const endpoint = normalizeLocalEndpoint(tts.baseUrl)
  try {
    const response = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { available: true, model: tts.model, voice: tts.voice, browserFallback: tts.browserFallback }
  } catch {
    return { available: false, model: tts.model, voice: tts.voice, browserFallback: tts.browserFallback }
  }
}

async function synthesizeSpeech(config, text, language) {
  const tts = effectiveTtsConfig(config)
  if (!tts.enabled) throw new Error('Local TTS is disabled')
  const endpoint = normalizeLocalEndpoint(tts.baseUrl)
  const response = await fetch(`${endpoint}/v1/audio/speech`, {
    method: 'POST',
    signal: AbortSignal.timeout(config.timeoutMs),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: tts.model,
      input: text,
      voice: tts.voice,
      lang_code: language === 'zh' ? 'chinese' : 'auto',
      response_format: tts.responseFormat,
      stream: false,
    }),
  })
  if (!response.ok) {
    const error = await response.text().catch(() => '')
    throw new Error(error || `TTS failed with HTTP ${response.status}`)
  }
  const result = { data: Buffer.from(await response.arrayBuffer()), mediaType: response.headers.get('content-type') || `audio/${tts.responseFormat}` }
  scheduleTtsUnload(endpoint, tts.model, tts.keepAliveMs)
  return result
}

export function installRealtimeAudioRoutes(webServer, config) {
  const capabilityPath = '/vision-router/audio/capabilities'
  const transcriptionPath = '/vision-router/audio/transcribe'
  const disposeCapabilities = webServer.register({
    kind: 'exact', path: capabilityPath,
    async handler(req, res) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const selected = await resolveAudioProvider(config)
        const tts = await ttsStatus(config)
        sendJson(res, 200, {
          available: true,
          provider: selected.provider.id,
          model: selected.model,
          chunkMs: config.audioChunkMs,
          maxSeconds: config.maxAudioSeconds,
          tts,
        })
      } catch (error) {
        sendJson(res, 200, { available: false, reason: error.message })
      }
    },
  })
  const disposeTranscription = webServer.register({
    kind: 'exact', path: transcriptionPath,
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      const mime = String(req.headers['content-type'] ?? '').split(';', 1)[0]
      if (mime !== 'audio/wav' && mime !== 'audio/x-wav') {
        return sendJson(res, 415, { error: 'Realtime audio must be mono WAV' })
      }
      try {
        const audio = await readRequestBody(req, config.maxAudioBytes)
        if (audio.length < 44) throw new Error('Audio payload is empty')
        const selected = await resolveAudioProvider(config)
        const locale = String(config.transcriptionLocale || req.headers['x-dvr-language'] || req.headers['accept-language'] || '')
          .split(',', 1)[0].trim()
        const language = locale.split('-', 1)[0]
        const rawText = await transcribeWithOllama(selected.endpoint, selected.model, audio, mime, language, config.timeoutMs)
        const text = normalizeTranscription(rawText, locale)
        scheduleOllamaUnload(selected.endpoint, selected.model, config.ollamaIdleUnloadMs)
        sendJson(res, 200, { text, provider: selected.provider.id, model: selected.model })
      } catch (error) {
        sendJson(res, 400, { error: error.message })
      }
    },
  })
  const disposeSpeech = webServer.register({
    kind: 'exact', path: '/vision-router/audio/speech',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const tts = effectiveTtsConfig(config)
        const body = await readRequestBody(req, Math.max(4096, tts.maxTextCharacters * 4))
        const parsed = JSON.parse(body.toString('utf8'))
        const text = String(parsed.text ?? '').trim()
        if (!text) throw new Error('Speech text is empty')
        if (text.length > tts.maxTextCharacters) throw new Error(`Speech text exceeds ${tts.maxTextCharacters} characters`)
        const language = /[\u3400-\u9fff]/.test(text) ? 'zh' : 'auto'
        const speech = await synthesizeSpeech(config, text, language)
        res.writeHead(200, {
          'content-type': speech.mediaType,
          'content-length': speech.data.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.end(speech.data)
      } catch (error) {
        sendJson(res, 503, { error: error.message })
      }
    },
  })
  return () => {
    disposeSpeech()
    disposeTranscription()
    disposeCapabilities()
  }
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
    return { base64: bytes.toString('base64'), mime: match[1], label: 'inline image' }
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

function rememberResult(cacheKey, entry, maxEntries = 64) {
  resultCache.delete(cacheKey)
  resultCache.set(cacheKey, entry)
  while (resultCache.size > maxEntries) resultCache.delete(resultCache.keys().next().value)
}

async function readCachedResult(config, cacheKey) {
  if (!config.resultCacheMs) return null
  const cached = resultCache.get(cacheKey)
  if (cached && Date.now() - cached.createdAt < config.resultCacheMs) {
    rememberResult(cacheKey, cached, config.resultCacheMaxEntries ?? 64)
    return cached.value
  }
  if (!config.cacheDirectory) return null
  try {
    const stored = JSON.parse(await readFile(join(resolve(config.cacheDirectory), `${cacheKey}.json`), 'utf8'))
    if (stored.version !== RESULT_CACHE_VERSION || Date.now() - stored.createdAt >= config.resultCacheMs) return null
    if (!stored.value?.model || !stored.value?.analysis) return null
    rememberResult(cacheKey, stored, config.resultCacheMaxEntries ?? 64)
    return stored.value
  } catch {
    return null
  }
}

async function writeCachedResult(config, cacheKey, value) {
  if (!config.resultCacheMs) return
  const entry = { version: RESULT_CACHE_VERSION, createdAt: Date.now(), value }
  rememberResult(cacheKey, entry, config.resultCacheMaxEntries ?? 64)
  if (!config.cacheDirectory) return
  try {
    const directory = resolve(config.cacheDirectory)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${cacheKey}.json`), JSON.stringify(entry))
  } catch {
    // A read-only cache directory must never break the actual model request.
  }
}

async function routeVision(config, image, prompt, requestedProvider) {
  const normalizedPrompt = prompt.trim().replace(/\s+/g, ' ')
  const cacheKey = createHash('sha256')
    .update(String(RESULT_CACHE_VERSION))
    .update('\0')
    .update(image.base64)
    .update('\0').update(normalizedPrompt)
    .update('\0').update(requestedProvider ?? '')
    .update('\0').update(JSON.stringify(config.providers))
    .update('\0').update(String(config.maxVisionTokens))
    .digest('hex')
  const cached = await readCachedResult(config, cacheKey)
  if (cached) return cached
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
          // Reuse the realtime audio model on memory-constrained local machines
          // to avoid swapping a second large vision model in and out of Ollama.
          const shared = config.realtimeAudio ? preferRealtimeAudioModels(models) : []
          model = (shared[0] ?? models[0]).name
        }
        const data = await ollamaJson(endpoint, '/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model, stream: false, keep_alive: config.ollamaKeepAlive,
            think: false,
            messages: [{ role: 'user', content: prompt, images: [image.base64] }],
            options: { temperature: 0.1, num_predict: config.maxVisionTokens },
          }),
        }, config.timeoutMs)
        const analysis = data.message?.content?.trim()
        if (!analysis) throw new Error(`model ${model} returned no text`)
        const result = { model: `${provider.id}/${model}`, analysis }
        await writeCachedResult(config, cacheKey, result)
        scheduleOllamaUnload(endpoint, model, config.ollamaIdleUnloadMs)
        return result
      }
      if (provider.type === 'openai-compatible') {
        const result = await openAICompatible(provider, prompt, image, config.timeoutMs)
        const routed = { model: `${provider.id}/${result.model}`, analysis: result.analysis }
        await writeCachedResult(config, cacheKey, routed)
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
        // Automatic attachment routing creates one reusable visual evidence record.
        // The original user text remains in the message for DeepSeek to interpret.
        const result = await routeVision(config, image, DEFAULT_PROMPTS.auto)
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
  if (config.realtimeAudio) {
    ctx.inject(['webServer'], audioCtx => {
      audioCtx.effect(
        () => installManagedTts(audioCtx, config),
        'vision-router:managed-tts',
      )
      audioCtx.effect(
        () => installRealtimeAudioRoutes(audioCtx.webServer, config),
        'vision-router:realtime-audio-routes',
      )
    })
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
