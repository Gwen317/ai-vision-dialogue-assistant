import type { ChatMessages } from '../../node_modules/@openrouter/sdk/esm/models/index.js';
import { Socket } from 'socket.io';
import { EpisodicMemoryService } from '../../memory_graph/episodic_memory/EpisodicMemoryService';
import type { TimelineEvent } from '../gateway_core/SocketGateway';

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

  const messages: ChatMessages[] = [
    {
      role: 'system',
      content: systemInstruction
    }
  ];

  const currentUserEvent: TimelineEvent = {
    type: 'message',
    timestamp: turnTiming.speechStartedAt,
    role: 'user',
    parts: currentParts
  };

  const historicalMessages = timeline
    .filter(event => event.type === 'message' && event.timestamp <= turnTiming.speechEndedAt)
    .slice(-6);

  const imageEvents = timeline
    .filter(event => event.type === 'image' && event.timestamp <= turnTiming.speechEndedAt)
    .sort((a, b) => a.timestamp - b.timestamp);

  const selectedImages = new Map<number, TimelineEvent>();
  imageEvents
    .filter(event => event.timestamp <= turnTiming.speechStartedAt)
    .slice(-2)
    .forEach(event => selectedImages.set(event.timestamp, event));

  const latestImageBeforeTurnEnd = imageEvents.at(-1);
  if (latestImageBeforeTurnEnd) {
    selectedImages.set(latestImageBeforeTurnEnd.timestamp, latestImageBeforeTurnEnd);
  }

  const contextEvents = [
    ...historicalMessages,
    ...selectedImages.values(),
    currentUserEvent
  ].sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }

    if (a.type === b.type) {
      return 0;
    }

    return a.type === 'image' ? -1 : 1;
  });

  for (const event of contextEvents) {
    if (event.type === 'message') {
      messages.push({
        role: event.role === 'model' ? 'assistant' : 'user',
        content: event.parts
      });
      continue;
    }

    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `[Camera frame captured @ ${new Date(event.timestamp).toISOString()}]`
        },
        {
          type: 'image_url',
          imageUrl: {
            url: `data:image/jpeg;base64,${event.imageBase64}`,
            detail: 'low'
          }
        }
      ]
    });
  }

  return { messages, currentParts };
}

export class ModelRouter {
  private static openrouter: any = null;

