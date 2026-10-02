# tidy-turns

A Claude Code plugin that cleans up finished turns in the terminal. When a turn ends, its tool calls and working notes fold away. You see one line, then the answer:

```
✻ Sautéed for 7s ▸
⏺ Done.
```

Click the line to open a summary of the turn under it:

```
✻ Sautéed for 7s ▾
├─ 3 tool calls · 1 command · 1 read
├─ 1 file changed
├─ Haiku 4.5 · 519 tokens
└─ 1 failed
⏺ Done.
```

While the summary is open, the line is bright and its star and tree are orange. While it's closed, the line is dim. Click the line again to close the summary. The folded work stays hidden either way.

## What it changes

- Each finished turn's tool calls and notes fold away. The turn that is running still shows everything.
- The `✻ Verb for 7s` line moves above the answer and replaces Claude Code's own line under it.
- Replies appear whole when each text block ends, not word by word. This one applies on every surface, not only the terminal.
- `/tidy-turns` turns folding off and on for the session.
- The ctrl+o transcript always shows every row.

The desktop app draws turns its own way, so the plugin folds nothing there.

## Install

You need a Claude Code build that loads function-hook plugins (2.1.286 or later).

1. Clone the repo:

   ```bash
   git clone https://github.com/bmurgic/tidy-turns.git
   ```

2. Start Claude Code with the plugin folder:

   ```bash
   claude --plugin-dir ./tidy-turns
   ```

## Settings

Each summary item is a row in `/config`. Changing one reloads the plugin. Only the tool call count is on by default.

| Setting | Shows | Default |
| --- | --- | --- |
| `showToolCount` | How many tool calls the turn made | on |
| `showToolKinds` | The calls by kind, such as `2 reads · 1 command`. A kind with its own item below is left out while that item is on. | off |
| `showSubagents` | How many subagents the turn ran | off |
| `showFilesChanged` | How many files the turn's edits changed | off |
| `showSessionTools` | Session tool calls by kind, such as `2 messages · 1 monitor` | off |
| `showFailures` | How many tool calls failed or were denied | off |
| `showEndReason` | `interrupted`, `refused`, or `errored` when the turn did not end normally | off |
| `showModel` | The model that answered, such as `Haiku 4.5` | off |
| `showTokens` | The output tokens the turn used, its subagents' included | off |
| `showSkills` | How many skills the turn loaded | off |
| `showToolSearches` | How many tool searches the turn made | off |
| `showMcpCalls` | How many MCP tool calls the turn made | off |

The summary puts each group of related items on its own row, in this order: activity (count, kinds, subagents), changes, session tools, usage (model, tokens, skills, tool searches, MCP calls), and problems in red. A group with nothing to show gets no row. A turn with no summary at all has no arrow and isn't clickable.

## Develop

Run the tests and check the manifest from the repo folder:

```bash
claude plugin test .
```

```bash
claude plugin validate .
```

`tsconfig.json` reads the engine's type declarations from `.claude-plugin/types`. Claude Code generates that folder, and git ignores it.

## License

MIT. See [LICENSE](LICENSE).
