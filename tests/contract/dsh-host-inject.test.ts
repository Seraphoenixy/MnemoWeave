import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../plugins/dsh-mnemo-weave/lib/index.js';

/** The DSH Host half must inject the same block order and budget note as the shared renderer. */

test('the DSH host bundle renders rules first, then working context, then memories', () => {
  const text = render({
    rules: [{ body: '提交前必须运行类型检查。' }],
    workingContext: [{ text: 'Working note.' }],
    memories: [{ content: 'Formal memory.', scope: 'project' }],
  });
  const positions = ['Runtime rules', '提交前必须运行类型检查。', 'Working context', 'Formal memories'].map(needle => text.indexOf(needle));
  assert.ok(positions.every(position => position >= 0), text);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test('an omitted rule budget is named and empty views render nothing', () => {
  const omitted = render({ rules: [], rulesBudget: { exceeded: true }, memories: [{ content: 'memory' }] });
  assert.match(omitted, /Runtime rules were omitted: the budget was exceeded\./);
  assert.equal(render({}), '');
  assert.equal(render({ rules: [{ body: '   ' }], workingContext: [{ text: '' }], memories: [] }), '');
});

test('memory rows keep their scope and excerpt marker', () => {
  const text = render({ memories: [{ content: 'global one', scope: 'global' }, { content: 'excerpt one', scope: 'project', excerpt: true }] });
  assert.match(text, /- \(global\) global one/);
  assert.match(text, /- \(project\) excerpt one \[excerpt\]/);
});
