/**
 * EmbeddingClient.ts — 多后端 Embedding 抽象层
 * 
 * 提供文本向量提取、图像描述生成、实体标签提取等能力。
 * 支持多种后端 Provider 切换：
 * - DashScopeProvider：使用阿里云 DashScope API（text-embedding-v3）
 * - MockProvider：开发测试用，生成确定性伪随机向量
 */

import OpenAI from 'openai';

// ─────────────────────────────────────────────
//  抽象接口
// ─────────────────────────────────────────────

export interface EmbeddingProvider {
  /** 将文本转为语义向量 */
  embedText(text: string): Promise<number[]>;

  /** 对图像生成一句话摘要描述 */
  generateImageDescription(imageBase64: string): Promise<string>;

  /** 从对话文本中提取实体标签 */
  extractEntityTags(transcript: string): Promise<string[]>;
}

// ─────────────────────────────────────────────
//  DashScope Provider (阿里云通义千问)
// ─────────────────────────────────────────────

export class DashScopeEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  private textModel: string;
  private textDim: number;
  private descriptionModel: string;

  constructor() {
    const apiKey = process.env.DASHSCOPE_API_KEY || '';
    const baseURL = process.env.DASHSCOPE_LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';

    this.client = new OpenAI({ apiKey, baseURL });
    this.textModel = process.env.EMBEDDING_TEXT_MODEL || 'text-embedding-v3';
    this.textDim = parseInt(process.env.EMBEDDING_TEXT_DIM || '1024', 10);
    this.descriptionModel = process.env.EMBEDDING_DESCRIPTION_MODEL || 'qwen-vl-plus';
  }

  /**
   * 文本向量提取 — 调用 DashScope text-embedding-v3
   * 输入文本会被截断至合理长度以避免 Token 超限
   */
  async embedText(text: string): Promise<number[]> {
    const truncatedText = text.slice(0, 2048);

    try {
      const response = await this.client.embeddings.create({
        model: this.textModel,
        input: truncatedText,
        dimensions: this.textDim
      } as any);

      const embedding = (response.data[0] as any)?.embedding;
      if (!Array.isArray(embedding)) {
        throw new Error('Unexpected embedding response format');
      }

      return embedding;
    } catch (err) {
      console.error('[EmbeddingClient:DashScope] Text embedding failed:', err);
      // 降级：返回零向量，不中断主流程
      return new Array(this.textDim).fill(0);
    }
  }

  /**
   * 图像描述生成 — 调用多模态 VL 模型生成一句话摘要
   */
  async generateImageDescription(imageBase64: string): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.descriptionModel,
        messages: [
          {
            role: 'system',
            content: '你是一个视觉分析助手。请用一句简短的中文描述图片中的主要物体和场景，不超过50个字。只输出描述，不要其他内容。'
          },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`,
                  detail: 'low'
                }
              } as any
            ]
          }
        ],
        max_tokens: 100
      });

      return (response.choices[0]?.message?.content || 'camera frame captured').trim();
    } catch (err) {
      console.error('[EmbeddingClient:DashScope] Image description failed:', err);
      return 'camera frame captured';
    }
  }

  /**
   * 实体标签提取 — 从对话中提取物理实体关键词
   */
  async extractEntityTags(transcript: string): Promise<string[]> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.descriptionModel.replace('-vl', ''), // 用纯文本模型即可
        messages: [
          {
            role: 'system',
            content: '从以下对话文本中提取所有物理实体（如设备、工具、电子元器件、物品名称等）。仅输出一个 JSON 数组，如 ["LED", "电阻", "万用表"]。如果没有实体，输出空数组 []。不要输出其他任何内容。'
          },
          {
            role: 'user',
            content: transcript.slice(0, 1024)
          }
        ],
        max_tokens: 200
      });

      const raw = (response.choices[0]?.message?.content || '[]').trim();
      // 尝试从回复中提取 JSON 数组
      const match = raw.match(/\[.*\]/s);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          return parsed.filter((t: any) => typeof t === 'string').slice(0, 10);
        }
      }
      return [];
    } catch (err) {
      console.error('[EmbeddingClient:DashScope] Entity tag extraction failed:', err);
      return [];
    }
  }
}

// ─────────────────────────────────────────────
//  Mock Provider (开发测试)
// ─────────────────────────────────────────────

export class MockEmbeddingProvider implements EmbeddingProvider {
  private textDim: number;

  constructor() {
    this.textDim = parseInt(process.env.EMBEDDING_TEXT_DIM || '1024', 10);
  }

  /**
   * 生成确定性伪随机向量 — 相同输入产生相同向量
   * 使用简易字符哈希种子，保证检索可测试
   */
  async embedText(text: string): Promise<number[]> {
    return MockEmbeddingProvider.deterministicVector(text, this.textDim);
  }

  async generateImageDescription(_imageBase64: string): Promise<string> {
    return 'Mock: camera frame with objects detected';
  }

  async extractEntityTags(transcript: string): Promise<string[]> {
    // 简单提取中文名词模式
    const patterns = ['电阻', '电容', 'LED', '主板', '电路板', '万用表', '烙铁', '手机', '杯子', '钥匙', '键盘'];
    return patterns.filter(p => transcript.includes(p));
  }

  /**
   * 确定性伪随机向量生成：相同的输入文本总是生成相同的向量。
   * 使用 xorshift32 PRNG 以文本哈希作为种子。
   */
  static deterministicVector(text: string, dim: number): number[] {
    // 简易字符串哈希
    let seed = 0;
    for (let i = 0; i < text.length; i++) {
      seed = ((seed << 5) - seed + text.charCodeAt(i)) | 0;
    }
    if (seed === 0) seed = 42;

    // xorshift32 PRNG
    const xorshift = () => {
      seed ^= seed << 13;
      seed ^= seed >> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;  // 归一化到 [0, 1)
    };

    const vec = new Array(dim);
    for (let i = 0; i < dim; i++) {
      vec[i] = xorshift() * 2 - 1; // 映射到 [-1, 1)
    }

    // L2 归一化
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dim; i++) vec[i] /= norm;
    }

    return vec;
  }
}

// ─────────────────────────────────────────────
//  工厂方法
// ─────────────────────────────────────────────

/**
 * 根据环境变量自动选择 Embedding Provider
 * - DASHSCOPE_API_KEY 有效 → DashScopeProvider
 * - 否则 → MockProvider
 */
export function createEmbeddingProvider(): EmbeddingProvider {
  const dashscopeKey = process.env.DASHSCOPE_API_KEY;
  const provider = (process.env.EMBEDDING_PROVIDER || 'dashscope').toLowerCase();

  if (provider === 'dashscope' && dashscopeKey && dashscopeKey !== 'mock' && !dashscopeKey.startsWith('your_')) {
    console.log('[EmbeddingClient] Using DashScope embedding provider');
    return new DashScopeEmbeddingProvider();
  }

  console.log('[EmbeddingClient] Using Mock embedding provider (no valid API key)');
  return new MockEmbeddingProvider();
}
