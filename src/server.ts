#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JobManager } from "./job-manager.ts";
import { Telemetry } from "./telemetry.ts";
import { registerTools } from "./tools.ts";

const VERSION = "0.1.0";

export function buildServer(jm: JobManager, telemetry?: Telemetry): McpServer {
  const server = new McpServer({ name: "cursor-bridge", version: VERSION });
  registerTools(server, jm, telemetry);
  return server;
}

if (import.meta.main) {
  const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const jm = new JobManager({ jobsDir: path.join(projectRoot, "jobs") });
  const telemetry = new Telemetry({
    logsDir: path.join(projectRoot, "logs"),
    jobsDir: path.join(projectRoot, "jobs"),
    activeJobIds: () => jm.activeJobIds(),
  });
  jm.attachTelemetry(telemetry);
  await telemetry.startup();
  telemetry.record("server", { event: "start", version: VERSION });
  let finishing = false;
  const bye = (reason: string) => {
    if (finishing) return;
    finishing = true;
    telemetry.record("server", { event: "shutdown", reason });
    jm.shutdown();
    // hard backstop first (unref'd), then a graceful path: wait for job done-handlers
    // to enqueue their terminal telemetry, flush, exit early if that completes sooner
    setTimeout(() => process.exit(0), 3_500).unref();
    void (async () => {
      await jm.drain(2_500);
      await telemetry.flush(300);
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => bye("SIGINT"));
  process.on("SIGTERM", () => bye("SIGTERM"));
  process.stdin.on("end", () => bye("stdin-eof"));
  process.stdin.on("close", () => bye("stdin-eof"));
  await buildServer(jm, telemetry).connect(new StdioServerTransport());
}
