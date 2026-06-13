import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import OpenAI from 'openai';

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

  const model = process.env.DASHSCOPE_CHAT_MODEL || 'qwen-vl-plus';
  console.log(`Testing streaming with model: ${model}`);

  const stream = await client.chat.completions.create({
    model: model,
    messages: [
      { role: 'user', content: 'Say hello in 5 words.' }
    ],
    stream: true,
    stream_options: {
      include_usage: true
    }
  });

  let responseText = '';
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    responseText += content;
    process.stdout.write(content);
  }
  console.log('\nStream complete!');
  console.log('Final text length:', responseText.length);
  assert.ok(responseText.length > 0, 'Response should not be empty');
}

main().catch(console.error);
