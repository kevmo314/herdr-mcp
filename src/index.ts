#!/usr/bin/env node
// herdr-mcp: an MCP server for Herdr. Terminals, agents, files and machines go through
// herdr-core's JSON-RPC API (`hc connect`); the window goes through `herdr-app`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HcClient, HcRpcError } from "./hc.js";
import { parseOutput, runApp } from "./app.js";

const VERSION = "0.1.0";

const INSTRUCTIONS = `Herdr runs programs and coding agents (Claude Code, Codex, pi, ...) in terminals that stay alive, on this machine and on others it has added. These tools drive it.

Addresses: a terminal is "t7", a name ("review"), or "machine/t7" on another machine. Spaces, tabs and panes are the window's; terminals are herdr-core's.

Delegate work: herdr_run with background=true (never stream an agent's screen), a name, a cwd, and the whole task as the first message via "task" (a send to a booting agent can be dropped; check first_message.sent). Prefer a template from herdr_templates when one fits. Then keep doing useful work and herdr_wait on it (terminal or children) instead of polling. Read results with herdr_read; never infer success from an expected outcome.

Status comes from the program's own reports: idle, working, done, blocked, error; plain programs report none. "blocked" means a person is needed: read the screen and ask the user; do not force a send to bypass a permission decision.

Clean up only terminals you started (herdr_kill, then herdr_rm). Never stop or restart the user's core: it affects every terminal.

Window: herdr_app_ls / herdr_app_status to inspect, herdr_app_do to run a window command (space.new, tab.new, pane.split, agent.focus, ...; herdr_app_commands lists them). New spaces and tabs are shown immediately, so only create them when asked, and name them. A terminal started with labels herdr.space=<id> (and optionally herdr.tab=<id>) appears in the window; unlabeled ones stay hidden.`;

const hc = new HcClient();
const caller = process.env.HC_TERMINAL_ID || undefined;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));
const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: e instanceof HcRpcError ? e.describe() : e instanceof Error ? e.message : String(e) }],
  isError: true,
});

/** Run a handler and turn thrown errors into an isError result. */
const guard =
  <A>(fn: (a: A) => Promise<ToolResult>) =>
  async (a: A): Promise<ToolResult> => {
    try {
      return await fn(a);
    } catch (e) {
      return fail(e);
    }
  };

const b64decode = (s: string | undefined | null): string => (s ? Buffer.from(s, "base64").toString("utf8") : "");
const b64encode = (s: string): string => Buffer.from(s, "utf8").toString("base64");

const terminalArg = z.string().describe("The terminal: `t7`, a name, or `machine/t7`.");
const onArg = z.string().optional().describe("Another machine (see herdr_machines); default: this one.");
const cwdArg = z.string().optional().describe("Working directory. Default: the core's; on another machine, its home.");
const timeoutArg = z.number().optional().describe("Seconds before the wait checks in, leaving it running (default 180).");

const server = new McpServer({ name: "herdr", version: VERSION }, { instructions: INSTRUCTIONS });

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

server.registerTool(
  "herdr_list",
  {
    title: "List terminals",
    description:
      "Live terminals on this machine and every connected machine, with their status, cwd, labels and parent. Includes the user's other work, not just yours.",
    inputSchema: {
      all: z.boolean().optional().describe("Include finished terminals."),
      labels: z.record(z.string()).optional().describe("Only terminals carrying all of these labels."),
    },
  },
  guard(async ({ all, labels }) => json(await hc.call("terminal.list", { all, labels }))),
);

server.registerTool(
  "herdr_get",
  {
    title: "Get a terminal",
    description: "One terminal's facts, live or finished: argv, cwd, state, status, exit code, labels, foreground process.",
    inputSchema: { terminal: terminalArg },
  },
  guard(async ({ terminal }) => json(await hc.call("terminal.get", { terminal, caller }))),
);

