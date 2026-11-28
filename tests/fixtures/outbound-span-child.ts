// Child process for tests/outbound-url.test.ts: real dd-trace, a fake agent
// on loopback, and notifySlack sent through a loopback proxy, so no request
// leaves the machine. Prints the raw trace payloads the agent received.
const agent: Uint8Array[] = [];
const agentServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (new URL(req.url).pathname.includes("traces")) {
      agent.push(new Uint8Array(await req.arrayBuffer()));
    }
    return Response.json({});
  },
});
const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });

process.env.DD_TRACE_ENABLED = "true";
process.env.DD_TRACE_AGENT_URL = `http://127.0.0.1:${agentServer.port}`;
process.env.DD_TRACE_AGENT_PROTOCOL_VERSION = "0.4";
process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = "false";
process.env.DD_REMOTE_CONFIGURATION_ENABLED = "false";
process.env.DD_TRACE_STATS_COMPUTATION_ENABLED = "false";
process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
process.env.http_proxy = process.env.HTTP_PROXY;
// The tracer's own uploads to the fake agent must not go through the proxy.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = process.env.NO_PROXY;
process.env.SLACK_WEBHOOK_URL = process.argv[2];

const { tracer } = await import("../../src/observability/tracer");
const { notifySlack } = await import("../../src/utils/notify");

const sent = await notifySlack("trace redaction test");
await fetch(process.argv[3] ?? "http://127.0.0.1:9/").catch(() => {});
(tracer as unknown as { flush?: (cb: () => void) => void }).flush?.(() => {});
const deadline = Date.now() + 8000;
while (agent.length === 0 && Date.now() < deadline) await Bun.sleep(100);
await Bun.sleep(200);
const text = agent.map((b) => Buffer.from(b).toString("latin1")).join("\n");
process.stdout.write(JSON.stringify({ sent, payloads: agent.length, text }));
process.exit(0);
