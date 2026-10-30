// A JSON-RPC 2.0 client for herdr-core over `hc connect` (one JSON message per line on
// the child's stdin/stdout). One child process is kept for the life of the server and
// restarted on demand if it dies.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface HcError {
  code: number;
  message: string;
  data?: { kind?: string; hint?: string; [k: string]: unknown };
}

export class HcRpcError extends Error {
  constructor(
    public readonly method: string,
    public readonly rpc: HcError,
  ) {
    super(rpc.message);
    this.name = "HcRpcError";
  }
  /** What an agent should see: the message, the stable kind and the hint, if any. */
  describe(): string {
    const parts = [`${this.method}: ${this.rpc.message}`];
    if (this.rpc.data?.kind) parts.push(`kind: ${this.rpc.data.kind}`);
    if (this.rpc.data?.hint) parts.push(`hint: ${this.rpc.data.hint}`);
    return parts.join("\n");
  }
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface HcClientOptions {
  /** The hc binary (default: `hc`, or $HERDR_MCP_HC). */
  bin?: string;
  /** The hc session, like HC_SESSION. */
  session?: string;
  /** The protocol generation we speak. */
  generation?: number;
}

export interface HelloResult {
  generation: number;
  version: string;
  core: { id: string; name: string };
  framed: boolean;
  methods: string[];
  features: string[];
}

export class HcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<HelloResult> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private hello: HelloResult | null = null;
  private stderrTail: string[] = [];

  constructor(private readonly opts: HcClientOptions = {}) {}

  get bin(): string {
    return this.opts.bin ?? process.env.HERDR_MCP_HC ?? "hc";
  }

  /** The hello result from the current connection, if any. */
  get info(): HelloResult | null {
    return this.hello;
  }

  /** Connect (or reuse the live connection) and return the handshake. */
  connect(): Promise<HelloResult> {
    if (this.ready) return this.ready;
    this.ready = this.start().catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  private async start(): Promise<HelloResult> {
    const args = ["connect"];
    const session = this.opts.session ?? process.env.HC_SESSION;
    if (session) args.push("--session", session);

    const child = spawn(this.bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    this.stderrTail = [];

    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (e) => reject(e));
    });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this.onLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      this.hello = null;
      const why = this.stderrTail.length
        ? this.stderrTail.join("\n")
        : `hc connect exited (code ${code}, signal ${signal})`;
      for (const p of this.pending.values()) {
        p.reject(new Error(`${p.method}: connection to herdr-core lost: ${why}`));
      }
      this.pending.clear();
    });

    try {
      await spawned;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(
          `could not start \`${this.bin}\`: herdr-core is not installed or not on PATH. ` +
            `Install Herdr (https://herdr.dev) or set HERDR_MCP_HC to the hc binary.`,
        );
      }
      throw err;
    }

    const hello = (await this.rawCall(child, "hello", {
      generation: this.opts.generation ?? 1,
    })) as HelloResult;
    this.hello = hello;
    return hello;
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: { id?: number; result?: unknown; error?: HcError };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not ours: hc may print a note
    }
    if (typeof msg.id !== "number") return; // a notification; events aren't subscribed here
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new HcRpcError(p.method, msg.error));
    else p.resolve(msg.result);
  }

  private rawCall(child: ChildProcessWithoutNullStreams, method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      const ok = child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      if (!ok) child.stdin.once("drain", () => {});
    });
  }

  /** Call a herdr-core method. Null and undefined params are dropped. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    const child = this.child;
    if (!child) throw new Error(`${method}: not connected to herdr-core`);
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) clean[k] = v;
    return (await this.rawCall(child, method, clean)) as T;
  }

  close() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.hello = null;
    if (child) {
      child.stdin.end();
      child.kill();
    }
  }
}
