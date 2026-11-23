#!/usr/bin/env node
// A TURN server for the tests: coturn in Docker, with one fixed test user.
//
//   node scripts/turn-server.mjs start   start it (and wait until it listens)
//   node scripts/turn-server.mjs stop    stop it
//   node scripts/turn-server.mjs test    start it, run test/turn.test.ts against it, stop it
//
// It runs one container, named vine-test-coturn, with no volumes, and removes
// only that container. The user and password are for this throwaway server.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";

const NAME = "vine-test-coturn";
const IMAGE = "coturn/coturn:4.6";
const PORT = 3478;
const RELAY_PORTS = [49160, 49200];
const USER = "vine";
const PASSWORD = "vine-test-only";

const docker = (args, opts = {}) => spawnSync("docker", args, { encoding: "utf8", ...opts });

function stop() {
  docker(["rm", "-f", NAME]);
}

/**
 * True once a STUN server answers a binding request on host:port over UDP.
 * coturn answers these without credentials, so this tells it's serving: its
 * log can't (through `docker logs` its output is buffered, and lines arrive late).
 */
function stunAnswers(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = createSocket(host.includes(":") ? "udp6" : "udp4");
    const id = randomBytes(12);
    // A binding request: type 0x0001, length 0, the magic cookie, a transaction id.
    const request = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), id]);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.close();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    // A binding success response (0x0101) for this transaction.
    sock.on("message", (m) => m.length >= 20 && m.readUInt16BE(0) === 0x0101 && m.subarray(8, 20).equals(id) && done(true));
    sock.on("error", () => done(false));
    sock.send(request, port, host, (e) => e && done(false));
  });
}

async function start() {
  if (docker(["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    console.error("Docker isn't running: the TURN test needs it.");
    process.exit(1);
  }
  stop();
  // Linux: the host's network, so relay addresses are the host's own. Elsewhere
  // (Docker Desktop) the container is behind a VM: publish the ports instead.
  const network =
    process.platform === "linux"
      ? ["--network", "host"]
      : ["-p", `${PORT}:${PORT}/udp`, "-p", `${PORT}:${PORT}/tcp`, "-p", `${RELAY_PORTS[0]}-${RELAY_PORTS[1]}:${RELAY_PORTS[0]}-${RELAY_PORTS[1]}/udp`];
  const r = docker(
    [
      "run", "-d", "--rm", "--name", NAME, ...network, IMAGE,
      "-n", "--log-file=stdout", "--lt-cred-mech", `--user=${USER}:${PASSWORD}`, "--realm=vine.test",
      `--listening-port=${PORT}`, `--min-port=${RELAY_PORTS[0]}`, `--max-port=${RELAY_PORTS[1]}`,
      "--allow-loopback-peers", "--no-tls", "--no-dtls", "--no-cli",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (await stunAnswers("127.0.0.1", PORT)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error("coturn didn't answer on its port within 30s:");
  console.error(docker(["logs", "--tail", "60", NAME]).stdout);
  stop();
  process.exit(1);
}

const env = { VINE_TEST_TURN: `127.0.0.1:${PORT}`, VINE_TEST_TURN_USER: USER, VINE_TEST_TURN_PASSWORD: PASSWORD };

switch (process.argv[2]) {
  case "start":
    await start();
    console.log(`coturn is listening. Run the test with:\n  ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")} npx vitest run test/turn.test.ts`);
    break;
  case "stop":
    stop();
    break;
  case "test": {
    await start();
    let code = 1;
    try {
      const r = spawnSync("npx", ["vitest", "run", "test/turn.test.ts"], { stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });
      code = r.status ?? 1;
    } finally {
      stop();
    }
    process.exit(code);
    break;
  }
  default:
    console.log("Usage: node scripts/turn-server.mjs start|stop|test");
    process.exit(2);
}
