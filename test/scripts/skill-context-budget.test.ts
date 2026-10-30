import { describe, expect, it } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'url';

const budgetModule = pathToFileURL(
  path.resolve('scripts', 'benchmark', 'skill-context-budget.mjs'),
).href;

describe('skill context budget', () => {
  it('estimates CJK text per character and other text per 3.8 characters', async () => {
    const { estimateTokens } = await import(budgetModule);

    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(38))).toBe(10);
    expect(estimateTokens('读取当前阶段')).toBe(6);
    expect(estimateTokens(`读取${'a'.repeat(19)}`)).toBe(7);
  });

  it('reads quoted and plain Skill descriptions from frontmatter', async () => {
    const { readSkillDescription } = await import(budgetModule);

    expect(readSkillDescription("---\nname: x\ndescription: 'Use for X.'\n---\nBody")).toBe(
      'Use for X.',
    );
    expect(readSkillDescription('---\ndescription: Plain text\n---\n')).toBe('Plain text');
    expect(readSkillDescription('# No frontmatter')).toBeNull();
  });

  it('reports entries over their ceiling and overrides that are no longer needed', async () => {
    const { checkContextBudgets } = await import(budgetModule);
    const budgets = {
      defaults: { rule: 100, skill: 100, reference: 100, description: 10 },
      overrides: {
        'big.md': 300,
        'shrunk.md': 300,
        'removed.md': 300,
      },
    };
    const entries = [
      { path: 'big.md', kind: 'reference', language: 'en', tokens: 250 },
      { path: 'shrunk.md', kind: 'reference', language: 'en', tokens: 80 },
      { path: 'grew.md', kind: 'skill', language: 'zh', tokens: 140 },
    ];

    const result = checkContextBudgets(entries, budgets);

    expect(result.overBudget.map((entry: { path: string }) => entry.path)).toEqual(['grew.md']);
    expect(result.overBudget[0]).toMatchObject({ budget: 100, tokens: 140 });
    expect(result.staleOverrides).toEqual(['shrunk.md', 'removed.md']);
  });

  it('collects rules, Skill bodies, references, and descriptions for both languages', async () => {
    const { collectContextEntries } = await import(budgetModule);
    const entries: Array<{ path: string; kind: string; language: string }> =
      await collectContextEntries();

    const has = (kind: string, language: string, suffix: string) =>
      entries.some(
        (entry) =>
          entry.kind === kind && entry.language === language && entry.path.endsWith(suffix),
      );
    expect(has('rule', 'en', 'comet-workflow-guard.en.md')).toBe(true);
    expect(has('rule', 'zh', 'comet-workflow-guard.md')).toBe(true);
    expect(has('skill', 'en', 'comet-native/SKILL.md')).toBe(true);
    expect(has('skill', 'zh', 'comet-native/SKILL.md')).toBe(true);
    expect(has('reference', 'en', 'comet-native/reference/commands.md')).toBe(true);
    expect(has('description', 'zh', 'comet-native/SKILL.md#description')).toBe(true);
    expect(entries.some((entry) => entry.path.endsWith('.mjs'))).toBe(false);
  });

  it('keeps shipped agent-facing text within config/skill-context-budgets.json', async () => {
    const { checkContextBudgets, collectContextEntries, readContextBudgets } = await import(
      budgetModule
    );

    const result = checkContextBudgets(await collectContextEntries(), await readContextBudgets());

    // Shrinking a file below its default ceiling should also remove its override.
    expect(result.staleOverrides).toEqual([]);
    expect(
      result.overBudget.map(
        (entry: { path: string; tokens: number; budget: number }) =>
          `${entry.path}: ~${entry.tokens} > ${entry.budget}; shrink it or justify a higher ceiling`,
      ),
    ).toEqual([]);
  });
});