server.registerTool(
  "herdr_run",
  {
    title: "Run a program or agent",
    description:
      "Start a program in a new terminal that stays alive. argv runs as given; line runs in the shell; neither opens that machine's shell. " +
      "If argv[0] names a template (see herdr_templates), its command starts and its body plus `task` are sent as the first message once the agent is ready. " +
      "For a plain agent, `task` is typed as its first message once it is ready. " +
      "Agents: always background=true, a name, and the whole task up front. Programs: background=false waits for exit (up to timeout) and returns its output in `output` and how it ended in `wait`. " +
      "Returns the terminal (address is what you use afterwards) and, with a task, first_message.sent.",
    inputSchema: {
      argv: z.array(z.string()).optional().describe("Program and arguments, or a template name."),
      line: z.string().optional().describe("A shell line instead of argv (`cd app && npm test`)."),
      task: z.string().optional().describe("The agent's first message (a template's task, or typed once an agent is ready)."),
      name: z.string().optional().describe("Unique among live terminals: 1-32 of a-z 0-9 - _ ."),
      cwd: cwdArg,
      on: onArg,
      env: z.record(z.string()).optional().describe("Environment on top of the core's."),
      labels: z.record(z.string()).optional().describe("Free-form labels. herdr.space=<id> shows it in the window."),
      background: z.boolean().optional().describe("Return as soon as it runs (default true). False: wait like a shell and include its output."),
      timeout: timeoutArg,
      outlive_parent: z.boolean().optional().describe("Keep running when the caller's terminal ends."),
      keep: z.boolean().optional().describe("Replace a lost program with a shell in place (never re-run)."),
      rm: z.boolean().optional().describe("Remove the terminal right after it exits."),
    },
  },
  guard(async ({ argv, line, task, name, cwd, on, env, labels, background, timeout, outlive_parent, keep, rm }) => {
    if (argv?.length && line) throw new Error("give argv or line, not both");
    const wait = background === false;
    const fullArgv = argv ? [...argv] : undefined;
    let sendAfter: string | undefined;
    if (task) {
      // A template takes its task in argv; a plain agent gets it typed once ready.
      const templates = (await hc.call<{ templates: { name: string }[] }>("templates.list")).templates;
      if (fullArgv && templates.some((t) => t.name === fullArgv[0])) fullArgv.push(task);
      else sendAfter = task;
    }
    // The core drops the output of a waited run that is removed at exit, so a foreground
    // run with rm is removed here, after its output is in hand.
    const rmAfter = wait && rm === true;
    const run = await hc.call<Record<string, unknown>>("terminal.run", {
      argv: fullArgv,
      line,
      name,
      cwd,
      on,
      env,
      labels,
      wait,
      timeout,
      outlive_parent,
      keep,
      rm: rmAfter ? undefined : rm,
      caller,
    });
    const address = run.address as string;
    const ended = run.wait as { ended?: boolean; reason?: string } | null | undefined;
    if (rmAfter && ended?.ended && ended.reason === "exit") {
      try {
        await hc.call("terminal.rm", { terminal: address, caller });
        run.removed = true;
      } catch {
        run.removed = false;
      }
    }
    if (sendAfter) {
      // Wait until the agent is ready (not working), then type the task.
      const ready = await hc.call<{ ended: boolean; reason: string; status?: string | null }>("terminal.wait", {
        terminal: address,
        timeout: Math.min(timeout ?? 60, 180),
        caller,
      });
      let first: Record<string, unknown>;
      if (ready.reason === "exit") {
        first = { sent: false, reason: "the program exited before the task could be sent" };
      } else {
        try {
          const sent = await hc.call<Record<string, unknown>>("terminal.send", { terminal: address, text: sendAfter, caller });
          first = { sent: true, ...sent };
        } catch (e) {
          first = { sent: false, reason: e instanceof HcRpcError ? e.describe() : String(e) };
        }
      }
      run.first_message = first;
    }
    return json(run);
  }),
);

server.registerTool(
  "herdr_send",
  {
    title: "Send a message",
    description:
      "Paste text into a terminal and press Enter (once nobody has typed for ~3 s). Refuses a blocked program unless force. " +
      "With wait=true, also waits for the turn it starts and returns how it ended. Do not resend after an unclear result: read first.",
    inputSchema: {
      terminal: terminalArg,
      text: z.string().describe("Pasted, then submitted with Enter."),
      wait: z.boolean().optional().describe("Wait for the turn this send starts."),
      timeout: timeoutArg,
      force: z.boolean().optional().describe("Type even if the program is blocked. Never use it to bypass a permission decision."),
      if: z.enum(["idle", "working"]).optional().describe("Only type if the status is exactly this."),
    },
  },
  guard(async (a) => json(await hc.call("terminal.send", { ...a, caller }))),
);

