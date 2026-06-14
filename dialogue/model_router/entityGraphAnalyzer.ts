/**
 * entityGraphAnalyzer.ts — 实体记忆图谱分析大脑
 *
 * 把"对话 / 摄像头检测 / 历史记忆"转化为结构化的实体节点与关系，是记忆图谱的语义构建层。
 * 对外提供三类能力（均在缺少真实凭证时自动降级到确定性本地 mock）：
 * 1. analyzeDetectedObject —— 对单个目标检测结果做语义分析与建链；
 * 2. extractAndAnalyzeEntitiesFromDialogue —— 对话结束后后台批量抽取实体；
 * 3. reconstructGraphFromMemories —— 从长期记忆卡片整体重建图谱。
 *
 * 注：这些方法通过 ModelRouter 的静态门面对外暴露，以保持既有调用方与测试的公共 API 不变。
 */

import { Socket } from 'socket.io';
import type { TimelineEvent, ConversationMessageEvent } from '../gateway_core/SocketGateway';
import {
  resolveLlmRouting,
  createOpenAiClient,
  buildPromptContentParts,
  parseJsonObjectLoose,
  parseJsonArrayLoose,
  DEFAULT_DASHSCOPE_CHAT_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  type LlmRouting
} from './llmProvider';

/** 实体类型枚举（图谱节点的合法分类） */
export type EntityType = 'device' | 'tool' | 'wire' | 'concept' | 'capacitor' | 'person';

/** 单个实体的智能分析结果 */
export interface ObjectAnalysis {
  shouldAdd: boolean;
  refinedLabel: string;
  type: EntityType | string;
  details: string;
  relations: Array<{ target: string; relation: string }>;
}

/**
 * 取选定供应商对应的对话模型名（图谱分析统一走文本/多模态对话模型）。
 */
function resolveChatModel(routing: LlmRouting): string {
  if (routing.useDashScope) {
    return process.env.DASHSCOPE_CHAT_MODEL || DEFAULT_DASHSCOPE_CHAT_MODEL;
  }
  return process.env.OPENROUTER_CHAT_MODEL || DEFAULT_OPENROUTER_MODEL;
}

/**
 * 调用选定供应商完成一次"多模态 + JSON 输出"的分析请求，返回原始文本。
 * 图谱分析链路使用 allowTestKeys=false：测试密钥会被判为未配置而落入 mock 分支。
 */
async function runVisionAnalysis(routing: LlmRouting, prompt: string, imageBase64: string | null): Promise<string> {
  const modelName = resolveChatModel(routing);
  const apiKey = (routing.useDashScope ? routing.dashscopeKey : routing.openrouterKey)!;
  const client = createOpenAiClient(routing.provider, apiKey);

  const response = await client.chat.completions.create({
    model: modelName,
    messages: [{ role: 'user', content: buildPromptContentParts(prompt, imageBase64) as any }],
    temperature: 0.2
  });

  return response.choices[0]?.message?.content || '';
}

// ─────────────────────────────────────────────
//  能力 1：单目标检测结果的智能分析与建链
// ─────────────────────────────────────────────

/**
 * 结合视觉、时间与对话上下文，智能分析并过滤单个目标检测实体。
 */
