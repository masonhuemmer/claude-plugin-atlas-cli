import { expect, mock, test } from 'claude-code/testing';
import type { On } from 'claude-code';
import { empty, readIssue, ticketID } from '../hooks/model.ts';
import type { Issue } from '../hooks/model.ts';

const ISSUE: Issue = {
  key: 'AT-42', site: 'example.atlassian.net', browse_url: 'https://example.atlassian.net/browse/AT-42',
  summary: 'Ship ticket picker', description: 'Attach tickets and preserve their outcome.', status: 'Open',
  updated: '2026-10-12T10:00:00Z', comments: ['Acceptance: picker works in terminal.'],
  links: [{ type: 'Relates', inward: 'AT-41', outward: '' }],
};
const ID = ticketID(ISSUE);
const PANE = {
  plugin: 'atlas-tickets', component: 'Pane', requestId: 'atlas-tickets', surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: { title: 'Atlas Tickets', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const;

function fixture(on: On) {
  const f = {
    session: 'session-a', issue: { ...ISSUE }, saved: new Map<string, unknown>(), files: new Map<string, string>(),
    agent: {} as Record<string, unknown>, commands: [] as string[][], spawns: [] as Record<string, unknown>[], failGet: false,
    failWrite: false, failTransition: false, transitionStatus: 'In Progress', gitDiff: '',
    searchItems: undefined as Issue[] | undefined, suggestions: undefined as Issue[] | undefined,
    discovered: undefined as Issue[] | undefined,
    clock: mock.clock(on, { now: 1791800000000 }),
    suggestDelay: {} as Record<string, number>, suggestResults: {} as Record<string, Issue[]>,
  };
  on('session.id', () => ({ value: f.session }));
  on('session.cwd', () => ({ value: '/repo' }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('classic.SessionStart', () => ({}));
  on('agent.list', () => ({ value: [] }));
  on('agent.register', ($, e) => { f.agent = e; return { value: { agent: 'atlas-tickets:researcher' } }; });
  // Claude Code 2.1.296's test bridge reads both the event and Agent-tool result.
  on('agent.spawn', ($, e) => { f.spawns.push(e); return { model: 'haiku', agentId: `research-${f.spawns.length}`, result: { status: 'async_launched', agentId: `research-${f.spawns.length}`, resolvedModel: 'haiku' } }; });
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('env.get', () => ({ value: '/home/test' }));
  on('store.get', ($, e) => ({ value: f.saved.get(e.key) }));
  on('store.set', ($, e) => { f.saved.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined }; });
  on('fs.exists', () => ({ value: false }));
  on('fs.read', ($, e) => ({ value: f.files.get(e.path) ?? 'export const ticket = 42;\n' }));
  on('fs.write', ($, e) => { if (f.failWrite) throw new Error('Disk full'); f.files.set(e.path, e.text); return { value: undefined }; });
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('ui.close', () => ({ value: undefined }));
  on('ui.toast', () => ({ value: undefined }));
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }));
  on('turn.start', ($, e) => ({ turnId: e.turnId }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  on('process.run', async ($, e) => {
    const argv = [...e.argv]; f.commands.push(argv);
    const ok = (value: unknown) => ({ value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stdout: JSON.stringify(value), stderr: '' } });
    if (argv[0] === 'git') return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stdout: argv[1] === 'diff' ? f.gitDiff : 'abc123', stderr: '' } };
    if (argv[0] === 'rg') return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 0, stdout: 'src/picker.ts\nREADME.md\n', stderr: '' } };
    if (argv[2] === 'get') return f.failGet ? { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 5, stdout: '', stderr: 'Jira unavailable' } } : ok({ ...f.issue, key: argv[3], browse_url: `https://${f.issue.site}/browse/${argv[3]}` });
    if (argv[2] === 'suggest') {
      const items = f.suggestResults[argv[4]] ?? f.suggestions ?? [f.issue];
      if (f.suggestDelay[argv[4]]) await f.clock.sleep(f.suggestDelay[argv[4]]);
      return ok({ items });
    }
    if (argv[2] === 'search') return ok({ items: argv[4]?.startsWith('(summary') ? f.discovered ?? f.searchItems ?? [f.issue] : f.searchItems ?? [f.issue] });
    if (argv[2] === 'boards') return ok([{ id: 7, name: 'Product' }]);
    if (argv[2] === 'board') return ok({ schema_version: 1, board_id: 7, board_name: 'Product', state: 'in_column', column: f.issue.status === 'Open' ? 'Backlog' : 'Doing', status: f.issue.status, on_board: true });
    if (argv[2] === 'transitions') return ok({ items: [{ id: '21', name: 'Start work', to_status: f.transitionStatus, column: 'Doing' }] });
    if (argv[2] === 'transition') {
      if (f.failTransition) return { value: { isStdoutTruncated: false, isStderrTruncated: false, exitCode: 5, stdout: '', stderr: 'Timed out' } };
      f.issue = { ...f.issue, status: 'In Progress', updated: '2026-10-12T11:00:00Z' };
      return ok({ ok: true });
    }
    throw new Error(`Unexpected process: ${argv.join(' ')}`);
  });
  return f;
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const;
const completion = (agentId: string | undefined, answer = '## Findings\nThe picker lives in src/picker.ts:1.') => ({
  answer, durationMs: 10, isAborted: false, reason: 'answer', turnId: agentId ? 'research-turn' : 'main-turn', ...(agentId ? { agentId } : {}),
} as const);

