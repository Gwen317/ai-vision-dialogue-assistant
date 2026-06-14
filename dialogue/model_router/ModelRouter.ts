import type { ChatMessages } from '../../node_modules/@openrouter/sdk/esm/models/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import OpenAI from 'openai';
import { Socket } from 'socket.io';
import { EpisodicMemoryService } from '../../memory_graph/episodic_memory/EpisodicMemoryService';
import type { TimelineEvent, ConversationMessageEvent } from '../gateway_core/SocketGateway';
import { CosyVoiceTtsClient } from './CosyVoiceTtsClient';
import { resolveCosyVoiceId } from './cosyVoicePresetVoices';

type OpenRouterContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; imageUrl: { url: string; detail?: 'auto' | 'low' | 'high' } };

interface ImageFrameEvent {
  type: 'image';
  timestamp: number;
  imageBase64: string;
}

interface TurnTiming {
  speechStartedAt: number;
  speechEndedAt: number;
}

interface BuildTimelineMessagesInput {
  systemInstruction: string;
  userSpeech: string;
  timeline: TimelineEvent[];
  turnTiming: TurnTiming;
}

function extensionForAudioMimeType(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}

function convertAudioToMp3(inputPath: string, outputPath: string): Promise<void> {
  if (!ffmpegPath) {
    return Promise.reject(new Error('ffmpeg-static did not provide an ffmpeg binary path.'));
  }
  const binaryPath: string = ffmpegPath;

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(binaryPath, [
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-acodec',
      'libmp3lame',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-b:a',
      '64k',
      outputPath
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      }
    });
  });
}