export async function analyzeDetectedObject(
  timeline: TimelineEvent[],
  className: string,
  imageBase64: string | null,
  existingNodes: string[],
  overrideLlmProvider?: string
): Promise<ObjectAnalysis> {
  const routing = resolveLlmRouting(overrideLlmProvider, false);

  // 整理最近对话历史，供模型理解当前场景
  const conversationHistoryText = timeline
    .filter((event): event is ConversationMessageEvent => event.type === 'message')
    .slice(-6)
    .map(msg => {
      const text = msg.parts.map((p: any) => p.text || '').join('');
      return `${msg.role === 'user' ? '用户' : 'AI助手'}: ${text}`;
    })
    .join('\n') || '(无历史对话)';

  // mock 降级：返回确定性结果，便于离线开发与测试
  if (routing.isMock) {
    console.log('[EntityGraphAnalyzer] Object analysis running in MOCK mode.');
    return mockAnalyzeObject(className, existingNodes);
  }

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

  console.log(`[EntityGraphAnalyzer] Object analysis routing to ${routing.provider} model.`);

  try {
    const resultText = await runVisionAnalysis(routing, prompt, imageBase64);
    console.log(`[EntityGraphAnalyzer] Object analysis raw response:\n${resultText}`);

    const parsed = parseJsonObjectLoose<ObjectAnalysis>(resultText);
    if (parsed) return parsed;
    throw new Error('Unparseable analysis JSON');
  } catch (err) {
    console.error('[EntityGraphAnalyzer] Failed to analyze detected object:', err);
    // 兜底：人物默认不入图谱，其余作为通用概念入图谱
    return {
      shouldAdd: className.toLowerCase() !== 'person',
      refinedLabel: className,
      type: 'concept',
      details: `自动检测到的"${className}"。`,
      relations: []
    };
  }
}

/** analyzeDetectedObject 的确定性 mock 实现 */
function mockAnalyzeObject(className: string, existingNodes: string[]): ObjectAnalysis {
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

  const now = new Date().toLocaleTimeString();
  const mockRefinedLabels: Record<string, { refinedLabel: string; type: string; details: string }> = {
    'cell phone': { refinedLabel: '智能手机', type: 'device', details: `于时间 ${now} 视觉检测到的手机设备，结合上下文用于互动。` },
    scissors: { refinedLabel: '安全剪刀', type: 'tool', details: `于时间 ${now} 检测到的裁剪工具，在组装场景中使用。` },
    cup: { refinedLabel: '水杯', type: 'concept', details: `于时间 ${now} 放置在桌面上的饮水容器。` }
  };

  const mockInfo = mockRefinedLabels[lowerClass] || {
    refinedLabel: className,
    type: 'concept',
    details: `于时间 ${now} 自动检测到的物品: ${className}。`
  };

  const mockRelations: Array<{ target: string; relation: string }> = [];
  if (existingNodes.length > 0) {
    mockRelations.push({ target: existingNodes[0], relation: '同场景出现' });
  }

  return {
    shouldAdd: true,
    refinedLabel: mockInfo.refinedLabel,
    type: mockInfo.type,
    details: mockInfo.details,
    relations: mockRelations
  };
}

// ─────────────────────────────────────────────
//  能力 2：对话结束后后台批量抽取实体
// ─────────────────────────────────────────────

/**
 * 从一轮对话文本（含可选图像）中后台异步抽取物理实体与人物，
 * 经智能过滤后通过 socket 推送给前端图谱。
 */
export async function extractAndAnalyzeEntitiesFromDialogue(
  socket: Socket,
  userSpeech: string,
  aiResponse: string,
  imageBase64: string | null,
  existingNodes: string[],
  overrideLlmProvider?: string
): Promise<void> {
  const routing = resolveLlmRouting(overrideLlmProvider, false);
  const combinedTranscript = `用户: ${userSpeech}\nAI助手: ${aiResponse}`;

  // mock 降级：基于关键词命中推送确定性实体
  if (routing.isMock) {
    console.log('[EntityGraphAnalyzer] Dialogue entity extraction running in MOCK mode.');
    for (const entity of mockExtractEntities(combinedTranscript)) {
      const relations = existingNodes.length > 0
        ? [{ target: existingNodes[0], relation: '同场景相关' }]
        : [];
      emitAnalysisResult(socket, entity.className, imageBase64, {
        shouldAdd: true,
        refinedLabel: entity.refinedLabel,
        type: entity.type,
        details: entity.details,
        relations
      });
    }
    return;
  }

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

  try {
    const resultText = await runVisionAnalysis(routing, prompt, imageBase64);
    console.log(`[EntityGraphAnalyzer] Background dialogue entity analysis raw response:\n${resultText}`);

    const entities = parseJsonArrayLoose<any>(resultText) ?? [];
    for (const item of entities) {
      if (item.shouldAdd && item.className) {
        emitAnalysisResult(socket, item.className, imageBase64, {
          shouldAdd: true,
          refinedLabel: item.refinedLabel || item.className,
          type: item.type || 'concept',
          details: item.details || `由 AI 从对话提取的 "${item.refinedLabel || item.className}"。`,
          relations: item.relations || []
        });
      }
    }
  } catch (err) {
    console.error('[EntityGraphAnalyzer] Failed to analyze entities from dialogue background:', err);
  }
}

