import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localServerPointerPath, registerLocalServerTask, resolveLocalServerRegistration } from '../../packages/client/src/registration.ts';

/**
 * The publish pointer and the registration entry point.
 *
 * Three host plugins are installed from three different folders; the pointer is what makes them
 * agree on one published Server. Registration itself is only ever started by a person (the
 * settings page button or the install step), so its checks must fail before any prompt.
 */

test('the published pointer is what several host plugins share', () => {
  const root = mkdtempSync(join(tmpdir(), 'mw-pointer-'));
  try {
    mkdirSync(join(root, 'MnemoWeave'), { recursive: true });
    const pointer = join(root, 'MnemoWeave', 'local-server.json');
    writeFileSync(pointer, JSON.stringify({ serverDir: 'D:\\publish', envFile: 'D:\\publish\\.env.local-server', nodeExe: 'C:\\node\\node.exe' }));
    assert.equal(localServerPointerPath({ LOCALAPPDATA: root }), pointer);
    assert.deepEqual(resolveLocalServerRegistration({ LOCALAPPDATA: root }), {
      serverDir: 'D:\\publish', envFile: 'D:\\publish\\.env.local-server', nodeExe: 'C:\\node\\node.exe',
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('explicit environment beats the pointer, and an unusable pointer resolves to nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'mw-pointer-'));
  try {
    assert.deepEqual(resolveLocalServerRegistration({
      LOCALAPPDATA: root, MNEMOWEAVE_SERVER_DIR: ' C:\\published ', MNEMOWEAVE_NODE_EXE: 'C:\\node\\node.exe',
    }), { serverDir: 'C:\\published', envFile: join('C:\\published', '.env.local-server'), nodeExe: 'C:\\node\\node.exe' });

    assert.equal(resolveLocalServerRegistration({ LOCALAPPDATA: root }), undefined);

    mkdirSync(join(root, 'MnemoWeave'), { recursive: true });
    writeFileSync(join(root, 'MnemoWeave', 'local-server.json'), '{ not json');
    assert.equal(resolveLocalServerRegistration({ LOCALAPPDATA: root }), undefined, 'a corrupt pointer is ignored rather than crashing a host');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('registration reports a missing publish before asking for elevation', async () => {
  if (process.platform !== 'win32') return;
  const dir = mkdtempSync(join(tmpdir(), 'mw-register-'));
  try {
    const missingScript = await registerLocalServerTask(
      { serverDir: dir, envFile: join(dir, '.env') },
      { taskExists: async () => false },
    );
    assert.deepEqual(missingScript.result, 'failed');
    assert.match(missingScript.detail ?? '', /registration script not found/);

    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'request-registration-task.ps1'), '');
    const missingEnv = await registerLocalServerTask(
      { serverDir: dir, envFile: join(dir, '.env') },
      { taskExists: async () => false },
    );
    assert.deepEqual(missingEnv.result, 'failed');
    assert.match(missingEnv.detail ?? '', /environment file not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an existing task is reported as already registered without running anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mw-register-'));
  try {
    const outcome = await registerLocalServerTask(
      { serverDir: dir, envFile: join(dir, '.env') },
      { taskExists: async () => true },
    );
    assert.deepEqual(outcome, { result: 'already_registered' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
