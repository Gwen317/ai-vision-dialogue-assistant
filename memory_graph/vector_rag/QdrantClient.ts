/**
 * QdrantClient.ts — 向量数据库客户端封装
 * 
 * 支持两种运行模式：
 * 1. Qdrant 服务模式：连接外部 Qdrant 实例（Docker/Cloud）
 * 2. 内存降级模式：当 Qdrant 不可用时，自动降级为内存数组 + 手动余弦相似度
 * 
 * 集合设计遵循 系统核心设计与创新特性数据规程规范.md：
 * - 集合名称: multimodal_memory_collection
 * - vector_text: 文本语义向量 (维度由 EMBEDDING_TEXT_DIM 配置)
 * - vector_image: 多模态视觉向量 (512维)
 */

import * as fs from 'fs';
import * as path from 'path';

/** 向量数据库中单个记忆点的结构 */
export interface MemoryPoint {
  id: string;
  vectors: {
    vector_text: number[];
    vector_image?: number[];
  };
  payload: {
    memory_id: string;
    timestamp: string;       // ISO8601
    description: string;
    tags: string[];
    transcript: string;
    image_base64?: string;   // 开发阶段暂存截图 Base64
  };
}

/** 搜索结果条目 */
export interface SearchResult {
  id: string;
  score: number;
  payload: MemoryPoint['payload'];
}

/** 内存模式下的存储结构 */
interface InMemoryPoint {
  id: string;
  vector_text: number[];
  vector_image: number[];
  payload: MemoryPoint['payload'];
}

// [COST CONTROL: In-Memory Database Fallback]
// The In-Memory fallback mode stores vector points locally in a JSON file and processes cosine similarity queries
// entirely in-memory using pure JS. This saves 100% of the cost of renting/hosting cloud vector database instances (such as Qdrant Cloud),
// allowing the system to run on low-end servers or local machines with zero cloud database overhead.
export class QdrantClient {
  private url: string;
  private apiKey: string;
  private collectionName: string;
  private textDim: number;
  private imageDim: number;
  private useQdrant: boolean = false;
  private localFilePath: string = path.resolve(process.cwd(), 'memories_local.json');

  /** 内存降级模式的存储 */
  private inMemoryStore: InMemoryPoint[] = [];
  private maxInMemoryPoints: number;

  constructor() {
    this.url = (process.env.QDRANT_URL || '').trim();
    this.apiKey = (process.env.QDRANT_API_KEY || '').trim();
    this.collectionName = 'multimodal_memory_collection';
    this.textDim = parseInt(process.env.EMBEDDING_TEXT_DIM || '1024', 10);
    this.imageDim = 512;
    this.maxInMemoryPoints = parseInt(process.env.MEMORY_MAX_CARDS || '200', 10);
  }

  // ─────────────────────────────────────────────
  //  初始化与连接管理
  // ─────────────────────────────────────────────

  /**
   * 初始化客户端：尝试连接 Qdrant，失败则降级为内存模式
   */
  public async initialize(): Promise<void> {
    if (this.url) {
      try {
        const ok = await this.healthCheck();
        if (ok) {
          this.useQdrant = true;
          await this.ensureCollection();
          console.log(`[QdrantClient] Connected to Qdrant at ${this.url}, collection: ${this.collectionName}`);
          return;
        }
      } catch (err) {
        console.warn(`[QdrantClient] Failed to connect to Qdrant at ${this.url}:`, err);
      }
    }

    this.useQdrant = false;
    console.log('[QdrantClient] Running in IN-MEMORY fallback mode (no Qdrant connection)');
    this.loadFromLocalFile();
  }

  /**
   * Qdrant 健康检查
   */
  public async healthCheck(): Promise<boolean> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['api-key'] = this.apiKey;