/** 向前端推送一条实体分析结果 */
function emitAnalysisResult(socket: Socket, className: string, imageFrame: string | null, analysis: ObjectAnalysis): void {
  socket.emit('object_analysis_result', { className, imageFrame, analysis });
}

/** extractAndAnalyzeEntitiesFromDialogue 的关键词命中式 mock 实现 */
function mockExtractEntities(transcript: string): Array<{ className: string; refinedLabel: string; type: string; details: string }> {
  const lowerText = transcript.toLowerCase();
  const entities: Array<{ className: string; refinedLabel: string; type: string; details: string }> = [];

  if (lowerText.includes('手机') || lowerText.includes('phone')) {
    entities.push({ className: 'cell phone', refinedLabel: '智能手机', type: 'device', details: '对话中提及的手机设备。' });
  }
  if (lowerText.includes('剪刀') || lowerText.includes('scissors')) {
    entities.push({ className: 'scissors', refinedLabel: '安全剪刀', type: 'tool', details: '对话中涉及的剪裁工具。' });
  }
  if (lowerText.includes('杯子') || lowerText.includes('cup') || lowerText.includes('水杯')) {
    entities.push({ className: 'cup', refinedLabel: '水杯', type: 'concept', details: '对话中提及的水杯。' });
  }
  if (lowerText.includes('万用表') || lowerText.includes('multimeter')) {
    entities.push({ className: 'multimeter', refinedLabel: '数字万用表', type: 'device', details: '对话中提及的数字万用表设备。' });
  }
  if (lowerText.includes('电阻') || lowerText.includes('resistor')) {
    entities.push({ className: 'resistor', refinedLabel: '贴片电阻', type: 'capacitor', details: '对话中提及的贴片电阻电子元器件。' });
  }

  return entities;
}

// ─────────────────────────────────────────────
//  能力 3：从长期记忆整体重建图谱
// ─────────────────────────────────────────────

/**
 * 从长期情景记忆卡片整体重建实体关系拓扑图谱。
 */
export async function reconstructGraphFromMemories(
  memories: any[],
  overrideLlmProvider?: string
): Promise<{ nodes: any[]; links: any[] }> {
  if (memories.length === 0) {
    return { nodes: [], links: [] };
  }

  const routing = resolveLlmRouting(overrideLlmProvider, false);

  // mock 降级：基于关键词从历史记录中还原节点与链
  if (routing.isMock) {
    console.log('[EntityGraphAnalyzer] Graph reconstruction running in MOCK mode.');
    return mockReconstructGraph(memories);
  }

  // 压缩记忆卡片以降低 token 占用
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

  try {
    // 图谱重建是纯文本任务：DashScope 使用文本模型变体，且不附带图像
    const modelName = routing.useDashScope
      ? (process.env.DASHSCOPE_CHAT_MODEL || DEFAULT_DASHSCOPE_CHAT_MODEL).replace('-vl', '')
      : (process.env.OPENROUTER_CHAT_MODEL || DEFAULT_OPENROUTER_MODEL);
    const apiKey = (routing.useDashScope ? routing.dashscopeKey : routing.openrouterKey)!;
    const client = createOpenAiClient(routing.provider, apiKey);

    const response = await client.chat.completions.create({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2
    });
    const resultText = response.choices[0]?.message?.content || '';
    console.log(`[EntityGraphAnalyzer] Reconstruct graph raw response:\n${resultText}`);

    const graphData = parseJsonObjectLoose<{ nodes: any[]; links: any[] }>(resultText);
    if (!graphData) {
      return { nodes: [], links: [] };
    }

    return normalizeReconstructedGraph(graphData, memories);
  } catch (err) {
    console.error('[EntityGraphAnalyzer] Failed to reconstruct graph from LLM:', err);
    return { nodes: [], links: [] };
  }
}

