import type { EngineInterface, On, RenderElement, Timer } from 'claude-code';
import {
  briefDocument, context, empty, fingerprint, footer, loadBinding,
  message, readIssue, researcherPrompt, researchPrompt, safeSegment, sourceFingerprint, ticketID, ticketKey,
} from './model.ts';
import type { Binding, Board, Issue, Job, Placement, Ticket, Transition } from './model.ts';
import { candidateJQL, mergeIssues, rankIssues } from './search.ts';

const PANE = 'atlas-tickets';
let binding = empty();
let session = '';
let root = '';
let epoch = 0;
let busy = false;
let notice = '';
let selected = '';
let results: Issue[] = [];
let candidates: Issue[] = [];
let recent: Issue[] = [];
let remote: Issue[] = [];
let remoteQuery = '';
let searchText = '';
let searchTimer: Timer | undefined;
let searchVersion = 0;
let searching = false;
let warmed = false;
let resultLimit = 8;
let screen: 'search' | 'ticket' | 'settings' = 'search';
let statusOpen = false;
let detailsOpen = false;
let boards: Board[] = [];
let transitions: Transition[] = [];
let transitionID = '';
let viewingBrief = '';
let jobs: Record<string, Job> = {};
let turnBinding: Binding | undefined;
let activeTurn = '';
let submitted: { text: string; binding: Binding }[] = [];
let researcher = 'atlas-tickets:researcher';

function current(): Ticket | undefined {
  return binding.tickets.find(t => ticketID(t.issue) === selected);
}

async function save($: EngineInterface): Promise<void> {
  await $.store.set(`session:${session}`, binding);
  await $.store.set(`jobs:${session}`, jobs);
  $.ui.invalidate('ui.render');
}

async function hydrate($: EngineInterface): Promise<void> {
  cancelSearch();
  epoch++;
  session = await $.session.id();
  root = await $.session.cwd();
  binding = loadBinding(await $.store.get(`session:${session}`));
  jobs = (await $.store.get(`jobs:${session}`) as Record<string, Job> | undefined) ?? {};
  const running = new Set((await $.agent.list()).filter(a => a.status === 'running').map(a => a.id));
  for (const t of binding.tickets) {
    if (t.brief?.status === 'researching' && !Object.entries(jobs).some(([id, job]) =>
      running.has(id) && job.ticket === ticketID(t.issue) && job.fingerprint === t.brief?.fingerprint)) {
      t.brief.status = 'failed';
      t.brief.error = 'Research was interrupted. Choose Research again.';
    }
  }
  selected = binding.tickets[0] ? ticketID(binding.tickets[0].issue) : '';
  results = []; boards = []; transitions = []; transitionID = ''; viewingBrief = '';
  candidates = []; recent = []; remote = []; remoteQuery = ''; searchText = ''; resultLimit = 8;
  warmed = false;
  screen = selected ? 'ticket' : 'search'; statusOpen = false; detailsOpen = false;
  turnBinding = undefined; activeTurn = ''; submitted = []; busy = false; notice = '';
  await save($);
}

async function act($: EngineInterface, operation: () => Promise<void>): Promise<void> {
  if (busy) return;
  const started = epoch;
  busy = true; notice = ''; $.ui.invalidate('ui.render');
  try { await operation(); }
  catch (error) { if (started === epoch) notice = message(error); }
  finally { if (started === epoch) { busy = false; $.ui.invalidate('ui.render'); } }
}

