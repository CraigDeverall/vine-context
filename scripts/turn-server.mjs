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

function start() {
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
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const logs = docker(["logs", NAME]);
    if (/listener opened|Listener opened|IPv4\. .*listener/i.test(`${logs.stdout}${logs.stderr}`)) return;
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 300)"]);
  }
  console.error("coturn didn't start listening within 20s:");
  console.error(docker(["logs", "--tail", "30", NAME]).stdout);
  stop();
  process.exit(1);
}

const env = { VINE_TEST_TURN: `127.0.0.1:${PORT}`, VINE_TEST_TURN_USER: USER, VINE_TEST_TURN_PASSWORD: PASSWORD };

switch (process.argv[2]) {
  case "start":
    start();
    console.log(`coturn is listening. Run the test with:\n  ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")} npx vitest run test/turn.test.ts`);
    break;
  case "stop":
    stop();
    break;
  case "test": {
    start();
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
