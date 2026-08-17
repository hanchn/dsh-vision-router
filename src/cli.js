#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

// Pin the tested server revision so optional installs remain reproducible.
const MLX_AUDIO_SOURCE = 'git+https://github.com/Blaizzy/mlx-audio.git@6546e953908800219454d4483592c1db9d8871a8'
const START_COMMAND = 'mlx_audio.server --host 127.0.0.1 --port 8000'

function printHelp() {
  console.log(`dsh-multimodal-router

Usage:
  dsh-multimodal-router setup-tts [--enable|--disable]
                                Choose whether to install MLX-Audio/Qwen3-TTS
  dsh-multimodal-router check-tts   Check whether the local TTS service is ready

The recommended TTS runtime is optional. If it is not installed, the complete
voice-conversation feature stays unavailable; image features remain available.`)
}

function commandExists(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0
}

async function checkTts() {
  try {
    const response = await fetch('http://127.0.0.1:8000/v1/models', { signal: AbortSignal.timeout(2000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    console.log('MLX-Audio is ready at http://127.0.0.1:8000')
    return 0
  } catch {
    console.error(`MLX-Audio is not running. Start it with:\n  ${START_COMMAND}`)
    return 1
  }
}

async function wantsTts(args) {
  if (args.includes('--enable')) return true
  if (args.includes('--disable')) return false
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Choose explicitly in non-interactive mode: setup-tts --enable or setup-tts --disable')
    return null
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question('Download and enable Qwen3-TTS (about 2GB)? [y/N] ')
    return /^(?:y|yes|是)$/i.test(answer.trim())
  } finally {
    prompt.close()
  }
}

async function setupTts(args) {
  const enabled = await wantsTts(args)
  if (enabled === null) return 1
  if (!enabled) {
    console.log('Qwen3-TTS was not downloaded. Voice conversation will remain unavailable.')
    console.log('Run this command again with --enable whenever you want to add it.')
    return 0
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    console.error('The bundled MLX-Audio setup currently supports Apple Silicon Macs only.')
    return 1
  }
  if (!commandExists('uv')) {
    console.error('uv is required. Install it first with:\n  brew install uv')
    return 1
  }
  console.log('Installing the optional MLX-Audio runtime...')
  const result = spawnSync('uv', [
    'tool', 'install', '--force', MLX_AUDIO_SOURCE, '--prerelease=allow',
    '--with', 'uvicorn', '--with', 'fastapi', '--with', 'python-multipart',
    '--with', 'webrtcvad', '--with', 'setuptools<81',
  ], { stdio: 'inherit' })
  if (result.status !== 0) return result.status ?? 1
  console.log('\nMLX-Audio installed. Multimodal Router will start and stop it automatically.')
  console.log('Qwen3-TTS will download automatically on the first spoken response.')
  console.log(`\nManual troubleshooting command:\n  ${START_COMMAND}`)
  return 0
}

const command = process.argv[2]
if (command === 'setup-tts') process.exitCode = await setupTts(process.argv.slice(3))
else if (command === 'check-tts') process.exitCode = await checkTts()
else {
  printHelp()
  process.exitCode = command && !['help', '--help', '-h'].includes(command) ? 1 : 0
}