server.registerTool(
  "herdr_wait",
  {
    title: "Wait on a terminal",
    description:
      "Wait until a program is not working (an agent reports idle/done/blocked/error, or a program exits), or with `output`, until it prints that text. " +
      "Use it instead of sleeping or polling. A timeout is a check-in (ended=false), not a failure: wait again. " +
      "children=all waits until none of the caller's children is working; children=any returns on the next child's news.",
    inputSchema: {
      terminal: z.string().optional().describe("The terminal; with children, whose children (default: the caller)."),
      children: z.enum(["any", "all"]).optional(),
      output: z.string().optional().describe("For programs: end when output printed after the wait starts contains this text."),
      timeout: timeoutArg,
    },
  },
  guard(async (a) => json(await hc.call("terminal.wait", { ...a, caller }))),
);

server.registerTool(
  "herdr_read",
  {
    title: "Read a terminal",
    description: "The terminal's screen plus `lines` of history, as plain text, live or finished.",
    inputSchema: {
      terminal: terminalArg,
      lines: z.number().int().min(0).optional().describe("Lines of history above the screen (default 100)."),
    },
  },
  guard(async ({ terminal, lines }) => {
    const r = await hc.call<{ text: string; complete: boolean; how: string; why?: string | null }>("terminal.read", {
      terminal,
      lines: lines ?? 100,
      caller,
    });
    const note = r.complete ? "" : `\n\n[herdr: incomplete read (${r.how}${r.why ? `, ${r.why}` : ""}); read again once it stops]`;
    return text(r.text + note);
  }),
);

server.registerTool(
  "herdr_keys",
  {
    title: "Press keys",
    description: "Press named keys in a terminal: enter, esc, tab, up, down, ctrl+c, alt+x, f5, a, ... (e.g. to answer a dialog with down, enter).",
    inputSchema: { terminal: terminalArg, keys: z.array(z.string()).min(1) },
  },
  guard(async ({ terminal, keys }) => json(await hc.call("terminal.keys", { terminal, keys, caller }))),
);

server.registerTool(
  "herdr_interrupt",
  {
    title: "Interrupt",
    description: "Press the stop key (esc for agents, ctrl+c for programs) and report what happened. Stops the current turn, not the process.",
    inputSchema: { terminal: terminalArg, timeout: z.number().optional().describe("Seconds to watch for an effect (default 10).") },
  },
  guard(async (a) => json(await hc.call("terminal.interrupt", a))),
);

server.registerTool(
  "herdr_kill",
  {
    title: "Kill a terminal's program",
    description: "End the program: hangup, then terminate, then kill. Only clean up terminals you started.",
    inputSchema: { terminal: terminalArg },
  },
  guard(async ({ terminal }) => json(await hc.call("terminal.kill", { terminal, caller }))),
);

server.registerTool(
  "herdr_rm",
  {
    title: "Remove a finished terminal",
    description: "Remove a finished terminal from the list.",
    inputSchema: { terminal: terminalArg },
  },
  guard(async ({ terminal }) => json(await hc.call("terminal.rm", { terminal, caller }))),
);

server.registerTool(
  "herdr_label",
  {
    title: "Label a terminal",
    description: "Set or remove labels (free-form key=value). An empty string removes a label.",
    inputSchema: { terminal: terminalArg, labels: z.record(z.string()) },
  },
  guard(async ({ terminal, labels }) => json(await hc.call("terminal.label", { terminal, labels }))),
);

server.registerTool(
  "herdr_put",
  {
    title: "Put a file beside a terminal",
    description: "Write a file beside a live terminal, on its machine, for its program to read (an image to paste, a patch). Returns where it landed.",
    inputSchema: {
      terminal: terminalArg,
      name: z.string().describe("The file's name."),
      text: z.string().optional().describe("UTF-8 content."),
      base64: z.string().optional().describe("Binary content, base64 (instead of text)."),
    },
  },
  guard(async ({ terminal, name, text: t, base64 }) => {
    const data = base64 ?? (t !== undefined ? b64encode(t) : undefined);
    if (!data) throw new Error("give text or base64");
    return json(await hc.call("terminal.put", { terminal, name, data }));
  }),
);