async function transcribeWithMolifangzhou(audioBuffer: Buffer, mimeType: string): Promise<string> {
  const apiKey = process.env.MOLIFANGZHOU_API_KEY;
  if (!apiKey || apiKey === 'mock' || apiKey.startsWith('your_')) {
    throw new Error('MOLIFANGZHOU_API_KEY is required for speech transcription.');
  }

  const baseUrl = process.env.MOLIFANGZHOU_BASE_URL || 'https://ai.gitee.com/v1';
  const model = process.env.MOLIFANGZHOU_STT_MODEL || 'GLM-ASR';
  const client = new OpenAI({
    baseURL: baseUrl,
    apiKey
  });

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'molifangzhou-stt-'));
  const inputAudioPath = path.join(tmpDir, `speech-input.${extensionForAudioMimeType(mimeType)}`);
  const mp3AudioPath = path.join(tmpDir, 'speech.mp3');

  try {
    await fs.promises.writeFile(inputAudioPath, audioBuffer);
    await convertAudioToMp3(inputAudioPath, mp3AudioPath);
    const response = await client.audio.transcriptions.create({
      file: fs.createReadStream(mp3AudioPath),
      model
    });

    return (response.text || '').trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Molifangzhou STT failed: ${message}`);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

export function buildTimelineMessages({
  systemInstruction,
  userSpeech,
  timeline,
  turnTiming
}: BuildTimelineMessagesInput): {
  messages: ChatMessages[];
  currentParts: OpenRouterContentPart[];
} {
  const currentParts: OpenRouterContentPart[] = [
    {
      type: 'text',
      text: `[User speech @ ${new Date(turnTiming.speechStartedAt).toISOString()} - ${new Date(turnTiming.speechEndedAt).toISOString()}]\n${userSpeech}`
    }
  ];

  // Attach the latest image to the current user message (merged, not separate)
  const imageEvents = timeline
    .filter(event => event.type === 'image' && event.timestamp <= turnTiming.speechEndedAt)
    .sort((a, b) => a.timestamp - b.timestamp);

  const latestImage = imageEvents.at(-1) as Extract<TimelineEvent, { type: 'image' }> | undefined;
  if (latestImage) {
    currentParts.push({
      type: 'image_url',
      imageUrl: {
        url: `data:image/jpeg;base64,${latestImage.imageBase64}`,
        detail: 'low'
      }
    });
  }

  const messages: ChatMessages[] = [
    {
      role: 'system',
      content: systemInstruction
    }
  ];

  // Historical messages — text only, no images, sorted by event-time to maintain correct chronological order
  const historicalMessages = timeline
    .filter((event): event is ConversationMessageEvent => event.type === 'message' && event.timestamp <= turnTiming.speechEndedAt)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-6);

  for (const event of historicalMessages) {
    let content = event.parts;

    if ((event as any).interrupted && event.role === 'model') {
      content = event.parts.map((part: any, idx: number) => {
        if (idx === 0 && typeof part.text === 'string') {
          return {
            ...part,
            text: part.text + '\n\n[System: Your previous response was interrupted by the user at this point. Please continue your reasoning from exactly where you left off, seamlessly incorporating the user\'s new input below. Do not repeat what you already said — just continue from the breakpoint.]'
          };
        }
        return part;
      });
    }

    // Strip image parts from historical messages to keep clean text-only history
    if (Array.isArray(content)) {
      content = content.filter((part: any) => !part.type || part.type !== 'image_url');
    }

    messages.push({
      role: event.role === 'model' ? 'assistant' : 'user',
      content
    });
  }

  // Current user message with merged image (text + image in ONE message)
  messages.push({
    role: 'user',
    content: currentParts
  });

  return { messages, currentParts };
}

function prepareMessagesForModel(messages: any[], modelName: string): any[] {
  const isVisionModel = modelName.toLowerCase().includes('vl') || modelName.toLowerCase().includes('vision');
  
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return msg;
    }
    if (Array.isArray(msg.content)) {
      const parts = msg.content.map((part: any) => {
        if (part.type === 'image_url') {
          if (!isVisionModel) {
            // Strip image part if model is not a vision model
            return null;
          }
          if (part.imageUrl) {
            return {
              type: 'image_url',
              image_url: {
                url: part.imageUrl.url,
                detail: part.imageUrl.detail || 'low'
              }
            };
          }
        }
        if (part && typeof part === 'object' && part.text && !part.type) {
          return {
            type: 'text',
            text: part.text
          };
        }
        return part;
      }).filter(Boolean);

      // If all content parts are stripped, return a placeholder text
      if (parts.length === 0) {
        return { role: msg.role, content: '[Image omitted]' };
      }
      
      // If there is only one text part left, simplify it to a string for cleaner payload
      if (parts.length === 1 && parts[0].type === 'text') {
        return { role: msg.role, content: parts[0].text };
      }

      return { role: msg.role, content: parts };
    }
    return msg;
  });
}

export class ModelRouter {
  private static openrouter: any = null;
  private static speechTranscriber: ((audioBuffer: Buffer) => Promise<string>) | null = null;
  private static ttsClientInstance: CosyVoiceTtsClient | null = null;

  private static get ttsClient(): CosyVoiceTtsClient {
    if (!this.ttsClientInstance) {
      this.ttsClientInstance = new CosyVoiceTtsClient();
    }
    return this.ttsClientInstance;
  }

  public static setOpenRouterForTest(openrouter: any) {
    this.openrouter = openrouter;
  }

  public static setSpeechTranscriberForTest(transcriber: ((audioBuffer: Buffer) => Promise<string>) | null) {
    this.speechTranscriber = transcriber;
  }

  private static async getOpenRouter() {
    if (!this.openrouter) {
      const { OpenRouter } = await (new Function('return import("@openrouter/sdk")')() as Promise<typeof import('@openrouter/sdk')>);
      this.openrouter = new OpenRouter({
        apiKey: process.env.OPENROUTER_API_KEY || '',
        appTitle: 'AI Vision Dialogue Assistant'
      });
    }
    return this.openrouter;
  }

  private static async getLlmStream(
    messages: any[],
    userSpeech: string,
    overrideLlmProvider?: string
  ): Promise<{ stream: any; modelName: string }> {
    const dashscopeKey = process.env.DASHSCOPE_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    
    const llmProvider = (overrideLlmProvider || process.env.LLM_PROVIDER || 'openrouter').toLowerCase();
    const useDashScope = llmProvider === 'dashscope' && dashscopeKey && dashscopeKey !== 'mock' && !dashscopeKey.startsWith('your_');

    const complexKeywords = ['debug', 'code', 'math', 'solve', 'circuit', 'program', 'algorithm', 'explain in detail', 'analyze'];
    const lowerSpeech = userSpeech.toLowerCase();
    const isReasoning = complexKeywords.some(keyword => lowerSpeech.includes(keyword));

    if (useDashScope) {
      const modelName = isReasoning
        ? (process.env.DASHSCOPE_REASONING_MODEL || 'qwen-vl-max')
        : (process.env.DASHSCOPE_CHAT_MODEL || 'qwen-vl-plus');
      
      console.log(`Routing to Aliyun DashScope model: ${modelName}`);
      const client = new OpenAI({
        apiKey: dashscopeKey,
        baseURL: process.env.DASHSCOPE_LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
      });

      const preparedMessages = prepareMessagesForModel(messages, modelName);

      const stream = await client.chat.completions.create({
        model: modelName,
        messages: preparedMessages,
        stream: true,
        stream_options: {
          include_usage: true
        }
      });

      return { stream, modelName };
    } else {
      const modelName = isReasoning
        ? (process.env.OPENROUTER_REASONING_MODEL || process.env.OPENROUTER_CHAT_MODEL || 'nex-agi/nex-n2-pro:free')
        : (process.env.OPENROUTER_CHAT_MODEL || 'nex-agi/nex-n2-pro:free');

      console.log(`Routing to OpenRouter model: ${modelName}`);
      const openrouter = await this.getOpenRouter();
      const preparedMessages = prepareMessagesForModel(messages, modelName);

      const stream = await openrouter.chat.send({
        chatRequest: {
          model: modelName,
          messages: preparedMessages,
          stream: true,
          reasoning: {
            effort: 'medium'
          },
          streamOptions: {
            includeUsage: true
          }
        }
      });

      return { stream, modelName };
    }
  }

  private static readonly HANDHELD_OBJECT_CLASSES = new Set([
    'cell phone', 'cup', 'bottle', 'scissors', 'book', 'handbag', 'banana', 'apple', 'orange', 'keyboard', 'mouse', 'laptop'
  ]);

  private static describeDetectedEntity(className: string): string {
    const key = className.trim().toLowerCase();
    if (key === 'person') {
      return 'a person is visible in the live video frame (they appear on camera — NOT an object the user is holding in their hand)';
    }
    if (this.HANDHELD_OBJECT_CLASSES.has(key)) {
      return `a ${className} is visible and may be held up or shown to the camera by the user`;
    }
    return `a ${className} is visible in the live video frame`;
  }

  private static buildMemoryQueryText(userSpeech: string, visualContext?: string[]): string {
    const objects = [...new Set((visualContext ?? []).map(v => v.trim()).filter(Boolean))];
    if (objects.length === 0) return userSpeech;
    const descriptions = objects.map(o => this.describeDetectedEntity(o));
    return `${userSpeech}\n[Camera context — background only: ${descriptions.join('; ')}]`;
  }

  private static buildVisualContextPrompt(visualContext?: string[]): string {
    const objects = [...new Set((visualContext ?? []).map(v => v.trim()).filter(Boolean))];
    if (objects.length === 0) return '';
    const descriptions = objects.map(o => this.describeDetectedEntity(o));
    return `\n[CURRENT CAMERA DETECTION — BACKGROUND ONLY] ${descriptions.join('; ')}\nThis is silent visual context from object detection — NOT the user's spoken request. Describe people as appearing in the frame, never as something the user is "holding". Only mention detections when relevant to the user's question.`;
  }

  private static getBaseSystemInstruction(visualContext?: string[]): string {
    return 'You are a futuristic, helpful AI Vision Dialogue Assistant. You are currently in a real-time, live video and audio call with the user. You have access to the user\'s real-time camera video stream (provided as image frames in messages) and microphone audio stream. Answer clearly, naturally, and concisely in Chinese. (请使用中文回答用户。)\n\n' +
      'SCENARIO CONTEXT & VISUAL GUIDELINES:\n' +
      '1. Remember that this is a live video call. Never refer to the images as "selfies" (自拍), "uploaded photos", or "screenshots".\n' +
      '2. Describe what you see accurately by entity type:\n' +
      '   - People (person): they appear IN the video frame — e.g. "画面里有一位…", "我看到视频中有…". NEVER say the user is "holding" or "拿着" a person.\n' +
      '   - Objects the user presents to camera: they may be holding or showing them — e.g. "你在镜头前展示的是…", "我看到你手里拿着…".\n' +
      '3. When referring to recalled memories with images, refer to them as what you saw in previous video call sessions or earlier in this call (e.g. "我们上次视频通话见过…", "你刚才在视频里给我看过的…").\n\n' +
      'IMPORTANT: If you see "[System: Your previous response was interrupted]" in the conversation history, the user cut you off mid-response. Continue seamlessly from the exact breakpoint — do NOT repeat what you already said. Incorporate the user\'s new input into your continued reasoning.' +
      this.buildVisualContextPrompt(visualContext);
  }

  private static buildRecalledMemoryPrompt(recalledMemory: { timestamp: Date; description: string; transcript: string; entityTags?: string[] }): string {
    const timeDiff = Math.round((Date.now() - recalledMemory.timestamp.getTime()) / 60000);
    const entityInfo = recalledMemory.entityTags?.length
      ? `\nIdentified entities: [${recalledMemory.entityTags.join(', ')}]`
      : '';
    return `\n[RECALLED EPISODIC MEMORY — BACKGROUND CONTEXT ONLY] A past event from ${timeDiff} minutes ago was silently retrieved alongside the user's message. In that earlier video call, the feed included "${recalledMemory.description}" and the conversation was:\n${recalledMemory.transcript}${entityInfo}\nThis is supplementary background — NOT the user's primary request. Answer the user's actual question first. Only reference this memory when it is directly relevant to what they asked (e.g. they ask about the past, compare items, or mention something shown earlier). Do not hijack the reply to recite memory unprompted. When the recalled content involves a person, refer to them as having appeared in the video — never as an object the user was holding.`;
  }

  public static async processInteraction(
    socket: Socket,
    audioBuffer: Buffer,
    audioMimeType: string,
    imageFrame: ImageFrameEvent | null,
    timeline: TimelineEvent[],
    turnTiming: TurnTiming,
    signal: AbortSignal,
    requestId: number,
    localText?: string,
    overrideLlmProvider?: string,
    overrideTtsProvider?: string,
    overrideTtsVoiceId?: string,
    existingNodes?: string[],
    visualContext?: string[]
  ): Promise<void> {
    const dashscopeKey = process.env.DASHSCOPE_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    
    const llmProvider = (overrideLlmProvider || process.env.LLM_PROVIDER || 'openrouter').toLowerCase();
    const hasDashScope = llmProvider === 'dashscope' && dashscopeKey && dashscopeKey !== 'mock' && !dashscopeKey.startsWith('your_');
    const hasOpenRouter = llmProvider === 'openrouter' && openrouterKey && openrouterKey !== 'mock' && !openrouterKey.startsWith('your_');

    if (!hasDashScope && !hasOpenRouter) {
      console.log('--- ModelRouter: Running in MOCK MODE ---');
      
      const finalUserSpeech = localText || '测试双工打断';
      socket.emit('user_transcription', finalUserSpeech);
      socket.emit('state_change', 'SPEAKING');
      
      const currentParts: OpenRouterContentPart[] = [
        {
          type: 'text',
          text: `[User speech @ ${new Date(turnTiming.speechStartedAt).toISOString()} - ${new Date(turnTiming.speechEndedAt).toISOString()}]\n${finalUserSpeech}`
        }
      ];

      timeline.push({
        type: 'message',
        timestamp: turnTiming.speechStartedAt,
        role: 'user',
        parts: currentParts
      });

      const modelMessageEntry: TimelineEvent = {
        type: 'message',
        timestamp: Date.now(),
        role: 'model',
        parts: [{ text: '' }]
      };
      timeline.push(modelMessageEntry);
      
      const mockText = '这是一个用于测试双工流式打断功能的测试段落。在这个模式下，大模型不会进行真实的网络调用，而是以每两百毫秒一个词的速度向下游推送这一段很长的话。你可以随时对着你的麦克风说话，或者发出大一点的声音来测试端侧的静音检测是否能成功识别你开口说话的动作。一旦系统检测到你的声音，前端就会自动执行打断流程，将 AI 正在播放的声音静音，并通知后端强行关闭当前的流。我们可以测试后端的日志是否会打印 Stream generation aborted 和 Memory truncated。现在，请你试着说话来打断我吧！';
      
      const chunks = mockText.split(/(?=[，。、])| /);
      let fullResponseText = '';
      
      while (true) {
        for (const chunk of chunks) {
          if (signal.aborted) {
            console.log('Mock Stream generation aborted by client.');
            modelMessageEntry.timestamp = Date.now();
            return;
          }
          
          fullResponseText += chunk;
          modelMessageEntry.parts[0].text = fullResponseText;
          socket.emit('text_chunk', chunk);
          
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        console.log('Mock Stream looping: restarting text output.');
      }
    }

    // 1. Transcribe the user's audio
    console.log('Transcribing user audio...');
    let userSpeech = '';
    const hasDashscope = dashscopeKey && dashscopeKey !== 'mock' && !dashscopeKey.startsWith('your_');
    const hasMolifangzhou = process.env.MOLIFANGZHOU_API_KEY && 
                            process.env.MOLIFANGZHOU_API_KEY !== 'mock' && 
                            !process.env.MOLIFANGZHOU_API_KEY.startsWith('your_');

    try {
      if (audioBuffer.byteLength === 0) {
        if (localText) {
          userSpeech = localText;
        } else {
          console.log('Empty audio buffer and no local text available.');
          socket.emit('user_transcription', '');
          socket.emit('state_change', 'IDLE');
          return;
        }
      } else if (this.speechTranscriber) {
        userSpeech = await this.speechTranscriber(audioBuffer);
      } else if (hasDashscope) {
        console.log('Using Aliyun DashScope (qwen3-asr-flash) for transcription (with MP3 transcoding)...');
        const client = new OpenAI({
          apiKey: dashscopeKey,
          baseURL: process.env.DASHSCOPE_LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        });

        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dashscope-asr-'));
        const inputAudioPath = path.join(tmpDir, `speech-input.${extensionForAudioMimeType(audioMimeType)}`);
        const mp3AudioPath = path.join(tmpDir, 'speech.mp3');

        try {
          // Write buffer to temp file and convert to MP3 (16kHz, mono)
          await fs.promises.writeFile(inputAudioPath, audioBuffer);
          await convertAudioToMp3(inputAudioPath, mp3AudioPath);

          const mp3Buffer = await fs.promises.readFile(mp3AudioPath);
          const base64Data = mp3Buffer.toString('base64');
          const dataUri = `data:audio/mp3;base64,${base64Data}`;

          const response = await client.chat.completions.create({
            model: 'qwen3-asr-flash',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'input_audio',
                    input_audio: {
                      data: dataUri
                    }
                  } as any
                ]
              }
            ]
          });
          userSpeech = (response.choices[0]?.message?.content || '').trim();
        } catch (asrErr) {
          console.error('[ModelRouter] DashScope ASR call failed, falling back to empty text:', asrErr);
          userSpeech = '';
        } finally {
          // Clean up temp folder
          try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
          } catch (cleanupErr) {
            console.error('[ModelRouter] Failed to cleanup DashScope ASR temp dir:', cleanupErr);
          }
        }
      } else if (hasMolifangzhou) {
        userSpeech = await transcribeWithMolifangzhou(audioBuffer, audioMimeType);
      } else if (localText) {
        console.log(`No backend STT keys configured. Falling back to local ASR text: "${localText}"`);
        userSpeech = localText;
      } else {
        throw new Error('No STT keys configured and no local ASR text fallback available.');
      }
    } catch (err: any) {
      if (localText) {
        console.log(`STT failed, falling back to local ASR text: "${localText}". Error was:`, err);
        userSpeech = localText;
      } else {
        const message = err instanceof Error ? err.message : 'Speech transcription failed.';
        console.error(message, err);
        socket.emit('user_transcription', '');
        socket.emit('error', message);
        socket.emit('state_change', 'IDLE');
        return;
      }
    }

    console.log(`Transcribed text: "${userSpeech}"`);

    if (!userSpeech) {
      console.log('No speech detected in audio.');
      socket.emit('user_transcription', '');
      socket.emit('state_change', 'IDLE');
      return;
    }

    // Emit the transcribed text back to the client immediately
    socket.emit('user_transcription', userSpeech);

    // Guard: abort during STT
    if (signal.aborted) {
      console.log('Aborted during transcription, skipping timeline write.');
      return;
    }

    // 2. Query Long-Term Multimodal Episodic Memory (silent background retrieval)
    console.log('Querying episodic memory...');
    const currentImageBase64 = imageFrame?.imageBase64 ?? null;
    const memoryQueryText = this.buildMemoryQueryText(userSpeech, visualContext);
    const recalledMemory = await EpisodicMemoryService.queryMemory(memoryQueryText, currentImageBase64);

    // Guard: abort during memory query
    if (signal.aborted) {
      console.log('Aborted during memory query, skipping timeline write.');
      return;
    }

    // 3. Construct System Instruction / Prompt with memory context
    let systemInstruction = this.getBaseSystemInstruction(visualContext);
    
    if (recalledMemory) {
      systemInstruction += this.buildRecalledMemoryPrompt(recalledMemory);
    }

    // 4. Assemble current payload parts in event-time order.
    const { messages, currentParts } = buildTimelineMessages({
      systemInstruction,
      userSpeech,
      timeline,
      turnTiming
    });

    // Guard: abort before writing to timeline
    if (signal.aborted) {
      console.log('Aborted before timeline write, skipping.');
      return;
    }

    // 4.1 Write user message to timeline BEFORE streaming so interrupt handler can see it.
    timeline.push({
      type: 'message',
      timestamp: turnTiming.speechStartedAt,
      role: 'user',
      parts: currentParts
    });

    // 4.2 Write model message placeholder to timeline BEFORE streaming so interrupt handler
    //     truncates the correct (current-turn) message instead of a previous turn.
    const modelMessageEntry: TimelineEvent = {
      type: 'message',
      timestamp: Date.now(),
      role: 'model',
      parts: [{ text: '' }]
    };
    timeline.push(modelMessageEntry);

    // 5. Generate content stream
    console.log('Generating streaming content...');
    socket.emit('state_change', 'SPEAKING');
    
    let responseStream;
    let selectedModelName = '';
    try {
      const result = await this.getLlmStream(messages, userSpeech, overrideLlmProvider);
      responseStream = result.stream;
      selectedModelName = result.modelName;
    } catch (err: any) {
      const message = err instanceof Error ? err.message : 'LLM stream generation failed.';
      console.error(message, err);
      socket.emit('error', message);
      socket.emit('state_change', 'IDLE');
      return;
    }

    if (signal.aborted) {
      console.log('Aborted after LLM stream setup, skipping.');
      return;
    }

    let fullResponseText = '';
    let sentenceBuffer = '';
    let ttsIndex = 0;

    for await (const chunk of responseStream) {
      // Check for abort signal from client interruption
      if (signal.aborted) {
        console.log('Stream generation aborted.');
        modelMessageEntry.timestamp = Date.now();
        return;
      }
      
      if (chunk.error) {
        throw new Error(`Stream error ${chunk.error.code}: ${chunk.error.message}`);
      }

      const chunkText = chunk.choices[0]?.delta?.content ?? '';
      fullResponseText += chunkText;
      modelMessageEntry.parts[0].text = fullResponseText;
      
      // Stream text chunk to client
      if (chunkText) {
        socket.emit('text_chunk', chunkText);
        sentenceBuffer += chunkText;

        const delimiters = ['。', '！', '？', '；', '.', '!', '?', '\n'];
        for (const delim of delimiters) {
          if (sentenceBuffer.includes(delim)) {
            const parts = sentenceBuffer.split(delim);
            const clause = (parts[0] + delim).trim();
            sentenceBuffer = parts.slice(1).join(delim);

            if (clause) {
              const currentIndex = ttsIndex++;
              this.synthesizeAndEmit(socket, clause, currentIndex, signal, requestId, overrideTtsProvider, overrideTtsVoiceId);
            }
            break;
          }
        }
      }

      const reasoningTokens = chunk.usage?.completionTokensDetails?.reasoningTokens ||
                             chunk.usage?.completion_tokens_details?.reasoning_tokens;
      if (reasoningTokens) {
        console.log(`Reasoning tokens: ${reasoningTokens}`);
      }
    }

    // Process any remaining text in the buffer
    const remaining = sentenceBuffer.trim();
    if (remaining) {
      const currentIndex = ttsIndex++;
      this.synthesizeAndEmit(socket, remaining, currentIndex, signal, requestId, overrideTtsProvider, overrideTtsVoiceId);
    }

    console.log('Stream generation completed.');

    modelMessageEntry.timestamp = Date.now();

    // 6. Save to Long-Term Episodic Memory in the background (non-blocking)
    EpisodicMemoryService.recordMemory(userSpeech, fullResponseText, currentImageBase64)
      .catch(err => console.error('Background memory recording failed:', err));

    // Asynchronously extract and analyze physical entities mentioned in the dialogue to auto-insert them into the graph
    this.extractAndAnalyzeEntitiesFromDialogue(
      socket,
      userSpeech,
      fullResponseText,
      currentImageBase64,
      existingNodes || [],
      overrideLlmProvider
    ).catch(err => console.error('Background entity extraction and analysis failed:', err));

    socket.emit('state_change', 'IDLE');
  }

  public static async processTextInteraction(
    socket: Socket,
    userSpeech: string,
    imageFrame: ImageFrameEvent | null,
    timeline: TimelineEvent[],
    turnTiming: TurnTiming,
    signal: AbortSignal,
    requestId: number,
    overrideLlmProvider?: string,
    overrideTtsProvider?: string,
    overrideTtsVoiceId?: string,
    existingNodes?: string[],
    visualContext?: string[]
  ): Promise<void> {
    const dashscopeKey = process.env.DASHSCOPE_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    
    const llmProvider = (overrideLlmProvider || process.env.LLM_PROVIDER || 'openrouter').toLowerCase();
    const hasDashScope = llmProvider === 'dashscope' && dashscopeKey && dashscopeKey !== 'mock' && !dashscopeKey.startsWith('your_');
    const hasOpenRouter = llmProvider === 'openrouter' && openrouterKey && openrouterKey !== 'mock' && !openrouterKey.startsWith('your_');

    if (!hasDashScope && !hasOpenRouter) {
      socket.emit('user_transcription', userSpeech);
      socket.emit('state_change', 'SPEAKING');
      socket.emit('text_chunk', `Mock response to: ${userSpeech}`);
      socket.emit('state_change', 'IDLE');
      return;
    }

    socket.emit('user_transcription', userSpeech);

    console.log('Querying episodic memory...');
    const currentImageBase64 = imageFrame?.imageBase64 ?? null;
    const memoryQueryText = this.buildMemoryQueryText(userSpeech, visualContext);
    const recalledMemory = await EpisodicMemoryService.queryMemory(memoryQueryText, currentImageBase64);

    if (signal.aborted) {
      console.log('Text query aborted during memory query.');
      return;
    }

    let systemInstruction = this.getBaseSystemInstruction(visualContext);
    if (recalledMemory) {
      systemInstruction += this.buildRecalledMemoryPrompt(recalledMemory);
    }

    const { messages, currentParts } = buildTimelineMessages({
      systemInstruction,
      userSpeech,
      timeline,
      turnTiming
    });

    if (signal.aborted) {
      console.log('Text query aborted before timeline write.');
      return;
    }

    timeline.push({
      type: 'message',
      timestamp: turnTiming.speechStartedAt,
      role: 'user',
      parts: currentParts
    });

    const modelMessageEntry: TimelineEvent = {
      type: 'message',
      timestamp: Date.now(),
      role: 'model',
      parts: [{ text: '' }]
    };
    timeline.push(modelMessageEntry);

    console.log('Generating streaming content from text query...');
    socket.emit('state_change', 'SPEAKING');

    let responseStream;
    let selectedModelName = '';
    try {
      const result = await this.getLlmStream(messages, userSpeech, overrideLlmProvider);
      responseStream = result.stream;
      selectedModelName = result.modelName;
    } catch (err: any) {
      const message = err instanceof Error ? err.message : 'LLM stream generation failed.';
      console.error(message, err);
      socket.emit('error', message);
      socket.emit('state_change', 'IDLE');
      return;
    }

    if (signal.aborted) {
      console.log('Text query aborted after LLM stream setup.');
      return;
    }

    let fullResponseText = '';
    let sentenceBuffer = '';
    let ttsIndex = 0;

    for await (const chunk of responseStream) {
      if (signal.aborted) {
        console.log('Text query stream generation aborted.');
        modelMessageEntry.timestamp = Date.now();
        return;
      }

      if (chunk.error) {
        throw new Error(`Stream error ${chunk.error.code}: ${chunk.error.message}`);
      }

      const chunkText = chunk.choices[0]?.delta?.content ?? '';
      fullResponseText += chunkText;
      modelMessageEntry.parts[0].text = fullResponseText;
      if (chunkText) {
        socket.emit('text_chunk', chunkText);
        sentenceBuffer += chunkText;

        const delimiters = ['。', '！', '？', '；', '.', '!', '?', '\n'];
        for (const delim of delimiters) {
          if (sentenceBuffer.includes(delim)) {
            const parts = sentenceBuffer.split(delim);
            const clause = (parts[0] + delim).trim();
            sentenceBuffer = parts.slice(1).join(delim);

            if (clause) {
              const currentIndex = ttsIndex++;
              this.synthesizeAndEmit(socket, clause, currentIndex, signal, requestId, overrideTtsProvider, overrideTtsVoiceId);
            }
            break;
          }
        }
      }
    }

    // Process any remaining text in the buffer
    const remaining = sentenceBuffer.trim();
    if (remaining) {
      const currentIndex = ttsIndex++;
      this.synthesizeAndEmit(socket, remaining, currentIndex, signal, requestId, overrideTtsProvider, overrideTtsVoiceId);
    }

    modelMessageEntry.timestamp = Date.now();

    EpisodicMemoryService.recordMemory(userSpeech, fullResponseText, currentImageBase64)
      .catch(err => console.error('Background memory recording failed:', err));

    // Asynchronously extract and analyze physical entities mentioned in the dialogue to auto-insert them into the graph
    this.extractAndAnalyzeEntitiesFromDialogue(
      socket,
      userSpeech,
      fullResponseText,
      currentImageBase64,
      existingNodes || [],
      overrideLlmProvider
    ).catch(err => console.error('Background entity extraction and analysis failed:', err));

    socket.emit('state_change', 'IDLE');
  }

  private static async synthesizeAndEmit(
    socket: Socket,
    text: string,
    index: number,
    signal: AbortSignal,
    requestId: number,
    overrideTtsProvider?: string,
    overrideTtsVoiceId?: string
  ): Promise<void> {
    if (overrideTtsProvider === 'browser') {
      return;
    }
    if (!this.ttsClient.isConfigured()) {
      return;
    }

    try {
      const voiceId = resolveCosyVoiceId(overrideTtsVoiceId);
      const audioBuffer = await this.ttsClient.synthesize(text, voiceId);

      if (signal.aborted) {
        return;
      }

      socket.emit('audio_tts_chunk', {
        audio: audioBuffer,
        index,
        requestId
      });
    } catch (err) {
      console.error(`Failed to synthesize text: "${text}", error:`, err);
    }
  }

  /**
   * 结合视觉、时间与上下文，智能分析并过滤目标检测实体
   */
  public static async analyzeDetectedObject(
    timeline: TimelineEvent[],
    className: string,
    imageBase64: string | null,
    existingNodes: string[],
    overrideLlmProvider?: string
  ): Promise<any> {
    const dashscopeKey = process.env.DASHSCOPE_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    
    const llmProvider = (overrideLlmProvider || process.env.LLM_PROVIDER || 'openrouter').toLowerCase();
    const useDashScope = llmProvider === 'dashscope' && dashscopeKey && dashscopeKey !== 'mock' && !dashscopeKey.startsWith('your_') && !dashscopeKey.startsWith('test-');
    const useOpenRouter = llmProvider === 'openrouter' && openrouterKey && openrouterKey !== 'mock' && !openrouterKey.startsWith('your_') && !openrouterKey.startsWith('test-');

    const recentMessages = timeline
      .filter((event): event is ConversationMessageEvent => event.type === 'message')
      .slice(-6);
    
    const conversationHistoryText = recentMessages
      .map(msg => {
        const text = msg.parts.map((p: any) => p.text || '').join('');
        return `${msg.role === 'user' ? '用户' : 'AI助手'}: ${text}`;
      })
      .join('\n') || '(无历史对话)';

    const prompt = `你是一个辅助 AI 视觉对话助手的实体分析大脑。
我们刚刚在摄像头画面中通过目标检测识别到了一个物体。
目标检测标签 (Class): "${className}"
当前本地时间 (Local Time): ${new Date().toLocaleString('zh-CN')}

当前对话历史上下文 (Recent Conversation History):
${conversationHistoryText}

当前图谱中已存在的节点 (Existing Nodes in Graph):
${existingNodes.length > 0 ? existingNodes.map(n => `- ${n}`).join('\n') : '(无)'}

请结合时间、上下文信息以及摄像头图片（若提供），对该物体进行一次智能语义分析，以决定它是否应该进入我们的实体记忆图谱中。

注意：
1. shouldAdd: 
   - 如果此物体是检测到了 "person"（人），我们需要对其进行人脸/角色认知：
     - 如果他是系统的主用户（坐在正中央，经常发声提问），将其作为实体录入，其名称为 "Gwen"；
     - 如果他是新进入画面的其他人（用户的朋友），将其作为实体录入，名称为 "Friend"（或者结合对话上下文若得知其名字如"Jerry"，则为具体名字）；
     - 请将此类人节点的 shouldAdd 设为 true。
   - 如果是其他重要的物理实体（如电容、仪器、手机、电阻等），设为 true。
   - 如果是背景杂音或无关噪点，设为 false。
2. refinedLabel: 细化名称。如 "Gwen", "Friend", "万用表", "智能手机" 等。
3. type: 必须是以下六个值之一：'device'（设备/仪器）、'tool'（工具）、'wire'（连线）、'concept'（普通概念）、'capacitor'（电容/元器件）、'person'（人物）。
4. details: 结合对话上下文与时间，写一句分析描述（例如：“系统主用户 Gwen，正在调试电路。”或“Gwen 的朋友，在 10:38 进入视频通话画面。”）。
5. relations: 分析新物体与“已存在的节点”之间的语义关联（目标 target 必须是已存在节点列表里的 ID，例如万用表和电阻之间有“测量”关系，面部检测和人之间有“关联”关系）。

请严格只返回一个 JSON 对象，格式如下：
{
  "shouldAdd": true,
  "refinedLabel": "Gwen",
  "type": "person",
  "details": "系统主用户 Gwen，正在调试电路。",
  "relations": []
}
不要包含任何 markdown 块或额外的解释文字。`;

    let resultText = '';

    if (useDashScope) {
      const modelName = process.env.DASHSCOPE_CHAT_MODEL || 'qwen-vl-plus';
      console.log(`[ModelRouter] Object analysis routing to Aliyun DashScope model: ${modelName}`);
      const client = new OpenAI({
        apiKey: dashscopeKey,
        baseURL: process.env.DASHSCOPE_LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
      });

      const contentParts: any[] = [{ type: 'text', text: prompt }];
      if (imageBase64) {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${imageBase64}`
          }
        });
      }

      const response = await client.chat.completions.create({
        model: modelName,
        messages: [{ role: 'user', content: contentParts }],
        temperature: 0.2
      });

      resultText = response.choices[0]?.message?.content || '';
    } else if (useOpenRouter) {
      const modelName = process.env.OPENROUTER_CHAT_MODEL || 'nex-agi/nex-n2-pro:free';
      console.log(`[ModelRouter] Object analysis routing to OpenRouter model: ${modelName}`);
      const client = new OpenAI({
        apiKey: openrouterKey,
        baseURL: 'https://openrouter.ai/api/v1'
      });

      const contentParts: any[] = [{ type: 'text', text: prompt }];
      if (imageBase64) {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${imageBase64}`
          }
        });
      }

      const response = await client.chat.completions.create({
        model: modelName,
        messages: [{ role: 'user', content: contentParts }],
        temperature: 0.2
      });

      resultText = response.choices[0]?.message?.content || '';
    } else {
      console.log('[ModelRouter] Object analysis running in MOCK mode.');
      const lowerClass = className.toLowerCase();
      
      if (lowerClass === 'person') {
        const hasGwen = existingNodes.includes('gwen');
        return {
          shouldAdd: true,
          refinedLabel: hasGwen ? 'Friend' : 'Gwen',
          type: 'person',
          details: hasGwen ? '视频通话中进入画面的用户朋友。' : '系统主用户 Gwen。',
          relations: []
        };
      }
      
      const shouldAdd = lowerClass !== 'person';
      
      const mockRefinedLabels: Record<string, { refinedLabel: string; type: string; details: string }> = {
        'cell phone': { refinedLabel: '智能手机', type: 'device', details: `于时间 ${new Date().toLocaleTimeString()} 视觉检测到的手机设备，结合上下文用于互动。` },
        'scissors': { refinedLabel: '安全剪刀', type: 'tool', details: `于时间 ${new Date().toLocaleTimeString()} 检测到的裁剪工具，在组装场景中使用。` },
        'cup': { refinedLabel: '水杯', type: 'concept', details: `于时间 ${new Date().toLocaleTimeString()} 放置在桌面上的饮水容器。` }
      };
      
      const mockInfo = mockRefinedLabels[lowerClass] || {
        refinedLabel: className,
        type: 'concept',
        details: `于时间 ${new Date().toLocaleTimeString()} 自动检测到的物品: ${className}。`
      };

      const mockRelations: Array<{ target: string; relation: string }> = [];
      if (existingNodes.length > 0) {
        mockRelations.push({
          target: existingNodes[0],
          relation: '同场景出现'
        });
      }

      return {
        shouldAdd,
        refinedLabel: mockInfo.refinedLabel,
        type: mockInfo.type,
        details: mockInfo.details,
        relations: mockRelations
      };
    }

    console.log(`[ModelRouter] Object analysis raw response:\n${resultText}`);

    try {
      const match = resultText.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
      return JSON.parse(resultText);
    } catch (err) {
      console.error(`[ModelRouter] Failed to parse object analysis JSON:`, err);
      return {
        shouldAdd: className.toLowerCase() !== 'person',
        refinedLabel: className,
        type: 'concept',
        details: `自动检测到的"${className}"。`,
        relations: []
      };
    }
  }

  /**
   * 后台异步：从对话文本与图像中提取物理实体，智能过滤并推送给前端图谱
   */
  public static async extractAndAnalyzeEntitiesFromDialogue(
    socket: Socket,
    userSpeech: string,
    aiResponse: string,
    imageBase64: string | null,
    existingNodes: string[],
    overrideLlmProvider?: string
  ): Promise<void> {
    const dashscopeKey = process.env.DASHSCOPE_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    
    const llmProvider = (overrideLlmProvider || process.env.LLM_PROVIDER || 'openrouter').toLowerCase();
    const useDashScope = llmProvider === 'dashscope' && dashscopeKey && dashscopeKey !== 'mock' && !dashscopeKey.startsWith('your_') && !dashscopeKey.startsWith('test-');
    const useOpenRouter = llmProvider === 'openrouter' && openrouterKey && openrouterKey !== 'mock' && !openrouterKey.startsWith('your_') && !openrouterKey.startsWith('test-');

    const combinedTranscript = `用户: ${userSpeech}\nAI助手: ${aiResponse}`;

    // 1. If in mock mode or no API key, use keyword-based fallback
    if (!useDashScope && !useOpenRouter) {
      console.log('[ModelRouter] Dialogue entity extraction running in MOCK mode.');
      const lowerText = combinedTranscript.toLowerCase();
      const mockEntities: Array<{ className: string; refinedLabel: string; type: string; details: string }> = [];
      
      if (lowerText.includes('手机') || lowerText.includes('phone')) {
        mockEntities.push({ className: 'cell phone', refinedLabel: '智能手机', type: 'device', details: '对话中提及的手机设备。' });
      }
      if (lowerText.includes('剪刀') || lowerText.includes('scissors')) {
        mockEntities.push({ className: 'scissors', refinedLabel: '安全剪刀', type: 'tool', details: '对话中涉及的剪裁工具。' });
      }
      if (lowerText.includes('杯子') || lowerText.includes('cup') || lowerText.includes('水杯')) {
        mockEntities.push({ className: 'cup', refinedLabel: '水杯', type: 'concept', details: '对话中提及的水杯。' });
      }
      if (lowerText.includes('万用表') || lowerText.includes('multimeter')) {
        mockEntities.push({ className: 'multimeter', refinedLabel: '数字万用表', type: 'device', details: '对话中提及的数字万用表设备。' });
      }
      if (lowerText.includes('电阻') || lowerText.includes('resistor')) {
        mockEntities.push({ className: 'resistor', refinedLabel: '贴片电阻', type: 'capacitor', details: '对话中提及的贴片电阻电子元器件。' });
      }

      for (const entity of mockEntities) {
        const mockRelations: Array<{ target: string; relation: string }> = [];
        if (existingNodes.length > 0) {
          mockRelations.push({ target: existingNodes[0], relation: '同场景相关' });
        }
        socket.emit('object_analysis_result', {
          className: entity.className,
          imageFrame: imageBase64,
          analysis: {
            shouldAdd: true,
            refinedLabel: entity.refinedLabel,
            type: entity.type,
            details: entity.details,
            relations: mockRelations
          }
        });
      }
      return;
    }

    // 2. Real LLM inference
    const prompt = `你是一个辅助 AI 视觉对话助手的实体分析大脑。
我们刚刚结束了一轮对话，你需要提取和分析对话中提到的或摄像头画面中出现的物理实体与人物角色，以决定它们是否应该录入实体记忆图谱中。

对话历史：
${combinedTranscript}

当前图谱中已存在的节点 (Existing Nodes in Graph)：
${existingNodes.length > 0 ? existingNodes.map(n => `- ${n}`).join('\n') : '(无)'}

任务：
1. 找出对话文本中提到、或者摄像头画面中出现的有价值的物理实体（如万用表、电容、电阻、安全剪刀、水杯等）或人物角色（如系统主用户 "Gwen"、其朋友 "Friend" / 具体名字）。
2. 判断是否应该录入图谱中。
3. 确定它们的中文细化名称 (refinedLabel), 类型 (type, 只能是 'device' | 'tool' | 'wire' | 'concept' | 'capacitor' | 'person' 之一), 详细分析描述 (details) 以及与已有节点的关系 (relations)。

注意：
1. type 必须是以下六个值之一：'device'（设备/仪器）、'tool'（工具）、'wire'（连线）、'concept'（普通概念）、'capacitor'（电容/元器件）、'person'（人物）。
2. refinedLabel: 细化名称。如“万用表”、“面包板”、“Gwen”等。
3. details: 结合对话上下文与时间，写一句分析描述。
4. relations: 分析新物体与“已存在的节点”之间的语义关联（目标 target 必须是已存在节点列表里的 ID）。

请严格只返回一个 JSON 数组，格式如下：
[
  {
    "className": "person",
    "shouldAdd": true,
    "refinedLabel": "Gwen",
    "type": "person",
    "details": "系统主用户 Gwen，与 AI 助手讨论电路调试。",
    "relations": []
  }
]
不要包含任何 markdown 块或额外的解释文字。`;

    let resultText = '';

    try {
      if (useDashScope) {
        const modelName = process.env.DASHSCOPE_CHAT_MODEL || 'qwen-vl-plus';
        const client = new OpenAI({
          apiKey: dashscopeKey,
          baseURL: process.env.DASHSCOPE_LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        });

        const contentParts: any[] = [{ type: 'text', text: prompt }];
        if (imageBase64) {
          contentParts.push({
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${imageBase64}`
            }
          });
        }

        const response = await client.chat.completions.create({
          model: modelName,
          messages: [{ role: 'user', content: contentParts }],
          temperature: 0.2
        });

        resultText = response.choices[0]?.message?.content || '';
      } else if (useOpenRouter) {
        const modelName = process.env.OPENROUTER_CHAT_MODEL || 'nex-agi/nex-n2-pro:free';
        const client = new OpenAI({
          apiKey: openrouterKey,
          baseURL: 'https://openrouter.ai/api/v1'
        });

        const contentParts: any[] = [{ type: 'text', text: prompt }];
        if (imageBase64) {
          contentParts.push({
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${imageBase64}`
            }
          });
        }

        const response = await client.chat.completions.create({
          model: modelName,
          messages: [{ role: 'user', content: contentParts }],
          temperature: 0.2
        });

        resultText = response.choices[0]?.message?.content || '';
      }

      console.log(`[ModelRouter] Background dialogue entity analysis raw response:\n${resultText}`);

      let entities: any[] = [];
      const match = resultText.match(/\[[\s\S]*\]/);
      if (match) {
        entities = JSON.parse(match[0]);
      } else {
        entities = JSON.parse(resultText);
      }

      if (Array.isArray(entities)) {
        for (const item of entities) {
          if (item.shouldAdd && item.className) {
            socket.emit('object_analysis_result', {
              className: item.className,
              imageFrame: imageBase64,
              analysis: {
                shouldAdd: true,
                refinedLabel: item.refinedLabel || item.className,
                type: item.type || 'concept',
                details: item.details || `由 AI 从对话提取的 "${item.refinedLabel || item.className}"。`,
                relations: item.relations || []
              }
            });
          }
        }
      }
    } catch (err) {
      console.error('[ModelRouter] Failed to analyze entities from dialogue background:', err);
    }
  }

  /**
   * 后台从长期记忆中动态重建实体图谱
   */
  public static async reconstructGraphFromMemories(
    memories: any[],
    overrideLlmProvider?: string
  ): Promise<{ nodes: any[]; links: any[] }> {
    const dashscopeKey = process.env.DASHSCOPE_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    
    const llmProvider = (overrideLlmProvider || process.env.LLM_PROVIDER || 'openrouter').toLowerCase();
    const useDashScope = llmProvider === 'dashscope' && dashscopeKey && dashscopeKey !== 'mock' && !dashscopeKey.startsWith('your_') && !dashscopeKey.startsWith('test-');
    const useOpenRouter = llmProvider === 'openrouter' && openrouterKey && openrouterKey !== 'mock' && !openrouterKey.startsWith('your_') && !openrouterKey.startsWith('test-');

    if (memories.length === 0) {
      return { nodes: [], links: [] };
    }

    // 1. Mock Mode fallback
    if (!useDashScope && !useOpenRouter) {
      console.log('[ModelRouter] Graph reconstruction running in MOCK mode.');
      const nodes: any[] = [];
      const links: any[] = [];
      const nodeSet = new Set<string>();

      // Read memories and extract predetermined mocks
      for (const m of memories) {
        const lower = (m.transcript || '').toLowerCase();
        const image = m.image_base64 || undefined;

        if ((lower.includes('手机') || lower.includes('phone')) && !nodeSet.has('cell_phone')) {
          nodeSet.add('cell_phone');
          nodes.push({ id: 'cell_phone', refinedLabel: '智能手机', type: 'device', details: '从历史对话中恢复的手机设备。', image });
        }
        if ((lower.includes('剪刀') || lower.includes('scissors')) && !nodeSet.has('scissors')) {
          nodeSet.add('scissors');
          nodes.push({ id: 'scissors', refinedLabel: '安全剪刀', type: 'tool', details: '从历史对话中恢复的裁剪工具。', image });
        }
        if ((lower.includes('杯子') || lower.includes('cup') || lower.includes('水杯')) && !nodeSet.has('cup')) {
          nodeSet.add('cup');
          nodes.push({ id: 'cup', refinedLabel: '水杯', type: 'concept', details: '从历史对话中恢复的水杯容器。', image });
        }
        if ((lower.includes('万用表') || lower.includes('multimeter')) && !nodeSet.has('multimeter')) {
          nodeSet.add('multimeter');
          nodes.push({ id: 'multimeter', refinedLabel: '数字万用表', type: 'device', details: '从历史对话中恢复的数字万用表。', image });
        }
        if ((lower.includes('电阻') || lower.includes('resistor')) && !nodeSet.has('resistor')) {
          nodeSet.add('resistor');
          nodes.push({ id: 'resistor', refinedLabel: '贴片电阻', type: 'capacitor', details: '从历史对话中恢复的贴片电阻。', image });
        }
      }

      // Build basic links if multiple nodes exist
      const nodeIds = nodes.map(n => n.id);
      if (nodeIds.length > 1) {
        for (let i = 1; i < nodeIds.length; i++) {
          links.push({ source: nodeIds[i - 1], target: nodeIds[i], relation: '同历史场景' });
        }
      }

      return { nodes, links };
    }

    // 2. Real LLM inference
    // Compact memories layout for token reduction
    const memoriesSummary = memories.map((m, i) => {
      return `卡片【${i}】:
ID: ${m.memory_id || 'unknown'}
时间: ${m.timestamp || 'unknown'}
对话摘要: ${m.description || '无'}
提取标签: [${(m.tags || []).join(', ')}]
对话录音记录:
${(m.transcript || '').slice(0, 500)}
---`;
    }).join('\n\n');

    const prompt = `你是一个辅助 AI 视觉对话助手的图谱重建大脑。
我们从向量数据库中加载了当前用户的所有长期情景记忆卡片，请你根据这些历史记录，重新梳理并构建出一个实体关系拓扑图谱。

历史情景记忆卡片列表：
${memoriesSummary}

任务：
1. 找出历史记忆中涉及到的所有关键物理实体（如设备、工具、元器件、关键概念）与人物角色（如主用户 "Gwen"、其朋友 "Friend" / 具体名字）。
2. 对每个实体进行智能合并（例如在不同对话里出现的“万用表”应属于同一个节点），确定它的中文细化名称 (refinedLabel)、类型 (type，只能是 'device' | 'tool' | 'wire' | 'concept' | 'capacitor' | 'person' 之一)、详细分析描述 (details)，并找出与它最相关的那个记忆卡片ID (memoryCardId，从卡片的 ID 字段中获取)。
3. 提取实体与实体之间的语义关联 (relations)。

注意：
1. type 必须是以下六个值之一：'device'（设备/仪器）、'tool'（工具）、'wire'（连线）、'concept'（普通概念）、'capacitor'（电容/元器件）、'person'（人物）。
2. relations 中的 target 必须是图谱中其他节点的 ID（由名称拼写转换为小写下划线标识，如 "gwen"、"friend"）。

请严格只返回一个 JSON 对象，格式如下：
{
  "nodes": [
    {
      "id": "gwen",
      "refinedLabel": "Gwen",
      "type": "person",
      "details": "系统主用户 Gwen。",
      "memoryCardId": "对应的记忆卡片ID"
    }
  ],
  "links": [
    {
      "source": "friend",
      "target": "gwen",
      "relation": "朋友"
    }
  ]
}
不要包含任何 markdown 块或额外的解释文字。`;

    let resultText = '';

    try {
      if (useDashScope) {
        const modelName = process.env.DASHSCOPE_CHAT_MODEL || 'qwen-vl-plus';
        const client = new OpenAI({
          apiKey: dashscopeKey,
          baseURL: process.env.DASHSCOPE_LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        });

        const response = await client.chat.completions.create({
          model: modelName.replace('-vl', ''), // Use text-only model variant
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2
        });

        resultText = response.choices[0]?.message?.content || '';
      } else if (useOpenRouter) {
        const modelName = process.env.OPENROUTER_CHAT_MODEL || 'nex-agi/nex-n2-pro:free';
        const client = new OpenAI({
          apiKey: openrouterKey,
          baseURL: 'https://openrouter.ai/api/v1'
        });

        const response = await client.chat.completions.create({
          model: modelName,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2
        });

        resultText = response.choices[0]?.message?.content || '';
      }

      console.log(`[ModelRouter] Reconstruct graph raw response:\n${resultText}`);

      let graphData: { nodes: any[]; links: any[] } = { nodes: [], links: [] };
      const match = resultText.match(/\{[\s\S]*\}/);
      if (match) {
        graphData = JSON.parse(match[0]);
      } else {
        graphData = JSON.parse(resultText);
      }

      // Post-process: map memoryCardId to image_base64
      if (graphData && Array.isArray(graphData.nodes)) {
        for (const node of graphData.nodes) {
          const cardId = node.memoryCardId;
          if (cardId) {
            const matchedMemory = memories.find(m => m.memory_id === cardId);
            if (matchedMemory && matchedMemory.image_base64) {
              node.image = matchedMemory.image_base64;
            }
          }
          // Ensure standard ID format (lowercase, underscores)
          node.id = node.id.toLowerCase().replace(/\s+/g, '_');
        }
      }

      // Map links source/target IDs to match standard
      if (graphData && Array.isArray(graphData.links)) {
        for (const link of graphData.links) {
          if (typeof link.source === 'string') {
            link.source = link.source.toLowerCase().replace(/\s+/g, '_');
          }
          if (typeof link.target === 'string') {
            link.target = link.target.toLowerCase().replace(/\s+/g, '_');
          }
        }
      }

      return {
        nodes: graphData.nodes || [],
        links: graphData.links || []
      };

    } catch (err) {
      console.error('[ModelRouter] Failed to reconstruct graph from LLM:', err);
      return { nodes: [], links: [] };
    }
  }
}

