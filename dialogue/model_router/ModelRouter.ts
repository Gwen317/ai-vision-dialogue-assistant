/**
 * ModelRouter.ts — 实时音视频对话编排核心
 *
 * 这是后端对话链路的"指挥中枢"，串联起一整轮交互：
 *   语音转写(STT) → 长程情景记忆召回(RAG) → 系统提示词组装 → 多模态 LLM 流式生成
 *   → 句级切分 + 语音合成(TTS) 下发 → 后台记忆归档与实体抽取。
 *
 * 为保持职责单一与可读性，传输层细节已拆分到同目录下的协作模块：
 *   - llmProvider.ts        供应商路由 / 凭证校验 / 客户端工厂 / 响应解析
 *   - audioTranscription.ts 语音转写（ffmpeg 转码 + DashScope / Molifangzhou ASR）
 *   - entityGraphAnalyzer.ts 实体记忆图谱的语义分析（本类仅做静态门面转发）
 *
 * 公共 API（processInteraction / processTextInteraction / analyzeDetectedObject /
 * reconstructGraphFromMemories 等）及导出函数（needsVisionInput / buildTimelineMessages）
 * 维持稳定，供 SocketGateway 与单元测试调用。
 */

import type { ChatMessages } from '../../node_modules/@openrouter/sdk/esm/models/index.js';
import { Socket } from 'socket.io';
import { EpisodicMemoryService } from '../../memory_graph/episodic_memory/EpisodicMemoryService';
import type { TimelineEvent, ConversationMessageEvent } from '../gateway_core/SocketGateway';
import { CosyVoiceTtsClient } from './CosyVoiceTtsClient';
import { resolveCosyVoiceId } from './cosyVoicePresetVoices';
import {
  resolveLlmRouting,
  createOpenAiClient,
  DEFAULT_DASHSCOPE_CHAT_MODEL,
  DEFAULT_DASHSCOPE_REASONING_MODEL,
  DEFAULT_OPENROUTER_MODEL
} from './llmProvider';
import {
  transcribeWithDashScope,
  transcribeWithMolifangzhou,
  hasDashScopeStt,
  hasMolifangzhouStt
} from './audioTranscription';
import {
  analyzeDetectedObject as analyzeDetectedObjectImpl,
  extractAndAnalyzeEntitiesFromDialogue as extractEntitiesImpl,
  reconstructGraphFromMemories as reconstructGraphImpl
} from './entityGraphAnalyzer';

// ─────────────────────────────────────────────
//  类型定义
// ─────────────────────────────────────────────

/** OpenRouter SDK 风格的内容片段（文本或图像，注意是 imageUrl 而非 image_url） */
type OpenRouterContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; imageUrl: { url: string; detail?: 'auto' | 'low' | 'high' } };

interface ImageFrameEvent {
  type: 'image';
  timestamp: number;
  imageBase64: string;
}

/** 一轮发言的起止时间 */
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

// ─────────────────────────────────────────────
//  视觉意图判定
// ─────────────────────────────────────────────

/** 本轮是否需要附带摄像头画面与视觉相关的提示上下文。 */
export function needsVisionInput(userSpeech: string): boolean {
  const text = userSpeech.trim();
  if (!text) return false;

  // 创作 / 闲聊 / 工具类请求 —— 明确不需要视觉
  const nonVisionPatterns = [
    /作文|小作文|写一[篇段句个]?|帮我写|给我写/,
    /故事|小故事|讲一[个篇段]?|给我讲|说一[个篇段]?|编一[个篇段]?/,
    /笑话|诗词|诗歌|猜谜|顺口溜/,
    /翻译|计算|算术|几点了|今天星期/,
    /^(你好|嗨|哈喽|谢谢|再见|嗯|啊|哦)[\?？!！。…]*$/
  ];
  if (nonVisionPatterns.some(p => p.test(text))) return false;

  // 明确指向画面 / 物体 / 记忆的请求 —— 需要视觉
  const visionPatterns = [
    /看(看|一下|到|见)|画面|镜头|视频|摄像头|相机/,
    /这是什么|那是什么|什么东西|识别|辨认|检测/,
    /描述|穿搭|长相|颜色|形状|大小/,
    /展示|拿着|举着|手里|桌上|面前|镜头前/,
    /记住|录入|图谱|记忆|分析.*(画面|镜头|物体|物品)/,
    /对比|上次|之前|还记得|以前|刚才.*(看|展示)/,
    /帮我看|你看看|看一下|能看见|看到/
  ];
  if (visionPatterns.some(p => p.test(text))) return true;

  return false;
}

