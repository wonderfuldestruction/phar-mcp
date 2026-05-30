#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const fixtures = JSON.parse(readFileSync("reports/reward-fixtures.latest.json", "utf8"));
const latestBlock = fixtures.latestBlock;
if (!latestBlock) throw new Error("reports/reward-fixtures.latest.json is missing latestBlock");

const forkUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const host = "127.0.0.1";
const port = process.env.PHAR_MCP_FORK_PORT ?? "8546";
const forkRpcUrl = `http://${host}:${port}`;
const anvilArgs = [
  "--fork-url",
  forkUrl,
  "--fork-block-number",
  String(latestBlock),
  "--chain-id",
  "43114",
  "--host",
  host,
  "--port",
  port
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      ...options
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"} signal ${signal ?? "null"}`));
    });
  });
}

async function rpcReady() {
  try {
    const response = await fetch(forkRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] })
    });
    const body = await response.json();
    return typeof body.result === "string";
  } catch {
    return false;
  }
}

async function waitForRpc() {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (await rpcReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Anvil fork RPC at ${forkRpcUrl}`);
}

const reportScripts = [
  "rehearse:reward-claims:report",
  "rehearse:fork:report",
  "rehearse:mixed-route:report",
  "rehearse:vote:report",
  "rehearse:pool-creation:report"
];

function stopAnvil(anvil) {
  return new Promise((resolve) => {
    if (anvil.exitCode !== null || anvil.signalCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      if (anvil.exitCode === null && anvil.signalCode === null) anvil.kill("SIGKILL");
    }, 5_000);
    anvil.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    anvil.kill("SIGTERM");
  });
}

async function runWithFreshFork(script) {
  const anvil = spawn("anvil", anvilArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });
  let anvilOutput = "";
  for (const stream of [anvil.stdout, anvil.stderr]) {
    stream.on("data", (chunk) => {
      anvilOutput += chunk.toString();
      if (process.env.PHAR_MCP_ANVIL_LOG === "1") process.stderr.write(chunk);
    });
  }

  try {
    await waitForRpc();
    await run("npm", ["run", script], {
      env: { ...process.env, FORK_RPC_URL: forkRpcUrl }
    });
  } catch (error) {
    const details = anvilOutput.split("\n").slice(-40).join("\n");
    throw new Error(`${script}: ${error instanceof Error ? error.message : String(error)}\n\nRecent Anvil output:\n${details}`);
  } finally {
    await stopAnvil(anvil);
  }
}

for (const script of reportScripts) {
  await runWithFreshFork(script);
}
