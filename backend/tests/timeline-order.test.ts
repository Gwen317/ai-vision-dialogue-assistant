import assert from 'node:assert/strict';
import { buildTimelineMessages } from '../../dialogue/model_router/ModelRouter';
import type { TimelineEvent } from '../../dialogue/gateway_core/SocketGateway';

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
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

const base = Date.UTC(2026, 5, 12, 10, 0, 0);
const imageAt30s = base + 30_000;
const userSpeechAt32s = base + 32_000;
const userSpeechEndAt34s = base + 34_000;
const modelAnsweredAt35s = base + 35_000;

const timeline: TimelineEvent[] = [
  {
    type: 'image',
    timestamp: imageAt30s,
    imageBase64: 'mock-image-at-30s'
  },
  {
    type: 'message',
    timestamp: modelAnsweredAt35s,
    role: 'model',
    parts: [{ text: 'This answer finished later and must not move earlier events.' }]
  }
];

const { messages } = buildTimelineMessages({
  systemInstruction: 'system',
  userSpeech: 'What is in the image?',
  timeline,
  turnTiming: {
    speechStartedAt: userSpeechAt32s,
    speechEndedAt: userSpeechEndAt34s
  }
});

const orderedTexts = messages.map(messageText);
const cameraIndex = orderedTexts.findIndex(text => text.includes('[Camera frame captured @'));
const userSpeechIndex = orderedTexts.findIndex(text => text.includes('[User speech @'));
const delayedAnswerIndex = orderedTexts.findIndex(text => text.includes('This answer finished later'));

console.log('Mock input timeline:');
console.log(`  image_frame captured at 30s: ${iso(imageAt30s)}`);
console.log(`  user speech starts at 32s:  ${iso(userSpeechAt32s)}`);
console.log(`  user speech ends at 34s:    ${iso(userSpeechEndAt34s)}`);
console.log(`  model answer completes 35s: ${iso(modelAnsweredAt35s)}`);
console.log('');

console.log('Messages sent to model, in order:');
orderedTexts.forEach((text, index) => {
  const label = text.includes('[Camera frame captured @')
    ? 'camera'
    : text.includes('[User speech @')
      ? 'current-user'
      : text.includes('This answer finished later')
        ? 'late-model-answer'
        : 'system/history';

  console.log(`  [${index}] ${label}: ${text.replace(/\n/g, ' | ')}`);
});
console.log('');

console.log('Assertions:');

console.log(`  camera frame included: ${cameraIndex !== -1}`);
assert.notEqual(cameraIndex, -1, 'camera frame should be included in model messages');

console.log(`  current user speech included: ${userSpeechIndex !== -1}`);
assert.notEqual(userSpeechIndex, -1, 'current user speech should be included in model messages');

console.log(`  late 35s model answer excluded from current request: ${delayedAnswerIndex === -1}`);
assert.equal(delayedAnswerIndex, -1, 'model answer after the current speech end should not be included');

console.log(`  camera index (${cameraIndex}) < user speech index (${userSpeechIndex}): ${cameraIndex < userSpeechIndex}`);
assert.ok(cameraIndex < userSpeechIndex, '30s camera frame must be ordered before 32s user speech');

console.log('');
console.log('timeline-order test passed');