// ─────────────────────────────────────────────
//  消息组装
// ─────────────────────────────────────────────

/**
 * 按"事件时间顺序"把时间线组装为发送给 LLM 的消息数组。
 *
 * 关键约定：
 * - 仅把"截至本轮发言结束"前的最新一张图像合并进当前用户消息（不单独成条消息）；
 * - 历史消息一律剥离图像、仅保留文本，避免历史图像污染 token 与时序；
 * - 被用户打断过的模型消息会追加一段"请从断点继续"的系统提示。
 */
export function buildTimelineMessages({
  systemInstruction,
  userSpeech,
  timeline,
  turnTiming,
  includeImage = true
}: BuildTimelineMessagesInput & { includeImage?: boolean }): {
  messages: ChatMessages[];
  currentParts: OpenRouterContentPart[];
} {
  const currentParts: OpenRouterContentPart[] = [
    {
      type: 'text',
      text: `[User speech @ ${new Date(turnTiming.speechStartedAt).toISOString()} - ${new Date(turnTiming.speechEndedAt).toISOString()}]\n${userSpeech}`
    }
  ];

  // 取本轮发言结束前最新的一张图像，合并进当前用户消息
  const imageEvents = timeline
    .filter(event => event.type === 'image' && event.timestamp <= turnTiming.speechEndedAt)
    .sort((a, b) => a.timestamp - b.timestamp);

  const latestImage = imageEvents.at(-1) as Extract<TimelineEvent, { type: 'image' }> | undefined;
  if (latestImage && includeImage) {
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

  // 历史消息：仅文本、按事件时间排序、保留最近 6 条
  const historicalMessages = timeline
    .filter((event): event is ConversationMessageEvent => event.type === 'message' && event.timestamp <= turnTiming.speechEndedAt)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-6);

  for (const event of historicalMessages) {
    let content = event.parts;

    // 被打断的模型回复：追加"从断点无缝继续"的提示
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

    // 剥离历史消息中的图像片段，保持纯文本历史
    if (Array.isArray(content)) {
      content = content.filter((part: any) => !part.type || part.type !== 'image_url');
    }

    messages.push({
      role: event.role === 'model' ? 'assistant' : 'user',
      content
    });
  }

  // 当前用户消息（文本 + 合并图像）置于末尾
  messages.push({
    role: 'user',
    content: currentParts
  });

  return { messages, currentParts };
}

/**
 * 按目标模型能力调整消息：
 * - 非视觉模型剥离图像片段；
 * - 把 OpenRouter 风格的 imageUrl 转为 OpenAI 风格的 image_url；
 * - 内容仅剩单条文本时简化为字符串以精简载荷。
 */
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
            return null; // 非视觉模型：丢弃图像
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
          return { type: 'text', text: part.text };
        }
        return part;
      }).filter(Boolean);

      if (parts.length === 0) {
        return { role: msg.role, content: '[Image omitted]' };
      }
      if (parts.length === 1 && parts[0].type === 'text') {
        return { role: msg.role, content: parts[0].text };
      }
      return { role: msg.role, content: parts };
    }
    return msg;
  });
}

export class ModelRouter {
  /** 可注入的 OpenRouter SDK 实例（测试用） */
  private static openrouter: any = null;
  /** 可注入的自定义语音转写器（测试用） */
  private static speechTranscriber: ((audioBuffer: Buffer) => Promise<string>) | null = null;
  private static ttsClientInstance: CosyVoiceTtsClient | null = null;

  private static get ttsClient(): CosyVoiceTtsClient {
    if (!this.ttsClientInstance) {
      this.ttsClientInstance = new CosyVoiceTtsClient();
    }
    return this.ttsClientInstance;
  }