      const res = await fetch(`${this.url}/healthz`, { headers, signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * 确保目标集合存在，不存在则创建（命名向量模式）
   */
  private async ensureCollection(): Promise<void> {
    const headers = this.buildHeaders();

    // 检查集合是否存在
    const checkRes = await fetch(`${this.url}/collections/${this.collectionName}`, { headers });
    if (checkRes.ok) {
      console.log(`[QdrantClient] Collection "${this.collectionName}" already exists.`);
      return;
    }

    // 创建集合 — 命名向量 (Named Vectors)
    const createPayload = {
      vectors: {
        vector_text: {
          size: this.textDim,
          distance: 'Cosine'
        },
        vector_image: {
          size: this.imageDim,
          distance: 'Cosine'
        }
      }
    };

    const createRes = await fetch(`${this.url}/collections/${this.collectionName}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(createPayload)
    });

    if (!createRes.ok) {
      const errBody = await createRes.text();
      throw new Error(`Failed to create collection: ${createRes.status} ${errBody}`);
    }

    console.log(`[QdrantClient] Created collection "${this.collectionName}" with named vectors.`);

    // 创建 Payload 索引以优化过滤查询
    await this.createPayloadIndex('timestamp', 'keyword');
    await this.createPayloadIndex('tags', 'keyword');
  }

  /**
   * 为 Payload 字段创建索引
   */
  private async createPayloadIndex(fieldName: string, fieldSchema: string): Promise<void> {
    const headers = this.buildHeaders();

    try {
      await fetch(
        `${this.url}/collections/${this.collectionName}/index`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({ field_name: fieldName, field_schema: fieldSchema })
        }
      );
      console.log(`[QdrantClient] Created payload index for "${fieldName}".`);
    } catch (err) {
      console.warn(`[QdrantClient] Failed to create index for "${fieldName}":`, err);
    }
  }

  // ─────────────────────────────────────────────
  //  数据操作：Upsert / Search / Delete
  // ─────────────────────────────────────────────

  /**
   * 插入或更新一条记忆向量点
   */
  public async upsertPoint(point: MemoryPoint): Promise<void> {
    if (this.useQdrant) {
      await this.qdrantUpsert(point);
    } else {
      this.inMemoryUpsert(point);
    }
  }

  /**
   * 基于文本向量搜索最近邻
   */
  public async searchByText(vector: number[], limit: number = 5): Promise<SearchResult[]> {
    if (this.useQdrant) {
      return this.qdrantSearch('vector_text', vector, limit);
    }
    return this.inMemorySearch('vector_text', vector, limit);
  }

  /**
   * 基于图像向量搜索最近邻
   */
  public async searchByImage(vector: number[], limit: number = 5): Promise<SearchResult[]> {
    if (this.useQdrant) {
      return this.qdrantSearch('vector_image', vector, limit);
    }
    return this.inMemorySearch('vector_image', vector, limit);
  }

  /**
   * 删除指定 ID 的记忆点
   */
  public async deletePoint(id: string): Promise<void> {
    if (this.useQdrant) {
      const headers = this.buildHeaders();
      await fetch(`${this.url}/collections/${this.collectionName}/points/delete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ points: [id] })
      });
    } else {
      this.inMemoryStore = this.inMemoryStore.filter(p => p.id !== id);
      this.saveToLocalFile();
    }
  }

  /**
   * 获取当前存储的记忆点数量
   */
  public async getPointCount(): Promise<number> {
    if (this.useQdrant) {
      const headers = this.buildHeaders();
      try {
        const res = await fetch(`${this.url}/collections/${this.collectionName}`, { headers });
        if (res.ok) {
          const data = (await res.json()) as any;
          return data.result?.points_count ?? 0;
        }
      } catch { /* fallback */ }
      return 0;
    }
    return this.inMemoryStore.length;
  }

  /**
   * 获取运行模式描述
   */
  public getMode(): string {
    return this.useQdrant ? `qdrant:${this.url}` : 'in-memory';
  }

  /**
   * 滚动获取所有记忆点
   */
  public async scrollPoints(limit: number = 100): Promise<SearchResult[]> {
    if (this.useQdrant) {
      const headers = this.buildHeaders();
      try {
        const res = await fetch(`${this.url}/collections/${this.collectionName}/points/scroll`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            limit,
            with_payload: true,
            with_vector: false
          })
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          return (data.result?.points || []).map((r: any) => ({
            id: r.id,
            score: 1.0,
            payload: r.payload
          }));
        }
      } catch (err) {
        console.error('[QdrantClient] Scroll failed:', err);
      }
      return [];
    }
    // 内存降级模式
    return this.inMemoryStore.map(p => ({
      id: p.id,
      score: 1.0,
      payload: p.payload
    }));
  }

  // ─────────────────────────────────────────────
  //  Qdrant HTTP API 实现
  // ─────────────────────────────────────────────

  private async qdrantUpsert(point: MemoryPoint): Promise<void> {
    const headers = this.buildHeaders();

    const body = {
      points: [
        {
          id: point.id,
          vector: {
            vector_text: point.vectors.vector_text,
            vector_image: point.vectors.vector_image || new Array(this.imageDim).fill(0)
          },
          payload: point.payload
        }
      ]
    };

    const res = await fetch(`${this.url}/collections/${this.collectionName}/points?wait=true`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Qdrant upsert failed: ${res.status} ${errBody}`);
    }
  }

  private async qdrantSearch(vectorName: string, vector: number[], limit: number): Promise<SearchResult[]> {
    const headers = this.buildHeaders();

    const body = {
      vector: {
        name: vectorName,
        query: vector
      },
      limit,
      with_payload: true
    };

    const res = await fetch(`${this.url}/collections/${this.collectionName}/points/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      console.error(`[QdrantClient] Search failed: ${res.status}`);
      return [];
    }

    const data = (await res.json()) as any;
    return (data.result || []).map((r: any) => ({
      id: r.id,
      score: r.score,
      payload: r.payload
    }));
  }

  // ─────────────────────────────────────────────
  //  内存降级模式实现
  // ─────────────────────────────────────────────

  private inMemoryUpsert(point: MemoryPoint): void {
    // 移除已有同 ID 记录
    this.inMemoryStore = this.inMemoryStore.filter(p => p.id !== point.id);

    this.inMemoryStore.push({
      id: point.id,
      vector_text: point.vectors.vector_text,
      vector_image: point.vectors.vector_image || new Array(this.imageDim).fill(0),
      payload: point.payload
    });

    // 维护最大容量（FIFO 淘汰最旧的）
    if (this.inMemoryStore.length > this.maxInMemoryPoints) {
      this.inMemoryStore = this.inMemoryStore.slice(-this.maxInMemoryPoints);
    }

    console.log(`[QdrantClient:InMemory] Upserted point ${point.id}, total: ${this.inMemoryStore.length}`);
    this.saveToLocalFile();
  }

  private inMemorySearch(vectorName: 'vector_text' | 'vector_image', queryVector: number[], limit: number): SearchResult[] {
    if (this.inMemoryStore.length === 0) return [];

    const scored = this.inMemoryStore.map(point => {
      const storedVector = vectorName === 'vector_text' ? point.vector_text : point.vector_image;
      const score = QdrantClient.cosineSimilarity(queryVector, storedVector);
      return { point, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(s => ({
      id: s.point.id,
      score: s.score,
      payload: s.point.payload
    }));
  }

  // ─────────────────────────────────────────────
  //  工具方法
  // ─────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['api-key'] = this.apiKey;
    return headers;
  }

  private loadFromLocalFile(): void {
    try {
      if (fs.existsSync(this.localFilePath)) {
        const data = fs.readFileSync(this.localFilePath, 'utf-8');
        this.inMemoryStore = JSON.parse(data);
        console.log(`[QdrantClient:InMemory] Loaded ${this.inMemoryStore.length} points from local file: ${this.localFilePath}`);
      } else {
        this.inMemoryStore = [];
        console.log(`[QdrantClient:InMemory] Local persistence file not found, starting empty.`);
      }
    } catch (err) {
      console.error('[QdrantClient:InMemory] Failed to load local memories file:', err);
      this.inMemoryStore = [];
    }
  }

  private saveToLocalFile(): void {
    try {
      fs.writeFileSync(this.localFilePath, JSON.stringify(this.inMemoryStore, null, 2), 'utf-8');
      console.log(`[QdrantClient:InMemory] Saved ${this.inMemoryStore.length} points to local file: ${this.localFilePath}`);
    } catch (err) {
      console.error('[QdrantClient:InMemory] Failed to save memories to local file:', err);
    }
  }

  /**
   * 余弦相似度计算
   * 对于小规模内存检索场景（< 1000 条 × 1024 维）执行时间 < 1ms
   */
  public static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
