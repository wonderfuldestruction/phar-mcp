#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createPublicClient, http, toFunctionSelector, toFunctionSignature } from "viem";
import { avalanche } from "viem/chains";
import { contractAbis } from "../dist/abis.js";
import { contractRegistry } from "../dist/contracts.js";
import { lookupFunction } from "../dist/lookup.js";
import { sourceArtifactEvidence } from "./source-artifacts.mjs";

const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const client = createPublicClient({ chain: avalanche, transport: http(rpcUrl) });

const eip1967Slots = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"
};

const targetDefinitions = [
  {
    key: "accessHub",
    reads: [
      ["timelock"],
      ["treasury"],
      ["voter"],
      ["minter"],
      ["xRam"],
      ["r33"],
      ["nfpManager"],
      ["poolFactory"],
      ["clGaugeFactory"],
      ["gaugeFactory"],
      ["feeDistributorFactory"],
      ["feeRecipientFactory"],
      ["DEFAULT_ADMIN_ROLE"],
      ["PROTOCOL_OPERATOR"],
      ["SWAP_FEE_SETTER"],
      ["getRoleMembers", ["0x0000000000000000000000000000000000000000000000000000000000000000"]],
      ["supportsInterface", ["0x01ffc9a7"]]
    ]
  },
  {
    key: "treasuryHelper",
    reads: [
      ["USDC"],
      ["getAccessHub"],
      ["getTreasury"],
      ["getTimelock"],
      ["getVoter"],
      ["getOperator"],
      ["getXRam"],
      ["getVoteModule"],
      ["getLegacyRouter"],
      ["getBasisPoints"],
      ["getMemberCount"],
      ["getAllMembers"],
      ["getTotalWeight"]
    ]
  },
  {
    key: "voter",
    reads: [
      ["getPeriod"],
      ["voteModule"],
      ["minter"],
      ["legacyFactory"],
      ["clGaugeFactory"],
      ["feeDistributorFactory"]
    ]
  },
  {
    key: "clGaugeFactory",
    reads: [
      ["implementation"],
      ["voter"],
      ["nfpManager"],
      ["feeCollector"]
    ]
  },
  {
    key: "legacyGauge",
    reads: [
      ["stake"],
      ["voter"],
      ["totalSupply"],
      ["rewardsList"],
      ["rewardsListLength"]
    ]
  },
  {
    key: "feeDistributor",
    reads: [
      ["voter"],
      ["voteModule"],
      ["feeRecipient"],
      ["getRewardTokens"],
      ["getPeriod"]
    ]
  },
  {
    key: "feeRecipient",
    reads: [
      ["feeDistributor"],
      ["feeRecipientFactory"],
      ["pair"],
      ["voter"]
    ]
  },
  {
    key: "pairFactory",
    reads: [
      ["accessHub"],
      ["allPairsLength"],
      ["feeRecipientFactory"],
      ["treasury"],
      ["voter"],
      ["isPair", ["registry:legacyPair"]]
    ]
  },
  {
    key: "feeDistributorFactory",
    reads: [["lastFeeDistributor"]]
  },
  {
    key: "feeRecipientFactory",
    reads: [
      ["accessHub"],
      ["lastFeeRecipient"],
      ["treasury"],
      ["voter"],
      ["feeRecipientForPair", ["registry:legacyPair"]]
    ]
  }
];

function shortError(error) {
  return error?.shortMessage ?? error?.message ?? String(error);
}

