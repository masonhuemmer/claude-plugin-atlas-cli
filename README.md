# Atlas Tickets for Claude Code

Attach Jira tickets to the outcome of a Claude Code session. Pick tickets in the terminal, preview and apply Jira transitions, and let a background Haiku researcher prepare a document for the main agent.

This is a separate implementation inspired by [Herdr's Atlas integration](https://github.com/masonhuemmer/herdr-plugin-atlas-cli). Atlas continues to own Jira authentication and site routing.

## Run locally

Requires Claude Code **2.1.296 or later with native mods enabled**, an authenticated `atlas` CLI with `jira suggest`, board placement and transition support, `git`, and `rg` (ripgrep). Run `atlas doctor` to check your Atlas configuration.

From the project you want Claude to work on:

```sh
claude --plugin-dir /absolute/path/to/claude-plugin-atlas-cli
```

To load the local checkout in every project without the flag, link it into your personal skills directory (adjust the checkout path if needed):

```sh
mkdir -p ~/.claude/skills
ln -s "$PWD" ~/.claude/skills/atlas-tickets
```

Start future sessions with `claude`. Run `/reload-plugins` in an existing session to load the plugin or apply code updates. The repository is named `claude-plugin-atlas-cli`; the plugin is registered as `atlas-tickets`.

Then run `/atlas` or `/atlas SDO-123`. The native pane docks beside a wide fullscreen terminal and appears above the prompt in a narrower terminal. Use Tab to move between fields and buttons, Enter to submit a field or press a button, and Escape to close the pane.

1. Open **Add ticket** to find a ticket by key, summary, or abbreviation. Results filter as you type; press Enter to search Jira for more candidates. Choose **Attach** to attach a result, or **Open** for a ticket already attached. A blank search lists your active tickets.
2. Attaching opens the ticket view. **Change status** sits directly below the current **Jira status** and is focused by default. Press Enter or `s` to open it, choose a destination with the arrow keys and Enter, inspect the preview, then select **Apply → destination**. Status changes do not require a board. This is the only Jira write the plugin performs.
3. Use **Tickets** to return to your attached ticket. With multiple attachments, the **Attached ticket** selector switches between them. `/atlas` also opens this view when tickets are attached; `/atlas search words` opens search.
4. Haiku starts researching on attachment. **View brief** opens the saved document. A ready brief is shared automatically with the next submitted prompt to the main agent. **Research again** refreshes its sources and regenerates it.
5. **Details & board** reveals the full summary, description, Jira link, fetch time, and optional board selector. **Choose board** shows the board column separately from the Jira status.
6. **Settings** contains **Outcome** and the optional **Jira site** alias for multi-site searches. Set the outcome to the deliverable you want, such as “Implement ticket attachments” or “Write the incident report.” An empty outcome takes the first attached ticket's summary.

The compact strip above the prompt shows the outcome, attached tickets, status, and research state. Each submitted prompt captures its attached tickets, and the completed response links that same set. Changes made during a turn apply to newly submitted prompts; already queued prompts retain their earlier attachments. Completing agent work does not change Jira status.

Search matches partial keys (`AT42`, `AT-4`), reordered words, abbreviations (`tkt pkr`), and single-letter typos including transpositions (`tikcet picker`). Exact matches rank above approximate ones. Typing searches a session cache seeded with up to 100 of your active tickets and 100 recently updated tickets on the selected site. Enter combines Jira suggestions with broader summary-prefix candidates and applies the same fuzzy ranking; this can find older tickets outside the initial cache. Up to 400 discovered tickets stay cached while the plugin is loaded. The picker initially shows eight results, with **Show more** for the rest.

Fuzzy search is bounded by those candidates, rather than a complete local index of Jira. An exact ticket key performs a direct lookup. Jira Cloud [ignores fuzzy text-search operators](https://support.atlassian.com/jira-software-cloud/docs/search-for-work-items-using-the-text-field/), so typo and abbreviation matching is implemented in the plugin.

## Research and persistence

The plugin supplies Atlas snapshots of the attached ticket, comments, and up to five direct Jira links. Haiku uses Claude Code's built-in Read, Glob, and Grep tools to inspect project instructions, code, docs, and tests. Its tool list excludes code editing, shell commands, and Jira writes. Each run stops after 10 model turns and is prompted to keep source reads to eight. File access follows your Claude Code permissions.

The researcher returns a brief containing acceptance criteria, cited findings, relevant code and tests, a proposed approach, and open questions. The plugin saves it under:

```text
~/.work/<workstream>/atlas-tickets/<claude-session>/<ticket>-<fingerprint>-<time>.md
```

If your `qrspi.sh ws` resolver is installed, it supplies the workstream path; otherwise the project directory's name supplies it. Briefs are ordinary Markdown files you can share. They contain ticket and repository information and use your existing Claude account for research.

Bindings and research metadata live in the plugin's Claude Code store, keyed by session ID. Resume restores the binding. Clear and fork start unbound. Detaching a ticket or changing the outcome prevents an old research result from being shared to the new outcome. A researcher interrupted by restarting Claude is shown as failed and can be run again.

Refreshing a changed ticket or changing the outcome marks its brief stale. Tracked working tree changes are checked when research finishes and before the next prompt is submitted. Untracked file names are included in that check; edits to an already untracked file require **Research again**. Jira data is refreshed explicitly, so externally changed tickets require **Refresh**. Failed reads retain cached information and show the error and last fetch time. A timed-out transition is never retried automatically.

## Development

```sh
npm install
npm test
npm run validate
npm run typecheck
```

Load the plugin once in an interactive Claude Code session before typechecking. Claude writes the API definitions for your installed version into `.claude-plugin/types/`, which is ignored by Git. There are no runtime package dependencies or build step.

The native test suite uses fake Atlas responses, a fake store, and a fake researcher. It exercises live fuzzy filtering, search ranking and candidate discovery, ticket navigation, transition previews and failures, durable brief delivery, session isolation, research tool permissions, stale sources, and late completion handling without Jira writes or model calls.

The implementation uses Anthropic's [native mods API](https://code.claude.com/docs/en/plugins/mods/overview), [terminal UI elements](https://code.claude.com/docs/en/plugins/mods/interface), and [native testing kit](https://code.claude.com/docs/en/plugins/mods/test). Native mods are version dependent; this release is validated against Claude Code 2.1.296.

A live synthetic-ticket check also exercises a real Haiku researcher and the saved-document handoff. It uses a local Atlas fixture and performs no Jira writes. Custom plugin tools were not routed into plugin-spawned subagents in the tested Claude Code build, so research uses the built-in file tools.
