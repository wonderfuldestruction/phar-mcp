#!/usr/bin/env node
import { createPublicClient, http } from "viem";
import { avalanche } from "viem/chains";
import { DEFAULT_AVALANCHE_RPC_URL } from "../dist/contracts.js";
import { poolDiscover } from "../dist/queryTools.js";

const rpcUrl = process.env.AVALANCHE_RPC_URL || DEFAULT_AVALANCHE_RPC_URL;
const client = createPublicClient({
  chain: avalanche,
  transport: http(rpcUrl)
});

const wavax = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
const usdc = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
const phar = "0x13A466998Ce03Db73aBc2d4DF3bBD845Ed1f28E7";

const cases = [
  {
    name: "wavax_usdc_all",
    args: { tokenA: wavax, tokenB: usdc }
  },
  {
    name: "phar_usdc_all",
    args: { tokenA: phar, tokenB: usdc }
  },
  {
    name: "wavax_usdc_explicit_cl_dlmm",
    args: {
      tokenA: wavax,
      tokenB: usdc,
      protocols: ["cl", "dlmm"],
      tickSpacings: ["5", "10"],
      binSteps: ["5"]
    }
  }
];

function countExisting(entries) {
  return Array.isArray(entries) ? entries.filter((entry) => entry.exists).length : 0;
}

const results = [];
for (const testCase of cases) {
  try {
    const result = await poolDiscover(client, testCase.args);
    results.push({
      name: testCase.name,
      ok: true,
      args: testCase.args,
      result,
      counts: {
        legacyExisting: countExisting(result.legacy),
        clExisting: countExisting(result.cl),
        dlmmExisting: countExisting(result.dlmm),
        warnings: result.warnings?.length ?? 0
      }
    });
  } catch (error) {
    results.push({
      name: testCase.name,
      ok: false,
      args: testCase.args,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

const summary = {
  cases: results.length,
  failures: results.filter((entry) => !entry.ok).length,
  legacyExisting: results.reduce((sum, entry) => sum + (entry.counts?.legacyExisting ?? 0), 0),
  clExisting: results.reduce((sum, entry) => sum + (entry.counts?.clExisting ?? 0), 0),
  dlmmExisting: results.reduce((sum, entry) => sum + (entry.counts?.dlmmExisting ?? 0), 0),
  warnings: results.reduce((sum, entry) => sum + (entry.counts?.warnings ?? 0), 0)
};

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

console.log(JSON.stringify({
  timestamp: new Date().toISOString(),
  chainId: 43114,
  rpcUrl,
  summary,
  cases: results
}, jsonReplacer, 2));

if (summary.failures > 0) {
  process.exitCode = 1;
}