  /** 句级切分用的标点分隔符（按优先级排序） */
  private static readonly SENTENCE_DELIMITERS = ['。', '！', '？', '；', '.', '!', '?', '\n'];

  /** 触发"推理模型"的复杂任务关键词 */
  private static readonly REASONING_KEYWORDS = [
    'debug', 'code', 'math', 'solve', 'circuit', 'program', 'algorithm', 'explain in detail', 'analyze'
  ];

  // ─── 测试注入 ───

  public static setOpenRouterForTest(openrouter: any) {
    this.openrouter = openrouter;
  }

  public static setSpeechTranscriberForTest(transcriber: ((audioBuffer: Buffer) => Promise<string>) | null) {
    this.speechTranscriber = transcriber;
  }

  // ─────────────────────────────────────────────
  //  LLM 流式接入
  // ─────────────────────────────────────────────

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

  /**
   * 根据供应商与任务复杂度选择模型，并发起流式生成。
   * 流式链路使用 allowTestKeys=true：测试密钥被视为真实凭证，
   * 以便注入的 mock OpenRouter 客户端被走到。
   */
  private static async getLlmStream(
    messages: any[],
    userSpeech: string,
    overrideLlmProvider?: string
  ): Promise<{ stream: any; modelName: string }> {
    const routing = resolveLlmRouting(overrideLlmProvider, true);
    const lowerSpeech = userSpeech.toLowerCase();
    const isReasoning = this.REASONING_KEYWORDS.some(keyword => lowerSpeech.includes(keyword));

    if (routing.useDashScope) {
      const modelName = isReasoning
        ? (process.env.DASHSCOPE_REASONING_MODEL || DEFAULT_DASHSCOPE_REASONING_MODEL)
        : (process.env.DASHSCOPE_CHAT_MODEL || DEFAULT_DASHSCOPE_CHAT_MODEL);

      console.log(`Routing to Aliyun DashScope model: ${modelName}`);
      const client = createOpenAiClient('dashscope', routing.dashscopeKey!);
      const stream = await client.chat.completions.create({
        model: modelName,
        messages: prepareMessagesForModel(messages, modelName),
        stream: true,
        stream_options: { include_usage: true }
      });
      return { stream, modelName };
    }

    // 默认走 OpenRouter（通过 SDK，便于测试注入）
    const modelName = isReasoning
      ? (process.env.OPENROUTER_REASONING_MODEL || process.env.OPENROUTER_CHAT_MODEL || DEFAULT_OPENROUTER_MODEL)
      : (process.env.OPENROUTER_CHAT_MODEL || DEFAULT_OPENROUTER_MODEL);

    console.log(`Routing to OpenRouter model: ${modelName}`);
    const openrouter = await this.getOpenRouter();
    const stream = await openrouter.chat.send({
      chatRequest: {
        model: modelName,
        messages: prepareMessagesForModel(messages, modelName),
        stream: true,
        reasoning: { effort: 'medium' },
        streamOptions: { includeUsage: true }
      }
    });
    return { stream, modelName };
  }

  // ─────────────────────────────────────────────
  //  视觉上下文与系统提示词
  // ─────────────────────────────────────────────

  /** 可能被用户"举到镜头前"的手持物体类别 */
  private static readonly HANDHELD_OBJECT_CLASSES = new Set([
    'cell phone', 'cup', 'bottle', 'scissors', 'book', 'handbag', 'banana', 'apple', 'orange', 'keyboard', 'mouse', 'laptop'
  ]);

  /** 把目标检测类别转写为面向 LLM 的自然语言描述（区分"人物"与"手持物"） */
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

  /** 把视觉检测拼进记忆检索查询（作为背景上下文） */
  private static buildMemoryQueryText(userSpeech: string, visualContext?: string[]): string {
    const objects = [...new Set((visualContext ?? []).map(v => v.trim()).filter(Boolean))];
    if (objects.length === 0) return userSpeech;
    const descriptions = objects.map(o => this.describeDetectedEntity(o));
    return `${userSpeech}\n[Camera context — background only: ${descriptions.join('; ')}]`;
  }

