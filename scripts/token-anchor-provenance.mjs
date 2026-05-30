#!/usr/bin/env node
import { createPublicClient, http, parseAbi, toFunctionSignature } from "viem";
import { avalanche } from "viem/chains";
import { contractAbis } from "../dist/abis.js";
import { contractRegistry } from "../dist/contracts.js";

const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const client = createPublicClient({ chain: avalanche, transport: http(rpcUrl) });
const proxyAdminAbi = parseAbi([
  "function admin() view returns (address)",
  "function implementation() view returns (address)"
]);
const USDC_PROXY_ADMIN_FUNCTIONS = ["admin()", "changeAdmin(address)", "implementation()", "upgradeTo(address)", "upgradeToAndCall(address,bytes)"];
const USDC_ADMIN_SURFACE_NAMES = [
  "blacklist",
  "blacklister",
  "configureMinter",
  "masterMinter",
  "mint",
  "pause",
  "pauser",
  "rescueERC20",
  "unBlacklist",
  "updateBlacklister",
  "updateMasterMinter",
  "updatePauser"
];

function stringify(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function shortError(error) {
  return error?.shortMessage ?? error?.message ?? String(error);
}

function signatures(abi) {
  return (abi ?? [])
    .filter((item) => item.type === "function")
    .map((item) => toFunctionSignature(item))
    .sort();
}

async function fetchRemoteAbi(address) {
  const endpoints = [
    ["snowtrace", `https://api.snowtrace.io/api?module=contract&action=getabi&address=${address}`],
    ["routescan", `https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api?module=contract&action=getabi&address=${address}`]
  ];
  const attempts = [];

  for (const [source, url] of endpoints) {
    try {
      const retrievedAt = new Date().toISOString();
      const response = await fetch(url);
      const body = await response.json();
      if (body.status !== "1") {
        attempts.push({ source, ok: false, retrievedAt, error: body.result ?? body.message ?? "remote ABI unavailable" });
        continue;
      }
      const abi = JSON.parse(body.result);
      attempts.push({ source, ok: true, retrievedAt, functionCount: signatures(abi).length });
      return { source, abi, attempts };
    } catch (error) {
      attempts.push({ source, ok: false, retrievedAt: new Date().toISOString(), error: shortError(error) });
    }
  }

  return { source: null, abi: null, attempts };
}

function compare(local, remote) {
  return {
    ok: local.length > 0 && remote.length > 0 && local.every((signature) => remote.includes(signature)) && remote.every((signature) => local.includes(signature)),
    localCount: local.length,
    remoteCount: remote.length,
    missing: remote.filter((signature) => !local.includes(signature)),
    extra: local.filter((signature) => !remote.includes(signature))
  };
}

async function readTokenMetadata(address) {
  const abi = contractAbis.erc20Read;
  const calls = {};
  for (const functionName of ["name", "symbol", "decimals", "totalSupply"]) {
    try {
      const result = await client.readContract({ address, abi, functionName, blockNumber });
      calls[functionName] = { ok: true, result, blockNumber };
    } catch (error) {
      calls[functionName] = { ok: false, blockNumber, error: shortError(error) };
    }
  }
  return calls;
}

async function wavaxProvenance() {
  const entry = contractRegistry.wavax;
  const remote = await fetchRemoteAbi(entry.address);
  const localSignatures = signatures(contractAbis[entry.abiKey]);
  const remoteSignatures = signatures(remote.abi);
  const exactAbi = compare(localSignatures, remoteSignatures);
  const metadata = await readTokenMetadata(entry.address);

  return {
    key: entry.key,
    address: entry.address,
    registryStatus: entry.status,
    abiKey: entry.abiKey,
    functionListStatus: entry.functionListStatus,
    explorer: {
      source: remote.source,
      attempts: remote.attempts,
      exactAbi
    },
    metadata,
    recommendation: exactAbi.ok && entry.status === "verified_abi_first_pass"
      ? "keep verified_abi_first_pass; WAVAX exact public ABI is a small user-facing ERC20 wrapping surface"
      : "review WAVAX registry status or local ABI"
  };
}

async function usdcProvenance() {
  const entry = contractRegistry.usdcNative;
  const proxyAbi = await fetchRemoteAbi(entry.address);
  const proxySignatures = signatures(proxyAbi.abi);
  const [implementationAddress, adminAddress] = await Promise.all([
    client.readContract({ address: entry.address, abi: proxyAdminAbi, functionName: "implementation", blockNumber }).catch(() => null),
    client.readContract({ address: entry.address, abi: proxyAdminAbi, functionName: "admin", blockNumber }).catch(() => null)
  ]);
  const implementationAbi = implementationAddress ? await fetchRemoteAbi(implementationAddress) : { source: null, abi: null, attempts: [] };
  const implementationSignatures = signatures(implementationAbi.abi);
  const implementationNames = new Set((implementationAbi.abi ?? []).filter((item) => item.type === "function").map((item) => item.name));
  const adminSurfaceNames = USDC_ADMIN_SURFACE_NAMES.filter((name) => implementationNames.has(name));
  const metadata = await readTokenMetadata(entry.address);
  const proxyIsAdminOnly = USDC_PROXY_ADMIN_FUNCTIONS.every((signature) => proxySignatures.includes(signature)) &&
    proxySignatures.length === USDC_PROXY_ADMIN_FUNCTIONS.length;

  return {
    key: entry.key,
    address: entry.address,
    registryStatus: entry.status,
    abiKey: entry.abiKey,
    functionListStatus: entry.functionListStatus,
    proxy: {
      explorerSource: proxyAbi.source,
      attempts: proxyAbi.attempts,
      functionCount: proxySignatures.length,
      signatures: proxySignatures,
      proxyIsAdminOnly
    },
    implementation: {
      address: implementationAddress,
      admin: adminAddress,
      explorerSource: implementationAbi.source,
      functionCount: implementationSignatures.length,
      adminSurfaceNames
    },
    metadata,
    recommendation: proxyIsAdminOnly && adminSurfaceNames.length > 0
      ? "keep official_address_only with generic_erc20_read; proxy ABI is admin-only and implementation ABI includes admin/minter/blacklist/pause surfaces"
      : "review USDC registry status and implementation ABI"
  };
}

const blockNumber = await client.getBlockNumber();
const wavax = await wavaxProvenance();
const usdcNative = await usdcProvenance();
const ok = wavax.explorer.exactAbi.ok === true &&
  wavax.registryStatus === "verified_abi_first_pass" &&
  usdcNative.registryStatus === "official_address_only" &&
  usdcNative.functionListStatus === "generic_erc20_read" &&
  usdcNative.proxy.proxyIsAdminOnly === true &&
  usdcNative.implementation.adminSurfaceNames.length > 0;

console.log(stringify({
  ok,
  timestamp: new Date().toISOString(),
  chainId: 43114,
  rpcUrl,
  blockNumber,
  summary: {
    wavaxExactVerified: wavax.explorer.exactAbi.ok,
    wavaxFunctionCount: wavax.explorer.exactAbi.localCount,
    usdcProxyAdminOnly: usdcNative.proxy.proxyIsAdminOnly,
    usdcImplementationAddress: usdcNative.implementation.address,
    usdcImplementationFunctionCount: usdcNative.implementation.functionCount,
    usdcAdminSurfaceNames: usdcNative.implementation.adminSurfaceNames,
    usdcGenericReadOnly: usdcNative.registryStatus === "official_address_only" && usdcNative.functionListStatus === "generic_erc20_read"
  },
  targets: {
    wavax,
    usdcNative
  },
  caveat: "WAVAX is exact public ABI verified. Native USDC remains a generic ERC20 read anchor because the proxy-address ABI is admin-only and the implementation ABI includes non-user admin/minter/blacklist/pause functions."
}));

if (!ok) process.exit(1);