async function atlas($: EngineInterface, args: string[], site = binding.site): Promise<unknown> {
  const result = await $.process.run(['atlas', 'jira', ...args, ...(site ? ['--site', site] : [])], { timeoutMs: 35000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Atlas exited ${result.exitCode}. Check atlas doctor.`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('Atlas returned invalid JSON. Install an Atlas build with board and suggestion support.'); }
}

function searchItems(value: unknown): Issue[] {
  const items = (value as { items: unknown[] }).items;
  if (!Array.isArray(items)) throw new Error('Atlas returned an invalid search response.');
  return items.map(readIssue);
}

function filterSearch(): void {
  const attached = binding.tickets.map(t => t.issue);
  results = searchText.trim() ? rankIssues(searchText, mergeIssues(candidates, attached), remoteQuery === searchText.trim() ? remote : []) : recent;
  resultLimit = 8;
}

function cancelSearch(): void {
  searchTimer?.cancel(); searchTimer = undefined;
  searchVersion++; searching = false;
}

function queueSearch($: EngineInterface, value: string): void {
  cancelSearch();
  searchText = value.slice(0, 120); notice = ''; filterSearch();
  if (searchText.trim().length >= 2) {
    searching = true;
    const version = searchVersion;
    searchTimer = $.clock.after(300, () => {
      if (version !== searchVersion) return;
      searchTimer = undefined;
      return search($, searchText);
    });
  }
  $.ui.invalidate('ui.render');
}

async function search($: EngineInterface, query: string): Promise<void> {
  cancelSearch();
  const version = searchVersion;
  const started = epoch;
  const site = binding.site;
  searchText = query.slice(0, 120); searching = true; notice = '';
  const q = searchText.trim();
  filterSearch(); $.ui.invalidate('ui.render');
  try {
    if (!q || !warmed) {
      const lists = await Promise.allSettled([
        atlas($, ['search', '--jql', 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC', '--limit', '100'], site).then(searchItems),
        atlas($, ['search', '--jql', 'ORDER BY updated DESC', '--limit', '100'], site).then(searchItems),
      ]);
      if (started !== epoch || version !== searchVersion) return;
      warmed = lists.some(list => list.status === 'fulfilled');
      recent = lists[0].status === 'fulfilled' ? lists[0].value : [];
      candidates = mergeIssues(candidates, recent, lists[1].status === 'fulfilled' ? lists[1].value : []).slice(-400);
      filterSearch(); $.ui.invalidate('ui.render');
      if (!warmed && !q) throw new Error(message((lists[0] as PromiseRejectedResult).reason));
    }
    if (q) {
      const jql = candidateJQL(q);
      const lists = await Promise.allSettled(ticketKey(q.toUpperCase())
        ? [atlas($, ['get', q.toUpperCase()], site).then(value => [readIssue(value)])]
        : [atlas($, ['suggest', '--query', q], site).then(searchItems),
          ...(jql ? [atlas($, ['search', '--jql', jql, '--limit', '100'], site).then(searchItems)] : [])]);
      if (started !== epoch || version !== searchVersion) return;
      remote = lists[0].status === 'fulfilled' ? lists[0].value : []; remoteQuery = q;
      candidates = mergeIssues(candidates, ...lists.filter(list => list.status === 'fulfilled').map(list => list.value)).slice(-400);
      filterSearch();
      const failed = lists.find(list => list.status === 'rejected');
      if (failed?.status === 'rejected') notice = `Jira search incomplete: ${message(failed.reason)} Cached matches are still shown.`;
    }
  } catch (error) {
    if (started === epoch && version === searchVersion) notice = message(error);
  } finally {
    if (started === epoch && version === searchVersion) { searching = false; $.ui.invalidate('ui.render'); }
  }
}

function showTicket(id: string): void {
  cancelSearch();
  selected = id; screen = 'ticket'; statusOpen = false; detailsOpen = false;
  transitions = []; transitionID = ''; boards = []; viewingBrief = ''; notice = '';
}

async function attach($: EngineInterface, issue: Issue): Promise<void> {
  if (binding.tickets.some(t => ticketID(t.issue) === ticketID(issue))) { showTicket(ticketID(issue)); return; }
  const started = epoch;
  const full = readIssue(await atlas($, ['get', issue.key], issue.site));
  const now = await $.clock.now();
  if (started !== epoch) return;
  const ticket: Ticket = { issue: full, fetchedAt: now };
  if (!binding.outcome) binding.outcome = full.summary;
  binding.tickets.push(ticket);
  showTicket(ticketID(full));
  await save($);
  await research($, ticket);
}

async function refresh($: EngineInterface, ticket: Ticket): Promise<void> {
  const started = epoch;
  try {
    const issue = readIssue(await atlas($, ['get', ticket.issue.key], ticket.issue.site));
    const now = await $.clock.now();
    if (started !== epoch || !binding.tickets.includes(ticket)) return;
    if (fingerprint(ticket.issue) !== fingerprint(issue) && ticket.brief) ticket.brief.status = 'stale';
    ticket.issue = issue; ticket.fetchedAt = now; delete ticket.error;
  } catch (error) {
    if (started !== epoch) return;
    ticket.error = message(error);
    if (ticket.brief?.status === 'ready') ticket.brief.status = 'stale';
    await save($);
    throw error;
  }
  if (ticket.board) {
    try {
      const placement = await atlas($, ['board', 'placement', ticket.issue.key, '--board', String(ticket.board.id)], ticket.issue.site) as Placement;
      if (placement.schema_version !== 1) throw new Error('Unsupported Atlas board placement schema.');
      if (started !== epoch) return;
      ticket.placement = placement; delete ticket.placementError;
    } catch (error) { if (started === epoch) ticket.placementError = message(error); }
  }
  if (started === epoch) await save($);
}

async function loadBoards($: EngineInterface, ticket: Ticket): Promise<void> {
  const started = epoch;
  const value = await atlas($, ['boards', '--project', ticket.issue.key.split('-')[0]], ticket.issue.site) as Board[];
  if (!Array.isArray(value) || value.some(b => !Number.isInteger(b.id) || b.id <= 0 || typeof b.name !== 'string')) throw new Error('Atlas returned invalid boards.');
  if (started === epoch && current() === ticket) { boards = value; notice = boards.length ? '' : 'No accessible boards.'; }
}

async function loadTransitions($: EngineInterface, ticket: Ticket): Promise<void> {
  const started = epoch;
  const value = await atlas($, ['transitions', ticket.issue.key, ...(ticket.board ? ['--board', String(ticket.board.id)] : [])], ticket.issue.site) as { items: Transition[] };
  if (!Array.isArray(value.items) || value.items.some(t => typeof t.id !== 'string' || !t.id || typeof t.to_status !== 'string')) throw new Error('Atlas returned invalid transitions.');
  if (started === epoch && current() === ticket) {
    transitions = value.items; transitionID = '';
    notice = transitions.length ? '' : 'No available transitions.';
  }
}

async function applyTransition($: EngineInterface, ticket: Ticket, chosen: Transition): Promise<void> {
  const started = epoch;
  await loadTransitions($, ticket);
  if (started !== epoch || current() !== ticket) return;
  const fresh = transitions.find(t => t.id === chosen.id && t.to_status === chosen.to_status && t.column === chosen.column);
  if (!fresh) throw new Error('Available transitions changed. Choose a transition again.');
  transitionID = '';
  try { await atlas($, ['transition', ticket.issue.key, '--id', fresh.id], ticket.issue.site); }
  catch (error) {
    // A timed-out write may have reached Jira. Never retry it automatically.
    await refresh($, ticket).catch(() => {});
    throw new Error(`Transition was not confirmed: ${message(error)} Check the refreshed status before trying again.`);
  }
  if (started !== epoch) return;
  transitions = [];
  statusOpen = false;
  await refresh($, ticket);
  notice = `Jira now reports ${ticket.issue.status}.`;
}

async function revision($: EngineInterface): Promise<string> {
  const head = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd: root, timeoutMs: 5000 });
  const diff = await $.process.run(['git', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], { cwd: root, timeoutMs: 5000 });
  const status = await $.process.run(['git', 'status', '--porcelain'], { cwd: root, timeoutMs: 5000 });
  return fingerprint([root, head.exitCode, head.stdout, diff.stdout, status.stdout]);
}

async function workDirectory($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME');
  if (!home) throw new Error('HOME is unavailable; cannot save a research brief.');
  const resolver = `${home}/.agents/skills/qrspi/scripts/qrspi.sh`;
  if (await $.fs.exists(resolver)) {
    const result = await $.process.run([resolver, 'ws'], { cwd: root, timeoutMs: 5000 });
    if (result.exitCode === 0 && result.stdout.trim().startsWith('/')) return result.stdout.trim();
  }
  return `${home}/.work/${safeSegment(root.split('/').filter(Boolean).pop() ?? 'project')}`;
}

async function linkedSources($: EngineInterface, issue: Issue): Promise<string[]> {
  const keys = [...new Set((issue.links ?? []).flatMap(l => [l.inward, l.outward]).filter(k => ticketKey(k) && k !== issue.key))];
  const sources = await Promise.all(keys.slice(0, 5).map(async key => {
    try { return JSON.stringify(readIssue(await atlas($, ['get', key], issue.site))).slice(0, 12000); }
    catch (error) { return `${key}: unavailable (${message(error)})`; }
  }));
  if (keys.length > 5) sources.push(`${keys.length - 5} additional linked tickets were outside this research run's limit.`);
  return sources;
}

async function research($: EngineInterface, ticket: Ticket): Promise<void> {
  if (ticket.brief?.status === 'researching') return;
  const started = epoch;
  try {
    const rev = await revision($);
    const source = sourceFingerprint(ticket, binding.outcome, rev);
    const directory = await workDirectory($);
    const now = await $.clock.now();
    if (started !== epoch || !binding.tickets.includes(ticket)) return;
    const job: Job = {
      session, ticket: ticketID(ticket.issue), fingerprint: source, outcome: binding.outcome,
      root, issue: ticket.issue, linked: await linkedSources($, ticket.issue), revision: rev,
      path: `${directory}/atlas-tickets/${safeSegment(session)}/${ticket.issue.key}-${source}-${now}.md`,
    };
    if (started !== epoch || !binding.tickets.includes(ticket)) return;
    ticket.brief = { status: 'researching', fingerprint: source, share: true, revision: rev };
    await save($);
    const result = await $.agent.spawn({ subagentType: researcher, model: 'haiku', description: `Research ${ticket.issue.key}`, prompt: researchPrompt(job), cwd: root });
    if (started !== epoch) return;
    if (!result.agentId) throw new Error(result.deny ?? 'Claude Code did not start the researcher.');
    jobs[result.agentId] = job;
    await save($);
  } catch (error) {
    if (started !== epoch) return;
    ticket.brief = { status: 'failed', fingerprint: '', share: true, error: message(error) };
    await save($);
    notice = `Ticket attached. Research failed: ${message(error)}`;
  }
}

async function finishResearch($: EngineInterface, agent: string, answer: string, succeeded: boolean): Promise<void> {
  const job = jobs[agent];
  if (!job) return;
  const started = epoch;
  delete jobs[agent];
  const ticket = binding.tickets.find(t => ticketID(t.issue) === job.ticket);
  if (job.session !== session || !ticket || ticket.brief?.status !== 'researching' || ticket.brief.fingerprint !== job.fingerprint || binding.outcome !== job.outcome) {
    await save($); return;
  }
  try {
    if (!succeeded || !answer.trim()) throw new Error('Research ended without a complete brief. Choose Research again.');
    const now = await $.clock.now();
    await $.fs.write(job.path, briefDocument(job, answer, now));
    const latestRevision = await revision($);
    if (started !== epoch || !binding.tickets.includes(ticket) || ticket.brief.fingerprint !== job.fingerprint || binding.outcome !== job.outcome) return;
    const stale = sourceFingerprint(ticket, binding.outcome, latestRevision) !== job.fingerprint;
    ticket.brief = { status: stale ? 'stale' : 'ready', fingerprint: job.fingerprint, path: job.path, summary: answer.slice(0, 1000), share: true, revision: job.revision };
    await $.ui.toast(`${ticket.issue.key}: ${stale ? 'sources changed during research; refresh the brief' : 'research brief ready; shared on the next turn'}.`);
  } catch (error) {
    if (started !== epoch) return;
    ticket.brief.status = 'failed'; ticket.brief.error = message(error);
  }
  if (started === epoch) await save($);
}

export function register(on: On): void {
  on('session.start', async ($, e, next) => {
    await hydrate($);
    const registered = await $.agent.register({ name: 'researcher', description: 'Research an attached Jira ticket and return a sourced brief.', prompt: researcherPrompt,
      model: 'haiku', tools: ['Read', 'Glob', 'Grep'], maxTurns: 10, background: true });
    researcher = registered.agent;
    await $.command.register({ name: 'atlas', description: 'Attach Jira tickets, update status, and read research briefs', argumentHint: '[ticket key or search]', immediate: true });
    return next(e);
  });

  on('classic.SessionStart', { source: ['resume', 'clear', 'fork'] }, async ($, e, next) => {
    await hydrate($);
    return next(e);
  });

  on('agent.offer', { agent: 'atlas-tickets:researcher' }, () => ({ isOffered: false }));

  on('command.run', { command: 'atlas' }, async ($, e) => {
    cancelSearch();
    screen = e.args.trim() || !binding.tickets.length ? 'search' : 'ticket';
    statusOpen = false; detailsOpen = false; viewingBrief = ''; notice = '';
    await $.ui.open({ id: PANE, title: 'Atlas Tickets', focus: true, closeOnEscape: true, rows: 20, columns: 52 });
    if (screen === 'search') await search($, e.args);
    return {};
  });

  on('ui.close', { id: PANE }, ($, e, next) => {
    cancelSearch();
    return next(e);
  });

  on('prompt.submit', async ($, e, next) => {
    if (binding.tickets.some(t => t.brief?.status === 'ready')) {
      const latestRevision = await revision($);
      for (const t of binding.tickets) {
        if (t.brief?.status === 'ready' && t.brief.revision !== latestRevision) t.brief.status = 'stale';
      }
      await save($);
    }
    const snapshot = { text: e.text, binding: JSON.parse(JSON.stringify(binding)) as Binding };
    submitted.push(snapshot);
    const attached = context(snapshot.binding);
    const result = await next(attached ? { ...e, context: [...(e.context ?? []), attached] } : e);
    if (result.drop !== undefined) submitted = submitted.filter(s => s !== snapshot);
    else snapshot.text = result.text;
    return result;
  });

  on('turn.start', ($, e, next) => {
    const index = submitted.findIndex(s => s.text === e.text);
    const snapshot = submitted.splice(index < 0 ? 0 : index, 1)[0];
    turnBinding = snapshot?.binding ?? JSON.parse(JSON.stringify(binding)) as Binding;
    activeTurn = e.turnId;
    $.ui.invalidate('ui.render');
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      await finishResearch($, e.agentId, e.answer, e.reason === 'answer');
      return next(e);
    }
    const snapshot = activeTurn === e.turnId ? turnBinding : undefined;
    turnBinding = undefined; activeTurn = ''; $.ui.invalidate('ui.render');
    const result = await next(e);
    const link = snapshot && !e.isAborted ? footer(snapshot) : '';
    return link ? { ...result, text: `${result.text === e.answer ? '' : result.text}\n\n${link}`.trim() } : result;
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const original = await next(e);
    if (!binding.tickets.length) return original;
    const { Box, Text, Button } = $.ui.resolve(e);
    return Box({ flexDirection: 'column', children: [original, Box({ flexDirection: 'row', gap: 1, children: [
      Button({ key: 'atlas-open', label: 'Atlas', onPress: () => {
        showTicket(selected || ticketID(binding.tickets[0].issue));
        return $.ui.open({ id: PANE, title: 'Atlas Tickets', focus: true, closeOnEscape: true, rows: 20, columns: 52 });
      } }),
      Text({ dimColor: true, wrap: 'truncate-end', children: `${binding.tickets.map(t => `${t.issue.key} · ${t.issue.status}${t.error ? ' (cached)' : ''} · ${t.brief?.status ?? 'no brief'}`).join(' | ')} · ${binding.outcome}` }),
    ] })] });
  });

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE || e.surface !== 'terminal') return next(e);
    const { Box, Text, Button, Input, Select, Markdown } = $.ui.resolve(e);
    const rows: RenderElement[] = [];
    const ticket = current();
    rows.push(Box({ flexDirection: 'row', gap: 1, children: [
      Button({ key: 'tickets', label: `Tickets (${binding.tickets.length})`, onPress: () => {
        if (busy) return;
        showTicket(selected || (binding.tickets[0] ? ticketID(binding.tickets[0].issue) : '')); $.ui.invalidate('ui.render');
      } }),
      Button({ key: 'add-ticket', label: 'Add ticket', onPress: async () => {
        if (busy) return;
        screen = 'search'; viewingBrief = ''; statusOpen = false;
        if (!warmed) await search($, searchText); else queueSearch($, searchText);
      } }),
      Button({ key: 'settings', label: 'Settings', onPress: () => {
        if (busy) return;
        cancelSearch(); screen = 'settings'; notice = ''; $.ui.invalidate('ui.render');
      } }),
    ] }));
    rows.push(Text({ dimColor: true, wrap: 'truncate-end', children: `Outcome: ${binding.outcome || 'Uses the first attached ticket’s summary'}` }));
    if (busy) rows.push(Text({ color: 'yellow', children: 'Working…' }));
    if (notice) rows.push(Text({ color: 'yellow', children: notice }));
    if (screen === 'settings') {
      rows.push(Text({ bold: true, children: 'Session settings' }));
      rows.push(Input({ key: 'outcome', label: 'Outcome', value: binding.outcome, autoFocus: true, placeholder: 'What should this session produce?', onSubmit: value => act($, async () => {
        const title = value.trim().slice(0, 300);
        if (!title) throw new Error('Enter an outcome.');
        if (binding.outcome !== title) {
          binding.outcome = title;
          for (const t of binding.tickets) if (t.brief) t.brief.status = 'stale';
          await save($);
        }
        notice = 'Outcome saved.';
      }) }));
      rows.push(Input({ key: 'site', label: 'Jira site (optional)', value: binding.site, placeholder: 'Atlas site alias for multi-site searches', onSubmit: value => act($, async () => {
        cancelSearch(); warmed = false;
        binding.site = value.trim().slice(0, 200); results = []; candidates = []; recent = []; remote = []; remoteQuery = ''; searchText = '';
        await save($); notice = 'Site saved. Open Add ticket to search.';
      }) }));
      rows.push(Text({ dimColor: true, children: 'Outcome changes mark existing research stale.' }));
    } else if (screen === 'search') {
      rows.push(Input({ key: 'search', label: 'Find ticket', value: searchText, placeholder: 'Key, words, or abbreviation', autoFocus: true,
        onInput: value => queueSearch($, value),
        onSubmit: value => search($, value), submitLabel: 'Search now',
      }));
      rows.push(Text({ dimColor: true, children: 'Searches Jira as you type · Enter searches now' }));
      if (searching) rows.push(Text({ color: 'yellow', children: 'Searching Jira…' }));
      rows.push(Text({ dimColor: true, children: searchText.trim() ? `${results.length} matches · recent tickets + Jira results` : 'Your active tickets · type to search recent tickets' }));
      for (const issue of results.slice(0, resultLimit)) {
        const attached = binding.tickets.some(t => ticketID(t.issue) === ticketID(issue));
        const width = Math.max(12, e.props.bodyColumns - issue.key.length - 12);
        const summary = issue.summary.length > width ? `${issue.summary.slice(0, width - 1)}…` : issue.summary;
        rows.push(Button({ key: `attach-${ticketID(issue)}`, label: `${attached ? 'Open' : 'Attach'} ${issue.key} · ${summary}`, onPress: () => act($, () => attach($, issue)) }));
      }
      if (!results.length && !busy && !searching) rows.push(Text({ children: !searchText.trim() ? 'No active tickets assigned to you. Type to search Jira.' : searchText.trim().length < 2 ? 'Type at least 2 characters to search Jira.' : 'No matches. Try fewer words or an exact ticket key.' }));
      if (results.length > resultLimit) rows.push(Button({ key: 'more-results', label: `Show more (${resultLimit} of ${results.length})`, onPress: () => {
        resultLimit += 8; $.ui.invalidate('ui.render');
      } }));
    } else if (ticket) {
      if (binding.tickets.length > 1) rows.push(Select({ key: 'attached', label: 'Attached ticket', value: selected,
        options: binding.tickets.map(t => ({ value: ticketID(t.issue), label: `${t.issue.key} · ${t.issue.summary}` })),
        onSelect: value => { if (!busy) { showTicket(value); $.ui.invalidate('ui.render'); } },
      }));
      rows.push(Text({ bold: true, color: 'cyan', wrap: 'truncate-end', children: `${ticket.issue.key}: ${ticket.issue.summary}` }));
      rows.push(Text({ bold: true, children: `Jira status: ${ticket.issue.status}${ticket.error ? ' (cached, unavailable)' : ''}` }));
      if (ticket.error) rows.push(Text({ color: 'yellow', children: ticket.error }));
      if (statusOpen) {
        rows.push(Text({ bold: true, children: 'Change Jira status' }));
        if (transitions.length) rows.push(Select({ key: 'transition', label: 'Move to', options: [{ value: '', label: 'Choose status…' }, ...transitions.map(t => ({ value: t.id, label: `${t.to_status} · ${t.name}${t.column ? ` / ${t.column}` : ''}` }))], value: transitionID, onSelect: value => {
          if (!busy) { transitionID = value; $.ui.invalidate('ui.render'); }
        } }));
        const chosen = transitions.find(t => t.id === transitionID);
        if (chosen) {
          rows.push(Text({ color: 'yellow', children: `Apply to ${ticket.issue.key}: ${ticket.issue.status} → ${chosen.to_status}${chosen.column ? ` (column: ${chosen.column})` : ''}` }));
          rows.push(Button({ key: 'apply-status', label: `Apply → ${chosen.to_status}`, onPress: () => act($, () => applyTransition($, ticket, chosen)) }));
        } else rows.push(Text({ dimColor: true, children: 'Choose a destination, then Apply to update Jira.' }));
        rows.push(Button({ key: 'cancel-status', label: 'Back to ticket', onPress: () => {
          if (busy) return;
          statusOpen = false; transitions = []; transitionID = ''; notice = ''; $.ui.invalidate('ui.render');
        } }));
      } else if (viewingBrief) {
        rows.push(Button({ key: 'back-brief', label: 'Back to ticket', onPress: () => { viewingBrief = ''; $.ui.invalidate('ui.render'); } }));
        rows.push(Markdown({ text: viewingBrief }));
      } else {
        rows.push(Box({ flexDirection: 'row', gap: 1, children: [
          Button({ key: 'status', label: 'Change status', hotkey: 's', autoFocus: true, onPress: () => act($, async () => {
            statusOpen = true; await loadTransitions($, ticket);
          }) }),
          Button({ key: 'refresh', label: 'Refresh', hotkey: 'r', onPress: () => act($, () => refresh($, ticket)) }),
        ] }));
        rows.push(Text({ bold: true, children: `Research: ${ticket.brief?.status ?? 'not started'}` }));
        if (ticket.brief?.error) rows.push(Text({ color: 'yellow', children: ticket.brief.error }));
        const researchActions: RenderElement[] = [];
        if (ticket.brief?.path) {
          researchActions.push(Button({ key: 'view-brief', label: 'View brief', onPress: () => act($, async () => { viewingBrief = await $.fs.read(ticket.brief!.path!); }) }));
        }
        if (ticket.brief?.status !== 'researching') researchActions.push(Button({ key: 'research', label: 'Research again', onPress: () => act($, async () => { await refresh($, ticket); await research($, ticket); }) }));
        if (researchActions.length) rows.push(Box({ flexDirection: 'row', gap: 1, children: researchActions }));
        if (ticket.brief?.status === 'ready') {
          if (ticket.brief.share) rows.push(Text({ dimColor: true, children: 'Brief shared with main agent on next prompt.' }));
          else rows.push(Button({ key: 'share-brief', label: 'Share with main agent on next prompt', onPress: () => act($, async () => {
            ticket.brief!.share = true; await save($); notice = 'Brief will accompany the next prompt to the main agent.';
          }) }));
        }
        rows.push(Box({ flexDirection: 'row', gap: 1, children: [
          Button({ key: 'details', label: detailsOpen ? 'Hide details' : 'Details & board', onPress: () => {
            detailsOpen = !detailsOpen; $.ui.invalidate('ui.render');
          } }),
          Button({ key: 'detach', label: `Detach ${ticket.issue.key}`, onPress: () => act($, async () => {
            binding.tickets = binding.tickets.filter(t => t !== ticket);
            showTicket(binding.tickets[0] ? ticketID(binding.tickets[0].issue) : ''); await save($);
          }) }),
        ] }));
        if (detailsOpen) {
          rows.push(Text({ children: ticket.issue.summary }));
          rows.push(Text({ children: ticket.issue.browse_url }));
          rows.push(Text({ dimColor: true, children: `Last fetched: ${new Date(ticket.fetchedAt).toISOString()}` }));
          rows.push(Text({ children: ticket.board ? `Board: ${ticket.board.name} · Column: ${ticket.placement?.column || ticket.placement?.state || 'unknown'}${ticket.placementError ? ' (cached, unavailable)' : ''}` : 'Board: optional; status changes work without one.' }));
          if (ticket.placementError) rows.push(Text({ color: 'yellow', children: ticket.placementError }));
          rows.push(Button({ key: 'boards', label: 'Choose board', onPress: () => act($, () => loadBoards($, ticket)) }));
          if (boards.length) rows.push(Select({ key: 'board', label: 'Board', options: [{ value: '', label: 'Select board…' }, ...boards.map(b => ({ value: String(b.id), label: b.name }))], value: ticket.board ? String(ticket.board.id) : '', onSelect: value => act($, async () => {
            const board = boards.find(b => String(b.id) === value); if (!board) return;
            ticket.board = board; delete ticket.placement; transitions = []; transitionID = ''; await refresh($, ticket);
          }) }));
          if (ticket.issue.description) rows.push(Text({ children: ticket.issue.description.slice(0, 1800) }));
          if (ticket.brief?.path) rows.push(Text({ dimColor: true, children: ticket.brief.path }));
        }
      }
    } else rows.push(Text({ children: 'No tickets attached. Choose Add ticket to get started.' }));
    if (activeTurn) rows.push(Text({ dimColor: true, children: 'Attachment changes apply to new prompts.' }));
    rows.push(Box({ flexDirection: 'row', gap: 1, children: [
      Button({ key: 'close', label: 'Close', onPress: () => { cancelSearch(); return $.ui.close({ id: PANE }); } }),
      Text({ dimColor: true, children: screen === 'ticket' && !statusOpen && !viewingBrief ? 's status · r refresh · Esc close' : 'Tab move · Enter · Esc close' }),
    ] }));
    return Box({ flexDirection: 'column', paddingX: 1, children: rows });
  });
}
