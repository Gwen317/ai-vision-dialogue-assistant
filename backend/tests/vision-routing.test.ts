import assert from 'node:assert/strict';
import { needsVisionInput, buildTimelineMessages } from '../../dialogue/model_router/ModelRouter';
import type { TimelineEvent } from '../../dialogue/gateway_core/SocketGateway';

function hasImagePart(message: any): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some((part: any) => part.type === 'image_url');
}

// Creative / conversational requests should NOT trigger vision
assert.equal(needsVisionInput('请你给我讲一个五十字的小作文儿'), false);
assert.equal(needsVisionInput('你给我讲一个一百字的小作文'), false);
assert.equal(needsVisionInput('你给我讲一个二百字的小故事'), false);
assert.equal(needsVisionInput('讲个笑话'), false);

// Explicit vision requests SHOULD trigger vision
assert.equal(needsVisionInput('帮我看看这是什么'), true);
assert.equal(needsVisionInput('画面里有什么'), true);
assert.equal(needsVisionInput('请帮我记住画面中出现的人物'), true);

const base = Date.UTC(2026, 5, 12, 10, 0, 0);
const timeline: TimelineEvent[] = [
  {
    type: 'image',
    timestamp: base + 1000,
    imageBase64: 'mock-image'
  }
];

const withImage = buildTimelineMessages({
  systemInstruction: 'system',
  userSpeech: '帮我看看这是什么',
  timeline,
  turnTiming: { speechStartedAt: base + 2000, speechEndedAt: base + 3000 },
  includeImage: true
});
const userMsgWithImage = withImage.messages.at(-1);
assert.ok(userMsgWithImage && hasImagePart(userMsgWithImage), 'vision turn should attach image');

const withoutImage = buildTimelineMessages({
  systemInstruction: 'system',
  userSpeech: '你给我讲一个一百字的小作文',
  timeline,
  turnTiming: { speechStartedAt: base + 2000, speechEndedAt: base + 3000 },
  includeImage: false
});
const userMsgNoImage = withoutImage.messages.at(-1);
assert.ok(userMsgNoImage && !hasImagePart(userMsgNoImage), 'non-vision turn should omit image');

console.log('vision-routing test passed');
