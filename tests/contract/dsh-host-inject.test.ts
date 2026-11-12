import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../plugins/dsh-mnemo-weave/lib/index.js';

/**
 * The DSH Host half injects the resident rules and nothing else. Working context and formal
 * memories are not part of the injected text: the model reaches memory through the tools.
 */

test('the DSH host bundle renders every resident rule whole, in the injected order', () => {
  const text = render({
    rules: [{ body: '提交前必须运行类型检查。' }, { body: '不得改写架构决策。' }],
    complete: true,
  });
  assert.match(text, /^准则（用户确认，按此执行）：/);
  const positions = ['提交前必须运行类型检查。', '不得改写架构决策。'].map(needle => text.indexOf(needle));
  assert.ok(positions.every(position => position >= 0), text);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  // No block other than the rules is rendered into the prompt.
  assert.doesNotMatch(text, /Working context|Formal memories|Runtime rules/);
});

test('an incomplete or empty delivery renders nothing at all', () => {
  assert.equal(render({ rules: [], complete: true }), '');
  assert.equal(render({}), '');
  // A partial set must not look like the whole set: the host reports the failure instead.
  assert.equal(render({ rules: [{ body: '第一条准则。' }], complete: false, failure: 'output_limit' }), '');
  assert.equal(render({ rules: [{ body: '   ' }, { body: '' }], complete: true }), '');
});

test('a rule body is trimmed at the edges and keeps multi-line text', () => {
  const text = render({ rules: [{ body: '  第一行\n第二行  ' }], complete: true });
  assert.match(text, /- 第一行\n第二行/);
  assert.equal(text.includes('undefined'), false);
});
