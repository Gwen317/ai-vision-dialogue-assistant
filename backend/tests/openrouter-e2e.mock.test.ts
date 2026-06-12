import assert from 'node:assert/strict';
import { ModelRouter } from '../../dialogue/model_router/ModelRouter';
import type { TimelineEvent } from '../../dialogue/gateway_core/SocketGateway';

type EmittedEvent = {
  event: string;
  payload: unknown;
};

class MockSocket {
  public emitted: EmittedEvent[] = [];

  emit(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
  }
}

async function* mockChatStream() {
  yield {
    choices: [
      {
        delta: {
          content: 'The image '
        }
      }
    ]
  };

  yield {
    choices: [
      {
        delta: {
          content: 'shows a test object.'
        }
      }
    ],
    usage: {
      completionTokensDetails: {
        reasoningTokens: 7
      }
    }
  };
}

function messageText(message: any): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content
    .filter((part: any) => part.type === 'text')
    .map((part: any) => part.text)
    .join('\n');
}

async function main() {
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  process.env.OPENROUTER_CHAT_MODEL = 'nex-agi/nex-n2-pro:free';
  process.env.OPENROUTER_STT_MODEL = 'openai/whisper-1';

  const base = Date.UTC(2026, 5, 12, 10, 0, 0);
  const imageAt30s = base + 30_000;
  const speechStartedAt = base + 32_000;
  const speechEndedAt = base + 34_000;

  let capturedChatRequest: any = null;
  let capturedTranscriptionRequest: any = null;

  ModelRouter.setOpenRouterForTest({
    stt: {
      async createTranscription(request: any) {
        capturedTranscriptionRequest = request;
        return {
          text: 'What is in the image?'
        };
      }
    },
    chat: {
      async send(request: any) {
        capturedChatRequest = request.chatRequest;
        return mockChatStream();
      }
    }
  });

  const socket = new MockSocket();
  const timeline: TimelineEvent[] = [
    {
      type: 'image',
      timestamp: imageAt30s,
      imageBase64: 'mock-image-at-30s'
    }
  ];

  await ModelRouter.processInteraction(
    socket as any,
    Buffer.from('mock-webm-audio'),
    {
      type: 'image',
      timestamp: imageAt30s,
      imageBase64: 'mock-image-at-30s'
    },
    timeline,
    {
      speechStartedAt,
      speechEndedAt
    },
    new AbortController().signal
  );

  const textChunks = socket.emitted
    .filter(item => item.event === 'text_chunk')
    .map(item => item.payload)
    .join('');

  const stateChanges = socket.emitted
    .filter(item => item.event === 'state_change')
    .map(item => item.payload);

  const modelMessageTexts = capturedChatRequest.messages.map(messageText);
  const cameraIndex = modelMessageTexts.findIndex((text: string) => text.includes('[Camera frame captured @'));
  const userSpeechIndex = modelMessageTexts.findIndex((text: string) => text.includes('[User speech @'));

  console.log('Mock OpenRouter request flow:');
  console.log(`  STT model: ${capturedTranscriptionRequest.sttRequest.model}`);
  console.log(`  STT audio format: ${capturedTranscriptionRequest.sttRequest.inputAudio.format}`);
  console.log(`  chat model: ${capturedChatRequest.model}`);
  console.log(`  streamed response: ${textChunks}`);
  console.log('');

  console.log('Messages sent to mocked OpenRouter chat, in order:');
  modelMessageTexts.forEach((text: string, index: number) => {
    const label = text.includes('[Camera frame captured @')
      ? 'camera'
      : text.includes('[User speech @')
        ? 'current-user'
        : 'system/history';

    console.log(`  [${index}] ${label}: ${text.replace(/\n/g, ' | ')}`);
  });
  console.log('');

  console.log('Assertions:');
  console.log(`  STT called with webm audio: ${capturedTranscriptionRequest.sttRequest.inputAudio.format === 'webm'}`);
  assert.equal(capturedTranscriptionRequest.sttRequest.inputAudio.format, 'webm');

  console.log(`  chat used configured OpenRouter model: ${capturedChatRequest.model === 'nex-agi/nex-n2-pro:free'}`);
  assert.equal(capturedChatRequest.model, 'nex-agi/nex-n2-pro:free');

  console.log(`  camera message index (${cameraIndex}) < user speech index (${userSpeechIndex}): ${cameraIndex < userSpeechIndex}`);
  assert.ok(cameraIndex !== -1 && userSpeechIndex !== -1 && cameraIndex < userSpeechIndex);

  console.log(`  socket streamed full response: ${textChunks === 'The image shows a test object.'}`);
  assert.equal(textChunks, 'The image shows a test object.');

  console.log(`  socket states include SPEAKING and IDLE: ${stateChanges.includes('SPEAKING') && stateChanges.includes('IDLE')}`);
  assert.ok(stateChanges.includes('SPEAKING'));
  assert.ok(stateChanges.includes('IDLE'));

  const savedUserTurn = timeline.find(event => event.type === 'message' && event.role === 'user');
  const savedModelTurn = timeline.find(event => event.type === 'message' && event.role === 'model');

  console.log(`  timeline saved user turn: ${Boolean(savedUserTurn)}`);
  assert.ok(savedUserTurn);

  console.log(`  timeline saved model turn: ${Boolean(savedModelTurn)}`);
  assert.ok(savedModelTurn);

  console.log('');
  console.log('openrouter-e2e mock test passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
