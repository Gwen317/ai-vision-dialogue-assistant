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
  private static ttsClient = new CosyVoiceTtsClient();

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

  public static async processInteraction(
    socket: Socket,
    audioBuffer: Buffer,
    audioMimeType: string,
    imageFrame: ImageFrameEvent | null,
    timeline: TimelineEvent[],
    turnTiming: TurnTiming,
    signal: AbortSignal,
    localText?: string,
    overrideLlmProvider?: string,
    overrideTtsProvider?: string
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

    // 2. Query Long-Term Multimodal Episodic Memory
    console.log('Querying episodic memory...');
    const currentImageBase64 = imageFrame?.imageBase64 ?? null;
    const recalledMemory = await EpisodicMemoryService.queryMemory(userSpeech, currentImageBase64);

    // Guard: abort during memory query
    if (signal.aborted) {
      console.log('Aborted during memory query, skipping timeline write.');
      return;
    }

    // 3. Construct System Instruction / Prompt with memory context
    let systemInstruction = 'You are a futuristic, helpful AI Vision Dialogue Assistant. You have access to the user\'s real-time camera feed and microphone. Answer clearly, naturally, and concisely in Chinese. (请使用中文回答用户。)\n\nIMPORTANT: If you see "[System: Your previous response was interrupted]" in the conversation history, the user cut you off mid-response. Continue seamlessly from the exact breakpoint — do NOT repeat what you already said. Incorporate the user\'s new input into your continued reasoning.';
    
    if (recalledMemory) {
      const timeDiff = Math.round((Date.now() - recalledMemory.timestamp.getTime()) / 60000); // Minutes
      const entityInfo = recalledMemory.entityTags?.length
        ? `\nIdentified entities: [${recalledMemory.entityTags.join(', ')}]`
        : '';
      systemInstruction += `\n[RECALLED EPISODIC MEMORY] You have recalled a past event from ${timeDiff} minutes ago. The user previously showed a/an "${recalledMemory.description}" and the conversation was:\n${recalledMemory.transcript}${entityInfo}\nRefer to this past event naturally if the user asks about the past, mentions things shown earlier, or asks you to compare items.`;
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
              this.synthesizeAndEmit(socket, clause, currentIndex, signal, overrideTtsProvider);
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
      this.synthesizeAndEmit(socket, remaining, currentIndex, signal, overrideTtsProvider);
    }

    console.log('Stream generation completed.');

    modelMessageEntry.timestamp = Date.now();

    // 6. Save to Long-Term Episodic Memory in the background (non-blocking)
    EpisodicMemoryService.recordMemory(userSpeech, fullResponseText, currentImageBase64)
      .catch(err => console.error('Background memory recording failed:', err));

    socket.emit('state_change', 'IDLE');
  }

  public static async processTextInteraction(
    socket: Socket,
    userSpeech: string,
    imageFrame: ImageFrameEvent | null,
    timeline: TimelineEvent[],
    turnTiming: TurnTiming,
    signal: AbortSignal,
    overrideLlmProvider?: string,
    overrideTtsProvider?: string
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
    const recalledMemory = await EpisodicMemoryService.queryMemory(userSpeech, currentImageBase64);

    if (signal.aborted) {
      console.log('Text query aborted during memory query.');
      return;
    }

    let systemInstruction = 'You are a futuristic, helpful AI Vision Dialogue Assistant. You have access to the user\'s real-time camera feed and microphone. Answer clearly, naturally, and concisely in Chinese. (请使用中文回答用户。)\n\nIMPORTANT: If you see "[System: Your previous response was interrupted]" in the conversation history, the user cut you off mid-response. Continue seamlessly from the exact breakpoint — do NOT repeat what you already said. Incorporate the user\'s new input into your continued reasoning.';
    if (recalledMemory) {
      const timeDiff = Math.round((Date.now() - recalledMemory.timestamp.getTime()) / 60000);
      const entityInfo = recalledMemory.entityTags?.length
        ? `\nIdentified entities: [${recalledMemory.entityTags.join(', ')}]`
        : '';
      systemInstruction += `\n[RECALLED EPISODIC MEMORY] You have recalled a past event from ${timeDiff} minutes ago. The user previously showed a/an "${recalledMemory.description}" and the conversation was:\n${recalledMemory.transcript}${entityInfo}\nRefer to this past event naturally if the user asks about the past, mentions things shown earlier, or asks you to compare items.`;
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
              this.synthesizeAndEmit(socket, clause, currentIndex, signal, overrideTtsProvider);
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
      this.synthesizeAndEmit(socket, remaining, currentIndex, signal, overrideTtsProvider);
    }

    modelMessageEntry.timestamp = Date.now();

    EpisodicMemoryService.recordMemory(userSpeech, fullResponseText, currentImageBase64)
      .catch(err => console.error('Background memory recording failed:', err));

    socket.emit('state_change', 'IDLE');
  }

  private static async synthesizeAndEmit(
    socket: Socket,
    text: string,
    index: number,
    signal: AbortSignal,
    overrideTtsProvider?: string
  ): Promise<void> {
    if (overrideTtsProvider === 'browser') {
      return;
    }
    if (!this.ttsClient.isConfigured()) {
      return;
    }

    try {
      const voiceId = process.env.DASHSCOPE_VOICE_ID || 'longanyang';
      const audioBuffer = await this.ttsClient.synthesize(text, voiceId);

      if (signal.aborted) {
        return;
      }

      socket.emit('audio_tts_chunk', {
        audio: audioBuffer,
        index
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
    const useDashScope = llmProvider === 'dashscope' && dashscopeKey && dashscopeKey !== 'mock' && !dashscopeKey.startsWith('your_');
    const useOpenRouter = llmProvider === 'openrouter' && openrouterKey && openrouterKey !== 'mock' && !openrouterKey.startsWith('your_');

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
1. shouldAdd: 如果此物体仅仅是背景杂音（例如检测到了 person，但其实这只是用户本人，图谱不需要记录用户本人作为物品；或者检测错误/无关噪点），则设为 false；如果它是一个重要的物理实体（如电容、仪器、手机、电阻、剪刀等工具或设备），尤其是用户在对话中提到过或正在使用的，设为 true。
2. refinedLabel: 细化名称。如果上下文明确了该物体的具体名称（例如用户提到“这是我的万用表”，而标签只是“electronic device”），请将其重命名为更具体、有温度的中文名（如“万用表”）；若无更具体命名，请翻译为通俗的中文名（如 "cell phone" -> "智能手机"）。
3. type: 必须是以下五个值之一：'device'（设备/仪器）、'tool'（工具）、'wire'（连线）、'concept'（普通概念）、'capacitor'（电容/元器件）。
4. details: 结合对话上下文与时间，写一句分析描述（例如：“用户在 19:30 调试电路时使用的剪刀，用于修剪导线。”）。
5. relations: 分析该物体与“已存在的节点”之间的语义关联（例如，万用表和电阻之间有“测量”关系，面包板和导线之间有“插接”关系）。

请严格只返回一个 JSON 对象，格式如下：
{
  "shouldAdd": true,
  "refinedLabel": "智能手机",
  "type": "device",
  "details": "用户在对话中用以展示或调试的手机设备。",
  "relations": [
    { "target": "existing_node_id", "relation": "连接到" }
  ]
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
      const shouldAdd = lowerClass !== 'person';
      
      const mockRefinedLabels: Record<string, { refinedLabel: string; type: string; details: string }> = {
        'cell phone': { refinedLabel: '智能手机', type: 'device', details: `于时间 ${new Date().toLocaleTimeString()} 视觉检测到的手机设备，结合上下文用于互动。` },
        'scissors': { refinedLabel: '安全剪刀', type: 'tool', details: `于时间 ${new Date().toLocaleTimeString()} 检测到的裁剪工具，在组装场景中使用。` },
        'cup': { refinedLabel: '水杯', type: 'concept', details: `于时间 ${new Date().toLocaleTimeString()} 放置在桌面上的饮水容器。` },
        'person': { refinedLabel: '用户本人', type: 'concept', details: '互动的参与主体。' }
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
}

