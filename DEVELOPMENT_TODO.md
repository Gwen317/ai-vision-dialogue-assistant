# AI 视觉对话助手：模块功能描述与协同开发任务清单 (Development Task List)

为了方便团队成员协作开发，本项目将所有的核心创新特性划分到三个扁平的特性模块（`dialogue`、`vision`、`memory_graph`）中。本文件梳理了每个模块下具体小文件夹及文件的职责，并以任务清单（TODO List）的形式列出需要实现的功能。

---

## 🗣️ 一、 dialogue (双工对话与声学模拟模块)

本模块负责处理音频捕获、语音静音检测（VAD）、状态机转移、空间混响模拟以及云端大模型极速分级路由与打断机制。

### 1. `dialogue/vad_capture/FsmController.ts`
* **功能描述**：双工状态机（FSM）控制器，驱动整个对话生命周期，防止状态错乱。
* **开发任务清单**：
  - [ ] 定义并管理状态类型：`IDLE`（空闲）、`LISTENING`（录音）、`THINKING`（思考）、`SPEAKING`（播放/AI说话）。
  - [ ] 提供状态变更监听器注册接口（`registerStateListener`），实时驱动前端 UI 组件的动效。
  - [ ] 实现打断（Interrupt）事件触发时的状态强转清理逻辑。

### 2. `dialogue/acoustic_reverb/AudioAcousticProcessor.ts`
* **功能描述**：端侧 Web Audio 声学模拟器，提供环境混响合成与 Lombard 效应自适应。
* **开发任务清单**：
  - [ ] 初始化全局 `AudioContext`，并建立 `Filter -> Convolver -> Gain -> Analyser` 的音轨渲染管线。
  - [ ] 实现白噪声与指数衰减相结合的**冲激响应（IR）合成算法**，动态生成用于 ConvolverNode 的混响 Buffer，模拟客厅、走廊、大厅等物理空间。
  - [ ] 监测输入麦克风的背景噪音强度。
  - [ ] 实施**伦巴德效应（Lombard Effect）**：在噪声较大时，自动提升 AI 的播音音量（Gain）并微调高频滤波器增益（Highshelf Filter），确保语音可听度。

### 3. `dialogue/gateway_core/SocketGateway.ts`
* **功能描述**：后端实时双工网关，负责二进制媒体流与 JSON 控制信令的分发。
* **开发任务清单**：
  - [ ] 开启长连接 Socket.io 服务，接收客户端 `audio_chunk` 音频流和 `image_frame` 画面帧。
  - [ ] 监听 `vad_end` 并启动大模型处理。
  - [ ] **打断控制**：监听客户端 `interrupt` 信令，立即调用正在生成的 Gemini 实例的 `AbortController.abort()` 强杀云端 Token 生成。
  - [ ] **记忆截断**：依据客户端上报的已播字词偏移量（Offset），在后台数据库中对上一轮 AI 的文本进行截断，防止“端云记忆分叉”。

### 4. `dialogue/model_router/ModelRouter.ts`
* **功能描述**：后端智能大模型路由，负责用户语音识别与分级模型请求分流。
* **开发任务清单**：
  - [ ] 接入 Google Gen AI SDK。
  - [ ] 使用 `gemini-2.5-flash` 极速识别用户上传的二进制 WebM 音频流，转化为文字。
  - [ ] 接入情景记忆检索，实现历史上下文的召回与系统 Prompt 注入。
  - [ ] **智能分级路由**：若识别文本中包含复杂任务关键字（如 `debug`, `code`, `math`, `circuit` 等），自动将模型请求路由至高推理能力的 `gemini-1.5-pro`，其余普通对话路由至 `gemini-2.5-flash`。

---

## 👁️ 二、 vision (视频流捕获与音画同步模块)

本模块负责摄像头的图像帧滑动窗口暂存、本地画质去模糊/去曝光预检，以及基于字词时间戳的 Canvas 绘图同步绘制。

### 1. `vision/video_capture/VideoCapture.ts`
* **功能描述**：端侧摄像头视频帧滑窗管理器。
* **开发任务清单**：
  - [ ] 开启摄像头 `MediaStream` 捕获，并将帧画面绘制在隐藏的 Canvas 上进行 JPEG 二进制压缩。
  - [ ] 维护一个最大容量为 10 的环形帧队列（`FrameQueue`），以 500ms（2fps）为间隔滑窗缓存最近 5 秒的画面。
  - [ ] 提供时间轴对齐算法：在 VAD 判定说话开始（`speech_start`）和说话结束（`speech_end`）时，挑选出距离该时刻最近的两帧作为上下文打包发送。

### 2. `vision/quality_guard/QualityGuard.ts`
* **功能描述**：端侧图像质量主动检测防护网。
* **开发任务清单**：
  - [ ] 实现 **Laplacian 方差算子模糊度预检**（拉普拉斯方差低于 12.0 时，判定画面抖动模糊，拦截发送并本地 TTS 播报提醒）。
  - [ ] 实现 **平均亮度检测**：基于 $Y = 0.299R + 0.587G + 0.114B$ 计算画面平均灰度值，判定是否过暗（$Y < 40$）或过曝（$Y > 240$），并予以用户纠正引导。