test('fuzzy search filters while typing and keeps typo matches when Jira suggestions miss', async ($, on) => {
  const f = fixture(on);
  const other = { ...ISSUE, key: 'AT-99', browse_url: 'https://example.atlassian.net/browse/AT-99', summary: 'Rotate database credentials' };
  f.searchItems = [other, ISSUE]; f.suggestions = [];
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: '' });
  const ui = await $.ui.mount(PANE);
  const reads = f.commands.length;
  await ui.input({ key: 'search', text: 'tikcet pcker', kind: 'change' });
  expect(await ui.find({ key: `attach-${ticketID(other)}` })).toBeUndefined();
  expect(await ui.find({ key: `attach-${ID}` })).toBeDefined();
  expect(f.commands).toHaveLength(reads);
  await ui.input({ key: 'search', text: 'tikcet pcker' });
  expect(await ui.find({ key: `attach-${ID}` })).toBeDefined();
});

test('attaching opens a focused ticket view with status controls instead of search results', async ($, on) => {
  fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: '' });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: `attach-${ID}` });
  expect(await ui.find({ key: 'search' })).toBeUndefined();
  expect(await ui.find({ key: `attach-${ID}` })).toBeUndefined();
  expect(await ui.find({ key: 'status', text: /Change status/ })).toBeDefined();
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: '' });
  expect(await ui.find({ key: 'search' })).toBeUndefined();
  expect((await ui.find({ key: 'status' }))?.props.hotkey).toBe('s');
  await ui.press({ key: 'status' });
  expect(await ui.find({ key: 'transition' })).toBeDefined();
});

test('Enter discovers and fuzzy ranks tickets outside the recent cache', async ($, on) => {
  const f = fixture(on);
  f.searchItems = []; f.suggestions = []; f.discovered = [ISSUE];
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: '' });
  const ui = await $.ui.mount(PANE);
  await ui.input({ key: 'search', text: 'tikcet pcker', kind: 'change' });
  expect(await ui.find({ key: `attach-${ID}` })).toBeUndefined();
  await ui.input({ key: 'search', text: 'tikcet pcker' });
  expect(await ui.find({ key: `attach-${ID}` })).toBeDefined();
  expect(f.commands.some(a => a[2] === 'search' && a[4].includes('summary ~ "ti*"'))).toBe(true);
});

