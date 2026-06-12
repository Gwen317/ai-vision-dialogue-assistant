# AI 视觉对话助手 (AI Vision Dialogue Assistant)

这是一个高频、流式、低延迟的双工多模态实时音视频对话系统。系统结合了端侧 AI 算法（静音检测、环境噪声过滤、音画同步）与云端大模型接口（Gemini 2.5 Flash / 1.5 Pro），支持用户通过语音和视觉画面与 AI 助手进行实时交互。

## 📁 项目目录结构

```text
study/
├── ai_topics_comparison/    # 课题评估、技术选型与系统架构设计文档
│   ├── 技术选型与多维论证报告.md
│   ├── 系统总体技术规程设计.md
│   ├── 系统架构设计全景蓝图.md
│   ├── 系统核心设计与创新特性数据规程规范.md
│   └── 课题评估与选题对比报告.md
├── frontend/                # 基于 React + Vite + TypeScript 的前端客户端
│   ├── src/                 # 前端核心代码 (FSM 状态机、音视频采集、本地 VAD 等)
│   ├── package.json
│   └── vite.config.ts
└── backend/                 # 基于 Node.js + Express + Socket.io 的云端网关
    ├── src/                 # 后端核心代码 (Gemini API 路由、对话流式打断/截断器等)
    ├── .env                 # 环境变量配置文件 (包含 API Keys 等)
    └── package.json
```

## 🛠️ 技术选型与核心特性

### 1. 前端客户端 (Frontend)
- **核心框架**: React + TypeScript + Vite
- **通信协议**: Socket.io-client (基于 WebSocket 二进制切片帧，高频上行 200ms 录音 Blob)
- **边缘端侧 AI 引擎**:
  - `@ricky0123/vad-web` (基于 **ONNX Runtime Web + WebAssembly** 运行 Silero VAD 静音检测)
  - `TensorFlow.js` (本地运行 **YAMNet-nano** 噪音分类模型，识别人声/键盘/咳嗽等杂音，避免误触发)
- **播放与音效**:
  - 支持 **空间混响模拟算法 (Acoustic Convolver)**，动态合成房间脉冲响应（IR），模拟录音室、客厅、走廊等多种场景音效。
  - **音画毫秒级 Canvas 教学同步**: 服务端流式返回字词时间戳队列，前端实现“音出笔落”的流畅同步体验。

### 2. 后端网关 (Backend)
- **核心架构**: Node.js + Express + TypeScript
- **实时双工通信**: Socket.io (WebSocket 长连接，支持并发音频中转与状态流)
- **AI 模型集成**: Google Generative AI Node.js SDK
  - **智能路由**:
    - **Tier 1 (本地指令)**: 直接处理音量调节、截图等基础动作。
    - **Tier 2 (极速模型 - Gemini 2.5 Flash)**: 处理日常对话、物品分类等中低复杂度交互。
    - **Tier 3 (推理模型 - Gemini 1.5 Pro)**: 触发代码调试、数学计算、复杂电路排障等高难度场景。
- **打断/截断管理器 (Memory Truncator)**:
  - 监听客户端打断事件，利用 `AbortController.abort()` 强杀云端大模型拉取线程。
  - 对话记忆重构：根据客户端已播放的字符偏移量 `N` 实时截断 AI 历史文本，防止“端云记忆分叉”。

---

## 🚀 快速开始

### 1. 后端网关配置与启动
1. 进入后端目录：
   ```bash
   cd backend
   ```
2. 安装依赖：
   ```bash
   npm install
   ```
3. 配置环境变量：
   在 `backend` 目录下创建 `.env` 文件，并填写你的 Gemini API Key 以及端口信息：
   ```env
   PORT=3000
   GEMINI_API_KEY=your_gemini_api_key_here
   ```
4. 启动开发服务器：
   ```bash
   npm run dev
   ```

### 2. 前端客户端启动
1. 进入前端目录：
   ```bash
   cd ../frontend
   ```
2. 安装依赖：
   ```bash
   npm install
   ```
3. 启动开发服务器：
   ```bash
   npm run dev
   ```
4. 在浏览器中打开提示的本地地址（如 `http://localhost:5173`）即可进行测试。

---

## 👥 协作与交流

欢迎任何形式的 Contribution！你可以通过 GitHub Fork 本仓库，提交 Pull Request，或者直接在 Issues 中反馈问题。