### 3. `vision/drawing_sync/CanvasSyncRenderer.ts`
* **功能描述**：端侧 Canvas 同步教学画板。
* **开发任务清单**：
  - [ ] 绘制科技感（Sci-fi）风格的背景网格线。
  - [ ] 提供文本正则表达式解析器，捕获文本中夹带的 `[[draw:type:params]]` 指令。
  - [ ] 实现线条（`line`，支持匀速伸展动效）、圆形（`circle`）、矩形（`rect`）、文字（`text`）及清屏（`clear`）等绘制命令的执行器。

### 4. `vision/drawing_instructions/DrawingInstructionGenerator.ts`
* **功能描述**：后端 Canvas 绘图指令协议封装生成器。
* **开发任务清单**：
  - [ ] 封装标准的指令生成静态助手类。
  - [ ] 提供 `line()`、`circle()`、`rect()`、`text()`、`clear()` 的格式化包装，确保大模型调用工具（Tool Call）或拼接回复流时输出的标签协议百分之百符合前端解析规程。

---

## 🧠 三、 memory_graph (多模态情景记忆与实体图谱模块)

本模块负责长程多模态情景记忆库（Episodic Memory RAG）的向量化和加权双路检索，以及利用 D3.js 将识别到的物理实体拓扑图谱化。

### 1. `memory_graph/entity_graph/D3GraphRenderer.tsx`
* **功能描述**：端侧 D3.js 物理环境实体拓扑图谱。
* **开发任务清单**：
  - [ ] 集成 D3 力学仿真（`forceSimulation`），支持节点排斥力、连线弹力及居中定位。
  - [ ] 绘制带有发光（Neon）呼吸动效的圆圈节点，并根据类型（设备、电容、工具、普通概念）呈现不同色彩。
  - [ ] 提供拖拽力交互绑定，并暴露节点点击回调接口（`onNodeClick`），当用户点击特定物理元器件节点时，弹出悬浮卡片显示当时的截屏和 AI 分析记录。

### 2. `memory_graph/backend/vector_rag/QdrantClient.ts`
* **功能描述**：后端向量数据库 Qdrant 客户端连接与存取组件。
* **开发任务清单**：
  - [ ] 封装 Qdrant SDK 或 HTTP API 连接器。
  - [ ] 提供 Collection 的创建与检索优化（Payload 索引）。
  - [ ] 提供高维向量数据及包含截图描述、会话转译的 Payload 数据的 upsert 接口与 search 接口。

### 3. `memory_graph/backend/episodic_memory/EpisodicMemoryService.ts`
* **功能描述**：长程情景记忆核心存取与双路召回算法服务。
* **开发任务清单**：
  - [ ] 会话结束时，将文本调用 `text-embedding-004` 提取语义特征向量。
  - [ ] 将图像（如有）调用 `multimodal-embedding-001` 提取视觉特征向量，并异步调用 `gemini-2.5-flash` 自动生成一句话实体摘要。
  - [ ] 保存并维护 `MemoryCard` 结构。
  - [ ] **双路加权检索**：实现相似度融合公式：
    $$\text{Score} = w_{\text{text}} \cdot \text{Sim}_{\text{text}} + w_{\text{vis}} \cdot \text{Sim}_{\text{vis}}$$
    其中 $w_{\text{text}} = 0.4$，$w_{\text{vis}} = 0.6$。在融合评分高于 `0.70` 时，将关联度最高的那张记忆卡片的会话纪要及画面描述拼入大模型 System Prompt 进行多模态 RAG 召回。

---

## 🛠️ 四、 关键技术实现要点与架构笔记 (Key Technical Points & Architectural Notes)

### 1. 神经网络静音检测 (Silero VAD) 与端侧离线化集成
* **解决痛点**：取代了易受环境白噪音、物理撞击声（拍手、敲键盘）、风噪等非人声干扰的传统 RMS 振幅门限方案，提供高置信度的实时人类声音振动特征识别。
* **架构设计与部署细节**：
  * **前端引擎**：使用 `@ricky0123/vad-web` 底层驱动，运行轻量级 ONNX 神经网络，利用浏览器的 WebAssembly 配合 Web Audio Worklet 进行多线程低时延采样及预测。
  * **离线化及缓存**：将 VAD 的核心模型 `silero_vad_v5.onnx`、工作线程脚本 `vad.worklet.bundle.min.js` 以及 4 个 `onnxruntime-web` WebAssembly 库文件（`ort-wasm*.wasm`）存放在前端 `/public/vad/` 本地文件夹中。前端初始化时通过配置 `baseAssetPath: "/vad/"` 和 `onnxWASMBasePath: "/vad/"` 保证模型秒级加载，消除 CDN 抖动故障。
* **全双工交互控制流**：
  * **即时打断 (onSpeechStart)**：一旦检测到人声概率跨越阈值，立即取消本地 TTS 发音并上报中断偏移量 `interrupt`；切换全局状态为用户讲话，避免高延迟打断失败。
  * **自动恢复思考 (onSpeechEnd)**：在用户完全停止说话后发出 `vad_end`，自动重置状态并触发云端多模态推理大模型重新生成回复，实现无按钮双手解放的流畅对话。
  * **实时数据流 HUD 看板**：在 `onFrameProcessed` 中计算当前的 `isSpeech` 概率，采用**直写原生 DOM 机制**（不触发 React 核心 State 更新），在 60fps 频率下实现实时的 `SPEECH PROB` 人声置信度数据高光呈现。