  /** 把视觉检测拼进系统提示词（强调仅为静默背景，不得主动复述） */
  private static buildVisualContextPrompt(visualContext?: string[]): string {
    const objects = [...new Set((visualContext ?? []).map(v => v.trim()).filter(Boolean))];
    if (objects.length === 0) return '';
    const descriptions = objects.map(o => this.describeDetectedEntity(o));
    return `\n[CURRENT CAMERA DETECTION — BACKGROUND ONLY] ${descriptions.join('; ')}\nSilent object-detection context — NOT the user's request. Do NOT mention these detections unless the user asks about the video/scene. Never describe people as something the user is "holding".`;
  }

  /** 构造基础系统指令（按是否为视觉轮切换提示策略） */
  private static getBaseSystemInstruction(visualContext?: string[], visionTurn = true): string {
    const priorityRules =
      'RESPONSE PRIORITY (critical — follow strictly):\n' +
      '1. The user\'s spoken request is ALWAYS the primary task. Answer it directly first.\n' +
      '2. Do NOT open with camera/scene descriptions ("画面里…", "我看到…", "背景是…") unless the user explicitly asks about the video, scene, objects, or their appearance.\n' +
      '3. For creative or conversational requests (写作文, 讲故事, 笑话, 聊天, 问答, 指令), respond ONLY to that request — zero visual preamble.\n' +
      '4. Camera frames and detection tags (when present) are silent background context — use them only when directly relevant to what the user asked.\n\n';

    const visionGuidelines = visionTurn
      ? 'WHEN (and only when) the user asks about the video/scene/objects:\n' +
        '- This is a live video call — never say "自拍", "上传的照片", or "截图".\n' +
        '- People appear IN the frame — e.g. "画面里有一位…". NEVER say the user is "holding" or "拿着" a person.\n' +
        '- Objects shown to camera — e.g. "你在镜头前展示的是…", "我看到你手里拿着…".\n' +
        '- When referring to recalled memories with images, use previous video call sessions (e.g. "我们上次视频通话见过…").\n\n'
      : 'This turn has NO camera frame attached. Respond as a voice assistant only — do not invent or describe visual details.\n\n';

    return (
      'You are a helpful AI assistant in a real-time live video and audio call. Answer clearly, naturally, and concisely in Chinese. (请使用中文回答用户。)\n\n' +
      priorityRules +
      visionGuidelines +
      'IMPORTANT: If you see "[System: Your previous response was interrupted]" in the conversation history, the user cut you off mid-response. Continue seamlessly from the exact breakpoint — do NOT repeat what you already said. Incorporate the user\'s new input into your continued reasoning.' +
      (visionTurn ? this.buildVisualContextPrompt(visualContext) : '')
    );
  }

  /** 把召回的情景记忆拼进系统提示词（作为背景上下文，不得喧宾夺主） */
  private static buildRecalledMemoryPrompt(recalledMemory: { timestamp: Date; description: string; transcript: string; entityTags?: string[] }): string {
    const timeDiff = Math.round((Date.now() - recalledMemory.timestamp.getTime()) / 60000);
    const entityInfo = recalledMemory.entityTags?.length
      ? `\nIdentified entities: [${recalledMemory.entityTags.join(', ')}]`
      : '';
    return `\n[RECALLED EPISODIC MEMORY — BACKGROUND CONTEXT ONLY] A past event from ${timeDiff} minutes ago was silently retrieved alongside the user's message. In that earlier video call, the feed included "${recalledMemory.description}" and the conversation was:\n${recalledMemory.transcript}${entityInfo}\nThis is supplementary background — NOT the user's primary request. Answer the user's actual question first. Only reference this memory when it is directly relevant to what they asked (e.g. they ask about the past, compare items, or mention something shown earlier). Do not hijack the reply to recite memory unprompted. When the recalled content involves a person, refer to them as having appeared in the video — never as an object the user was holding.`;
  }

