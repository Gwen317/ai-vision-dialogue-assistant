/**
 * audioTranscription.ts — 语音转写（STT）传输层
 *
 * 负责把前端上传的音频字节转写为文本，封装两类后端能力：
 * - 阿里云 DashScope（qwen3-asr-flash）
 * - 摩理方舟 / Gitee AI（GLM-ASR）
 *
 * 两者都要求 16kHz 单声道 MP3，因此统一先经 ffmpeg 转码再上传。
 * 转写编排（选择哪个 provider、本地 ASR 回退）保留在 ModelRouter，本模块只提供纯能力函数。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import OpenAI from 'openai';
import { getDashScopeBaseUrl, isUsableApiKey } from './llmProvider';

/** 根据音频 MIME 类型推断临时文件扩展名 */
export function extensionForAudioMimeType(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}

/**
 * 调用 ffmpeg 把任意音频转码为 16kHz / 单声道 / 64kbps 的 MP3。
 * 这是各家 ASR 接口的通用稳妥输入格式。
 */
export function convertAudioToMp3(inputPath: string, outputPath: string): Promise<void> {
  if (!ffmpegPath) {
    return Promise.reject(new Error('ffmpeg-static did not provide an ffmpeg binary path.'));
  }
  const binaryPath: string = ffmpegPath;

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(binaryPath, [
      '-y',
      '-i', inputPath,
      '-vn',
      '-acodec', 'libmp3lame',
      '-ar', '16000',
      '-ac', '1',
      '-b:a', '64k',
      outputPath
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      }
    });
  });
}

/**
 * 在临时目录内把音频转码为 MP3 后执行回调，结束后自动清理临时目录。
 * 统一了两个 ASR provider 的临时文件生命周期管理。
 */
async function withTranscodedMp3<T>(
  audioBuffer: Buffer,
  mimeType: string,
  prefix: string,
  run: (mp3Path: string) => Promise<T>
): Promise<T> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  const inputAudioPath = path.join(tmpDir, `speech-input.${extensionForAudioMimeType(mimeType)}`);
  const mp3AudioPath = path.join(tmpDir, 'speech.mp3');

  try {
    await fs.promises.writeFile(inputAudioPath, audioBuffer);
    await convertAudioToMp3(inputAudioPath, mp3AudioPath);
    return await run(mp3AudioPath);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(cleanupErr => {
      console.error(`[audioTranscription] Failed to cleanup temp dir ${tmpDir}:`, cleanupErr);
    });
  }
}

/** 当前是否配置了可用的 DashScope ASR 凭证 */
export function hasDashScopeStt(): boolean {
  // 与流式链路一致：允许 test- 前缀（实际调用方仍可通过注入自定义转写器绕过网络）
  return isUsableApiKey(process.env.DASHSCOPE_API_KEY, true);
}

/** 当前是否配置了可用的摩理方舟 STT 凭证 */
export function hasMolifangzhouStt(): boolean {
  return isUsableApiKey(process.env.MOLIFANGZHOU_API_KEY, true);
}

/**
 * 使用 DashScope（qwen3-asr-flash）转写音频。
 * 内部失败时返回空字符串而非抛错，以便上层平滑回退到本地 ASR 文本。
 */
export async function transcribeWithDashScope(audioBuffer: Buffer, mimeType: string): Promise<string> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const client = new OpenAI({ apiKey, baseURL: getDashScopeBaseUrl() });

  return withTranscodedMp3(audioBuffer, mimeType, 'dashscope-asr-', async (mp3Path) => {
    try {
      const mp3Buffer = await fs.promises.readFile(mp3Path);
      const dataUri = `data:audio/mp3;base64,${mp3Buffer.toString('base64')}`;

      const response = await client.chat.completions.create({
        model: 'qwen3-asr-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'input_audio', input_audio: { data: dataUri } } as any
            ]
          }
        ]
      });
      return (response.choices[0]?.message?.content || '').trim();
    } catch (asrErr) {
      console.error('[audioTranscription] DashScope ASR call failed, returning empty text:', asrErr);
      return '';
    }
  });
}

/**
 * 使用摩理方舟 / Gitee AI（GLM-ASR）转写音频。
 * 凭证缺失或调用失败时抛出错误，由上层捕获后回退。
 */
export async function transcribeWithMolifangzhou(audioBuffer: Buffer, mimeType: string): Promise<string> {
  const apiKey = process.env.MOLIFANGZHOU_API_KEY;
  if (!isUsableApiKey(apiKey, true)) {
    throw new Error('MOLIFANGZHOU_API_KEY is required for speech transcription.');
  }

  const baseUrl = process.env.MOLIFANGZHOU_BASE_URL || 'https://ai.gitee.com/v1';
  const model = process.env.MOLIFANGZHOU_STT_MODEL || 'GLM-ASR';
  const client = new OpenAI({ baseURL: baseUrl, apiKey });

  try {
    return await withTranscodedMp3(audioBuffer, mimeType, 'molifangzhou-stt-', async (mp3Path) => {
      const response = await client.audio.transcriptions.create({
        file: fs.createReadStream(mp3Path),
        model
      });
      return (response.text || '').trim();
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Molifangzhou STT failed: ${message}`);
  }
}
