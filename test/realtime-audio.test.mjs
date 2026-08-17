import assert from 'node:assert/strict'
import test from 'node:test'
import { installRealtimeAudioRoutes, normalizeTranscription } from '../src/index.js'

const config = {
  providers: [{
    id: 'local-auto', type: 'ollama', baseUrl: 'http://127.0.0.1:11434',
    model: 'auto', apiKeyEnv: '', priority: 100,
  }],
  discoveryCacheMs: 300000,
  timeoutMs: 180000,
  audioChunkMs: 1500,
  maxAudioSeconds: 30,
  maxAudioBytes: 10 * 1024 * 1024,
  tts: { enabled: false, browserFallback: false },
}

test('normalizes Chinese speech recognition to simplified Chinese', () => {
  assert.equal(normalizeTranscription('現在還是繁體字，麥克風沒有識別。', 'zh-CN'), '现在还是繁体字，麦克风没有识别。')
  assert.equal(normalizeTranscription('現在還是繁體字。', 'en-US'), '現在還是繁體字。')
})

test('exposes realtime audio only when a compatible local model is available', async () => {
  const routes = new Map()
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const dispose = installRealtimeAudioRoutes(webServer, config)
  const chunks = []
  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(chunk) { chunks.push(chunk) },
  }
  await routes.get('/multimodal-router/audio/capabilities')({ method: 'GET' }, response)
  const body = JSON.parse(chunks.join(''))
  assert.equal(response.status, 200)
  assert.equal(body.available, true)
  assert.match(body.model, /^gemma4:(?:e2b|e4b|12b)/i)
  assert.equal(body.maxSeconds, 30)
  assert.equal(body.chunkMs, 1500)
  assert.deepEqual(body.tts, { available: false, browserFallback: false })
  dispose()
  assert.equal(routes.size, 0)
})
