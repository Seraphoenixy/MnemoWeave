// Build an isolated demo store so the memory page can be exercised with real data.
//
// This never touches the user's real store. It creates `work/demo-store/` with its own Provider
// directory and governance database, publishes a handful of memories through the same code path
// the Server uses, and then prints how to point a Server at it.
//
//   node scripts/seed-demo.mjs            # create or refresh the demo store
//   node scripts/seed-demo.mjs --print    # only print the environment
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RememberInput } from '../packages/core/contracts/src/index.ts';
import { SqliteCandidates } from '../packages/infrastructure/governance/src/index.ts';
import { MnemonCliProvider } from '../packages/providers/mnemon/src/index.ts';
import { mnemonBinary } from '../tests/e2e/mnemon-binary.ts';

const root = resolve('work/demo-store');
const stateDir = join(root, 'state');
const providerDir = join(root, 'provider');
const STORE = 'demo';

function printEnv(port) {
  process.stdout.write([
    '',
    '把下面这些环境变量交给一个独立的 Server 进程（不要覆盖你的真实部署）：',
    '',
    `  $env:MNEMON_DATA_DIR='${providerDir}'`,
    `  $env:MNEMON_STORE='${STORE}'`,
    `  $env:MNEMOWEAVE_STATE_DIR='${stateDir}'`,
    `  $env:MNEMOWEAVE_PORT='${port}'`,
    '  $env:MNEMOWEAVE_TOKEN=$env:MNEMOWEAVE_TOKEN',
    '',
    '然后：node apps/server/src/main.ts',
    '页面把「设置 → 连接」的地址改成同一个端口即可浏览这份演示数据。',
    '',
  ].join('\n'));
}

if (process.argv.includes('--print')) {
  printEnv(process.env.DEMO_PORT ?? '4319');
  process.exit(0);
}

if (existsSync(root)) {
  rmSync(root, { recursive: true, force: true });
  process.stdout.write('已清空旧的演示目录\n');
}
mkdirSync(stateDir, { recursive: true });
mkdirSync(providerDir, { recursive: true });

const repo = new SqliteCandidates(join(stateDir, 'governance.db'));
// Resolved the same way the tests do: on Windows the PATH entry is a .cmd shim that
// `execFile` cannot spawn, so a native executable is required.
const provider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: providerDir, store: STORE });

/** Publish through the same path the Server uses, so the demo data is not a special case. */
async function publish({ content, projectId, knowledgeType, meta, at }) {
  const request = RememberInput.parse({
    idempotencyKey: `demo-${randomUUID()}`,
    content,
    knowledgeType,
    tags: meta.tags ?? [],
    ...(projectId === null ? { scope: 'global' } : { scope: 'project', projectId }),
    provenance: {
      source: 'local-user',
      sourceReference: `demo:${randomUUID().slice(0, 8)}`,
      evidence: ['演示数据，可随时删除'],
      verificationStatus: 'verified',
      confidence: 1,
      applicability: projectId ?? 'global',
      limitations: '仅用于界面演示',
      lastVerified: at,
    },
  });
  const candidate = repo.submit(request);
  const written = await provider.persistReviewed(content, `candidate:${randomUUID()}`);
  repo.catalog.publishSynced(
    randomUUID(), request, written.id, createHash('sha256').update(content).digest('hex'),
    at, 'sync', 'demo revision', meta,
  );
  return written.id;
}

