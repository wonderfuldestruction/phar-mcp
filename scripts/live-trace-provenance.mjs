#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { avalanche } from "viem/chains";

const reportDir = "reports";
const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const wallet = (process.env.PHAR_MCP_WALLET ?? "0x0000000000000000000000000000000000000000").toLowerCase();
const client = createPublicClient({ chain: avalanche, transport: http(rpcUrl, { timeout: 120_000, retryCount: 0 }) });
const representativeFunctionKeys = [
  "erc20.approve",
  "router.swapExactTokensForTokens",
  "xPharToken.convertEmissionsToken",
  "p33.deposit",
  "p33.mint",
  "p33.redeem",
  "p33.withdraw",
  "autoVault.deposit",
  "ramsesV3PositionManager.mint",
  "dlmmRouter.addLiquidity",
  "dlmmRouter.addLiquidityNATIVE",
  "dlmmRouter.removeLiquidity",
  "universalRouter.executeDeadline",
  "voter.vote",
  "xPharToken.exit"
];
const traceMethods = [
  {
    method: "debug_traceTransaction",
    params: (hash) => [hash, { tracer: "callTracer", timeout: "20s" }],
    resultKind: "callTracer"
  },
  {
    method: "trace_transaction",
    params: (hash) => [hash],
    resultKind: "parityTrace"
  }
];

