/**
 * Automatic skill adoption, off by default.
 *
 * Adoption is only allowed when the paired backtest is complete and fresh, the file still has the
 * reviewed baseline, no check regressed, and every check passed. Anything unmeasured or unclear
 * stays pending for the user.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillBacktestResult, SkillBacktestSide } from '../shared/contract.ts';
import { adoptSkill, skillStateDir, type SkillVersion } from './skills-write.ts';

export const MAX_BACKTEST_AGE_MS = 24 * 60 * 60 * 1000;

/** A review coming back from the page is checked before it can influence a write. */
export function parseAdoptionReview(value: unknown): AdoptionReview | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as { report?: unknown; checks?: unknown; completedAt?: unknown };
  if (typeof input.completedAt !== 'string' || !Array.isArray(input.checks) || input.checks.some(check => typeof check !== 'string')) return null;
  if (typeof input.report !== 'object' || input.report === null) return null;
  const report = input.report as { baseline?: unknown; candidate?: unknown; regressions?: unknown };
  const side = (candidate: unknown): SkillBacktestSide | null => {
    if (typeof candidate !== 'object' || candidate === null) return null;
    const { answer, steps, checks } = candidate as { answer?: unknown; steps?: unknown; checks?: unknown };
    if (typeof answer !== 'string' || typeof steps !== 'string' || !Array.isArray(checks)) return null;
    const verdicts: Array<{ passed: boolean; reason: string }> = [];
    for (const check of checks) {
      if (typeof check !== 'object' || check === null) return null;
      const { passed, reason } = check as { passed?: unknown; reason?: unknown };
      if (typeof passed !== 'boolean' || typeof reason !== 'string') return null;
      verdicts.push({ passed, reason });
    }
    return { answer, steps, checks: verdicts };
  };
  const baseline = side(report.baseline);
  const drafted = side(report.candidate);
  if (baseline === null || drafted === null || !Array.isArray(report.regressions) || report.regressions.some(item => typeof item !== 'string')) return null;
  return { report: { baseline, candidate: drafted, regressions: report.regressions as string[] }, checks: input.checks, completedAt: input.completedAt };
}

export interface AdoptionReview {
  report: SkillBacktestResult;
  checks: string[];
  completedAt: string;
}

export interface AdoptionDecision {
  adopt: boolean;
  reason: 'eligible' | 'disabled' | 'no-baseline' | 'baseline-changed' | 'no-backtest'
    | 'incomplete-backtest' | 'stale-backtest' | 'regressions' | 'failed-check';
}

export interface SkillsPreferences { autoAdopt: boolean }

export function adoptionDecision(input: {
  enabled: boolean;
  hasBaseline: boolean;
  baselineChanged: boolean;
  review: AdoptionReview | null;
  now: string;
  maxAgeMs?: number;
}): AdoptionDecision {
  if (!input.enabled) return { adopt: false, reason: 'disabled' };
  if (!input.hasBaseline) return { adopt: false, reason: 'no-baseline' };
  if (input.baselineChanged) return { adopt: false, reason: 'baseline-changed' };
  if (input.review === null) return { adopt: false, reason: 'no-backtest' };
  const { report, checks, completedAt } = input.review;
  if (report.baseline.checks.length !== checks.length || report.candidate.checks.length !== checks.length) {
    return { adopt: false, reason: 'incomplete-backtest' };
  }
  const completed = Date.parse(completedAt);
  const now = Date.parse(input.now);
  if (!Number.isFinite(completed) || !Number.isFinite(now) || now - completed > (input.maxAgeMs ?? MAX_BACKTEST_AGE_MS) || completed > now) {
    return { adopt: false, reason: 'stale-backtest' };
  }
  if (report.regressions.length > 0) return { adopt: false, reason: 'regressions' };
  if (report.candidate.checks.some(check => !check.passed)) return { adopt: false, reason: 'failed-check' };
  return { adopt: true, reason: 'eligible' };
}

export async function readSkillPreferences(stateDir: string = skillStateDir()): Promise<SkillsPreferences> {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, 'preferences.json'), 'utf8')) as Partial<SkillsPreferences>;
    return { autoAdopt: parsed.autoAdopt === true };
  } catch {
    return { autoAdopt: false };
  }
}

export async function saveSkillPreferences(input: { autoAdopt: boolean }, stateDir: string = skillStateDir()): Promise<SkillsPreferences> {
  const preferences: SkillsPreferences = { autoAdopt: input.autoAdopt === true };
  await mkdir(stateDir, { recursive: true });
  const temporary = join(stateDir, `preferences.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
  await rename(temporary, join(stateDir, 'preferences.json'));
  return preferences;
}

export async function autoAdoptSkill(input: {
  workspace: string; path: string; candidate: string; baselineHash: string;
  review: AdoptionReview | null; home?: string; stateDir?: string; now?: string; enabled?: boolean;
}): Promise<{ adopted: boolean; reason: AdoptionDecision['reason']; hash?: string; version?: SkillVersion }> {
  const stateDir = input.stateDir ?? skillStateDir();
  const preferences = await readSkillPreferences(stateDir);
  const enabled = input.enabled ?? preferences.autoAdopt;
  let current = '';
  let exists = false;
  try {
    current = await readFile(input.path, 'utf8');
    exists = true;
  } catch { /* no baseline means nothing to update */ }
  const decision = adoptionDecision({
    enabled,
    hasBaseline: exists,
    baselineChanged: exists && createHash('sha256').update(current).digest('hex') !== input.baselineHash,
    review: input.review,
    now: input.now ?? new Date().toISOString(),
  });
  if (!decision.adopt) return { adopted: false, reason: decision.reason };
  const written = await adoptSkill({ workspace: input.workspace, path: input.path, candidate: input.candidate, baselineHash: input.baselineHash, ...(input.home === undefined ? {} : { home: input.home }), stateDir });
  return { adopted: true, reason: decision.reason, hash: written.hash, version: written.version };
}