test('typing automatically discovers Jira matches after a short debounce without Enter', async ($, on) => {
  const f = fixture(on);
  f.searchItems = []; f.suggestions = []; f.discovered = [ISSUE];
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: '' });
  const ui = await $.ui.mount(PANE);
  await ui.input({ key: 'search', text: 'tikcet pcker', kind: 'change' });
  await f.clock.advance(299);
  expect(f.commands.filter(a => a[2] === 'suggest')).toHaveLength(0);
  await f.clock.advance(1);
  expect(await ui.find({ key: `attach-${ID}` })).toBeDefined();
  expect(f.commands.filter(a => a[2] === 'suggest')).toHaveLength(1);
});

test('newer search results survive a late response for older text', async ($, on) => {
  const f = fixture(on);
  const other = { ...ISSUE, key: 'AT-99', browse_url: 'https://example.atlassian.net/browse/AT-99', summary: 'Operations follow-up' };
  f.searchItems = []; f.discovered = []; f.suggestResults = { picker: [ISSUE], database: [other] };
  f.suggestDelay.picker = 1000;
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: '' });
  const ui = await $.ui.mount(PANE);
  await ui.input({ key: 'search', text: 'picker', kind: 'change' });
  await f.clock.advance(300);
  await ui.input({ key: 'search', text: 'database', kind: 'change' });
  await f.clock.advance(300);
  expect(await ui.find({ key: `attach-${ticketID(other)}` })).toBeDefined();
  await f.clock.advance(700);
  expect(await ui.find({ key: `attach-${ticketID(other)}` })).toBeDefined();
  expect(await ui.find({ key: `attach-${ID}` })).toBeUndefined();
});

test('rapid edits debounce to one lookup and Enter flushes a pending lookup exactly once', async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: '' });
  const ui = await $.ui.mount(PANE);
  for (const text of ['p', 'pi', 'pic', 'picker']) {
    await ui.input({ key: 'search', text, kind: 'change' });
    await f.clock.advance(100);
  }
  expect(f.commands.filter(a => a[2] === 'suggest')).toHaveLength(0);
  await f.clock.advance(200);
  expect(f.commands.filter(a => a[2] === 'suggest').map(a => a[4])).toEqual(['picker']);
  await ui.input({ key: 'search', text: 'ship picker', kind: 'change' });
  await ui.input({ key: 'search', text: 'ship picker' });
  await f.clock.advance(300);
  expect(f.commands.filter(a => a[2] === 'suggest').map(a => a[4])).toEqual(['picker', 'ship picker']);
});

test('clearing the field, opening settings and closing the pane cancel pending searches', async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: '' });
  const ui = await $.ui.mount(PANE);
  await ui.input({ key: 'search', text: 'picker', kind: 'change' });
  await ui.input({ key: 'search', text: '', kind: 'change' });
  await f.clock.advance(300);
  expect(f.commands.filter(a => a[2] === 'suggest')).toHaveLength(0);
  await ui.input({ key: 'search', text: 'picker', kind: 'change' });
  await ui.press({ key: 'settings' });
  await f.clock.advance(300);
  expect(f.commands.filter(a => a[2] === 'suggest')).toHaveLength(0);
  await ui.press({ key: 'add-ticket' });
  await ui.press({ key: 'close' });
  await f.clock.advance(300);
  expect(f.commands.filter(a => a[2] === 'suggest')).toHaveLength(0);
});

test('picker attaches an outcome and Haiku creates a durable brief for the main agent', async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: 'AT-42' });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: 'settings' });
  await ui.input({ key: 'outcome', text: 'Implement ticket attachments' });
  await ui.press({ key: 'add-ticket' });
  await ui.press({ key: `attach-${ID}` });
  expect(f.spawns[0].model).toBe('haiku');
  expect(f.spawns[0].subagent_type).toBe('atlas-tickets:researcher');
  expect(await ui.find({ type: 'Text', text: 'Research: researching' })).toBeDefined();
  expect(f.agent.tools).toEqual(['Read', 'Glob', 'Grep']);
  expect(f.agent.maxTurns).toBe(10);
  expect(f.spawns[0].prompt).toContain('Linked ticket snapshots');
  expect(f.spawns[0].prompt).toContain('https://example.atlassian.net/browse/AT-41');
  await $.turn.complete(completion('research-1'));
  expect(await ui.find({ type: 'Text', text: 'Research: ready' })).toBeDefined();
  expect([...f.files.values()][0]).toContain('Outcome: Implement ticket attachments');
  expect([...f.files.keys()][0]).toContain('/home/test/.work/repo/atlas-tickets/session-a/');
  const prompt = await $.prompt.submit({ text: 'Implement it', wait: false, origin: { kind: 'composer' } });
  expect(prompt.context?.join('\n')).toContain('Research brief: /home/test/.work/repo/');
  await $.turn.start({ text: 'Implement it', turnId: 'main-turn' });
  await ui.press({ key: 'view-brief' });
  expect(await ui.find({ type: 'Markdown' })).toBeDefined();
});

