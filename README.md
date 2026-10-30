# herdr-mcp

An [MCP](https://modelcontextprotocol.io) server for [Herdr](https://herdr.dev), the terminal
multiplexer for coding agents. It lets any MCP client (Claude Code, Claude Desktop, Codex, Cursor,
pi, ...) start and steer agents and programs in terminals that stay alive, run commands and edit
files on other machines Herdr knows, and arrange the Herdr window.

Terminals, files and machines go through herdr-core's JSON-RPC API over `hc connect`, which this
server keeps open for its whole life. Window commands go through the `herdr-app` CLI.

## Requirements

- Node.js 20 or newer
- [herdr-core](https://herdr.dev) (`hc`) on `PATH`, with a running core (`hc server status`)
- The Herdr desktop app (`herdr-app`) only for the `herdr_app_*` tools

## Install

```sh
npx herdr-mcp            # from npm, once published
```

or from source:

```sh
git clone https://github.com/kevmo314/herdr-mcp
cd herdr-mcp
npm install && npm run build
node dist/index.js       # speaks MCP over stdio
```

### Claude Code

```sh
claude mcp add herdr -- npx -y herdr-mcp
```

### Claude Desktop, Cursor and others

```json
{
  "mcpServers": {
    "herdr": {
      "command": "npx",
      "args": ["-y", "herdr-mcp"]
    }
  }
}
```

### Environment

| Variable | Meaning |
| --- | --- |
| `HERDR_MCP_HC` | The `hc` binary (default: `hc` on `PATH`) |
| `HERDR_MCP_APP` | The `herdr-app` binary (default: `herdr-app` on `PATH`) |
| `HC_SESSION` | The hc session to reach, as for `hc` itself |
| `HC_TERMINAL_ID` | Set automatically inside a Herdr terminal. Passed as the caller, so terminals you start are your children and `herdr_wait` with `children` works. |

## Tools

### Terminals and agents

| Tool | What it does |
| --- | --- |
| `herdr_list` | Live terminals here and on every connected machine (`all` includes finished ones; filter by `labels`) |
| `herdr_get` | One terminal's facts: argv, cwd, state, status, exit code, labels, foreground process |
| `herdr_run` | Start a program or agent in a new terminal. `argv` or `line`, `name`, `cwd`, `on` (machine), `labels`, `task` (the agent's first message), `background` (default true; false waits and returns the output) |
| `herdr_send` | Paste text and press Enter; `wait` for the turn it starts; `force` only for a dialog the user asked you to answer |
| `herdr_wait` | Wait until a terminal is not working, prints `output`, or `children` (`any`/`all`) report. Timeouts are check-ins, not failures |
| `herdr_read` | The screen plus history as plain text |
| `herdr_keys` | Press named keys: `enter`, `esc`, `down`, `ctrl+c`, ... |
| `herdr_interrupt` | Stop the current turn (esc for agents, ctrl+c for programs) and report what happened |
| `herdr_kill`, `herdr_rm` | End a program; remove a finished terminal |
| `herdr_label` | Set or remove labels |
| `herdr_put` | Write a file beside a live terminal, on its machine, for its program to read |
| `herdr_templates` | Ready-made agent roles (`~/.config/herdr-core/templates/*.md`) to run by name |

### Commands and files, here or on another machine

| Tool | What it does |
| --- | --- |
| `herdr_exec` | Run one command without a terminal and get its exit code and exact output (decoded) |
| `herdr_file_read` | Read a text file, with `offset` and `limit` |
| `herdr_file_write` | Write a whole file atomically, making missing folders |
| `herdr_file_edit` | Replace exact text; each `old` must occur once; all edits or none |

Every one of these takes `on` to target a machine from `herdr_machines` (`hc machine add`).

### Machines and the core

| Tool | What it does |
| --- | --- |
| `herdr_machines` | The machines this core has added and their connection state |
| `herdr_status` | Core identity, version, uptime and terminal counts; this server's connection |
| `herdr_rpc` | Any other herdr-core method by name (`doc.get`, `doc.set`, `machine.add`, `terminal.keep`, ...). `server.stop` and `server.restart` are refused |

### The window (herdr-app)

| Tool | What it does |
| --- | --- |
| `herdr_app_ls` | Spaces, tabs and terminals with pane IDs |
| `herdr_app_status` | Layout, selection, focus, overlays, errors |
| `herdr_app_commands` | Every window command with its arguments |
| `herdr_app_do` | Run one: `space.new`, `tab.new`, `pane.split`, `agent.focus`, `tab.select`, ... |
| `herdr_app_shot` | Save the window's last frame as a PNG |

## How an agent is meant to use it

The server's instructions (sent to the client on connect) follow `hc --skill`:

1. Delegate with `herdr_run`: `background: true`, a `name`, a `cwd`, and the whole task in `task`.
   Prefer a template from `herdr_templates`. Check `first_message.sent` in the result.
2. Keep working, then `herdr_wait` on the terminal (or `children: "all"`) instead of polling.
3. `herdr_read` the result before summarizing it. A `blocked` status means a person is needed:
   read the screen and ask the user rather than forcing a send.
4. `herdr_kill` then `herdr_rm` only what you started. Never stop the user's core.
5. Use `herdr_app_*` only to change what the person sees; new spaces and tabs appear immediately,
   so create them only when asked. A terminal started with the label `herdr.space=<id>` shows up
   in that space.

## Development

```sh
npm install
npm run dev          # tsx src/index.ts
npm test             # build, then a stdio smoke test against the local core
```

`src/hc.ts` is the `hc connect` JSON-RPC client, `src/app.ts` wraps the `herdr-app` CLI, and
`src/index.ts` defines the tools. `hc schema` prints the full OpenRPC document the core tools
are built from.

## License

MIT