  // ─────────────────────────────────────────────
  //  入口一：语音轮（音频 → 转写 → 对话）
  // ─────────────────────────────────────────────

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
    // 无可用 LLM 凭证 → 进入双工打断测试用的 mock 流
    if (resolveLlmRouting(overrideLlmProvider, true).isMock) {
      console.log('--- ModelRouter: Running in MOCK MODE ---');
      await this.runMockDuplexStream(socket, timeline, turnTiming, signal, localText);
      return;
    }

    // 1. 语音转写
    console.log('Transcribing user audio...');
    let userSpeech: string;
    try {
      const transcribed = await this.transcribeUserAudio(socket, audioBuffer, audioMimeType, localText);
      if (transcribed === null) return; // 终态事件已发出（空音频且无本地文本）
      userSpeech = transcribed;
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

    // 把识别文本立即回显给前端
    socket.emit('user_transcription', userSpeech);

    if (signal.aborted) {
      console.log('Aborted during transcription, skipping timeline write.');
      return;
    }

    await this.runDialogueTurn(
      socket, userSpeech, imageFrame, timeline, turnTiming, signal, requestId,
      overrideLlmProvider, overrideTtsProvider, overrideTtsVoiceId, existingNodes, visualContext, ''
    );
  }

  /**
   * 选择可用的转写通道并返回识别文本。
   * 返回 null 表示"空音频且无本地文本"，调用方应直接结束本轮。
   */
  private static async transcribeUserAudio(
    socket: Socket,
    audioBuffer: Buffer,
    audioMimeType: string,
    localText?: string
  ): Promise<string | null> {
    if (audioBuffer.byteLength === 0) {
      if (localText) return localText;
      console.log('Empty audio buffer and no local text available.');
      socket.emit('user_transcription', '');
      socket.emit('state_change', 'IDLE');
      return null;
    }

    // 优先级：注入转写器(测试) > DashScope > Molifangzhou > 本地 ASR 文本
    if (this.speechTranscriber) {
      return this.speechTranscriber(audioBuffer);
    }
    if (hasDashScopeStt()) {
      console.log('Using Aliyun DashScope (qwen3-asr-flash) for transcription (with MP3 transcoding)...');
      return transcribeWithDashScope(audioBuffer, audioMimeType);
    }
    if (hasMolifangzhouStt()) {
      return transcribeWithMolifangzhou(audioBuffer, audioMimeType);
    }
    if (localText) {
      console.log(`No backend STT keys configured. Falling back to local ASR text: "${localText}"`);
      return localText;
    }
    throw new Error('No STT keys configured and no local ASR text fallback available.');
  }

  // ─────────────────────────────────────────────
  //  入口二：文本轮（前端直接给定文本 → 对话）
  // ─────────────────────────────────────────────

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
    if (resolveLlmRouting(overrideLlmProvider, true).isMock) {
      socket.emit('user_transcription', userSpeech);
      socket.emit('state_change', 'SPEAKING');
      socket.emit('text_chunk', `Mock response to: ${userSpeech}`);
      socket.emit('state_change', 'IDLE');
      return;
    }

    socket.emit('user_transcription', userSpeech);