function stringify(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function signaturesSha256(signatures) {
  return sha256((signatures ?? []).join("\n"));
}

function bytecodeSha256(code) {
  return code && code !== "0x" ? sha256(code.toLowerCase()) : null;
}

function addressFromSlot(value) {
  if (!value || /^0x0+$/.test(value)) return null;
  const address = `0x${value.slice(-40)}`;
  return /^0x0+$/.test(address) ? null : address;
}

function selectorPresence(code, selector) {
  const raw = selector.slice(2).toLowerCase();
  const trimmed = raw.replace(/^0+/, "") || "0";
  const byteLength = Math.ceil(trimmed.length / 2);
  const pushOpcode = (0x5f + byteLength).toString(16).padStart(2, "0");
  const pushPattern = `${pushOpcode}${trimmed.padStart(byteLength * 2, "0")}`;
  const exact = code.includes(raw);
  const push = code.includes(pushPattern);
  return {
    exact,
    pushPattern,
    push,
    present: exact || push
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bodySummary(value, max = 500) {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function explorerOutcome(message) {
  const text = String(message ?? "").toLowerCase();
  if (text.includes("source code not verified")) return "explorer_unverified";
  if (text.includes("fetch failed")) return "transport_error";
  if (text.includes("unexpected token") || text.includes("json")) return "json_parse_error";
  if (text.includes("abi")) return "abi_parse_error";
  return "api_error";
}

function isRetryableOutcome(outcome) {
  return ["transport_error", "http_error", "api_error", "json_parse_error"].includes(outcome);
}

function attemptBase(source, url, address, endpointKind, retrievedAt, attempt, maxAttempts) {
  return {
    source,
    address,
    endpointKind,
    urlHost: new URL(url).host,
    attempt,
    maxAttempts,
    retrievedAt
  };
}

async function fetchExplorerJson(source, url, address, endpointKind, attempt, maxAttempts) {
  const retrievedAt = new Date().toISOString();
  const base = attemptBase(source, url, address, endpointKind, retrievedAt, attempt, maxAttempts);

  try {
    const response = await fetch(url);
    const rawText = await response.text();
    let body;
    try {
      body = JSON.parse(rawText);
    } catch (error) {
      const outcome = "json_parse_error";
      return {
        ...base,
        ok: false,
        retryable: isRetryableOutcome(outcome),
        outcome,
        httpStatus: response.status,
        httpStatusText: response.statusText,
        httpOk: response.ok,
        error: shortError(error),
        bodySummary: bodySummary(rawText)
      };
    }

    if (!response.ok) {
      const outcome = "http_error";
      return {
        ...base,
        ok: false,
        retryable: isRetryableOutcome(outcome),
        outcome,
        httpStatus: response.status,
        httpStatusText: response.statusText,
        httpOk: response.ok,
        apiStatus: body.status ?? null,
        apiMessage: body.message ?? null,
        status: body.status ?? null,
        message: body.message ?? null,
        resultSummary: bodySummary(body.result),
        error: body.result ?? body.message ?? `HTTP ${response.status}`
      };
    }

    const ok = body.status === "1";
    const outcome = ok ? "api_success" : explorerOutcome(body.result ?? body.message);

    return {
      ...base,
      ok,
      retryable: !ok && isRetryableOutcome(outcome),
      outcome,
      httpStatus: response.status,
      httpStatusText: response.statusText,
      httpOk: response.ok,
      apiStatus: body.status ?? null,
      apiMessage: body.message ?? null,
      status: body.status ?? null,
      message: body.message ?? null,
      resultSummary: bodySummary(body.result),
      error: ok ? null : body.result ?? body.message ?? "remote ABI unavailable",
      body
    };
  } catch (error) {
    const outcome = "transport_error";
    return {
      ...base,
      ok: false,
      retryable: isRetryableOutcome(outcome),
      outcome,
      error: shortError(error)
    };
  }
}

async function fetchExplorerJsonWithRetries(source, url, address, endpointKind = "etherscan_getabi", maxAttempts = 1) {
  const attempts = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await fetchExplorerJson(source, url, address, endpointKind, attempt, maxAttempts);
    attempts.push(result);

    if (result.ok || result.retryable !== true) return { result, attempts };
    if (attempt < maxAttempts) await sleep(250 * attempt);
  }

  return { result: attempts.at(-1), attempts };
}

function functionSignatures(abi) {
  return abi
    .filter((item) => item.type === "function")
    .map((item) => toFunctionSignature(item))
    .sort();
}

function errorSignature(item) {
  const inputs = (item.inputs ?? []).map((input) => input.type).join(",");
  return `${item.name}(${inputs})`;
}

function errorSignatures(abi) {
  return abi
    .filter((item) => item.type === "error")
    .map((item) => errorSignature(item))
    .sort();
}

async function explorerStatus(address) {
  const endpoints = [
    ["snowtraceSource", `https://api.snowtrace.io/api?module=contract&action=getsourcecode&address=${address}`, "etherscan_getsourcecode", 2],
    ["snowtraceAbi", `https://api.snowtrace.io/api?module=contract&action=getabi&address=${address}`, "etherscan_getabi", 3],
    ["routescanAbi", `https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api?module=contract&action=getabi&address=${address}`, "etherscan_getabi", 3]
  ];
  const out = {};
  for (const [name, url, endpointKind, maxAttempts] of endpoints) {
    const { result, attempts } = await fetchExplorerJsonWithRetries(name, url, address, endpointKind, maxAttempts);
    out[name] = {
      ok: result?.ok === true,
      retrievedAt: result?.retrievedAt,
      address,
      endpointKind,
      urlHost: new URL(url).host,
      attempt: result?.attempt,
      maxAttempts,
      retryable: result?.retryable ?? false,
      outcome: result?.outcome ?? null,
      httpStatus: result?.httpStatus ?? null,
      httpStatusText: result?.httpStatusText ?? null,
      httpOk: result?.httpOk ?? null,
      apiStatus: result?.apiStatus ?? null,
      apiMessage: result?.apiMessage ?? null,
      status: result?.status ?? null,
      message: result?.message ?? null,
      resultSummary: result?.resultSummary ?? result?.bodySummary ?? null,
      errorKind: result?.ok ? null : result?.outcome,
      error: result?.ok ? null : result?.error ?? result?.resultSummary ?? result?.message ?? "remote ABI unavailable",
      attempts: attempts.map(({ body, ...attempt }) => attempt)
    };
  }
  return out;
}

async function fetchRemoteAbi(address) {
  const endpoints = [
    ["snowtrace", `https://api.snowtrace.io/api?module=contract&action=getabi&address=${address}`, "etherscan_getabi", 3],
    ["routescan", `https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api?module=contract&action=getabi&address=${address}`, "etherscan_getabi", 3]
  ];
  const errors = [];
  const attempts = [];

  for (const [source, url, endpointKind, maxAttempts] of endpoints) {
    const { result, attempts: sourceAttempts } = await fetchExplorerJsonWithRetries(source, url, address, endpointKind, maxAttempts);
    attempts.push(...sourceAttempts.map(({ body, ...attempt }) => attempt));

    if (result?.ok !== true) {
      const message = result?.resultSummary ?? result?.error ?? result?.message ?? "remote ABI unavailable";
      errors.push(`${source}: ${message}`);
      continue;
    }

    try {
      const abi = JSON.parse(result.body.result);
      attempts[attempts.length - 1] = {
        ...attempts[attempts.length - 1],
        ok: true,
        retryable: false,
        outcome: "exact_abi_fetched",
        functionCount: functionSignatures(abi).length,
        errorKind: null,
        error: null
      };
      return { source, abi, attempts, fetchEvidenceStatus: "exact_abi_returned", inconclusiveSources: [] };
    } catch (error) {
      attempts[attempts.length - 1] = {
        ...attempts[attempts.length - 1],
        ok: false,
        retryable: true,
        outcome: "abi_parse_error",
        errorKind: "abi_parse_error",
        error: shortError(error)
      };
      errors.push(`${source}: ${shortError(error)}`);
    }
  }

  const inconclusiveSources = attempts
    .filter((attempt) => ["transport_error", "http_error", "api_error", "json_parse_error", "abi_parse_error"].includes(attempt.outcome))
    .map((attempt) => attempt.source);

  return {
    error: errors.join("; "),
    attempts,
    fetchEvidenceStatus: inconclusiveSources.length > 0 ? "inconclusive_fetch" : "confirmed_unavailable",
    inconclusiveSources: [...new Set(inconclusiveSources)]
  };
}

async function proxySlots(address) {
  const slots = {};
  for (const [name, slot] of Object.entries(eip1967Slots)) {
    const value = await client.getStorageAt({ address, slot, blockNumber });
    slots[name] = { slot, value, address: addressFromSlot(value), blockNumber };
  }
  return slots;
}

function resolveArgs(args = []) {
  return args.map((arg) => {
    if (typeof arg === "string" && arg.startsWith("registry:")) {
      const key = arg.slice("registry:".length);
      return contractRegistry[key]?.address ?? arg;
    }
    return arg;
  });
}

async function read(address, abi, functionName, args = []) {
  try {
    const fn = lookupFunction(abi, functionName);
    return {
      ok: true,
      functionName,
      result: await client.readContract({
        address,
        abi: [fn],
        functionName: fn.name,
        args: resolveArgs(args),
        blockNumber
      }),
      blockNumber
    };
  } catch (error) {
    return { ok: false, functionName, blockNumber, error: shortError(error) };
  }
}

function compareAbi(localAbi, remoteAbi) {
  const local = functionSignatures(localAbi);
  const remote = functionSignatures(remoteAbi);
  const missing = remote.filter((signature) => !local.includes(signature));
  const extra = local.filter((signature) => !remote.includes(signature));
  return {
    ok: missing.length === 0 && extra.length === 0,
    localCount: local.length,
    remoteCount: remote.length,
    missing,
    extra
  };
}

function exactAbiReport(remoteAbi, exactAbiMatch) {
  const classification = exactAbiMatch?.ok
    ? "exact_match"
    : exactAbiMatch?.remoteCount === 0
      ? "remote_abi_has_no_functions"
      : exactAbiMatch
        ? "remote_abi_mismatch"
        : "remote_abi_unavailable";
  return {
    source: remoteAbi.source ?? null,
    ok: exactAbiMatch?.ok ?? false,
    classification,
    unavailableReason: remoteAbi.error ?? null,
    fetchEvidenceStatus: remoteAbi.fetchEvidenceStatus ?? (remoteAbi.source ? "exact_abi_returned" : "unknown"),
    inconclusiveSources: remoteAbi.inconclusiveSources ?? [],
    attempts: remoteAbi.attempts ?? [],
    comparison: exactAbiMatch
  };
}

function statusRecommendation(entry, exactAbiMatch, implementationExactAbiMatch, selectorSummary, implementation) {
  if (entry.status === "verified_abi_first_pass") {
    return exactAbiMatch?.ok
      ? "keep verified_abi_first_pass"
      : "investigate verified status because exact public ABI comparison failed or was unavailable";
  }

  if (implementationExactAbiMatch?.ok) {
    return "eligible for proxy_implementation_verified; implementation exact public ABI matches local ABI";
  }

  if (!implementation && exactAbiMatch?.ok) {
    return "eligible for verified_abi_first_pass; target exact public ABI matches local ABI";
  }

  if (selectorSummary.selectorsMissing === 0 && implementation) {
    return "keep source_backed_abi_candidate; EIP-1967 implementation is selector-backed but public implementation ABI is unverified";
  }

  if (selectorSummary.selectorsMissing === 0) {
    return "keep source_backed_abi_candidate; target runtime is selector-backed but public exact ABI is unavailable";
  }

  return "investigate local ABI; one or more selectors were not found in the target runtime selected for this report";
}

function liveReadEvidence(liveReads) {
  const reads = Object.values(liveReads ?? {});
  return {
    readCount: reads.length,
    failedCount: reads.filter((item) => !item?.ok).length,
    blockNumber
  };
}

function sourceBackedPromotionBlockers(exactAbi, implementationExactAbi, selectorSummary, readsEvidence, implementation) {
  const blockers = [];
  if (exactAbi?.ok !== true) blockers.push("target exact public ABI unavailable or mismatched");
  if (implementation && implementationExactAbi?.ok !== true) {
    blockers.push("EIP-1967 implementation exact public ABI unavailable or mismatched");
  }
  if (Number(selectorSummary.selectorsMissing ?? 0) !== 0) blockers.push("selector coverage incomplete");
  if (Number(readsEvidence.failedCount ?? 0) !== 0) blockers.push("representative live reads failed");
  return blockers;
}

function provenanceGate(entry, exactAbi, implementationExactAbi, selectorSummary, liveReads, implementation, selectorAddress) {
  const readsEvidence = liveReadEvidence(liveReads);
  const selectorComplete = Number(selectorSummary.selectorsMissing ?? 0) === 0;
  const exactPublicAbiVerified = exactAbi?.ok === true;
  const implementationExactPublicAbiVerified = implementationExactAbi?.ok === true;
  const evidenceClass = entry.status === "verified_abi_first_pass" && exactPublicAbiVerified
    ? "exact_public_abi_verified"
    : implementation
      ? "eip1967_implementation_selector_backed"
      : "target_runtime_selector_backed";
  const selectorBackedOnly = evidenceClass !== "exact_public_abi_verified";
  const promotionEligible = entry.status === "source_backed_abi_candidate" &&
    selectorComplete &&
    readsEvidence.failedCount === 0 &&
    (implementation ? implementationExactPublicAbiVerified : exactPublicAbiVerified);
  const promotionBlockers = sourceBackedPromotionBlockers(
    exactAbi,
    implementationExactAbi,
    selectorSummary,
    readsEvidence,
    implementation
  );
  if (entry.status === "source_backed_abi_candidate" && !promotionEligible && promotionBlockers.length === 0) {
    promotionBlockers.push("registry remains source-backed pending manual promotion");
  }

  return {
    evidenceClass,
    selectorBackedOnly,
    exactPublicAbiVerified,
    promotionEligible,
    keepSourceBacked: entry.status === "source_backed_abi_candidate" &&
      selectorBackedOnly &&
      selectorComplete &&
      readsEvidence.failedCount === 0 &&
      !promotionEligible &&
      promotionBlockers.length > 0,
    promotionBlockers,
    selectorEvidence: {
      checkAddress: selectorAddress,
      checkAddressKind: implementation ? "eip1967_implementation" : "target_runtime",
      functionCount: selectorSummary.functionCount,
      selectorsMissing: selectorSummary.selectorsMissing,
      selectorComplete
    },
    liveReadEvidence: readsEvidence
  };
}

async function inspectTarget(definition) {
  const entry = contractRegistry[definition.key];
  const abi = contractAbis[entry.abiKey];
  const targetCode = (await client.getCode({ address: entry.address, blockNumber }))?.toLowerCase() ?? "";
  const slots = await proxySlots(entry.address);
  const implementation = slots.implementation.address;
  const selectorAddress = implementation ?? entry.address;
  const selectorCode = implementation
    ? (await client.getCode({ address: implementation, blockNumber }))?.toLowerCase() ?? ""
    : targetCode;
  const [remoteAbi, implementationRemoteAbi] = await Promise.all([
    fetchRemoteAbi(entry.address),
    implementation ? fetchRemoteAbi(implementation) : Promise.resolve(null)
  ]);
  const localFunctionSignatures = functionSignatures(abi);
  const localErrorSignatures = errorSignatures(abi);
  const sourceArtifact = await sourceArtifactEvidence(definition.key, {
    localFunctionSignatures,
    localErrorSignatures
  });
  const exactAbiMatch = remoteAbi.abi ? compareAbi(abi, remoteAbi.abi) : null;
  const implementationExactAbiMatch = implementationRemoteAbi?.abi ? compareAbi(abi, implementationRemoteAbi.abi) : null;
  const functions = abi
    .filter((item) => item.type === "function")
    .map((fn) => {
      const signature = toFunctionSignature(fn);
      const selector = toFunctionSelector(signature);
      return {
        signature,
        selector,
        targetRuntime: selectorPresence(targetCode, selector),
        selectorRuntime: selectorPresence(selectorCode, selector)
      };
    });
  const selectorSummary = {
    functionCount: functions.length,
    selectorsPresent: functions.filter((item) => item.selectorRuntime.present).length,
    selectorsMissing: functions.filter((item) => !item.selectorRuntime.present).length
  };
  const liveReads = {};
  for (const [functionName, args] of definition.reads) {
    liveReads[functionName] = await read(entry.address, abi, functionName, args);
  }
  const targetExactAbiReport = exactAbiReport(remoteAbi, exactAbiMatch);
  const implementationExactAbiReport = implementationRemoteAbi ? exactAbiReport(implementationRemoteAbi, implementationExactAbiMatch) : null;

  return {
    key: definition.key,
    name: entry.name,
    category: entry.category,
    address: entry.address,
    status: entry.status,
    abiKey: entry.abiKey,
    selectorCheckAddress: selectorAddress,
    localAbi: {
      functionCount: localFunctionSignatures.length,
      functionSignaturesSha256: signaturesSha256(localFunctionSignatures),
      errorCount: localErrorSignatures.length,
      errorSignaturesSha256: signaturesSha256(localErrorSignatures)
    },
    sourceArtifactEvidence: sourceArtifact,
    statusRecommendation: statusRecommendation(entry, exactAbiMatch, implementationExactAbiMatch, selectorSummary, implementation),
    provenanceGate: provenanceGate(
      entry,
      targetExactAbiReport,
      implementationExactAbiReport,
      selectorSummary,
      liveReads,
      implementation,
      selectorAddress
    ),
    proxy: {
      targetCodeBytes: targetCode ? (targetCode.length - 2) / 2 : 0,
      targetCodeSha256: bytecodeSha256(targetCode),
      targetCodeBlockNumber: blockNumber,
      eip1967: slots,
      implementationCodeBytes: implementation ? (selectorCode.length - 2) / 2 : null,
      implementationCodeSha256: implementation ? bytecodeSha256(selectorCode) : null,
      implementationCodeBlockNumber: implementation ? blockNumber : null
    },
    explorer: {
      target: await explorerStatus(entry.address),
      implementation: implementation ? await explorerStatus(implementation) : null,
      exactAbi: targetExactAbiReport,
      implementationExactAbi: implementationExactAbiReport
    },
    selectorSummary,
    liveReads,
    functions
  };
}

const blockNumber = await client.getBlockNumber();
const targets = [];
for (const definition of targetDefinitions) {
  targets.push(await inspectTarget(definition));
}
const selectorFailures = targets
  .filter((target) => target.selectorSummary.selectorsMissing > 0)
  .map((target) => `${target.key}: ${target.selectorSummary.selectorsMissing} missing selectors`);
const verifiedExactFailures = targets
  .filter((target) => target.status === "verified_abi_first_pass" && !target.explorer.exactAbi.ok)
  .map((target) => `${target.key}: exact public ABI comparison failed or was unavailable`);
const liveReadFailures = targets.flatMap((target) =>
  Object.values(target.liveReads)
    .filter((readResult) => !readResult.ok)
    .map((readResult) => `${target.key}.${readResult.functionName}: ${readResult.error}`)
);

const report = {
  timestamp: new Date().toISOString(),
  chainId: 43114,
  rpcUrl,
  blockNumber,
  summary: {
    targets: targets.length,
    exactVerifiedMatches: targets.filter((target) => target.status === "verified_abi_first_pass" && target.explorer.exactAbi.ok).length,
    promotableSourceBackedTargets: targets
      .filter((target) => target.status === "source_backed_abi_candidate" && target.provenanceGate?.promotionEligible === true)
      .map((target) => target.key),
    proxyAbiOnlyTargets: targets
      .filter((target) => target.explorer.exactAbi.classification === "remote_abi_has_no_functions")
      .map((target) => target.key),
    selectorComplete: targets.filter((target) => target.selectorSummary.selectorsMissing === 0).length,
    selectorFailures,
    verifiedExactFailures,
    liveReadFailures
  },
  caveat: "Selector presence is bytecode evidence, not a verified source ABI. Source-backed targets stay source_backed_abi_candidate unless exact public ABI evidence supports promotion.",
  targets
};

console.log(stringify(report));

if (selectorFailures.length > 0 || verifiedExactFailures.length > 0 || liveReadFailures.length > 0) {
  process.exit(1);
}
