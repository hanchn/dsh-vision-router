import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as VisionRouter from '../src/index.js'

const config = {
  providers: [{
    id: 'local-auto', type: 'ollama', baseUrl: 'http://127.0.0.1:11434',
    model: 'auto', apiKeyEnv: '', priority: 100,
  }],
  allowRemoteFallback: false,
  automaticAttachments: true,
  archiveDirectory: '',
  discoveryCacheMs: 300000,
  resultCacheMs: 3600000,
  ollamaKeepAlive: '2m',
  maxVisionTokens: 256,
  realtimeAudio: true,
  timeoutMs: 180000,
  maxImageBytes: 20 * 1024 * 1024,
}

test('mounts in the real DSH tool runtime and executes local vision', { timeout: 240000 }, async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 20 * 1024 * 1024, maxImagesPerMessage: 8,
      maxMessageImageBytes: 40 * 1024 * 1024, maxImagePixels: 40_000_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    async readImage() { throw new Error('not used in this path-based test') },
  })
  ctx.provide('llm', {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text'] }
    },
  })
  await ctx.plugin(VisionRouter, config)
  assert.ok(ctx.tools.get('inspect_image'))

  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: 'vision-router-e2e-1',
    name: 'inspect_image',
    arguments: {
      image_path: '/Applications/Ollama.app/Contents/Resources/ollama.png',
      prompt: 'Briefly identify what is visible in this application icon. Do not guess text that is not visible.',
      mode: 'describe',
    },
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.match(result.value.model, /^local-auto\//)
  assert.ok(result.value.analysis.length > 10)
})