server.registerTool(
  "herdr_templates",
  {
    title: "List templates",
    description: "Ready-made agent roles (reviewer, implementer, ...) by name and description. Run one with herdr_run argv=[name] and a task.",
    inputSchema: {},
  },
  guard(async () => json(await hc.call("templates.list"))),
);

// ---------------------------------------------------------------------------
// Commands and files, here or on another machine
// ---------------------------------------------------------------------------

server.registerTool(
  "herdr_exec",
  {
    title: "Exec a command",
    description:
      "Run one command here or on another machine without a terminal and return its exit code and exactly what it wrote. " +
      "For short commands (git diff, ls, cat). Everything it started ends with it at exit or timeout. Use herdr_run for anything long or interactive.",
    inputSchema: {
      argv: z.array(z.string()).optional().describe("Program and arguments, run as given (no shell)."),
      line: z.string().optional().describe("A shell line instead of argv."),
      cwd: cwdArg,
      on: onArg,
      env: z.record(z.string()).optional(),
      input: z.string().optional().describe("Text for its stdin."),
      timeout: z.number().optional().describe("Seconds before it is ended (default 60, at most 600)."),
    },
  },
  guard(async ({ argv, line, cwd, on, env, input, timeout }) => {
    if (!argv?.length && !line) throw new Error("give argv or line");
    const r = await hc.call<{ code: number | null; signal: number | null; stdout: string; stderr: string; truncated: boolean; timed_out: boolean; ms: number }>(
      "machine.exec",
      { argv, line, cwd, on, env, input: input !== undefined ? b64encode(input) : undefined, timeout },
    );
    return json({ ...r, stdout: b64decode(r.stdout), stderr: b64decode(r.stderr) });
  }),
);

server.registerTool(
  "herdr_file_read",
  {
    title: "Read a file",
    description: "Read a text file here or on another machine: lines from offset, at most limit. Returns the text and how many lines the file has.",
    inputSchema: {
      path: z.string().describe("Absolute, or from cwd."),
      on: onArg,
      cwd: cwdArg,
      offset: z.number().int().min(1).optional().describe("The first line to give, from 1."),
      limit: z.number().int().min(0).optional().describe("At most this many lines."),
    },
  },
  guard(async (a) => {
    const r = await hc.call<{ text: string; first: number; last: number; lines: number }>("file.read", a);
    const head = r.last < r.first ? `[${r.lines} lines; none in range]` : `[lines ${r.first}-${r.last} of ${r.lines}]`;
    return text(`${head}\n${r.text}`);
  }),
);

server.registerTool(
  "herdr_file_write",
  {
    title: "Write a file",
    description: "Write a whole file here or on another machine, making missing folders. Atomic: a reader sees old or new, never half.",
    inputSchema: {
      path: z.string().describe("Absolute, or from cwd."),
      text: z.string().describe("Its new content."),
      on: onArg,
      cwd: cwdArg,
    },
  },
  guard(async ({ path, text: t, on, cwd }) => json(await hc.call("file.write", { path, data: b64encode(t), on, cwd }))),
);

server.registerTool(
  "herdr_file_edit",
  {
    title: "Edit a file",
    description:
      "Replace exact text in a file here or on another machine. Each `old` must occur exactly once; edits must not overlap; all are made or none. " +
      "On edit_failed, add context to make `old` unique.",
    inputSchema: {
      path: z.string().describe("Absolute, or from cwd."),
      edits: z.array(z.object({ old: z.string(), new: z.string() })).min(1),
      on: onArg,
      cwd: cwdArg,
    },
  },
  guard(async (a) => json(await hc.call("file.edit", a))),
);

// ---------------------------------------------------------------------------
// Machines and the core
// ---------------------------------------------------------------------------

server.registerTool(
  "herdr_machines",
  {
    title: "List machines",
    description: "The other machines this core has added (over ssh or a command), with their connection state. Use their names in `on` and `machine/t7`.",
    inputSchema: {},
  },
  guard(async () => json(await hc.call("machine.list"))),
);

server.registerTool(
  "herdr_status",
  {
    title: "Core status",
    description: "herdr-core's identity, version, pid, uptime and terminal counts, plus this server's connection details.",
    inputSchema: {},
  },
  guard(async () => {
    const status = await hc.call("server.status");
    return json({ server: { name: "herdr-mcp", version: VERSION, hc: hc.bin, caller: caller ?? null }, hello: hc.info, status });
  }),
);