const memories = [
  {
    content: 'MnemoWeave 的记忆页把三类记忆分开呈现：运行时准则、项目档案与正式记忆。正式记忆才可编辑，另外两类只读，避免把「模型要遵守的规则」和「可纠正的事实」混在一起。',
    projectId: null, knowledgeType: 'Architecture',
    meta: { category: 'decision', importance: 5, tags: ['架构', '记忆界面'], entities: ['MnemoWeave'] },
    at: '2026-11-01T09:10:00.000Z',
  },
  {
    content: '编辑正式记忆必须携带打开编辑器时的 entryVersion 作为基准。服务端不得把它补成本机最新版本，否则会静默覆盖另一台机器的修改。',
    projectId: null, knowledgeType: 'Constraint',
    meta: { category: 'decision', importance: 5, tags: ['并发', '编辑'], entities: ['MnemoWeave', 'DSH'] },
    at: '2026-11-02T10:20:00.000Z',
  },
  {
    content: '撤回不是删除：它新增一个撤回版本，停止被召回与注入，但历史正文仍然可读。用 forget 会连带抹掉指向它的关系，破坏「撤回后仍可追溯」的承诺。',
    projectId: null, knowledgeType: 'Practice',
    meta: { category: 'decision', importance: 4, tags: ['撤回', '审计'], entities: ['MnemoWeave'] },
    at: '2026-11-03T11:30:00.000Z',
  },
  {
    content: '探索页按 Provider 自身的相似度排序，所以必须有一个相似度门槛：实测完全不相关的查询也会拿到 0.3 分，没有门槛时排序列表会被误读成答案。',
    projectId: 'mnemoweave', knowledgeType: 'Practice',
    meta: { category: 'insight', importance: 4, tags: ['检索', '探索'], entities: ['MnemoWeave'] },
    at: '2026-11-04T09:00:00.000Z',
  },
  {
    content: '图谱只返回结构，不返回正文。每个节点都去读正文意味着几百次 CLI 进程，而画布的节点标签可以由渲染层按需解析它真正显示的节点。',
    projectId: 'mnemoweave', knowledgeType: 'Architecture',
    meta: { category: 'decision', importance: 3, tags: ['图谱', '性能'], entities: ['MnemoWeave'] },
    at: '2026-11-05T14:45:00.000Z',
  },
  {
    content: 'DSH 宿主插件在启动时读取 profile 与用户环境变量，两处都缺令牌时页面显示「未配置」而不是假装可用。改令牌后需要重启 DSH，因为进程只在启动时读环境。',
    projectId: 'mnemoweave', knowledgeType: 'Troubleshooting',
    meta: { category: 'fact', importance: 3, tags: ['配置', 'DSH'], entities: ['DSH'] },
    at: '2026-11-06T08:15:00.000Z',
  },
  {
    content: '候选审核边界：模型输出只能成为候选，不能直接写入正式记忆；人工编辑则走 PATCH 追加不可变 Revision。两条路径的差别是「谁声称这是事实」。',
    projectId: null, knowledgeType: 'Concept',
    meta: { category: 'preference', importance: 4, tags: ['治理', '审核'], entities: ['MnemoWeave'] },
    at: '2026-11-07T16:00:00.000Z',
  },
  {
    content: '同步以范围为单位：global 或 project:<id>。游标、快照与设备授权都按范围，禁止用全局游标跨项目推进，也禁止用按项目快照的 nextSince 推进全局游标。',
    projectId: null, knowledgeType: 'Constraint',
    meta: { category: 'context', importance: 3, tags: ['同步'], entities: ['MnemoWeave'] },
    at: '2026-11-08T13:20:00.000Z',
  },
];

const published = [];
for (const memory of memories) {
  published.push(await publish(memory));
  process.stdout.write(`已发布：${memory.content.slice(0, 24)}…\n`);
}

// One memory gets a second version, so the detail view has a revision chain and a supersede edge
// to draw in the graph.
const evolved = memories[0];
const firstId = published[0];
const second = await publish({
  content: `${evolved.content}\n\n补充：分类信息（知识类型、分类、重要度、标签、实体）随 Revision 一起保存，未记录的字段保持缺失而不是被填成默认值。`,
  projectId: null,
  knowledgeType: 'Architecture',
  meta: { category: 'decision', importance: 5, tags: ['架构', '记忆界面', '分类'], entities: ['MnemoWeave'] },
  at: '2026-11-09T10:00:00.000Z',
});
void firstId;
void second;

repo.close();

writeFileSync(join(root, 'README.txt'), [
  '演示数据。用 scripts/seed-demo.mjs 重新生成。',
  '这份目录与真实部署完全隔离，可以随时整体删除。',
  '',
  `provider: ${providerDir}`,
  `state:    ${stateDir}`,
  `store:    ${STORE}`,
  '',
].join('\n'));

process.stdout.write(`\n演示库已生成：${root}\n共 ${published.length + 1} 条记忆（含 1 条第二版）\n`);
printEnv(process.env.DEMO_PORT ?? '4319');