test('status picker previews a real transition and applies its id only after Apply', async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: '' });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: `attach-${ID}` });
  await ui.press({ key: 'details' });
  await ui.press({ key: 'boards' });
  await ui.select({ key: 'board', value: '7' });
  await ui.press({ key: 'status' });
  await ui.select({ key: 'transition', value: '21' });
  expect(f.commands.filter(a => a[2] === 'transition')).toHaveLength(0);
  expect(await ui.find({ type: 'Text', text: /Apply to AT-42: Open → In Progress/ })).toBeDefined();
  await ui.press({ key: 'apply-status' });
  const writes = f.commands.filter(a => a[2] === 'transition');
  expect(writes).toEqual([['atlas', 'jira', 'transition', 'AT-42', '--id', '21', '--site', ISSUE.site]]);
  expect(await ui.find({ type: 'Text', text: 'Jira status: In Progress' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'Board: Product · Column: Doing' })).toBeDefined();
});

test('a failed refresh retains cached state and a timed out write is never retried', async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: 'AT-42' });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: `attach-${ID}` });
  f.failGet = true;
  await ui.press({ key: 'refresh' });
  expect(await ui.find({ type: 'Text', text: 'Jira status: Open (cached, unavailable)' })).toBeDefined();
  f.failGet = false; f.failTransition = true;
  await ui.press({ key: 'status' });
  await ui.select({ key: 'transition', value: '21' });
  await ui.press({ key: 'apply-status' });
  expect(f.commands.filter(a => a[2] === 'transition')).toHaveLength(1);
  expect(await ui.find({ type: 'Text', text: /Transition was not confirmed/ })).toBeDefined();
});

test('midturn detach keeps output ticket links and discards late research', async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: 'AT-42' });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: `attach-${ID}` });
  await $.turn.start({ text: 'Implement', turnId: 'main-turn' });
  await ui.press({ key: 'detach' });
  await $.turn.complete(completion('research-1'));
  expect(f.files.size).toBe(0);
  const answer = await $.turn.complete(completion(undefined, 'Implemented.'));
  expect(answer.text).not.toContain('Implemented.');
  expect(answer.text).toContain('[AT-42](https://example.atlassian.net/browse/AT-42)');
  const prompt = await $.prompt.submit({ text: 'Next task', wait: false, origin: { kind: 'composer' } });
  expect(prompt.context).toBeUndefined();
});

test('resume restores bindings while clear and fork start unbound', async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: 'AT-42' });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: `attach-${ID}` });
  f.session = 'session-b';
  await $.classic.SessionStart({ source: 'clear' });
  expect(await ui.find({ key: 'status' })).toBeUndefined();
  f.session = 'session-a';
  await $.classic.SessionStart({ source: 'resume' });
  expect(await ui.find({ type: 'Text', text: `${ISSUE.key}: ${ISSUE.summary}` })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'Research: failed' })).toBeDefined();
  f.session = 'session-c';
  await $.classic.SessionStart({ source: 'fork' });
  expect(await ui.find({ key: 'status' })).toBeUndefined();
});

test('changing the outcome discards a pending brief', async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: 'AT-42' });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: `attach-${ID}` });
  await ui.press({ key: 'settings' });
  await ui.input({ key: 'outcome', text: 'Write a design report' });
  await ui.press({ key: 'tickets' });
  await $.turn.complete(completion('research-1'));
  expect(f.files.size).toBe(0);
  expect(await ui.find({ type: 'Text', text: 'Research: stale' })).toBeDefined();
});

