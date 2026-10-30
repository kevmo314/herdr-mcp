// Smoke test: start the built server over stdio, list tools, and call a few read-only
// ones against the local herdr-core. Needs `hc` on PATH and a running core.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: "node", args: [path.join(here, "..", "dist", "index.js")] });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`${tools.length} tools:`, tools.map((t) => t.name).join(", "));

const status = await client.callTool({ name: "herdr_status", arguments: {} });
console.log("herdr_status:", status.isError ? "ERROR " + status.content[0].text : "ok");

const list = await client.callTool({ name: "herdr_list", arguments: {} });
console.log("herdr_list:", list.isError ? "ERROR " + list.content[0].text : "ok");

const exec = await client.callTool({ name: "herdr_exec", arguments: { argv: ["echo", "hello from herdr"] } });
const execOut = JSON.parse(exec.content[0].text);
console.log("herdr_exec:", exec.isError ? "ERROR" : execOut.stdout.trim());
if (execOut.stdout.trim() !== "hello from herdr") throw new Error("exec output mismatch");

const bad = await client.callTool({ name: "herdr_get", arguments: { terminal: "t999999" } });
console.log("herdr_get (missing):", bad.isError ? "isError as expected: " + bad.content[0].text.split("\n")[0] : "UNEXPECTED success");
if (!bad.isError) throw new Error("expected an error for a missing terminal");

await client.close();
console.log("smoke ok");