  public static setOpenRouterForTest(openrouter: any) {
    this.openrouter = openrouter;
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

  public static async processInteraction(
    socket: Socket,
    audioBuffer: Buffer,
    imageFrame: ImageFrameEvent | null,
    timeline: TimelineEvent[],
    turnTiming: TurnTiming,
    signal: AbortSignal
  ): Promise<void> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey === 'mock' || apiKey.startsWith('your_')) {
      console.log('--- ModelRouter: Running in MOCK MODE ---');
      
      // Simulate transcription feedback
      socket.emit('user_transcription', '测试双工打断');
      
      // Notify state SPEAKING
      socket.emit('state_change', 'SPEAKING');
      
      const mockText = '这是一个用于测试双工流式打断功能的测试段落。在这个模式下，大模型不会进行真实的网络调用，而是以每两百毫秒一个词的速度向下游推送这一段很长的话。你可以随时对着你的麦克风说话，或者发出大一点的声音来测试端侧的静音检测是否能成功识别你开口说话的动作。一旦系统检测到你的声音，前端就会自动执行打断流程，将 AI 正在播放的声音静音，并通知后端强行关闭当前的流。我们可以测试后端的日志是否会打印 Stream generation aborted 和 Memory truncated。现在，请你试着说话来打断我吧！';
      
      const chunks = mockText.split(/(?=[，。、])| /);
      let fullResponseText = '';
      
      while (true) {
        for (const chunk of chunks) {
          if (signal.aborted) {
            console.log('Mock Stream generation aborted by client.');
            return;
          }
          
          fullResponseText += chunk;
          socket.emit('text_chunk', chunk);
          
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        // Small delay between loops
        await new Promise((resolve) => setTimeout(resolve, 1000));
        console.log('Mock Stream looping: restarting text output.');
      }
      return;
    }

    const openrouter = await this.getOpenRouter();

    // 1. Transcribe the user's audio
    console.log('Transcribing user audio...');
    const transcriptionResult = await openrouter.stt.createTranscription({
      sttRequest: {
        model: process.env.OPENROUTER_STT_MODEL || 'openai/whisper-1',
        inputAudio: {
          data: audioBuffer.toString('base64'),
          format: 'webm'
        },
        temperature: 0
      }
    });

    const userSpeech = transcriptionResult.text.trim();
    console.log(`Transcribed text: "${userSpeech}"`);

    if (!userSpeech) {
      console.log('No speech detected in audio.');
      socket.emit('user_transcription', '');
      socket.emit('state_change', 'IDLE');
      return;
    }

    // Emit the transcribed text back to the client immediately
    socket.emit('user_transcription', userSpeech);

    // 2. Query Long-Term Multimodal Episodic Memory
    console.log('Querying episodic memory...');
    const currentImageBase64 = imageFrame?.imageBase64 ?? null;
    const recalledMemory = await EpisodicMemoryService.queryMemory(userSpeech, currentImageBase64);
    
    // 3. Determine Model Routing (Tier 2 vs Tier 3)
    let selectedModelName = process.env.OPENROUTER_CHAT_MODEL || 'nex-agi/nex-n2-pro:free';
    const complexKeywords = ['debug', 'code', 'math', 'solve', 'circuit', 'program', 'algorithm', 'explain in detail', 'analyze'];
    const lowerSpeech = userSpeech.toLowerCase();
    
    if (complexKeywords.some(keyword => lowerSpeech.includes(keyword))) {
      selectedModelName = process.env.OPENROUTER_REASONING_MODEL || selectedModelName;
      console.log(`Routing query to reasoning model: ${selectedModelName}`);
    } else {
      console.log(`Routing query to chat model: ${selectedModelName}`);
    }

    // 4. Construct System Instruction / Prompt with memory context
    let systemInstruction = 'You are a futuristic, helpful AI Vision Dialogue Assistant. You have access to the user\'s real-time camera feed and microphone. Answer clearly, naturally, and concisely.';
    
    if (recalledMemory) {
      const timeDiff = Math.round((Date.now() - recalledMemory.timestamp.getTime()) / 60000); // Minutes
      systemInstruction += `\n[RECALLED EPISODIC MEMORY] You have recalled a past event from ${timeDiff} minutes ago. The user previously showed a/an "${recalledMemory.description}" and the conversation was:\n${recalledMemory.transcript}\nRefer to this past event naturally if the user asks about the past, mentions things shown earlier, or asks you to compare items.`;
    }

    // 5. Assemble current payload parts in event-time order.
    const { messages, currentParts } = buildTimelineMessages({
      systemInstruction,
      userSpeech,
      timeline,
      turnTiming
    });

    // 6. Generate content stream
    console.log('Generating streaming content...');
    socket.emit('state_change', 'SPEAKING');
    
    const responseStream = await openrouter.chat.send({
      chatRequest: {
        model: selectedModelName,
        messages,
        stream: true,
        reasoning: {
          effort: 'medium'
        },
        streamOptions: {
          includeUsage: true
        }
      }
    });

    let fullResponseText = '';

    for await (const chunk of responseStream) {
      // Check for abort signal from client interruption
      if (signal.aborted) {
        console.log('Stream generation aborted.');
        return;
      }
      
      if (chunk.error) {
        throw new Error(`OpenRouter stream error ${chunk.error.code}: ${chunk.error.message}`);
      }

      const chunkText = chunk.choices[0]?.delta?.content ?? '';
      fullResponseText += chunkText;
      
      // Stream text chunk to client
      if (chunkText) {
        socket.emit('text_chunk', chunkText);
      }

      const reasoningTokens = chunk.usage?.completionTokensDetails?.reasoningTokens;
      if (reasoningTokens) {
        console.log(`OpenRouter reasoning tokens: ${reasoningTokens}`);
      }
    }

    console.log('Stream generation completed.');

    const modelAnsweredAt = Date.now();

    // Save this turn to the shared timeline using event time, not processing time.
    timeline.push({
      type: 'message',
      timestamp: turnTiming.speechStartedAt,
      role: 'user',
      parts: currentParts
    });
    timeline.push({
      type: 'message',
      timestamp: modelAnsweredAt,
      role: 'model',
      parts: [{ text: fullResponseText }]
    });

    // 7. Save to Long-Term Episodic Memory in the background (non-blocking)
    EpisodicMemoryService.recordMemory(userSpeech, fullResponseText, currentImageBase64)
      .catch(err => console.error('Background memory recording failed:', err));

    socket.emit('state_change', 'IDLE');
  }
}
