import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { CosyVoiceTtsClient } from '../../dialogue/model_router/CosyVoiceTtsClient';

dotenv.config();

async function main() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey || apiKey === 'mock' || apiKey.startsWith('your_')) {
    console.log('DASHSCOPE_API_KEY is not configured or is set to mock. Skipping live CosyVoice smoke test.');
    return;
  }

  const voiceId = process.env.DASHSCOPE_VOICE_ID || 'longanyang';
  const client = new CosyVoiceTtsClient();

  console.log(`Starting live CosyVoice synthesis test for text: "你好，这里是实时双工测试。"`);
  console.log(`Using Voice ID: ${voiceId}`);
  
  const start = Date.now();
  const audioBuffer = await client.synthesize("你好，这里是实时双工测试。", voiceId);
  const latency = Date.now() - start;

  console.log(`Synthesis succeeded in ${latency}ms.`);
  console.log(`Generated audio size: ${audioBuffer.byteLength} bytes.`);
  
  assert.ok(audioBuffer.byteLength > 100, 'Audio buffer should not be empty');

  console.log('cosyvoice-live smoke test passed!');
}

main().catch(error => {
  console.error('Smoke test failed:', error);
  process.exit(1);
});