    await this.runDialogueTurn(
      socket, userSpeech, imageFrame, timeline, turnTiming, signal, requestId,
      overrideLlmProvider, overrideTtsProvider, overrideTtsVoiceId, existingNodes, visualContext, ' (text)'
    );
  }

  // ─────────────────────────────────────────────
  //  对话轮共享核心（语音轮与文本轮复用）
  // ─────────────────────────────────────────────

  /**
   * 一轮对话的统一处理流程：记忆召回 → 提示词组装 → 时间线落库 →
   * LLM 流式生成 → TTS 下发 → 后台记忆归档与实体抽取。
   *
   * 全程在关键节点检查 `signal.aborted`，以支持用户随时打断。
   */
  private static async runDialogueTurn(
    socket: Socket,
    userSpeech: string,
    imageFrame: ImageFrameEvent | null,
    timeline: TimelineEvent[],
    turnTiming: TurnTiming,
    signal: AbortSignal,
    requestId: number,
    overrideLlmProvider: string | undefined,
    overrideTtsProvider: string | undefined,
    overrideTtsVoiceId: string | undefined,
    existingNodes: string[] | undefined,
    visualContext: string[] | undefined,
    logLabel: string
  ): Promise<void> {
    // 1. 长程多模态情景记忆召回（静默后台检索）
    console.log('Querying episodic memory...');
    const currentImageBase64 = imageFrame?.imageBase64 ?? null;
    const memoryQueryText = this.buildMemoryQueryText(userSpeech, visualContext);
    const recalledMemory = await EpisodicMemoryService.queryMemory(memoryQueryText, currentImageBase64);

    if (signal.aborted) {
      console.log('Aborted during memory query, skipping timeline write.');
      return;
    }

    // 2. 组装系统提示词（含视觉上下文与召回记忆）
    const visionTurn = needsVisionInput(userSpeech);
    console.log(`Vision turn${logLabel}: ${visionTurn} for speech: "${userSpeech}"`);
    let systemInstruction = this.getBaseSystemInstruction(visionTurn ? visualContext : undefined, visionTurn);
    if (recalledMemory) {
      systemInstruction += this.buildRecalledMemoryPrompt(recalledMemory);
    }

    // 3. 组装本轮消息
    const { messages, currentParts } = buildTimelineMessages({
      systemInstruction,
      userSpeech,
      timeline,
      turnTiming,
      includeImage: visionTurn
    });

    if (signal.aborted) {
      console.log('Aborted before timeline write, skipping.');
      return;
    }

    // 4. 流式生成前先把用户消息与模型占位消息写入时间线，
    //    以便打断处理器能定位到"当前轮"而非上一轮消息。
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

    // 5. 发起流式生成
    console.log('Generating streaming content...');
    socket.emit('state_change', 'SPEAKING');

    let responseStream: any;
    try {
      const result = await this.getLlmStream(messages, userSpeech, overrideLlmProvider);
      responseStream = result.stream;
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

    // 6. 流式下发文本与语音
    const { fullText, aborted } = await this.streamResponseToClient(
      socket, responseStream, modelMessageEntry, signal, requestId, overrideTtsProvider, overrideTtsVoiceId
    );
    if (aborted) return;

    console.log('Stream generation completed.');
    modelMessageEntry.timestamp = Date.now();

    // 7. 后台异步：归档情景记忆 + 抽取实体进图谱（不阻塞主流程）
    EpisodicMemoryService.recordMemory(userSpeech, fullText, currentImageBase64)
      .catch(err => console.error('Background memory recording failed:', err));
    this.extractAndAnalyzeEntitiesFromDialogue(
      socket, userSpeech, fullText, currentImageBase64, existingNodes || [], overrideLlmProvider
    ).catch(err => console.error('Background entity extraction and analysis failed:', err));

    socket.emit('state_change', 'IDLE');
  }

  /**
   * 消费 LLM 响应流：逐块回传文本、按句切分送 TTS，并响应打断。
   * @returns fullText 完整文本；aborted 是否在流中被打断
   */
  private static async streamResponseToClient(
    socket: Socket,
    responseStream: AsyncIterable<any>,
    modelMessageEntry: TimelineEvent,
    signal: AbortSignal,
    requestId: number,
    overrideTtsProvider?: string,
    overrideTtsVoiceId?: string
  ): Promise<{ fullText: string; aborted: boolean }> {
    let fullResponseText = '';
    let sentenceBuffer = '';
    let ttsIndex = 0;

    for await (const chunk of responseStream) {
      if (signal.aborted) {
        console.log('Stream generation aborted.');
        modelMessageEntry.timestamp = Date.now();
        return { fullText: fullResponseText, aborted: true };
      }

      if (chunk.error) {
        throw new Error(`Stream error ${chunk.error.code}: ${chunk.error.message}`);
      }

      const chunkText = chunk.choices[0]?.delta?.content ?? '';
      fullResponseText += chunkText;
      (modelMessageEntry as ConversationMessageEvent).parts[0].text = fullResponseText;

      if (chunkText) {
        socket.emit('text_chunk', chunkText);
        sentenceBuffer += chunkText;
        const flushed = this.emitFirstClause(
          socket, sentenceBuffer, ttsIndex, signal, requestId, overrideTtsProvider, overrideTtsVoiceId
        );
        sentenceBuffer = flushed.buffer;
        ttsIndex = flushed.ttsIndex;
      }

      // 记录推理 token 数（部分模型回传）
      const reasoningTokens = chunk.usage?.completionTokensDetails?.reasoningTokens ||
                              chunk.usage?.completion_tokens_details?.reasoning_tokens;
      if (reasoningTokens) {
        console.log(`Reasoning tokens: ${reasoningTokens}`);
      }
    }

    // 冲刷缓冲区剩余文本
    const remaining = sentenceBuffer.trim();
    if (remaining) {
      this.synthesizeAndEmit(socket, remaining, ttsIndex, signal, requestId, overrideTtsProvider, overrideTtsVoiceId);
    }

    return { fullText: fullResponseText, aborted: false };
  }

  /**
   * 从缓冲区切出"第一个完整子句"送去合成，返回剩余缓冲与下一个 TTS 序号。
   * 每次至多切出一个子句，以贴合流式低延迟下发。
   */
  private static emitFirstClause(
    socket: Socket,
    buffer: string,
    ttsIndex: number,
    signal: AbortSignal,
    requestId: number,
    overrideTtsProvider?: string,
    overrideTtsVoiceId?: string
  ): { buffer: string; ttsIndex: number } {
    for (const delim of this.SENTENCE_DELIMITERS) {
      if (buffer.includes(delim)) {
        const parts = buffer.split(delim);
        const clause = (parts[0] + delim).trim();
        const rest = parts.slice(1).join(delim);
        if (clause) {
          this.synthesizeAndEmit(socket, clause, ttsIndex, signal, requestId, overrideTtsProvider, overrideTtsVoiceId);
          ttsIndex++;
        }
        return { buffer: rest, ttsIndex };
      }
    }
    return { buffer, ttsIndex };
  }

  /** 合成单个子句并按序号下发音频块（浏览器 TTS 或未配置时跳过） */
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

      socket.emit('audio_tts_chunk', { audio: audioBuffer, index, requestId });
    } catch (err) {
      console.error(`Failed to synthesize text: "${text}", error:`, err);
    }
  }

  /**
   * Mock 双工流：在无真实凭证时持续循环朗读一段测试文本，
   * 用于验证端侧静音检测与"随时打断"链路。
   */
  private static async runMockDuplexStream(
    socket: Socket,
    timeline: TimelineEvent[],
    turnTiming: TurnTiming,
    signal: AbortSignal,
    localText?: string
  ): Promise<void> {
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
        (modelMessageEntry as ConversationMessageEvent).parts[0].text = fullResponseText;
        socket.emit('text_chunk', chunk);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      console.log('Mock Stream looping: restarting text output.');
    }
  }

  // ─────────────────────────────────────────────
  //  实体记忆图谱（转发至 entityGraphAnalyzer）
  // ─────────────────────────────────────────────

  /** 结合视觉、时间与上下文，智能分析并过滤单个目标检测实体 */
  public static analyzeDetectedObject(
    timeline: TimelineEvent[],
    className: string,
    imageBase64: string | null,
    existingNodes: string[],
    overrideLlmProvider?: string
  ): Promise<any> {
    return analyzeDetectedObjectImpl(timeline, className, imageBase64, existingNodes, overrideLlmProvider);
  }

  /** 后台异步：从对话文本与图像中提取物理实体并推送给前端图谱 */
  public static extractAndAnalyzeEntitiesFromDialogue(
    socket: Socket,
    userSpeech: string,
    aiResponse: string,
    imageBase64: string | null,
    existingNodes: string[],
    overrideLlmProvider?: string
  ): Promise<void> {
    return extractEntitiesImpl(socket, userSpeech, aiResponse, imageBase64, existingNodes, overrideLlmProvider);
  }

  /** 后台从长期记忆中动态重建实体图谱 */
  public static reconstructGraphFromMemories(
    memories: any[],
    overrideLlmProvider?: string
  ): Promise<{ nodes: any[]; links: any[] }> {
    return reconstructGraphImpl(memories, overrideLlmProvider);
  }
}
