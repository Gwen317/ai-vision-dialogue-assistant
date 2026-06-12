import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey === 'mock' || apiKey.startsWith('your_')) {
    throw new Error('OPENROUTER_API_KEY is required for live OpenRouter smoke test');
  }

  const { OpenRouter } = await (new Function('return import("@openrouter/sdk")')() as Promise<typeof import('@openrouter/sdk')>);
  const openrouter = new OpenRouter({
    apiKey,
    appTitle: 'AI Vision Dialogue Assistant Live Smoke Test'
  });

  const model = process.env.OPENROUTER_CHAT_MODEL || 'nex-agi/nex-n2-pro:free';
  const messages = [
    {
      role: 'user' as const,
      content: "Live smoke test: reply with exactly the word pong."
    }
  ];

  console.log('Live OpenRouter request:');
  console.log(`  model: ${model}`);
  console.log(`  message: ${messages[0].content}`);
  console.log('');

  const stream = await openrouter.chat.send({
    chatRequest: {
      model,
      messages,
      stream: true,
      streamOptions: {
        includeUsage: true
      }
    }
  });

  let response = '';
  let reasoningTokens: number | null = null;

  for await (const chunk of stream) {
    if (chunk.error) {
      throw new Error(`OpenRouter stream error ${chunk.error.code}: ${chunk.error.message}`);
    }

    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      response += content;
      process.stdout.write(content);
    }

    const chunkReasoningTokens = chunk.usage?.completionTokensDetails?.reasoningTokens;
    if (typeof chunkReasoningTokens === 'number') {
      reasoningTokens = chunkReasoningTokens;
    }
  }

  console.log('');
  console.log('');
  console.log('Live OpenRouter response summary:');
  console.log(`  response: ${response}`);
  console.log(`  reasoning tokens: ${reasoningTokens ?? 'not reported'}`);
  console.log('');

  assert.ok(response.trim().length > 0, 'live OpenRouter response should not be empty');

  console.log('openrouter-live smoke test passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
