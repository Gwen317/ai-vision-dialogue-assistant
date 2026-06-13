import dotenv from 'dotenv';
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

dotenv.config();

function generateSineWaveWav(outputPath: string): Promise<void> {
  if (!ffmpegPath) {
    return Promise.reject(new Error('ffmpeg-static not found'));
  }
  return new Promise((resolve, reject) => {
    // Generate a 1-second sine wave, mono, 16000Hz WAV
    const ffmpeg = spawn(ffmpegPath, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-acodec',
      'pcm_s16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      outputPath
    ]);
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

async function main() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey || apiKey === 'mock' || apiKey.startsWith('your_')) {
    throw new Error('DASHSCOPE_API_KEY is required');
  }

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.DASHSCOPE_LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  });

  const tempFile = path.join(os.tmpdir(), 'test-sine.wav');
  await generateSineWaveWav(tempFile);
  console.log('Valid sine wave WAV generated at:', tempFile);

  const audioBuffer = await fs.promises.readFile(tempFile);
  const base64Data = audioBuffer.toString('base64');
  const dataUri = `data:audio/wav;base64,${base64Data}`;

  console.log('Sending valid WAV base64 to qwen3-asr-flash...');
  try {
    const response = await client.chat.completions.create({
      model: 'qwen3-asr-flash',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: dataUri
              }
            } as any
          ]
        }
      ]
    });
    console.log('ASR Chat Response:', JSON.stringify(response.choices[0]?.message));
  } catch (err: any) {
    console.error('ASR Chat Error:', err.message, err);
  } finally {
    try {
      await fs.promises.unlink(tempFile);
    } catch {}
  }
}

main().catch(console.error);