function stringify(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function readJson(file) {
  const path = `${reportDir}/${file}`;
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function shortError(error) {
  return error?.shortMessage ?? error?.message ?? String(error);
}

function isUnavailable(error) {
  const message = shortError(error).toLowerCase();
  return message.includes("does not exist") ||
    message.includes("not available") ||
    message.includes("method not found") ||
    message.includes("unsupported method") ||
    message.includes("the method") && message.includes("does not exist");
}

function increment(map, key, amount = 1) {
  map[key] = (map[key] ?? 0) + amount;
}

function summarizeCallTrace(root) {
  const targetCounts = {};
  const selectorCounts = {};
  let callCount = 0;
  let maxDepth = 0;

  function walk(call, depth) {
    if (!call || typeof call !== "object") return;
    callCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    if (typeof call.to === "string") increment(targetCounts, call.to.toLowerCase());
    if (typeof call.input === "string" && call.input.length >= 10) increment(selectorCounts, call.input.slice(0, 10).toLowerCase());
    for (const child of call.calls ?? []) walk(child, depth + 1);
  }

  walk(root, 0);
  return {
    callCount,
    maxDepth,
    targetCounts,
    selectorCounts,
    root: root && typeof root === "object"
      ? {
        type: root.type ?? null,
        from: root.from ?? null,
        to: root.to ?? null,
        value: root.value ?? null,
        inputSelector: typeof root.input === "string" && root.input.length >= 10 ? root.input.slice(0, 10).toLowerCase() : null,
        outputBytes: typeof root.output === "string" && root.output.startsWith("0x") ? Math.max(0, (root.output.length - 2) / 2) : null,
        error: root.error ?? null,
        reverted: root.reverted ?? null,
        childCount: Array.isArray(root.calls) ? root.calls.length : 0
      }
      : null
  };
}

function summarizeParityTrace(rows = []) {
  const targetCounts = {};
  const selectorCounts = {};
  const typeCounts = {};
  let maxDepth = 0;
  for (const row of rows) {
    const action = row?.action ?? {};
    increment(typeCounts, row?.type ?? "unknown");
    if (typeof action.to === "string") increment(targetCounts, action.to.toLowerCase());
    if (typeof action.input === "string" && action.input.length >= 10) increment(selectorCounts, action.input.slice(0, 10).toLowerCase());
    if (Array.isArray(row?.traceAddress)) maxDepth = Math.max(maxDepth, row.traceAddress.length);
  }
  return {
    callCount: rows.length,
    maxDepth,
    targetCounts,
    selectorCounts,
    typeCounts
  };
}

function summarizeTraceResult(kind, result) {
  if (kind === "callTracer") return summarizeCallTrace(result);
  if (kind === "parityTrace" && Array.isArray(result)) return summarizeParityTrace(result);
  return { unsupportedShape: true, resultType: Array.isArray(result) ? "array" : typeof result };
}

function representativeTransactions(report) {
  const byKey = new Map();
  for (const tx of report?.transactions ?? []) {
    const key = tx.call?.selectedFunctionKey;
    if (key && !byKey.has(key)) byKey.set(key, tx);
  }
  return representativeFunctionKeys
    .map((key) => byKey.get(key))
    .filter(Boolean)
    .map((tx) => ({
      hash: tx.hash,
      source: tx.source,
      phase: tx.phase,
      label: tx.label,
      selectedFunctionKey: tx.call?.selectedFunctionKey ?? null,
      selector: tx.call?.selector ?? null,
      targetContract: tx.call?.targetKnownContract?.key ?? null
    }));
}

async function probeMethod(methodSpec, samples) {
  const out = {
    method: methodSpec.method,
    resultKind: methodSpec.resultKind,
    status: "not_attempted",
    attemptedCount: 0,
    unavailableCount: 0,
    successCount: 0,
    failureCount: 0,
    attempts: []
  };

  for (const sample of samples) {
    try {
      out.attemptedCount += 1;
      const result = await client.request({ method: methodSpec.method, params: methodSpec.params(sample.hash) });
      out.successCount += 1;
      out.status = "supported";
      out.attempts.push({
        ...sample,
        ok: true,
        summary: summarizeTraceResult(methodSpec.resultKind, result)
      });
    } catch (error) {
      const unavailable = isUnavailable(error);
      out.failureCount += 1;
      if (unavailable) out.unavailableCount += 1;
      out.attempts.push({
        ...sample,
        ok: false,
        unavailable,
        error: shortError(error)
      });
      if (unavailable) {
        out.status = "unavailable_on_rpc";
        break;
      }
      out.status = "failed";
    }
  }

  if (out.status === "not_attempted") out.status = samples.length === 0 ? "no_samples" : "failed";
  return out;
}

const liveReceipts = readJson("live-receipt-provenance.latest.json");
const chainId = await client.getChainId();
const blockNumber = await client.getBlockNumber();
const samples = representativeTransactions(liveReceipts);
const methodResults = [];
for (const methodSpec of traceMethods) {
  methodResults.push(await probeMethod(methodSpec, samples));
}
const anyTraceSupported = methodResults.some((result) => result.successCount > 0);
const allTraceMethodsUnavailable = methodResults.every((result) => result.status === "unavailable_on_rpc");
const fallbackComplete = liveReceipts?.ok === true &&
  Number(liveReceipts?.summary?.decodedFunctionCount ?? 0) === Number(liveReceipts?.summary?.txCount ?? -1) &&
  Number(liveReceipts?.summary?.unknownSelectorCount ?? -1) === 0;
const ok = chainId === 43114 &&
  liveReceipts?.wallet?.toLowerCase?.() === wallet &&
  samples.length > 0 &&
  (anyTraceSupported || (allTraceMethodsUnavailable && fallbackComplete));

console.log(stringify({
  ok,
  timestamp: new Date().toISOString(),
  chainId,
  rpcUrl,
  blockNumber,
  wallet: `0x${wallet.slice(2)}`,
  liveReceiptTimestamp: liveReceipts?.timestamp ?? null,
  summary: {
    sampleCount: samples.length,
    sampledFunctionKeys: samples.map((sample) => sample.selectedFunctionKey),
    anyTraceSupported,
    allTraceMethodsUnavailable,
    fallbackComplete,
    fallbackDecodedFunctionCount: liveReceipts?.summary?.decodedFunctionCount ?? null,
    fallbackUnknownSelectorCount: liveReceipts?.summary?.unknownSelectorCount ?? null
  },
  methods: methodResults,
  caveat: allTraceMethodsUnavailable
    ? "The configured Avalanche RPC does not expose debug_traceTransaction or trace_transaction. Historical live transaction evidence falls back to receipt status, emitted logs, raw public calldata, selector matches, and decoded top-level function calls from reports/live-receipt-provenance.latest.json."
    : "Trace evidence is provider-dependent. This report records supported trace summaries when available and otherwise relies on live receipt calldata provenance."
}));

if (!ok) process.exit(1);
