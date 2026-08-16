import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { replaceImageAttachments } from '../src/index.js'

const imagePath = '/Applications/Ollama.app/Contents/Resources/ollama.png'
const config = {
  providers: [{
    id: 'local-auto', type: 'ollama', baseUrl: 'http://127.0.0.1:11434',
    model: 'auto', apiKeyEnv: '', priority: 100,
  }],
  allowRemoteFallback: false,
  automaticAttachments: true,
  timeoutMs: 180000,
  maxImageBytes: 20 * 1024 * 1024,
}

test('turns a native DSH image attachment into text before the main model', { timeout: 240000 }, async () => {
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
  const rewritten = await replaceImageAttachments(attachments, config, messages, new AbortController().signal)
  assert.equal(rewritten[0].content.some(block => block.type === 'image'), false)
  const text = rewritten[0].content.map(block => block.text ?? '').join('')
  assert.match(text, /Vision Router automatically analyzed/)
  assert.match(text, /local-auto\/gemma4:26b/)
  assert.match(text, /End of image analysis/)
})