server.registerTool(
  "herdr_rpc",
  {
    title: "Raw herdr-core call",
    description:
      "Call any herdr-core JSON-RPC method directly (rpc.discover lists them all with their schemas). For methods without a dedicated tool: doc.get, doc.set, machine.add, machine.connect, machine.rename, machine.rm, terminal.keep. " +
      "server.stop and server.restart are refused: they affect every terminal the user has.",
    inputSchema: {
      method: z.string(),
      params: z.record(z.unknown()).optional(),
    },
  },
  guard(async ({ method, params }) => {
    if (method === "server.stop" || method === "server.restart") throw new Error(`${method} is refused: it would affect every terminal the user has. Ask them to run \`hc server ${method.split(".")[1]}\` themselves.`);
    if (method === "terminal.attach" || method === "events.subscribe") throw new Error(`${method} needs a streaming connection; use herdr_read / herdr_wait instead.`);
    return json(await hc.call(method, params ?? {}));
  }),
);

// ---------------------------------------------------------------------------
// The window (herdr-app)
// ---------------------------------------------------------------------------

server.registerTool(
  "herdr_app_ls",
  {
    title: "Window: list spaces",
    description: "Spaces, their tabs and terminals (with pane IDs) in the open Herdr window. Inspect before acting; use these IDs rather than guessing.",
    inputSchema: {},
  },
  guard(async () => {
    const r = await runApp(["ls"]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `herdr-app ls exited ${r.code}`);
    return json(parseOutput(r.stdout));
  }),
);

server.registerTool(
  "herdr_app_status",
  {
    title: "Window: status",
    description: "What the window shows: layout, selected space and tab, focused pane, overlays, zoom, and any file or mod errors.",
    inputSchema: {},
  },
  guard(async () => {
    const r = await runApp(["status"]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `herdr-app status exited ${r.code}`);
    return json(parseOutput(r.stdout));
  }),
);

server.registerTool(
  "herdr_app_commands",
  {
    title: "Window: list commands",
    description: "Every window command herdr_app_do can run, with its arguments and what it does.",
    inputSchema: {},
  },
  guard(async () => {
    const r = await runApp(["commands"]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `herdr-app commands exited ${r.code}`);
    return json(parseOutput(r.stdout));
  }),
);

server.registerTool(
  "herdr_app_do",
  {
    title: "Window: run a command",
    description:
      "Run a window command: space.new {name, folder, machine, argv, task}, tab.new {name, space, folder, argv, task}, pane.split {direction, pane}, " +
      "agent.focus {terminal}, tab.select {id}, space.rename {id, name}, ... (herdr_app_commands lists them all). " +
      "Returns the created IDs. Supply every required argument: commands from an agent never open a dialog. " +
      "New spaces and tabs are shown immediately: only create them when the user asks, and give them explicit names.",
    inputSchema: {
      command: z.string().describe("The command name, e.g. tab.new."),
      args: z.record(z.unknown()).optional().describe("Its arguments as an object."),
    },
  },
  guard(async ({ command, args }) => {
    const r = await runApp(["do", command, JSON.stringify(args ?? {})]);
    const out = parseOutput(r.stdout);
    if (r.code !== 0) {
      const msg = typeof out === "object" && out && "error" in out ? String((out as { error: unknown }).error) : r.stderr.trim() || r.stdout.trim();
      throw new Error(msg || `herdr-app do ${command} exited ${r.code}`);
    }
    return json(out ?? { ok: true });
  }),
);

server.registerTool(
  "herdr_app_shot",
  {
    title: "Window: screenshot",
    description: "Save the window's last rendered frame as a PNG (its own rendering, even when covered) and return its absolute path. Needs a running window.",
    inputSchema: { file: z.string().optional().describe("Where to save (default: herdr-shot.png in the current folder).") },
  },
  guard(async ({ file }) => {
    const r = await runApp(file ? ["shot", file] : ["shot"]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `herdr-app shot exited ${r.code}`);
    return text(r.stdout.trim());
  }),
);

// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const stop = () => {
    hc.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdin.on("close", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
