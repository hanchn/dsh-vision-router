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
  timeoutMs: 180000,
  maxImageBytes: 20 * 1024 * 1024,
}

test('mounts in the real DSH tool runtime and executes local vision', { timeout: 240000 }, async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
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