/** 规范化 LLM 重建出的图谱：统一节点 ID、把 memoryCardId 映射回截图 */
function normalizeReconstructedGraph(
  graphData: { nodes: any[]; links: any[] },
  memories: any[]
): { nodes: any[]; links: any[] } {
  if (Array.isArray(graphData.nodes)) {
    for (const node of graphData.nodes) {
      if (node.memoryCardId) {
        const matchedMemory = memories.find(m => m.memory_id === node.memoryCardId);
        if (matchedMemory?.image_base64) {
          node.image = matchedMemory.image_base64;
        }
      }
      node.id = String(node.id).toLowerCase().replace(/\s+/g, '_');
    }
  }

  if (Array.isArray(graphData.links)) {
    for (const link of graphData.links) {
      if (typeof link.source === 'string') link.source = link.source.toLowerCase().replace(/\s+/g, '_');
      if (typeof link.target === 'string') link.target = link.target.toLowerCase().replace(/\s+/g, '_');
    }
  }

  return { nodes: graphData.nodes || [], links: graphData.links || [] };
}

/** reconstructGraphFromMemories 的关键词命中式 mock 实现 */
function mockReconstructGraph(memories: any[]): { nodes: any[]; links: any[] } {
  const nodes: any[] = [];
  const links: any[] = [];
  const nodeSet = new Set<string>();

  // 关键词 → 节点模板
  const rules: Array<{ keywords: string[]; id: string; refinedLabel: string; type: string; details: string }> = [
    { keywords: ['手机', 'phone'], id: 'cell_phone', refinedLabel: '智能手机', type: 'device', details: '从历史对话中恢复的手机设备。' },
    { keywords: ['剪刀', 'scissors'], id: 'scissors', refinedLabel: '安全剪刀', type: 'tool', details: '从历史对话中恢复的裁剪工具。' },
    { keywords: ['杯子', 'cup', '水杯'], id: 'cup', refinedLabel: '水杯', type: 'concept', details: '从历史对话中恢复的水杯容器。' },
    { keywords: ['万用表', 'multimeter'], id: 'multimeter', refinedLabel: '数字万用表', type: 'device', details: '从历史对话中恢复的数字万用表。' },
    { keywords: ['电阻', 'resistor'], id: 'resistor', refinedLabel: '贴片电阻', type: 'capacitor', details: '从历史对话中恢复的贴片电阻。' }
  ];

  for (const m of memories) {
    const lower = (m.transcript || '').toLowerCase();
    const image = m.image_base64 || undefined;
    for (const rule of rules) {
      if (!nodeSet.has(rule.id) && rule.keywords.some(k => lower.includes(k))) {
        nodeSet.add(rule.id);
        nodes.push({ id: rule.id, refinedLabel: rule.refinedLabel, type: rule.type, details: rule.details, image });
      }
    }
  }

  // 多个节点时按出现顺序串联为"同历史场景"链
  const nodeIds = nodes.map(n => n.id);
  for (let i = 1; i < nodeIds.length; i++) {
    links.push({ source: nodeIds[i - 1], target: nodeIds[i], relation: '同历史场景' });
  }

  return { nodes, links };
}
