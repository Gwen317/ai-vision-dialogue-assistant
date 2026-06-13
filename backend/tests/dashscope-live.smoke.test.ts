import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

async function main() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  console.log('DASHSCOPE_API_KEY from process.env:', apiKey ? 'exists (length ' + apiKey.length + ')' : 'undefined');
  if (!apiKey || apiKey === 'mock' || apiKey.startsWith('your_')) {
    throw new Error('DASHSCOPE_API_KEY is required for live DashScope smoke test');
  }

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.DASHSCOPE_LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  });

  const model = process.env.DASHSCOPE_CHAT_MODEL || 'qwen-vl-plus';
  console.log(`Using chat model: ${model}`);

  const completion = await client.chat.completions.create({
    model: model,
    messages: [
      { role: 'user', content: 'Live smoke test: reply with exactly the word pong.' }
    ],
    stream: false
  });

  console.log('Response content:', completion.choices[0]?.message?.content);
  assert.ok(completion.choices[0]?.message?.content?.trim().toLowerCase().includes('pong'), 'Response should contain pong');
  console.log('dashscope-live chat test passed!');
}

main().catch(error => {
  console.error('Smoke test failed:', error);
  process.exit(1);
});