test('failed document saves never advertise a ready brief', async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: 'AT-42' });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: `attach-${ID}` });
  f.failWrite = true;
  await $.turn.complete(completion('research-1'));
  expect(await ui.find({ type: 'Text', text: 'Research: failed' })).toBeDefined();
  expect(await ui.find({ key: 'share-brief' })).toBeUndefined();
});

test('issue validation rejects malformed data', () => {
  expect(() => readIssue({ ...ISSUE, browse_url: 'https://other.example/browse/AT-42' })).toThrow();
  expect(empty().tickets).toHaveLength(0);
});

test('working tree changes make an existing brief stale before the next handoff', async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: 'AT-42' });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: `attach-${ID}` });
  await $.turn.complete(completion('research-1'));
  f.gitDiff = 'Changed picker implementation';
  const prompt = await $.prompt.submit({ text: 'Implement', wait: false, origin: { kind: 'composer' } });
  expect(await ui.find({ type: 'Text', text: 'Research: stale' })).toBeDefined();
  expect(prompt.context?.join('\n')).not.toContain('Research brief:');
});

test('failed researchers can be retried and changing tickets during research marks the brief stale', async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: 'AT-42' });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: `attach-${ID}` });
  await $.turn.complete({ ...completion('research-1'), reason: 'error' });
  expect(await ui.find({ type: 'Text', text: 'Research: failed' })).toBeDefined();
  await ui.press({ key: 'research' });
  expect(f.spawns).toHaveLength(2);
  f.gitDiff = 'Source changed during research';
  await $.turn.complete(completion('research-2'));
  expect(await ui.find({ type: 'Text', text: 'Research: stale' })).toBeDefined();
});

test('multiple tickets attach to one outcome and duplicate attachment starts no extra research', async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: 'AT-42' });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: `attach-${ID}` });
  await ui.press({ key: 'add-ticket' });
  await ui.press({ key: `attach-${ID}` });
  expect(f.spawns).toHaveLength(1);
  f.issue = { ...ISSUE, key: 'AT-43', browse_url: 'https://example.atlassian.net/browse/AT-43', summary: 'Add research' };
  await ui.press({ key: 'add-ticket' });
  await ui.input({ key: 'search', text: 'AT-43' });
  await ui.press({ key: `attach-${ticketID(f.issue)}` });
  await $.turn.start({ text: 'Implement both', turnId: 'main-turn' });
  const answer = await $.turn.complete(completion(undefined, 'Done.'));
  expect(answer.text).toContain('[AT-42]');
  expect(answer.text).toContain('[AT-43]');
  expect(f.spawns).toHaveLength(2);
});

test('queued prompts and their output keep the binding captured at submission', async ($, on) => {
  fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: 'AT-42' });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: `attach-${ID}` });
  const queued = await $.prompt.submit({ text: 'Queued task', wait: true, origin: { kind: 'composer' } });
  expect(queued.context?.join('\n')).toContain('AT-42');
  await ui.press({ key: 'detach' });
  await $.turn.start({ text: 'Queued task', turnId: 'main-turn' });
  const answer = await $.turn.complete(completion(undefined));
  expect(answer.text).toContain('[AT-42]');
  const next = await $.prompt.submit({ text: 'Later task', wait: false, origin: { kind: 'composer' } });
  expect(next.context).toBeUndefined();
});

test('a changed transition catalog requires a new preview before writing', async ($, on) => {
  const f = fixture(on);
  await $.session.start(START);
  await $.command.run({ command: 'atlas', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 }, args: 'AT-42' });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: `attach-${ID}` });
  await ui.press({ key: 'status' });
  await ui.select({ key: 'transition', value: '21' });
  f.transitionStatus = 'Blocked';
  await ui.press({ key: 'apply-status' });
  expect(f.commands.filter(a => a[2] === 'transition')).toHaveLength(0);
  expect(await ui.find({ type: 'Text', text: /Available transitions changed/ })).toBeDefined();
});
