/**
 * llmProvider.ts — 大模型传输层共享工具
 *
 * 本模块集中收敛了项目里散落多处、且曾经写法不一致的"模型供应商判定 / 凭证校验 /
 * 客户端构造 / 响应解析"等横切逻辑，使上层（ModelRouter、EntityGraphAnalyzer）只需关心
 * 业务编排，不必重复处理传输细节。
 *
 * 设计要点：
 * 1. 统一的供应商路由：根据「调用方覆盖值 → 环境变量 → 默认值」三级回退确定供应商。
 * 2. 统一的凭证校验：排除空值 / 占位符（mock、your_ 前缀）。
 * 3. `test-` 前缀的双语义（务必保留，否则会破坏既有测试）：
 *    - 流式对话链路（ModelRouter）允许把 `test-` 当作"真实"凭证，
 *      这样单元测试注入的 mock OpenRouter 客户端才会被走到；
 *    - 知识图谱分析链路（EntityGraphAnalyzer）把 `test-` 视为"未配置"，
 *      从而落入确定性的本地 mock 分支，避免测试发起真实网络请求。
 *    这一差异通过 `allowTestKeys` 选项显式表达。
 */

import OpenAI from 'openai';

/** 支持的大模型供应商标识 */
export type LlmProviderName = 'dashscope' | 'openrouter';

/** OpenAI 兼容协议的消息内容片段（文本 / 图像） */
export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

// ─────────────────────────────────────────────
//  默认模型与服务地址
// ─────────────────────────────────────────────

export const DEFAULT_DASHSCOPE_CHAT_MODEL = 'qwen-vl-plus';
export const DEFAULT_DASHSCOPE_REASONING_MODEL = 'qwen-vl-max';
export const DEFAULT_OPENROUTER_MODEL = 'nex-agi/nex-n2-pro:free';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** DashScope 兼容模式服务地址（运行时读取，便于测试覆盖） */
export function getDashScopeBaseUrl(): string {
  return process.env.DASHSCOPE_LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
}

// ─────────────────────────────────────────────
//  凭证校验
// ─────────────────────────────────────────────

/**
 * 判断某个 API Key 是否为"可用的真实凭证"。
 *
 * @param key 待校验的密钥
 * @param allowTestKeys 是否把 `test-` 前缀的测试密钥视为可用（默认 false）
 */
export function isUsableApiKey(key: string | undefined | null, allowTestKeys = false): boolean {
  if (!key) return false;
  if (key === 'mock') return false;
  if (key.startsWith('your_')) return false;
  if (!allowTestKeys && key.startsWith('test-')) return false;
  return true;
}

// ─────────────────────────────────────────────
//  供应商路由
// ─────────────────────────────────────────────

/** 供应商路由解析结果 */
export interface LlmRouting {
  /** 最终选定的供应商 */
  provider: LlmProviderName;
  dashscopeKey: string | undefined;
  openrouterKey: string | undefined;
  /** 选定 DashScope 且其凭证可用 */
  useDashScope: boolean;
  /** 选定 OpenRouter 且其凭证可用 */
  useOpenRouter: boolean;
  /** 两者皆不可用 —— 上层应进入 mock 降级模式 */
  isMock: boolean;
}

/**
 * 解析本轮请求应使用的大模型供应商及其可用性。
 *
 * 优先级：调用方覆盖值 > 环境变量 LLM_PROVIDER > 默认 'openrouter'。
 *
 * @param overrideProvider 调用方（前端）指定的供应商
 * @param allowTestKeys 见 {@link isUsableApiKey}
 */
export function resolveLlmRouting(overrideProvider?: string, allowTestKeys = false): LlmRouting {
  const dashscopeKey = process.env.DASHSCOPE_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  const provider = (overrideProvider || process.env.LLM_PROVIDER || 'openrouter').toLowerCase() as LlmProviderName;

  const useDashScope = provider === 'dashscope' && isUsableApiKey(dashscopeKey, allowTestKeys);
  const useOpenRouter = provider === 'openrouter' && isUsableApiKey(openrouterKey, allowTestKeys);

  return {
    provider,
    dashscopeKey,
    openrouterKey,
    useDashScope,
    useOpenRouter,
    isMock: !useDashScope && !useOpenRouter
  };
}

// ─────────────────────────────────────────────
//  客户端工厂
// ─────────────────────────────────────────────

/**
 * 构造 OpenAI 兼容客户端。
 * DashScope 与 OpenRouter 均暴露 OpenAI 兼容接口，仅 baseURL 不同。
 */
export function createOpenAiClient(provider: LlmProviderName, apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: provider === 'dashscope' ? getDashScopeBaseUrl() : OPENROUTER_BASE_URL
  });
}

// ─────────────────────────────────────────────
//  请求内容拼装
// ─────────────────────────────────────────────

/**
 * 组装一条"文本 + 可选图像"的多模态用户消息内容数组。
 * 图像缺省时仅返回文本片段。
 */
export function buildPromptContentParts(prompt: string, imageBase64: string | null): OpenAiContentPart[] {
  const parts: OpenAiContentPart[] = [{ type: 'text', text: prompt }];
  if (imageBase64) {
    parts.push({
      type: 'image_url',
      image_url: {
        url: imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`
      }
    });
  }
  return parts;
}

// ─────────────────────────────────────────────
//  响应解析（LLM 输出往往夹带 markdown / 解释文字）
// ─────────────────────────────────────────────

/**
 * 从可能夹带额外文字的 LLM 文本中宽松解析出一个 JSON 对象。
 * 先尝试截取第一个 `{...}` 片段，失败再尝试整体解析；均失败返回 null。
 */
export function parseJsonObjectLoose<T = any>(text: string): T | null {
  return parseJsonLoose<T>(text, /\{[\s\S]*\}/);
}

/**
 * 从可能夹带额外文字的 LLM 文本中宽松解析出一个 JSON 数组。
 */
export function parseJsonArrayLoose<T = any>(text: string): T[] | null {
  return parseJsonLoose<T[]>(text, /\[[\s\S]*\]/);
}

function parseJsonLoose<T>(text: string, blockPattern: RegExp): T | null {
  if (!text) return null;
  const match = text.match(blockPattern);
  const candidate = match ? match[0] : text;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}
