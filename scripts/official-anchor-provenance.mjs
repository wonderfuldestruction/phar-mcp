#!/usr/bin/env node
import { createPublicClient, http, parseAbi, toFunctionSignature } from "viem";
import { avalanche } from "viem/chains";
import { contractAbis } from "../dist/abis.js";
import { contractRegistry } from "../dist/contracts.js";

const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const client = createPublicClient({ chain: avalanche, transport: http(rpcUrl) });
const proxyAdminAbi = parseAbi(["function owner() view returns (address)"]);
const safeAbi = parseAbi([
  "function VERSION() view returns (string)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function nonce() view returns (uint256)"
]);
const positionManagerDeployerAbi = parseAbi(["function deployer() view returns (address)"]);
const descriptorAbi = parseAbi([
  "function nativeCurrencyLabel() view returns (string)",
  "function WETH9() view returns (address)",
  "function AVAX() view returns (address)"
]);

const targetDefinitions = {
  timelockController: {
    classification: "governance_timelock",
    userFacingDexSurface: false,
    expectedFunctionThemes: ["role", "schedule", "execute", "cancel"],
    exposedThrough: ["governance/offchain coordination only"],
    recommendation: "keep official_address_only; governance scheduling/execution is not a normal Pharaoh DEX user flow"
  },
  pharaohTeamMultisig: {
    classification: "authority_multisig",
    userFacingDexSurface: false,
    expectedFunctionThemes: [],
    exposedThrough: ["authority/provenance endpoint only"],
    recommendation: "keep official_address_only; team multisig is not a normal Pharaoh DEX user flow"
  },
  proxyAdmin: {
    classification: "upgrade_admin",
    userFacingDexSurface: false,
    expectedFunctionThemes: ["owner", "upgrade"],
    exposedThrough: ["proxy administration only"],
    recommendation: "keep official_address_only; upgrade administration is intentionally excluded from normal MCP user tools"
  },
  ramsesV3PoolDeployer: {
    classification: "cl_deployment_support",
    userFacingDexSurface: false,
    expectedFunctionThemes: [],
    exposedThrough: ["ramsesV3Factory", "ramsesV3PositionManager"],
    recommendation: "keep official_address_only; normal CL pool creation is exposed through factory and position-manager tools"
  },
  ramsesV3FactoryInitializedDeployer: {
    classification: "cl_initialized_deployer_or_operator",
    userFacingDexSurface: false,
    expectedFunctionThemes: [],
    exposedThrough: ["ramsesV3Factory", "ramsesV3PositionManager"],
    recommendation: "keep official_address_only; initialized deployer/operator is not a normal user-facing contract"
  },
  nonfungibleTokenPositionDescriptor: {
    classification: "nft_metadata_descriptor",
    userFacingDexSurface: false,
    expectedFunctionThemes: ["tokenURI", "metadata"],
    exposedThrough: ["ramsesV3PositionManager"],
    recommendation: "keep official_address_only; CL position actions are exposed through RamsesV3PositionManager"
  },
  usdcNative: {
    classification: "generic_token_anchor_proxy_admin_abi",
    userFacingDexSurface: false,
    expectedFunctionThemes: ["proxy_admin"],
    exposedThrough: ["erc20Read", "pharaoh_encode_approval"],
    recommendation: "keep official_address_only with generic_erc20_read; proxy ABI is admin-only and token implementation has broad admin/minter/blacklist/pause surfaces"
  }
};

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
        attempts.push({ source, ok: false, retrievedAt, message: body.message, result: body.result });
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

function hasTheme(signature, theme) {
  const lowered = signature.toLowerCase();
  if (theme === "role") return lowered.includes("role");
  if (theme === "schedule") return lowered.includes("schedule");
  if (theme === "execute") return lowered.includes("execute");
  if (theme === "cancel") return lowered.includes("cancel");
  if (theme === "owner") return lowered.includes("owner");
  if (theme === "upgrade") return lowered.includes("upgrade");
  if (theme === "tokenURI") return lowered.includes("tokenuri");
  if (theme === "metadata") return lowered.includes("nativecurrency") || lowered.includes("ratio") || lowered.includes("avax") || lowered.includes("weth9");
  if (theme === "proxy_admin") return ["admin()", "changeAdmin(address)", "implementation()", "upgradeTo(address)", "upgradeToAndCall(address,bytes)"].includes(signature);
  return false;
}

function themeEvidence(functionSignatures, expectedThemes) {
  return Object.fromEntries(expectedThemes.map((theme) => [
    theme,
    functionSignatures.filter((signature) => hasTheme(signature, theme))
  ]));
}

async function tryRead(address, abi, functionName, args = []) {
  try {
    return {
      ok: true,
      result: await client.readContract({ address, abi, functionName, args, blockNumber }),
      blockNumber
    };
  } catch (error) {
    return { ok: false, blockNumber, error: shortError(error) };
  }
}

async function codeSummary(address) {
  try {
    const code = await client.getCode({ address, blockNumber });
    return {
      ok: true,
      byteLength: code ? Math.max(0, (code.length - 2) / 2) : 0,
      isContract: Boolean(code && code !== "0x"),
      blockNumber
    };
  } catch (error) {
    return { ok: false, blockNumber, error: shortError(error) };
  }
}

