import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverAudioModels, discoverVisionModels, modelInputModalities } from '../src/index.js'

test('maps Gemma 4 variants to their supported modalities', () => {
  assert.deepEqual(modelInputModalities({ name: 'gemma4:e2b', details: { family: 'gemma4' } }), ['text', 'image', 'audio'])
  assert.deepEqual(modelInputModalities({ name: 'gemma4:e4b-q4_K_M', details: { family: 'gemma4' } }), ['text', 'image', 'audio'])
  assert.deepEqual(modelInputModalities({ name: 'gemma4:12b', details: { family: 'gemma4' } }), ['text', 'image', 'audio'])
  assert.deepEqual(modelInputModalities({ name: 'gemma4:26b', capabilities: ['vision', 'audio'], details: { family: 'gemma4' } }), ['text', 'image'])
  assert.deepEqual(modelInputModalities({ name: 'gemma4:31b-it', details: { family: 'gemma4' } }), ['text', 'image'])
})

test('keeps runtime-declared modalities for other model families', () => {
  assert.deepEqual(modelInputModalities({ name: 'other:model', capabilities: ['completion', 'audio'] }), ['text', 'audio'])
})

test('discovers a real local vision model from Ollama metadata', async () => {
  const models = await discoverVisionModels('http://127.0.0.1:11434', 30000)
  assert.ok(models.length > 0, 'expected at least one local vision model')
  assert.ok(modelInputModalities(models[0]).includes('image'))
})

test('discovers a real local audio-capable model', async () => {
  const models = await discoverAudioModels('http://127.0.0.1:11434', 30000)
  assert.ok(models.length > 0, 'expected at least one local audio-capable model')
  assert.ok(modelInputModalities(models[0]).includes('audio'))
})
