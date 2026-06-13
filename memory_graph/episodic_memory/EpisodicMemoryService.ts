/**
 * EpisodicMemoryService.ts — 长程情景记忆核心存取与双路召回算法服务
 * 
 * 升级自纯词法 Jaccard 匹配 → 基于 Embedding 的多模态双路加权 RAG 检索。
 * 
 * 核心公式（来源：系统总体技术规程设计.md）：
 *   Score(M_i) = w_text × Sim_text(M_i) + w_vis × Sim_vis(M_i)
 *   其中 w_text = 0.4, w_vis = 0.6
 *   召回阈值：Score ≥ 0.70
 * 
 * 设计目标：
 * 1. 会话结束时，异步提取文本/图像 Embedding 并存入向量库
 * 2. 查询时执行双路检索（文本 + 视觉），加权融合得分
 * 3. 高于阈值的最佳卡片注入 LLM System Prompt
 */

import { v4 as uuidv4 } from 'uuid';
import { QdrantClient, type SearchResult } from '../vector_rag/QdrantClient';
import { createEmbeddingProvider, type EmbeddingProvider } from './EmbeddingClient';

// ─────────────────────────────────────────────
//  数据结构
// ─────────────────────────────────────────────

export interface MemoryCard {
  id: string;
  timestamp: Date;
  imageVector: number[] | null;
  textVector: number[];
  description: string;          // AI 自动生成的一句话摘要
  transcript: string;           // 用户与 AI 的对话文本
  entityTags: string[];         // 提取的实体标签 ["LED", "电阻"]
  imageBase64: string | null;   // 截图 Base64（开发阶段暂存）
}

// ─────────────────────────────────────────────
//  核心服务
// ─────────────────────────────────────────────

export class EpisodicMemoryService {
  /** 单例向量客户端与 Embedding 提供器 */
  private static qdrant: QdrantClient | null = null;
  private static embedding: EmbeddingProvider | null = null;
  private static initialized: boolean = false;

  /** 检索配置参数 */
  private static textWeight = parseFloat(process.env.MEMORY_TEXT_WEIGHT || '0.4');
  private static visWeight = parseFloat(process.env.MEMORY_VIS_WEIGHT || '0.6');
  private static scoreThreshold = parseFloat(process.env.MEMORY_SCORE_THRESHOLD || '0.70');

  // ─── 初始化 ───

  /**
   * 延迟初始化：首次调用时自动初始化 Qdrant 和 Embedding
   */
  private static async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    this.qdrant = new QdrantClient();
    await this.qdrant.initialize();

    this.embedding = createEmbeddingProvider();
    this.initialized = true;

