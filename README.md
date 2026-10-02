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

The desktop app draws turns its own way, so the plugin folds nothing there.

## What it hooks

The plugin is one hooks module, `hooks/register.tsx`. It hooks these events:

| Event | What the hook does |
| --- | --- |
| `session.start` | Registers the `/tidy-turns` command. |
| `command.run` for `/tidy-turns` | Turns folding on or off for the session. |
| `turn.start`, `turn.complete` | Starts a turn's record, then saves its duration, verb, and how it ended. |
| `tool.call` | Counts the turn's tool calls by tool name, and notes which failed and which files an edit changed. It passes every call on unchanged and never makes a call of its own. |
| `session.append` for responses | Records the text of each reply, so the plugin can tell working notes from the final answer. |
| `turn.step` | Holds each reply's text until the block is whole, then passes it on. Adds each model request's output token count, and records the model name. |
| `ui.render` | Draws the folded turn, the `✻ Verb for 7s` line, and the summary in the terminal. |

Everything it records stays in the session's plugin state (`$.state`), and it writes debug lines to Claude Code's own debug log. The plugin makes no network requests, runs no programs, reads no files or environment variables, and asks for no credentials. "Tokens" in this README and in the `showTokens` setting means the model's output token count, not an access token.

## Install

You need a Claude Code build that loads function-hook plugins (2.1.286 or later). The repo is its own plugin marketplace.

1. In Claude Code, add the marketplace:

   ```
   /plugin marketplace add bmurgic/tidy-turns
   ```

2. Install the plugin:

   ```
   /plugin install tidy-turns@tidy-turns
   ```

3. Start a new session.

To do the same from a shell:

```bash
claude plugin marketplace add bmurgic/tidy-turns
```

```bash
claude plugin install tidy-turns@tidy-turns
```

## Use it

- **Read the answer.** When a turn finishes, its work folds away and the answer shows under a dim `✻ Verb for 7s ▸` line.
- **Open the summary.** Click the line. The summary opens under that turn only, and the arrow turns to `▾`. Click the line or any summary row to close it. Each turn remembers its own state.
- **Show the folded work.** Run `/tidy-turns` to turn folding off for the session, and run it again to turn folding back on. Press ctrl+o to see every row in the transcript view without changing anything.

A turn with nothing to summarize shows `✻ Verb for 7s` with no arrow, and clicking it does nothing.

## Change the settings

Each summary item is a setting that you turn on or off. Only the tool call count is on by default.

To change them in Claude Code, run:

```
/plugin configure tidy-turns@tidy-turns
```

To change them from a shell, pipe a JSON object of the settings to change. Write each value as the string `"true"` or `"false"`. Settings you leave out keep their values. Restart Claude Code to apply the change.

```bash
echo '{"showToolKinds":"true","showModel":"true","showTokens":"true"}' | claude plugin configure tidy-turns@tidy-turns --values-stdin
```

To see the current values, run `claude plugin configure tidy-turns@tidy-turns` with no input. To set values while you install, add `--config KEY=VALUE` to `claude plugin install`, once per setting.

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

The summary puts each group of related items on its own row, in this order: activity (count, kinds, subagents), changes, session tools, usage (model, tokens, skills, tool searches, MCP calls), and problems in red. A group with nothing to show gets no row.

## Update or remove

To get the latest release, refresh the marketplace, update the plugin, then restart Claude Code:

```bash
claude plugin marketplace update tidy-turns
```

```bash
claude plugin update tidy-turns@tidy-turns
```

To remove it:

```bash
claude plugin uninstall tidy-turns@tidy-turns
```

## Develop

To try a working copy without installing it, start Claude Code with the folder:

```bash
claude --plugin-dir ./tidy-turns
```

Run the tests, then check the plugin manifest and the marketplace catalog, from the repo folder:

```bash
claude plugin test .
```

```bash
claude plugin validate --strict .claude-plugin/plugin.json
```

```bash
claude plugin validate --strict .claude-plugin/marketplace.json
```

To release, raise `version` in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, commit, then tag and push the release:

```bash
claude plugin tag . --push
```

`tsconfig.json` reads the engine's type declarations from `.claude-plugin/types`. Claude Code generates that folder, and git ignores it.

## License

MIT. See [LICENSE](LICENSE).
