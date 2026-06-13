import dotenv from 'dotenv';
import OpenAI from 'openai';
import fs from 'node:fs';

dotenv.config();

async function main() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey || apiKey === 'mock' || apiKey.startsWith('your_')) {
    throw new Error('DASHSCOPE_API_KEY is required');
  }

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.DASHSCOPE_LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  });

  // Create a tiny valid silent WAV buffer
  // A standard 44-byte WAV header for silence
  const wavHeader = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    0x2c, 0x00, 0x00, 0x00, // file size - 8
    0x57, 0x41, 0x56, 0x45, // "WAVE"
    0x66, 0x6d, 0x74, 0x20, // "fmt "
    0x10, 0x00, 0x00, 0x00, // chunk size (16)
    0x01, 0x00,             // compression code (1 = PCM)
    0x01, 0x00,             // channels (1)
    0x44, 0xac, 0x00, 0x00, // sample rate (44100)
    0x88, 0x58, 0x01, 0x00, // byte rate (sample rate * block align)
    0x02, 0x00,             // block align (2)
    0x10, 0x00,             // bits per sample (16)
    0x64, 0x61, 0x74, 0x61, // "data"
    0x08, 0x00, 0x00, 0x00, // chunk size (8)
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 // 4 samples of silence (16-bit PCM)
  ]);

  const audioFile = await OpenAI.toFile(wavHeader, 'speech.wav', { type: 'audio/wav' });

  console.log('Sending WAV header audio buffer to DashScope ASR...');
  try {
    const response = await client.audio.transcriptions.create({
      model: 'qwen3-asr-flash',
      file: audioFile
    });
    console.log('ASR Response:', response);
  } catch (err: any) {
    console.error('ASR Error:', err.message, err);
  }
}

main().catch(console.error);