    console.log(`[EpisodicMemoryService] Initialized — vector store: ${this.qdrant.getMode()}`);
  }

  /** 测试注入用 */
  public static setProviderForTest(embedding: EmbeddingProvider): void {
    this.embedding = embedding;
  }

  public static setQdrantForTest(qdrant: QdrantClient): void {
    this.qdrant = qdrant;
    this.initialized = true;
  }

  // ─── 记忆存储 ───

  /**
   * recordMemory — 记忆归档处理器
   * 
   * 会话结束时异步调用，执行以下操作：
   * 1. 提取对话文本的语义特征向量
   * 2. 如有图像，调用 VL 模型生成一句话摘要
   * 3. 提取对话中的实体标签
   * 4. 写入向量数据库
   * 
   * 全程异步、非阻塞，不影响主对话流。
   */
  public static async recordMemory(
    userSpeech: string,
    aiResponse: string,
    imageBase64: string | null
  ): Promise<void> {
    await this.ensureInitialized();
    if (!this.qdrant || !this.embedding) return;

    const combinedText = `User: ${userSpeech}\nAI: ${aiResponse}`;
    const memoryId = uuidv4();
    const now = new Date();

    try {
      // 并行提取特征，最大化效率
      const [textVector, description, entityTags] = await Promise.all([
        this.embedding.embedText(combinedText),
        imageBase64
          ? this.embedding.generateImageDescription(imageBase64)
          : Promise.resolve('pure speech conversation'),
        this.embedding.extractEntityTags(combinedText)
      ]);

      // 构建记忆卡片并写入向量库
      await this.qdrant.upsertPoint({
        id: memoryId,
        vectors: {
          vector_text: textVector,
          // 注意：当前没有独立的图像 Embedding API，
          // 使用图像描述文本的 Embedding 作为视觉路代理向量
          vector_image: imageBase64
            ? await this.embedding.embedText(description)
            : undefined
        },
        payload: {
          memory_id: memoryId,
          timestamp: now.toISOString(),
          description,
          tags: entityTags,
          transcript: combinedText,
          image_base64: imageBase64 || undefined
        }
      });

      const pointCount = await this.qdrant.getPointCount();
      console.log(
        `[EpisodicMemoryService] Recorded memory "${description}" ` +
        `with ${entityTags.length} tags, total cards: ${pointCount}`
      );
    } catch (err) {
      console.error('[EpisodicMemoryService] Failed to record memory:', err);
    }
  }

  // ─── 记忆检索 ───

  /**
   * queryMemory — 双路加权检索算法
   * 
   * 执行流程：
   * 1. 将查询文本提取为 textVector
   * 2. 如有图像，提取图像描述并生成 visVector
   * 3. 分别在向量库执行文本路和视觉路近邻搜索
   * 4. 融合加权计算最终 Score
   * 5. 过滤阈值 ≥ 0.70，返回最佳记忆卡片
   * 
   * @returns 最佳匹配的记忆卡片，或 null
   */
  public static async queryMemory(
    queryText: string,
    currentImageBase64: string | null
  ): Promise<MemoryCard | null> {
    await this.ensureInitialized();
    if (!this.qdrant || !this.embedding) return null;

    try {
      // 1. 提取查询文本的语义向量
      const queryTextVector = await this.embedding.embedText(queryText);

      // 2. 文本路搜索
      const textResults = await this.qdrant.searchByText(queryTextVector, 10);

      // 3. 视觉路搜索（如果有图像）
      let imageResults: SearchResult[] = [];
      let queryImageVector: number[] | null = null;

      if (currentImageBase64) {
        // 用图像描述生成视觉代理向量
        const imgDesc = await this.embedding.generateImageDescription(currentImageBase64);
        queryImageVector = await this.embedding.embedText(imgDesc);
        imageResults = await this.qdrant.searchByImage(queryImageVector, 10);
      }

      // 4. 融合加权评分
      const fusedScores = this.fuseScores(textResults, imageResults, currentImageBase64 !== null);

      if (fusedScores.length === 0) {
        return null;
      }

      // 5. 取最高分，检查阈值
      const best = fusedScores[0];
      console.log(
        `[EpisodicMemoryService] Best match: "${best.payload.description}" ` +
        `score=${best.fusedScore.toFixed(4)} (text=${best.textScore.toFixed(4)}, vis=${best.visScore.toFixed(4)})`
      );

      if (best.fusedScore < this.scoreThreshold) {
        console.log(
          `[EpisodicMemoryService] Score ${best.fusedScore.toFixed(4)} below threshold ${this.scoreThreshold}, skipping recall.`
        );
        return null;
      }

      // 6. 构建返回的 MemoryCard
      return {
        id: best.id,
        timestamp: new Date(best.payload.timestamp),
        imageVector: null,
        textVector: [],
        description: best.payload.description,
        transcript: best.payload.transcript,
        entityTags: best.payload.tags || [],
        imageBase64: best.payload.image_base64 || null
      };
    } catch (err) {
      console.error('[EpisodicMemoryService] Query failed:', err);
      return null;
    }
  }

  // ─── 融合评分 ───

  /**
   * 双路检索结果融合
   * 
   * Score(M_i) = w_text × Sim_text + w_vis × Sim_vis
   * 
   * 当没有图像查询时，文本权重自动提升为 1.0
   */
  private static fuseScores(
    textResults: SearchResult[],
    imageResults: SearchResult[],
    hasImage: boolean
  ): Array<{
    id: string;
    textScore: number;
    visScore: number;
    fusedScore: number;
    payload: SearchResult['payload'];
  }> {
    // 建立 ID → 分数映射
    const scoreMap = new Map<string, {
      textScore: number;
      visScore: number;
      payload: SearchResult['payload'];
    }>();

    for (const r of textResults) {
      scoreMap.set(r.id, {
        textScore: r.score,
        visScore: 0,
        payload: r.payload
      });
    }

    for (const r of imageResults) {
      const existing = scoreMap.get(r.id);
      if (existing) {
        existing.visScore = r.score;
      } else {
        scoreMap.set(r.id, {
          textScore: 0,
          visScore: r.score,
          payload: r.payload
        });
      }
    }

    // 计算融合分数
    const wText = hasImage ? this.textWeight : 1.0;
    const wVis = hasImage ? this.visWeight : 0.0;

    const fused = Array.from(scoreMap.entries()).map(([id, scores]) => ({
      id,
      textScore: scores.textScore,
      visScore: scores.visScore,
      fusedScore: wText * scores.textScore + wVis * scores.visScore,
      payload: scores.payload
    }));

    // 按融合分数降序排列
    fused.sort((a, b) => b.fusedScore - a.fusedScore);

    return fused;
  }
}
