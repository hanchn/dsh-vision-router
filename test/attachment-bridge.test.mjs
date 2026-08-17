import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { installAdapterBridge } from '../src/index.js'

const imagePath = '/Applications/Ollama.app/Contents/Resources/ollama.png'
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

test('keeps the DSH image message intact and rewrites only the adapter request', { timeout: 240000 }, async () => {
  const data = await readFile(imagePath)
  const ref = {
    attachmentId: 'sha256:test-image', mediaType: 'image/png', bytes: data.byteLength,
    width: 32, height: 32, name: 'ollama.png',
  }
  const attachments = {
    async readImage(received) {
      assert.equal(received, ref)
      return { ref, data }
    },
  }
  const messages = [{
    role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'What is in this image?' }, { type: 'image', attachment: ref }],
  }]
  let received
  const adapter = {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text'] }
    },
    async * stream(options) {
      received = options
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const llm = { adapters: new Map([['deepseek', { adapter }]]) }
  const dispose = installAdapterBridge(llm, attachments, config)
  const options = {
    provider: 'deepseek', model: 'deepseek-chat', messages,
    signal: new AbortController().signal,
  }
  for await (const _chunk of adapter.stream(options)) {}
  dispose()

  assert.equal(messages[0].content.some(block => block.type === 'image'), true)
  assert.equal(received.messages[0].content.some(block => block.type === 'image'), false)
  const text = received.messages[0].content.map(block => block.text ?? '').join('')
  assert.match(text, /### Local vision context \(analysis complete\)/)
  assert.match(text, /Do not search for the image file/)
  assert.match(text, /local-auto\/gemma4:/)
})
