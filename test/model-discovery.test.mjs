import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverVisionModels } from '../src/index.js'

test('discovers a real local vision model from Ollama metadata', async () => {
  const models = await discoverVisionModels('http://127.0.0.1:11434', 30000)
  assert.ok(models.length > 0, 'expected at least one local vision model')
  assert.ok(Object.keys(models[0].shown.model_info).some(key => key.includes('.vision.')))
})
