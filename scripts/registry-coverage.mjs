#!/usr/bin/env node
import { toFunctionSignature } from "viem";
import { contractAbis } from "../dist/abis.js";
import { registryEntries } from "../dist/contracts.js";

function functionsFor(entry) {
  if (!entry.abiKey) return [];
  return (contractAbis[entry.abiKey] ?? [])
    .filter((item) => item.type === "function")
    .map((item) => ({
      name: item.name,
      signature: toFunctionSignature(item),
      stateMutability: item.stateMutability
    }));
}

const entries = registryEntries().map((entry) => {
  const functions = functionsFor(entry);
  return {
    key: entry.key,
    name: entry.name,
    category: entry.category,
    address: entry.address,
    status: entry.status,
    abiKey: entry.abiKey ?? null,
    functionListStatus: entry.functionListStatus,
    functionCount: functions.length,
    provenanceNote: entry.provenanceNote,
    sourceUrl: entry.sourceUrl,
    explorerUrl: entry.explorerUrl,
    functions
  };
});

const statusCounts = {};
const functionListStatusCounts = {};
for (const entry of entries) {
  statusCounts[entry.status] = (statusCounts[entry.status] ?? 0) + 1;
  functionListStatusCounts[entry.functionListStatus] = (functionListStatusCounts[entry.functionListStatus] ?? 0) + 1;
}

const failures = [];
for (const entry of entries) {
  if (!entry.provenanceNote) failures.push({ key: entry.key, reason: "missing provenanceNote" });
  if (!entry.functionListStatus) failures.push({ key: entry.key, reason: "missing functionListStatus" });
  if (entry.functionListStatus === "abi_functions_available" && entry.functionCount === 0) {
    failures.push({ key: entry.key, reason: "marked abi_functions_available with zero functions" });
  }
  if (entry.functionListStatus === "address_only_no_user_abi" && entry.functionCount !== 0) {
    failures.push({ key: entry.key, reason: "marked address_only_no_user_abi but exposes functions" });
  }
  if (entry.functionListStatus === "generic_erc20_read" && entry.abiKey !== "erc20Read") {
    failures.push({ key: entry.key, reason: "marked generic_erc20_read without erc20Read ABI" });
  }
}

console.log(JSON.stringify({
  ok: failures.length === 0,
  timestamp: new Date().toISOString(),
  chainId: 43114,
  summary: {
    totalContracts: entries.length,
    statusCounts,
    functionListStatusCounts,
    functionBearingContracts: entries.filter((entry) => entry.functionCount > 0).length,
    addressOnlyWithoutUserAbi: entries.filter((entry) => entry.functionListStatus === "address_only_no_user_abi").length,
    genericErc20ReadContracts: entries.filter((entry) => entry.functionListStatus === "generic_erc20_read").length
  },
  failures,
  entries
}, null, 2));

if (failures.length > 0) process.exit(1);
