import assert from 'node:assert/strict';
import test from 'node:test';
import { extractActionsBlock } from '../src/core/actions.js';
import { BOT_AVATARS, BOT_COLORS } from '../src/core/bots.js';
import { buildTurnPrompt } from '../src/bridge/adapters.js';
import type { Task } from '../src/bridge/types.js';

const parse = (action: unknown) => extractActionsBlock(`Done\n\n\`\`\`swarmaa-actions\n${JSON.stringify([action])}\n\`\`\``);

test('appearance action accepts contract names and rejects malformed or redirected actions', () => {
  for (const avatar of BOT_AVATARS) assert.equal(parse({ type: 'bot_appearance', avatar }).error, undefined);
  for (const color of [...BOT_COLORS, null]) assert.equal(parse({ type: 'bot_appearance', color }).error, undefined);
  for (const fields of [{}, { avatar: 'mark' }, { avatar: 'unknown' }, { avatar: null }, { avatar: 1 },
    { color: 'orange' }, { color: 'green' }, { color: '#9CC8FF' }, { color: false },
    { avatar: 'Scout' }, { avatar: ' scout' }, { color: 'blue', bot_id: 'another-bot' }]) {
    assert.ok(parse({ type: 'bot_appearance', ...fields }).error, JSON.stringify(fields));
  }
});

test('only bot task prompts advertise appearance and all contract names', () => {
  const task = { kind: 'turn', objective: 'Help', bot_id: 'bot-id' } as unknown as Task;
  const prompt = buildTurnPrompt(task, {});
  assert.match(prompt, /bot_appearance/);
  for (const name of [...BOT_AVATARS, ...BOT_COLORS]) assert.ok(prompt.includes(name));
  assert.match(prompt, /runner \(blue, sunglasses/);
  assert.match(prompt, /orange maps to peach, green to lime/);
  assert.doesNotMatch(buildTurnPrompt({ ...task, bot_id: null } as unknown as Task, {}), /bot_appearance|Characters:|Colours:/);
  assert.doesNotMatch(buildTurnPrompt({ instructions: '', messages: [] }), /bot_appearance/);
});
