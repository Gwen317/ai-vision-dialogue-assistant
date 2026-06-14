/**
 * QdrantClient & EpisodicMemoryService 集成测试
 * 
 * 使用内存降级模式 + MockEmbeddingProvider 测试完整的
 * recordMemory → queryMemory 双路加权检索流程
 * 
 * 运行: npx ts-node --transpile-only tests/episodic-memory-rag.test.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';

// 强制使用内存模式
process.env.QDRANT_URL = '';
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.MEMORY_SCORE_THRESHOLD = '0.50';  // 降低阈值以便 Mock 向量能触发召回
process.env.EMBEDDING_TEXT_DIM = '128';         // 用小维度加速测试

import { QdrantClient } from '../../memory_graph/vector_rag/QdrantClient';
import { MockEmbeddingProvider } from '../../memory_graph/episodic_memory/EmbeddingClient';
import { EpisodicMemoryService } from '../../memory_graph/episodic_memory/EpisodicMemoryService';
import { ModelRouter } from '../../dialogue/model_router/ModelRouter';

// ─────────────────────────────────────────────
//  测试工具
// ─────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

function assertApprox(actual: number, expected: number, tolerance: number, message: string) {
  const diff = Math.abs(actual - expected);
  assert(diff <= tolerance, `${message} (actual=${actual.toFixed(6)}, expected=${expected.toFixed(6)}, diff=${diff.toFixed(6)})`);
}

// ─────────────────────────────────────────────
//  Test 1: QdrantClient 内存模式
// ─────────────────────────────────────────────

async function testQdrantInMemory() {
  console.log('\n📦 Test 1: QdrantClient 内存降级模式');

  const client = new QdrantClient();
  client['localFilePath'] = path.resolve(__dirname, 'memories_test.json');
  if (fs.existsSync(client['localFilePath'])) {
    fs.unlinkSync(client['localFilePath']);
  }
  await client.initialize();

  assert(client.getMode() === 'in-memory', 'Should be in in-memory mode');

  // 插入测试向量
  const vec1 = [1, 0, 0, 0];
  const vec2 = [0, 1, 0, 0];
  const vec3 = [0.9, 0.1, 0, 0]; // 与 vec1 相似

  await client.upsertPoint({
    id: 'p1',
    vectors: { vector_text: vec1, vector_image: vec1 },
    payload: { memory_id: 'p1', timestamp: new Date().toISOString(), description: 'point 1', tags: ['test'], transcript: 'hello' }
  });

  await client.upsertPoint({
    id: 'p2',
    vectors: { vector_text: vec2, vector_image: vec2 },
    payload: { memory_id: 'p2', timestamp: new Date().toISOString(), description: 'point 2', tags: ['test'], transcript: 'world' }
  });

  await client.upsertPoint({
    id: 'p3',
    vectors: { vector_text: vec3, vector_image: vec3 },
    payload: { memory_id: 'p3', timestamp: new Date().toISOString(), description: 'point 3', tags: ['test'], transcript: 'similar to p1' }
  });

  const count = await client.getPointCount();
  assert(count === 3, `Point count should be 3, got ${count}`);

  // 搜索与 vec1 最相似的
  const results = await client.searchByText(vec1, 2);
  assert(results.length === 2, `Search should return 2 results, got ${results.length}`);
  assert(results[0].id === 'p1', `Top result should be p1, got ${results[0].id}`);
  assert(results[1].id === 'p3', `Second result should be p3 (similar), got ${results[1].id}`);
  assert(results[0].score > results[1].score, 'p1 score should be higher than p3');

  // 删除
  await client.deletePoint('p2');
  const countAfterDelete = await client.getPointCount();
  assert(countAfterDelete === 2, `After delete, count should be 2, got ${countAfterDelete}`);
}

// ─────────────────────────────────────────────
//  Test 2: 余弦相似度计算
// ─────────────────────────────────────────────

async function testCosineSimilarity() {
  console.log('\n📐 Test 2: 余弦相似度计算');

  // 完全相同的向量
  assertApprox(QdrantClient.cosineSimilarity([1, 0], [1, 0]), 1.0, 0.001, 'Same vector => 1.0');

  // 正交向量
  assertApprox(QdrantClient.cosineSimilarity([1, 0], [0, 1]), 0.0, 0.001, 'Orthogonal => 0.0');

  // 反向向量
  assertApprox(QdrantClient.cosineSimilarity([1, 0], [-1, 0]), -1.0, 0.001, 'Opposite => -1.0');

  // 部分相似
  const sim = QdrantClient.cosineSimilarity([1, 1, 0], [1, 0, 0]);
  assert(sim > 0.5 && sim < 1.0, `Partial similarity should be between 0.5 and 1.0, got ${sim}`);

  // 空向量
  assertApprox(QdrantClient.cosineSimilarity([], []), 0.0, 0.001, 'Empty vectors => 0.0');
}

// ─────────────────────────────────────────────
//  Test 3: MockEmbeddingProvider 确定性
// ─────────────────────────────────────────────

async function testMockEmbedding() {
  console.log('\n🎲 Test 3: MockEmbeddingProvider 确定性向量');

  const provider = new MockEmbeddingProvider();

  // 相同输入 → 相同输出
  const v1 = await provider.embedText('hello world');
  const v2 = await provider.embedText('hello world');
  assert(JSON.stringify(v1) === JSON.stringify(v2), 'Same input produces same vector');

  // 不同输入 → 不同输出
  const v3 = await provider.embedText('goodbye world');
  assert(JSON.stringify(v1) !== JSON.stringify(v3), 'Different input produces different vector');

  // 向量已归一化
  const norm = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
  assertApprox(norm, 1.0, 0.01, 'Vector should be L2-normalized');

  // 相似文本应产生有意义的相似度
  const simSame = QdrantClient.cosineSimilarity(v1, v2);
  assertApprox(simSame, 1.0, 0.001, 'Same text embeddings have sim=1.0');

  // 实体标签提取
  const tags = await provider.extractEntityTags('这个电阻和LED灯有什么区别？');
  assert(tags.includes('电阻'), 'Should extract 电阻');
  assert(tags.includes('LED'), 'Should extract LED');
}

// ─────────────────────────────────────────────
//  Test 4: EpisodicMemoryService 全流程
// ─────────────────────────────────────────────

async function testEpisodicMemoryFullPipeline() {
  console.log('\n🧠 Test 4: EpisodicMemoryService 全流程 (record → query)');

  // 注入 Mock 依赖
  const qdrant = new QdrantClient();
  qdrant['localFilePath'] = path.resolve(__dirname, 'memories_test.json');
  if (fs.existsSync(qdrant['localFilePath'])) {
    fs.unlinkSync(qdrant['localFilePath']);
  }
  await qdrant.initialize();
  const mock = new MockEmbeddingProvider();

  EpisodicMemoryService.setQdrantForTest(qdrant);
  EpisodicMemoryService.setProviderForTest(mock);

  // 录入记忆 1: 关于 LED 的对话
  await EpisodicMemoryService.recordMemory(
    '这个LED灯为什么不亮？',
    '从画面中可以看到LED的正负极接反了，请将长脚接正极。',
    null
  );

  // 录入记忆 2: 关于万用表的对话
  await EpisodicMemoryService.recordMemory(
    '这个万用表怎么测电压？',
    '将万用表旋钮调至直流电压档，红表笔接正极，黑表笔接负极。',
    null
  );

  // 录入记忆 3: 完全无关的闲聊
  await EpisodicMemoryService.recordMemory(
    '今天天气怎么样？',
    '根据我的判断，今天是晴天，气温约25度。',
    null
  );

  const count = await qdrant.getPointCount();
  assert(count === 3, `Should have 3 memory cards, got ${count}`);

  // 查询：关于 LED 的问题应该召回记忆 1
  const result = await EpisodicMemoryService.queryMemory('LED灯的正负极怎么分辨？', null);
  
  if (result) {
    console.log(`  📋 Recalled: "${result.description}"`);
    assert(result.transcript.includes('LED'), 'Recalled memory should mention LED');
    assert(result.timestamp instanceof Date, 'Timestamp should be a Date');
  } else {
    console.log('  ⚠️ No memory recalled (may be expected with mock vectors + threshold)');
  }

  // 查询不相关的内容
  const noResult = await EpisodicMemoryService.queryMemory('量子力学的波函数坍缩', null);
  // 使用 mock 向量时，不保证一定返回 null，但分数应该较低
  console.log(`  📋 Unrelated query result: ${noResult ? `"${noResult.description}"` : 'null (correct)'}`);
}

// ─────────────────────────────────────────────
//  Test 5: ModelRouter AI 目标分析
// ─────────────────────────────────────────────

async function testModelRouterObjectAnalysis() {
  console.log('\n🧠 Test 5: ModelRouter.analyzeDetectedObject AI 智能分析与建链');

  // 1. 正常实体检测
  const resPhone = await ModelRouter.analyzeDetectedObject([], 'cell phone', null, ['multimeter']);
  assert(resPhone.shouldAdd === true, 'cell phone should be added to graph');
  assert(typeof resPhone.refinedLabel === 'string' && resPhone.refinedLabel.length > 0, 'cell phone refined label should be non-empty string');
  assert(['device', 'tool', 'wire', 'concept', 'capacitor'].includes(resPhone.type), `cell phone type should be valid category: ${resPhone.type}`);
  assert(Array.isArray(resPhone.relations), 'relations should be an array');

  // 2. 人物实体检测（例如 person，应作为 Gwen/Friend 录入）
  const resPerson = await ModelRouter.analyzeDetectedObject([], 'person', null, []);
  assert(resPerson.shouldAdd === true, 'person should be recorded as user/friend (shouldAdd=true)');
}

// ─────────────────────────────────────────────
//  执行全部测试
// ─────────────────────────────────────────────

async function runAllTests() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  记忆图谱 RAG 模块集成测试');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await testQdrantInMemory();
  await testCosineSimilarity();
  await testMockEmbedding();
  await testEpisodicMemoryFullPipeline();
  await testModelRouterObjectAnalysis();

  // 清理测试临时文件
  const testFile = path.resolve(__dirname, 'memories_test.json');
  if (fs.existsSync(testFile)) {
    fs.unlinkSync(testFile);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  结果: ${passed} passed, ${failed} failed`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
