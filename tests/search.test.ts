import { expect, test } from 'claude-code/testing';
import { candidateJQL, mergeIssues, rankIssues } from '../hooks/search.ts';
import type { Issue } from '../hooks/model.ts';

const issue = (key: string, summary: string, site = 'example.atlassian.net'): Issue => ({
  key, summary, site, status: 'Open', browse_url: `https://${site}/browse/${key}`,
});
const picker = issue('AT-42', 'Ship ticket picker');
const unrelated = issue('AT-99', 'Rotate database credentials');

test('fuzzy matching handles typos, transpositions, abbreviations, partial keys and reordered words', () => {
  for (const query of ['tikcet pcker', 'pikr', 'pikcer', 'pkr tkt', 'picker ship', 'at42', 'AT-4']) {
    expect(rankIssues(query, [unrelated, picker])).toEqual([picker]);
  }
  expect(rankIssues('crème', [issue('AT-1', 'Creme checkout')])).toHaveLength(1);
  expect(rankIssues('xyzzy', [picker, unrelated])).toHaveLength(0);
});

test('exact matches rank ahead of approximate ones and Jira description matches remain available', () => {
  const approximate = issue('AT-3', 'Ship ticket piker');
  expect(rankIssues('picker', [approximate, picker])[0]).toEqual(picker);
  expect(rankIssues('picker', [picker], [unrelated])).toEqual([picker, unrelated]);
});

test('candidate merging preserves site identity and updates cached ticket data', () => {
  const updated = { ...picker, status: 'Done' };
  const otherSite = issue(picker.key, 'Another ticket', 'another.atlassian.net');
  expect(mergeIssues([picker], [updated, otherSite])).toEqual([updated, otherSite]);
});

test('Jira candidate queries use only word prefixes and cannot accept injected JQL', () => {
  expect(candidateJQL('ticket picker')).toBe('(summary ~ "ti*" OR summary ~ "pi*") ORDER BY updated DESC');
  expect(candidateJQL('" OR project = SECRET')).toBe('(summary ~ "or*" OR summary ~ "pr*" OR summary ~ "se*") ORDER BY updated DESC');
  expect(candidateJQL('!')).toBe('');
});
