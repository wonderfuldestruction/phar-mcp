#!/usr/bin/env node
import { createPublicClient, http } from "viem";
import { avalanche } from "viem/chains";
import { clQuote } from "../dist/queryTools.js";
import { contractRegistry } from "../dist/contracts.js";

const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const client = createPublicClient({ chain: avalanche, transport: http(rpcUrl) });

const WAVAX = contractRegistry.wavax.address;
const USDC = contractRegistry.usdcNative.address;
const PHAR = contractRegistry.pharToken.address;

const cases = [
  {
    name: "quoterV2_wavax_usdc_10",
    input: {
      quoter: "quoterV2",
      action: "quoteExactInputSingle",
      tokenIn: WAVAX,
      tokenOut: USDC,
      tickSpacing: "10",
      amountIn: "1000000000000000"
    }
  },
  {
    name: "quoterV2_wavax_usdc_5_preflight",
    input: {
      quoter: "quoterV2",
      action: "quoteExactInputSingle",
      tokenIn: WAVAX,
      tokenOut: USDC,
      tickSpacing: "5",
      amountIn: "1000000000000000"
    }
  },
  {
    name: "mixedRoute_v3_wavax_usdc_10",
    input: {
      quoter: "mixedRouteQuoterV1",
      action: "quoteExactInputSingleV3",
      tokenIn: WAVAX,
      tokenOut: USDC,
      tickSpacing: "10",
      amountIn: "1000000000000000"
    }
  },
  {
    name: "mixedRoute_v2_usdc_phar_volatile",
    input: {
      quoter: "mixedRouteQuoterV1",
      action: "quoteExactInputSingleV2",
      tokenIn: USDC,
      tokenOut: PHAR,
      stable: false,
      amountIn: "100000"
    }
  }
];

const results = [];

for (const testCase of cases) {
  try {
    results.push({
      name: testCase.name,
      input: testCase.input,
      ok: true,
      result: await clQuote(client, testCase.input)
    });
  } catch (error) {
    results.push({
      name: testCase.name,
      input: testCase.input,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

const summary = {
  cases: results.length,
  toolErrors: results.filter((result) => !result.ok).length,
  quoteSuccesses: results.filter((result) => result.ok && result.result?.ok === true).length,
  structuredQuoteFailures: results.filter((result) => result.ok && result.result?.ok === false).length,
  hardPreflightBlockers: results.flatMap((result) => result.result?.preflight?.blockers ?? []).filter((blocker) => blocker.severity === "error").length
};

console.log(JSON.stringify({
  timestamp: new Date().toISOString(),
  chainId: 43114,
  rpcUrl,
  summary,
  cases: results
}, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
