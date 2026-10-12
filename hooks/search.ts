import { ticketID } from './model.ts';
import type { Issue } from './model.ts';

function normalize(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function terms(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

// One insertion, deletion, substitution, or adjacent transposition.
function near(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) ||
    (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function subsequence(needle: string, word: string): boolean {
  if (needle.length < 2) return false;
  let i = 0;
  for (const letter of word) if (letter === needle[i]) i++;
  return i === needle.length;
}

function score(query: string, issue: Issue): number {
  const key = normalize(issue.key).replace(/[^a-z0-9]/g, '');
  const summary = normalize(issue.summary);
  const words = terms(issue.summary);
  let total = 0;
  for (const term of terms(query)) {
    let value = key === term ? 500 : key.startsWith(term) ? 300 : key.includes(term) ? 250 : 0;
    if (words.some(word => word.startsWith(term))) value = Math.max(value, 150);
    else if (summary.includes(term)) value = Math.max(value, 100);
    else if (term.length >= 4 && words.some(word => near(term, word))) value = Math.max(value, 60);
    else if (words.some(word => subsequence(term, word)) || subsequence(term, key)) value = Math.max(value, 30);
    if (!value) return 0;
    total += value;
  }
  return total;
}

export function mergeIssues(...groups: Issue[][]): Issue[] {
  const issues = new Map<string, Issue>();
  for (const group of groups) for (const issue of group) issues.set(ticketID(issue), issue);
  return [...issues.values()];
}

export function rankIssues(query: string, candidates: Issue[], remote: Issue[] = []): Issue[] {
  const remoteIDs = new Set(remote.map(ticketID));
  return mergeIssues(candidates, remote).map(issue => ({ issue, score: score(query, issue) || (remoteIDs.has(ticketID(issue)) ? 1 : 0) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score).map(item => item.issue);
}

// Jira Cloud no longer supports typo operators. Broaden candidate discovery
// with safe word prefixes, then apply the same local fuzzy ranking.
export function candidateJQL(query: string): string {
  const prefixes = [...new Set(terms(query).filter(term => term.length >= 2).slice(0, 6).map(term => term.slice(0, 2)))];
  return prefixes.length ? `(${prefixes.map(prefix => `summary ~ "${prefix}*"`).join(' OR ')}) ORDER BY updated DESC` : '';
}
