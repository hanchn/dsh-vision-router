window.__ModuleLoader__.load({
  id: '@hanchn/dsh-vision-router',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const styleId = '@hanchn/dsh-vision-router/realtime-audio.css'
    if (document.querySelector(`style[data-plugin-css="${styleId}"]`) === null) {
      const style = document.createElement('style')
      style.dataset.plugin = '@hanchn/dsh-vision-router'
      style.dataset.pluginCss = styleId
      style.textContent = `
        .dvr-tool-button{width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-content-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;line-height:1}
        .dvr-tool-button:hover{background:var(--dsw-alias-background-hover);color:var(--dsw-alias-content-primary)}
        .dvr-tool-button:focus-visible{outline:2px solid var(--dsw-alias-border-focus);outline-offset:1px}
        .dvr-audio-button[data-recording=true]{background:var(--dsw-alias-state-error-tertiary);color:var(--dsw-alias-state-error-primary);animation:dvr-pulse 1.2s ease-in-out infinite}
        .dvr-audio-button[data-active=true]:not([data-recording=true]){background:var(--dsw-alias-background-hover);color:var(--dsw-alias-content-primary)}
        .dvr-tool-button svg{display:block;width:16px;height:16px}
        .dvr-tool-button:disabled{opacity:.45;cursor:default}
        .dvr-file-input{display:none}
        .dvr-audio-control{position:relative;display:inline-flex;align-items:center}
        .dvr-audio-status{position:absolute;z-index:20;right:0;bottom:34px;max-width:280px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:nowrap;pointer-events:none}
        .dvr-audio-status[data-error=true]{color:var(--dsw-alias-state-error-primary)}
        @keyframes dvr-pulse{50%{opacity:.55}}
      `
      document.head.appendChild(style)
    }

    function flatten(chunks) {
      const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const samples = new Float32Array(length)
      let offset = 0
      for (const chunk of chunks) {
        samples.set(chunk, offset)
        offset += chunk.length
      }
      return samples
    }

    function resample(samples, sourceRate, targetRate = 16000) {
      if (sourceRate === targetRate) return samples
      const ratio = sourceRate / targetRate
      const output = new Float32Array(Math.floor(samples.length / ratio))
      for (let index = 0; index < output.length; index++) {
        const start = Math.floor(index * ratio)
        const end = Math.max(start + 1, Math.floor((index + 1) * ratio))
        let sum = 0
        for (let cursor = start; cursor < end && cursor < samples.length; cursor++) sum += samples[cursor]
        output[index] = sum / (end - start)
      }
      return output
    }

    function wavBlob(chunks, sourceRate) {
      const samples = resample(flatten(chunks), sourceRate)
      const buffer = new ArrayBuffer(44 + samples.length * 2)
      const view = new DataView(buffer)
      const word = (offset, value) => view.setUint16(offset, value, true)
      const dword = (offset, value) => view.setUint32(offset, value, true)
      const ascii = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
      ascii(0, 'RIFF'); dword(4, buffer.byteLength - 8); ascii(8, 'WAVE')
      ascii(12, 'fmt '); dword(16, 16); word(20, 1); word(22, 1)
      dword(24, 16000); dword(28, 32000); word(32, 2); word(34, 16)
      ascii(36, 'data'); dword(40, samples.length * 2)
      for (let index = 0; index < samples.length; index++) {
        const sample = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      }
      return new Blob([buffer], { type: 'audio/wav' })
    }

    function latestAssistant(session) {
      for (let index = session.nodes.length - 1; index >= 0; index--) {
        const node = session.nodes[index]
        if (node.kind !== 'assistant' || !node.messageId || node.interrupted) continue
        const text = node.blocks
          .filter(block => block.kind === 'text')
          .map(block => block.text)
          .join('\n')
          .trim()
        if (text) return { id: String(node.messageId), text }
      }
      return null
    }

    function speechText(markdown) {
      return markdown
        .replace(/```[\s\S]*?```/g, '代码块。')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/[*_~>|]/g, '')
        .trim()
    }

    function microphoneError(reason) {
      if (reason?.name === 'NotAllowedError' || reason?.name === 'SecurityError') {
        return '麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试'
      }
      if (reason?.name === 'NotFoundError' || reason?.name === 'DevicesNotFoundError') {
        return '没有检测到可用的麦克风'
      }
      if (reason?.name === 'NotReadableError' || reason?.name === 'TrackStartError') {
        return '麦克风正被其他应用占用，请关闭占用后重试'
      }
      return reason instanceof Error ? reason.message : String(reason)
    }

    function AudioIcon({ speaking }) {
      if (speaking) return React.createElement('svg', {
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      React.createElement('path', { d: 'M11 5 6 9H2v6h4l5 4V5Z' }),
      React.createElement('path', { d: 'M15.5 8.5a5 5 0 0 1 0 7' }),
      React.createElement('path', { d: 'M19 5a10 10 0 0 1 0 14' }))
      return React.createElement('svg', {
        viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      React.createElement('rect', { x: 9, y: 2, width: 6, height: 12, rx: 3 }),
      React.createElement('path', { d: 'M5 10v2a7 7 0 0 0 14 0v-2' }),
      React.createElement('path', { d: 'M12 19v3' }))
    }

    function AttachmentButton() {
      const inputRef = React.useRef(null)
      const addImages = event => {
        const files = [...(event.currentTarget.files ?? [])]
        if (files.length === 0) return
        const transfer = new DataTransfer()
        for (const file of files) transfer.items.add(file)
        const drop = typeof DragEvent === 'function'
          ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
          : new Event('drop', { bubbles: true, cancelable: true })
        if (!drop.dataTransfer) Object.defineProperty(drop, 'dataTransfer', { value: transfer })
        document.dispatchEvent(drop)
        event.currentTarget.value = ''
      }
      const title = '添加图片（PNG、JPEG、WebP、GIF）'
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          type: 'button', className: 'dvr-tool-button dvr-attachment-button',
          title, 'aria-label': title, onClick: () => inputRef.current?.click(),
        }, React.createElement('svg', {
          viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        },
        React.createElement('path', { d: 'M21.4 11.6 12 21a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7L9.6 17.8a2 2 0 0 1-2.8-2.8l9-9' }))),
        React.createElement('input', {
          ref: inputRef, type: 'file', multiple: true, className: 'dvr-file-input',
          accept: 'image/png,image/jpeg,image/webp,image/gif', onChange: addImages,
        }))
    }

    function AudioButton({ session, input, inputActions }) {
      const [capability, setCapability] = React.useState(null)
      const [recording, setRecording] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [conversationMode, setConversationMode] = React.useState(false)
      const [synthesizing, setSynthesizing] = React.useState(false)
      const [speaking, setSpeaking] = React.useState(false)
      const [error, setError] = React.useState(null)
      const active = React.useRef(null)
      const activeOutput = React.useRef(null)
      const playbackContext = React.useRef(null)
      const startRef = React.useRef(null)
      const enabledRef = React.useRef(false)
      const spokenRef = React.useRef(null)
      const AudioContext = window.AudioContext || window.webkitAudioContext
      const recordingSupported = Boolean(window.navigator?.mediaDevices?.getUserMedia && AudioContext)

      React.useEffect(() => {
        const controller = new AbortController()
        const refresh = () => fetch('/vision-router/audio/capabilities', { signal: controller.signal })
          .then(response => response.json())
          .then(value => setCapability(value))
          .catch(reason => {
            if (reason?.name !== 'AbortError') setCapability({ available: false })
          })
        refresh()
        const refreshTimer = window.setInterval(refresh, 15000)
        return () => {
          controller.abort()
          window.clearInterval(refreshTimer)
          enabledRef.current = false
          window.speechSynthesis?.cancel()
          activeOutput.current?.stop()
          active.current?.stop(false, false)
          playbackContext.current?.close().catch(() => {})
          playbackContext.current = null
        }
      }, [])

      const unlockAudioOutput = () => {
        if (!AudioContext) return null
        if (!playbackContext.current || playbackContext.current.state === 'closed') {
          playbackContext.current = new AudioContext()
        }
        playbackContext.current.resume().catch(() => {})
        return playbackContext.current
      }

      const start = async () => {
        if (active.current || !enabledRef.current) return
        setError(null)
        try {
          if (!recordingSupported) throw new Error('当前浏览器未开放麦克风录音，请使用 Chrome、Edge 或 Safari 打开此页面')
          window.speechSynthesis?.cancel()
          const stream = await window.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false })
          const context = new AudioContext()
          await context.resume()
          const source = context.createMediaStreamSource(stream)
          const processor = context.createScriptProcessor(4096, 1, 1)
          const silence = context.createGain()
          silence.gain.value = 0
          const chunks = []
          const baseDraft = input.draft.trimEnd()
          let stopped = false
          let request = null
          let rerunRequested = false
          let lastSentSamples = 0
          let latestText = ''
          let heardSpeech = false
          let noiseFloor = 0.004
          let lastVoiceAt = performance.now()
          const startedAt = lastVoiceAt

          processor.onaudioprocess = event => {
            if (stopped) return
            const frame = new Float32Array(event.inputBuffer.getChannelData(0))
            chunks.push(frame)
            let energy = 0
            for (const sample of frame) energy += sample * sample
            const rms = Math.sqrt(energy / frame.length)
            const now = performance.now()
            if (!heardSpeech) noiseFloor = noiseFloor * 0.95 + rms * 0.05
            const voiceThreshold = Math.max(0.008, noiseFloor * 2.2)
            if (rms > voiceThreshold) {
              heardSpeech = true
              lastVoiceAt = now
            } else if (heardSpeech && now - lastVoiceAt > 900 && now - startedAt > 1200) {
              active.current?.stop(true, true)
            }
          }
          source.connect(processor)
          processor.connect(silence)
          silence.connect(context.destination)

          const transcribe = async force => {
            if (request) {
              rerunRequested = true
              return request
            }
            if (chunks.length === 0) return latestText
            const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
            if (sampleCount === lastSentSamples) return latestText
            lastSentSamples = sampleCount
            setBusy(true)
            request = fetch('/vision-router/audio/transcribe', {
              method: 'POST', headers: {
                'content-type': 'audio/wav',
                'x-dvr-language': window.navigator.language || 'zh-CN',
              },
              body: wavBlob(chunks, context.sampleRate),
            }).then(async response => {
              const value = await response.json()
              if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`)
              latestText = value.text || latestText
              if (latestText) inputActions.setDraft(`${baseDraft}${baseDraft ? '\n' : ''}${latestText}`)
              return latestText
            }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
              .finally(() => {
                request = null
                setBusy(false)
                if (rerunRequested && !stopped) {
                  rerunRequested = false
                  queueMicrotask(() => transcribe(false))
                }
              })
            return request
          }

          const interval = window.setInterval(() => transcribe(false), capability.chunkMs)
          const timeout = window.setTimeout(() => active.current?.stop(heardSpeech, heardSpeech), capability.maxSeconds * 1000)
          const stop = async (finalize, submit) => {
            if (stopped) return
            stopped = true
            window.clearInterval(interval)
            window.clearTimeout(timeout)
            processor.disconnect(); source.disconnect(); silence.disconnect()
            stream.getTracks().forEach(track => track.stop())
            if (request) await request
            const finalText = finalize ? await transcribe(true) : latestText
            await context.close()
            active.current = null
            setRecording(false)
            if (submit && finalText) inputActions.submit()
            else if (submit && !finalText) setError('没有识别到可发送的语音')
          }
          active.current = { stop }
          setRecording(true)
        } catch (reason) {
          setError(microphoneError(reason))
          setRecording(false)
          enabledRef.current = false
          setConversationMode(false)
        }
      }

      startRef.current = start

      const assistant = latestAssistant(session)
      React.useEffect(() => {
        if (!conversationMode || session.running || !assistant || assistant.id === spokenRef.current) return
        spokenRef.current = assistant.id
        const text = speechText(assistant.text)
        if (!text) return startRef.current?.()
        let finished = false
        const resume = () => {
          if (finished) return
          finished = true
          activeOutput.current = null
          setSynthesizing(false)
          setSpeaking(false)
          if (enabledRef.current) startRef.current?.()
        }
        const systemVoice = () => {
          if (!capability.tts?.browserFallback || !('speechSynthesis' in window)) return resume()
          const utterance = new SpeechSynthesisUtterance(text)
          utterance.lang = /[\u3400-\u9fff]/.test(text) ? 'zh-CN' : navigator.language
          utterance.rate = 1
          utterance.onend = resume
          utterance.onerror = resume
          activeOutput.current = { stop: () => { window.speechSynthesis.cancel(); resume() } }
          window.speechSynthesis.cancel()
          window.speechSynthesis.speak(utterance)
        }
        setSynthesizing(true)
        setSpeaking(false)
        if (!capability.tts?.available) {
          systemVoice()
          return
        }
        const controller = new AbortController()
        activeOutput.current = { stop: () => { controller.abort(); resume() } }
        fetch('/vision-router/audio/speech', {
          method: 'POST', signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        }).then(async response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const bytes = await response.arrayBuffer()
          const context = playbackContext.current
          if (!context || context.state === 'closed') throw new Error('音频播放通道未启用')
          await context.resume()
          const buffer = await context.decodeAudioData(bytes.slice(0))
          const source = context.createBufferSource()
          source.buffer = buffer
          source.connect(context.destination)
          source.onended = resume
          activeOutput.current = { stop: () => {
            try { source.stop() } catch {}
            source.disconnect()
            resume()
          } }
          setSynthesizing(false)
          setSpeaking(true)
          source.start()
        }).catch(reason => {
          if (reason?.name === 'AbortError') return
          if (capability.tts?.browserFallback) systemVoice()
          else {
            setError(`朗读失败：${reason instanceof Error ? reason.message : String(reason)}`)
            resume()
          }
        })
      }, [conversationMode, session.running, assistant?.id])

      if (!capability?.available || (!capability.tts?.available && !capability.tts?.browserFallback)) return null

      const toggle = () => {
        if (conversationMode) {
          if (speaking || synthesizing) {
            activeOutput.current?.stop()
            setSpeaking(false)
            setSynthesizing(false)
            startRef.current?.()
            return
          }
          enabledRef.current = false
          setConversationMode(false)
          window.speechSynthesis?.cancel()
          activeOutput.current?.stop()
          active.current?.stop(false, false)
          return
        }
        const current = latestAssistant(session)
        unlockAudioOutput()
        spokenRef.current = current?.id ?? null
        enabledRef.current = true
        setConversationMode(true)
        start()
      }
      const unsupportedTitle = '当前浏览器未开放麦克风录音，请使用 Chrome、Edge 或 Safari 打开此页面'
      const title = !recordingSupported ? unsupportedTitle : error || (recording
        ? busy ? `正在识别并同步到输入框（${capability.model}）` : `正在听，内容会同步到输入框（${capability.model}）`
        : synthesizing ? '正在生成语音，点击可取消'
          : speaking ? '正在朗读，点击打断并讲话'
          : conversationMode ? '语音对话已开启，点击结束' : `开始语音对话（${capability.model}）`)
      const status = error || (recording
        ? busy ? '正在识别，文字将同步到输入框…' : '正在聆听，请讲话…'
        : synthesizing ? '正在生成语音，首次使用可能较慢…'
          : speaking ? '正在朗读，点击麦克风可打断…'
          : conversationMode ? '正在准备下一轮对话…' : '')
      return React.createElement('div', { className: 'dvr-audio-control' },
        React.createElement('button', {
          type: 'button', className: 'dvr-tool-button dvr-audio-button', title,
          'aria-label': title, 'data-recording': recording, 'data-active': conversationMode,
          disabled: !recordingSupported || (busy && !conversationMode), onClick: toggle,
        }, React.createElement(AudioIcon, { speaking })),
        status && React.createElement('span', {
          className: 'dvr-audio-status', role: 'status', 'data-error': Boolean(error),
        }, status))
    }

    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left', id: 'attachments', order: 10,
      }, () => React.createElement(AttachmentButton)))
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right', id: 'realtime-audio', order: 10,
      }, props => React.createElement(AudioButton, props)))
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
