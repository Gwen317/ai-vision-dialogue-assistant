/**
 * generate_voiceover.ts — 演示视频配音音频自动生成脚本
 *
 * 通过复用项目已有的 CosyVoiceTtsClient 模块，连接阿里云 DashScope API
 * 自动将解说词分段合成为 MP3 音频文件，并以时间戳命名保存至 backend/voiceover 目录下。
 *
 * 运行命令:
 * cd backend
 * npx ts-node --transpile-only tests/generate_voiceover.ts
 */

import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// 加载环境变量
dotenv.config();

import { CosyVoiceTtsClient } from '../../dialogue/model_router/CosyVoiceTtsClient';

// 配音的十个分段数据
const voiceoverSegments = [
  {
    name: '00_00_00_15',
    text: '大家好！今天为您演示的是《AI视觉对话助手》—— 一款基于 React 和 Node.js 开发的高频、流式、低延迟双工多模态实时音视频对话系统。正如大家在屏幕上所见，我们拥有科技感十足的暗黑系 UI，流动的彩虹波谱，以及支持力导向互动的实体图谱。我们致力于让 AI “见你所见，听你所言”，打破人机交互的最后一公里。'
  },
  {
    name: '00_15_00_35',
    text: '系统在架构上采用“端侧轻量智能” ➔ “网关中枢路由” ➔ “云端大模型推理”的三层级联架构。通过对计算负载的合理划分，在保障首字延迟 TTFT 小于 200 毫秒的同时，全方位融入了“端云协同、本地优先”的控制运营成本策略，最大化降低云端 API 的计费开销。'
  },
  {
    name: '00_35_01_05',
    text: '首先，我们来看看全双工语音对话与打断功能。在我们的系统中，用户无需按下任何按钮，只需开口说话即可与 AI 交流。当 AI 正在说话时，我可以随时打断它——比如“停一下，我想问别的！”，大家可以看到，AI 声音瞬间静音，全局状态立刻转入录制。网关通过 AbortController 瞬间挂起云端线程，并自动进行物理文本截断，从根本上杜绝了打断时的“端云记忆分叉”问题。'
  },
  {
    name: '01_05_01_30',
    text: '在声学体验上，我们基于端侧 Web Audio API 动态生成白噪声指数衰减的冲激响应，实时渲染出录音棚、客厅或大教堂的环境混响感。同时，系统内置了伦巴德效应自适应算法，当检测到麦克风的背景噪音增大时，AI 会自动拉高播音音量并微调高频滤波器增益，确保在嘈杂环境中依然具有极佳的语音可听度。'
  },
  {
    name: '01_30_01_55',
    text: '接下来是本项目的核心特色：全方位的运营成本控制。高频的多模态视频帧上传会产生极大的 API 计费开销。为此，我们在前端集成了本地画质预检防御。当我用手遮住摄像头，或者快速晃动时，端侧的 Laplacian 模糊检测和亮度分析会自动拦截图像帧，并在本地播放语音提醒。整个拦截过程完全在浏览器本地运行，云端 API 请求量和网络带宽消耗为零。'
  },
  {
    name: '01_55_02_15',
    text: '同时，前端在本地以每秒 2 帧的频率运行轻量级的 TensorFlow.js COCO-SSD 目标检测模型。只有当检测到重点手持目标（例如水杯、手机）且系统处于录音状态时，才会联动后台进行多模态 RAG 检索，避免了无意义背景画面高频上传带来的 Token 资金损耗。'
  },
  {
    name: '02_15_02_30',
    text: '对于语音 API 的成本控制，系统支持一键语音降级 fallback 机制。当切换为本地浏览器降级模式后，前端自动调用 Web Speech API 进行免费的本地 ASR 识别与本地 TTS 发音。此时，云端语音服务的运营费用直接降为 0。'
  },
  {
    name: '02_30_03_00',
    text: '接下来我们展示多模态长程情景记忆系统。移开刚才识别的物品并闲聊几句后，我再次拿回它询问：“关于我刚才展示的这个东西，我们之前聊过什么？”。可以看到，网关通过提取文本与视觉特征的余弦相似度，从向量数据库中精准召回了对应的历史记忆卡片，并将其以 System Instructions 喂给大模型，使 AI 拥有了跨越会话的记忆和比对能力。'
  },
  {
    name: '03_00_03_30',
    text: '同时，系统理解到的所有物理元器件、工具和概念，都将自动且动态地呈现在由 D3.js 物理力学仿真驱动的霓虹发光拓扑图谱中。节点根据设备、工具等分类呈现出不同色彩。点击特定的节点，会拉出气泡弹窗，展示当时抓拍的视频微缩截图和 AI 诊断描述，构建了空间与记忆的可视化链条。'
  },
  {
    name: '03_30_04_00',
    text: '为了彻底免去小微部署场景下的 Qdrant 数据库托管开销，我们还自研了一套轻量级内存向量数据库降级存根，检索响应小于 1 毫秒，实现了服务器存储成本的零开销。工程质量上，我们通过了强类型 TypeScript 编译与全套自动化单元测试。本作品通过四大成本控制支柱与五大创新点，成功打造了高容灾、低延迟、零负担的“绿色智能体”模式。谢谢观看！'
  }
];

async function generateAllVoiceovers() {
  console.log('================================================');
  console.log('🚀 视频配音音频自动生成脚本启动 (CosyVoice)');
  console.log('================================================');

  // 初始化合成客户端
  const ttsClient = new CosyVoiceTtsClient();
  if (!ttsClient.isConfigured()) {
    console.error('❌ 错误: backend/.env 中未配置或未正确配置 DASHSCOPE_API_KEY！请检查环境变量。');
    process.exit(1);
  }

  // 推荐新闻播报/讲解的专业干练音色（'longshuo_v3'，龙硕，博才干练男）
  const voiceId = 'longshuo_v3';
  
  // 确保输出目录存在
  const outputDir = path.resolve(__dirname, '../voiceover');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`[System] 创建配音输出目录: ${outputDir}`);
  }

  console.log(`使用 CosyVoice 角色音色: ${voiceId}`);
  console.log(`共规划了 ${voiceoverSegments.length} 个解说片段，开始流式合成中...\n`);

  for (let i = 0; i < voiceoverSegments.length; i++) {
    const seg = voiceoverSegments[i];
    const fileName = `${seg.name}.mp3`;
    const filePath = path.join(outputDir, fileName);

    console.log(`[${i + 1}/${voiceoverSegments.length}] 正在合成: ${fileName} (${seg.text.length}字)...`);
    
    try {
      // 合成音频缓冲
      const audioBuffer = await ttsClient.synthesize(seg.text, voiceId);
      
      // 保存至物理文件
      fs.writeFileSync(filePath, audioBuffer);
      console.log(`  ✅ 成功保存: ${filePath} (${(audioBuffer.byteLength / 1024).toFixed(1)} KB)`);
    } catch (err) {
      console.error(`  ❌ 合成失败 [${fileName}]:`, err);
    }
  }

  console.log('\n================================================');
  console.log(`🎉 全部配音合成完毕！音频文件已存入: \n${outputDir}`);
  console.log('================================================');
}

generateAllVoiceovers().catch((err) => {
  console.error('TTS Generator crashed:', err);
  process.exit(1);
});
