#!/usr/bin/env node
import { toFunctionSignature } from "viem";
import { contractAbis } from "../dist/abis.js";
import { contractRegistry } from "../dist/contracts.js";

const verifiedTargets = [
  "pharToken",
  "xPharToken",
  "p33",
  "router",
  "minter",
  "ramsesV3Factory",
  "ramsesV3PositionManager",
  "swapRouter",
  "quoter",
  "quoterV2",
  "tickLens",
  "universalRouter",
  "uniswapInterfaceMulticall",
  "mixedRouteQuoterV1",
  "voter",
  "clGaugeFactory",
  "clGaugeV3",
  "legacyGaugeFactory",
  "feeDistributorFactory",
  "feeRecipientFactory",
  "feeCollector",
  "dlmmRewarderFactory",
  "wavax"
];

const diffableStatuses = new Set(["verified_abi_first_pass"]);

function functionSignatures(abi) {
  return abi
    .filter((item) => item.type === "function")
    .map((item) => toFunctionSignature(item))
    .sort();
}

async function fetchRemoteAbi(address) {
  const endpoints = [
    ["snowtrace", `https://api.snowtrace.io/api?module=contract&action=getabi&address=${address}`],
    ["routescan", `https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api?module=contract&action=getabi&address=${address}`]
  ];
  const errors = [];

  for (const [source, url] of endpoints) {
    try {
      const response = await fetch(url);
      const body = await response.json();
      if (body.status !== "1") {
        throw new Error(body.result ?? body.message ?? "remote ABI unavailable");
      }
      return { source, abi: JSON.parse(body.result) };
    } catch (error) {
      errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(errors.join("; "));
}

const results = [];
for (const key of verifiedTargets) {
  const entry = contractRegistry[key];
  if (!entry?.abiKey) {
    results.push({ key, ok: false, skipped: true, reason: "no local ABI key" });
    continue;
  }

  if (!diffableStatuses.has(entry.status)) {
    results.push({
      key,
      address: entry.address,
      abiKey: entry.abiKey,
      status: entry.status,
      ok: false,
      skipped: true,
      reason: `status ${entry.status} is not expected to have an exact verified target ABI`
    });
    continue;
  }

  try {
    const remoteAbi = await fetchRemoteAbi(entry.address);
    const remote = functionSignatures(remoteAbi.abi);
    if (remote.length === 0) {
      throw new Error("remote ABI has zero functions; likely proxy/admin ABI or unavailable implementation ABI");
    }
    const local = functionSignatures(contractAbis[entry.abiKey]);
    const missing = remote.filter((signature) => !local.includes(signature));
    const extra = local.filter((signature) => !remote.includes(signature));
    results.push({
      key,
      address: entry.address,
      abiKey: entry.abiKey,
      remoteSource: remoteAbi.source,
      ok: missing.length === 0 && extra.length === 0,
      remoteCount: remote.length,
      localCount: local.length,
      missing,
      extra
    });
  } catch (error) {
    results.push({
      key,
      address: entry.address,
      abiKey: entry.abiKey,
      ok: false,
      skipped: true,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

console.log(JSON.stringify({
  ok: results.every((result) => result.ok || result.skipped),
  timestamp: new Date().toISOString(),
  exactMatches: results.filter((result) => result.ok).length,
  skipped: results.filter((result) => result.skipped).length,
  mismatches: results.filter((result) => !result.ok && !result.skipped),
  results
}, null, 2));

if (results.some((result) => !result.ok && !result.skipped)) {
  process.exit(1);
}