async function relationEvidence(key, address) {
  if (key === "timelockController") {
    return {
      getMinDelay: await tryRead(address, parseAbi(["function getMinDelay() view returns (uint256)"]), "getMinDelay")
    };
  }
  if (key === "pharaohTeamMultisig") {
    return {
      singletonSlot0: await client
        .getStorageAt({ address, slot: "0x0000000000000000000000000000000000000000000000000000000000000000", blockNumber })
        .then((result) => ({ ok: true, result, blockNumber }))
        .catch((error) => ({ ok: false, blockNumber, error: shortError(error) })),
      version: await tryRead(address, safeAbi, "VERSION"),
      threshold: await tryRead(address, safeAbi, "getThreshold"),
      owners: await tryRead(address, safeAbi, "getOwners"),
      nonce: await tryRead(address, safeAbi, "nonce")
    };
  }
  if (key === "proxyAdmin") {
    return {
      owner: await tryRead(address, proxyAdminAbi, "owner"),
      expectedOwner: contractRegistry.pharaohTeamMultisig.address
    };
  }
  if (key === "ramsesV3PoolDeployer") {
    return {
      factoryRamsesV3PoolDeployer: await tryRead(contractRegistry.ramsesV3Factory.address, contractAbis.ramsesV3Factory, "ramsesV3PoolDeployer"),
      positionManagerDeployer: await tryRead(contractRegistry.ramsesV3PositionManager.address, positionManagerDeployerAbi, "deployer")
    };
  }
  if (key === "ramsesV3FactoryInitializedDeployer") {
    return {
      codeExpectedEmpty: true
    };
  }
  if (key === "nonfungibleTokenPositionDescriptor") {
    return {
      nativeCurrencyLabel: await tryRead(address, descriptorAbi, "nativeCurrencyLabel"),
      WETH9: await tryRead(address, descriptorAbi, "WETH9"),
      AVAX: await tryRead(address, descriptorAbi, "AVAX"),
      userFacingPositionManager: contractRegistry.ramsesV3PositionManager.address
    };
  }
  return {};
}

const blockNumber = await client.getBlockNumber();
const targets = [];
for (const [key, definition] of Object.entries(targetDefinitions)) {
  const entry = contractRegistry[key];
  const remote = await fetchRemoteAbi(entry.address);
  const functionSignatures = signatures(remote.abi);
  const code = await codeSummary(entry.address);
  const relations = await relationEvidence(key, entry.address);
  targets.push({
    key,
    name: entry.name,
    address: entry.address,
    registryStatus: entry.status,
    abiKey: entry.abiKey ?? null,
    functionListStatus: entry.functionListStatus,
    functionCount: entry.abiKey === "erc20Read" ? 6 : 0,
    classification: definition.classification,
    userFacingDexSurface: definition.userFacingDexSurface,
    exposedThrough: definition.exposedThrough,
    recommendation: definition.recommendation,
    explorer: {
      source: remote.source,
      attempts: remote.attempts,
      remoteFunctionCount: functionSignatures.length,
      remoteFunctionSignatures: functionSignatures,
      themeEvidence: themeEvidence(functionSignatures, definition.expectedFunctionThemes)
    },
    code,
    relations,
    provenanceNote: entry.provenanceNote
  });
}

const failures = [];
for (const target of targets) {
  if (target.registryStatus !== "official_address_only") failures.push({ key: target.key, reason: "expected official_address_only registry status" });
  if (target.userFacingDexSurface !== false) failures.push({ key: target.key, reason: "official anchor marked as user-facing" });
  if (target.key !== "usdcNative" && target.functionListStatus !== "address_only_no_user_abi") {
    failures.push({ key: target.key, reason: "expected address_only_no_user_abi for non-token official anchor" });
  }
  if (target.key === "usdcNative" && target.functionListStatus !== "generic_erc20_read") {
    failures.push({ key: target.key, reason: "expected generic_erc20_read for native USDC token anchor" });
  }
  if (target.key === "proxyAdmin" && target.relations.owner?.ok && target.relations.owner.result.toLowerCase() !== contractRegistry.pharaohTeamMultisig.address.toLowerCase()) {
    failures.push({ key: target.key, reason: "proxyAdmin owner does not match team multisig" });
  }
  if (target.key === "ramsesV3PoolDeployer") {
    const factory = target.relations.factoryRamsesV3PoolDeployer;
    if (factory?.ok && factory.result.toLowerCase() !== target.address.toLowerCase()) failures.push({ key: target.key, reason: "factory deployer link mismatch" });
  }
  if (target.key === "ramsesV3FactoryInitializedDeployer" && target.code?.ok && target.code.byteLength !== 0) {
    failures.push({ key: target.key, reason: "expected initialized deployer/operator anchor to have no runtime code" });
  }
}

console.log(stringify({
  ok: failures.length === 0,
  timestamp: new Date().toISOString(),
  chainId: 43114,
  rpcUrl,
  blockNumber,
  summary: {
    totalOfficialAnchors: targets.length,
    nonUserAnchors: targets.filter((target) => target.userFacingDexSurface === false).length,
    genericTokenAnchors: targets.filter((target) => target.functionListStatus === "generic_erc20_read").length,
    addressOnlyNoUserAbi: targets.filter((target) => target.functionListStatus === "address_only_no_user_abi").length,
    zeroCodeAnchors: targets.filter((target) => target.code?.ok && target.code.byteLength === 0).length,
    classifications: Object.fromEntries(targets.map((target) => [target.key, target.classification]))
  },
  failures,
  targets,
  caveat: "Official address-only anchors are retained for provenance, governance/admin/support cross-links, metadata, or generic token routing; they are not unresolved normal user-facing Pharaoh DEX function surfaces."
}));

if (failures.length > 0) process.exit(1);
