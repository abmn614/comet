import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../..');
const BUDGET_FILE = path.join(REPO_ROOT, 'config', 'skill-context-budgets.json');
const SCHEMA = 'comet.skill-context-budgets.v1';
const KINDS = ['rule', 'skill', 'reference', 'description'];

// Wide CJK script and punctuation ranges; these tokenize at roughly one token per character.
const WIDE_CHARACTER = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/gu;
const OTHER_CHARACTERS_PER_TOKEN = 3.8;

/**
 * Heuristic token estimate for agent-facing text. It is not a real tokenizer:
 * budgets built on it are regression ceilings, not exact counts.
 */
export function estimateTokens(text) {
  const characters = Array.from(text).length;
  const wide = text.match(WIDE_CHARACTER)?.length ?? 0;
  return Math.ceil(wide + (characters - wide) / OTHER_CHARACTERS_PER_TOKEN);
}

export function readSkillDescription(content) {
  const frontmatter = content.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!frontmatter) return null;
  const line = frontmatter[1].split(/\r?\n/u).find((entry) => /^description\s*:/u.test(entry));
  if (!line) return null;
  const value = line.slice(line.indexOf(':') + 1).trim();
  const quoted = value.match(/^(['"])([\s\S]*)\1$/u);
  return quoted ? quoted[2] : value;
}

function skillContextKind(relativePath) {
  if (path.posix.basename(relativePath) === 'SKILL.md') return 'skill';
  if (relativePath.split('/').includes('reference')) return 'reference';
  return null;
}

function ruleLanguage(relativePath, languages) {
  return /\.en\.md$/u.test(relativePath) ? 'en' : (languages.default ?? 'zh');
}

async function readOptional(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Collects every shipped piece of agent-facing text that a host loads into
 * context: always-on rules, SKILL.md bodies, reference documents, and the
 * Skill descriptions hosts list in every session.
 */
export async function collectContextEntries(repoRoot = REPO_ROOT) {
  const layout = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'config', 'repository-layout.json'), 'utf8'),
  );
  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, layout.manifestPath), 'utf8'));
  const roots = layout.skillsRoots;
  const entries = [];

  for (const rule of manifest.rules ?? []) {
    const file = path.posix.join(roots.en, rule);
    const content = await readOptional(path.join(repoRoot, file));
    if (content === null) continue;
    entries.push({
      path: file,
      kind: 'rule',
      language: ruleLanguage(rule, manifest.languages ?? {}),
      tokens: estimateTokens(content),
    });
  }

  for (const [language, root] of Object.entries(roots)) {
    for (const skillFile of manifest.skills ?? []) {
      const kind = skillContextKind(skillFile);
      if (!kind) continue;
      const file = path.posix.join(root, skillFile);
      const content = await readOptional(path.join(repoRoot, file));
      if (content === null) continue;
      entries.push({ path: file, kind, language, tokens: estimateTokens(content) });
      if (kind !== 'skill') continue;
      const description = readSkillDescription(content);
      if (description !== null) {
        entries.push({
          path: `${file}#description`,
          kind: 'description',
          language,
          tokens: estimateTokens(description),
        });
      }
    }
  }

  return entries.sort((left, right) => right.tokens - left.tokens);
}

export async function readContextBudgets(file = BUDGET_FILE) {
  const budgets = JSON.parse(await fs.readFile(file, 'utf8'));
  if (budgets.schema !== SCHEMA) {
    throw new Error(`${path.basename(file)} must declare schema ${SCHEMA}`);
  }
  for (const kind of KINDS) {
    if (!Number.isInteger(budgets.defaults?.[kind]) || budgets.defaults[kind] <= 0) {
      throw new Error(`${path.basename(file)} needs a positive integer default for "${kind}"`);
    }
  }
  return budgets;
}

export function budgetFor(entry, budgets) {
  return budgets.overrides?.[entry.path] ?? budgets.defaults[entry.kind];
}

/**
 * Returns entries above their ceiling, plus overrides that no longer match a
 * shipped file or are no longer needed because the file fits the default.
 */
export function checkContextBudgets(entries, budgets) {
  const overBudget = entries
    .map((entry) => ({ ...entry, budget: budgetFor(entry, budgets) }))
    .filter((entry) => entry.tokens > entry.budget);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const staleOverrides = Object.keys(budgets.overrides ?? {}).filter((overridePath) => {
    const entry = byPath.get(overridePath);
    return !entry || entry.tokens <= budgets.defaults[entry.kind];
  });
  return { overBudget, staleOverrides };
}

export function summarizeContextEntries(entries) {
  const totals = {};
  for (const entry of entries) {
    const key = `${entry.language}:${entry.kind}`;
    totals[key] = (totals[key] ?? 0) + entry.tokens;
  }
  return totals;
}

function formatReport(entries, budgets, result, top) {
  const lines = ['Estimated agent-facing context tokens (heuristic, not a tokenizer)', ''];
  for (const entry of entries.slice(0, top)) {
    const budget = budgetFor(entry, budgets);
    const marker = entry.tokens > budget ? '  OVER' : '';
    lines.push(
      `${String(entry.tokens).padStart(7)} / ${String(budget).padEnd(6)} ${entry.kind.padEnd(11)} ${entry.path}${marker}`,
    );
  }
  lines.push('', 'Totals by language and kind:');
  for (const [key, value] of Object.entries(summarizeContextEntries(entries)).sort()) {
    lines.push(`  ${key.padEnd(18)} ${value}`);
  }
  for (const entry of result.overBudget) {
    lines.push(`OVER BUDGET: ${entry.path} is ~${entry.tokens} tokens (ceiling ${entry.budget})`);
  }
  for (const overridePath of result.staleOverrides) {
    lines.push(`STALE OVERRIDE: ${overridePath} is missing or fits its default ceiling`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  const json = argv.includes('--json');
  const topIndex = argv.indexOf('--top');
  const top = topIndex >= 0 ? Number(argv[topIndex + 1]) : 25;
  const entries = await collectContextEntries();
  const budgets = await readContextBudgets();
  const result = checkContextBudgets(entries, budgets);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ entries, totals: summarizeContextEntries(entries), ...result }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(formatReport(entries, budgets, result, top));
  }
  return result.overBudget.length || result.staleOverrides.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
