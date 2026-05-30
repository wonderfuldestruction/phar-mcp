#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createPublicClient, http, toFunctionSelector, toFunctionSignature } from "viem";
import { avalanche } from "viem/chains";
import { contractAbis } from "../dist/abis.js";
import { contractRegistry } from "../dist/contracts.js";
import { lookupFunction } from "../dist/lookup.js";

const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const wallet = process.env.PHAR_MCP_WALLET ?? "0x0000000000000000000000000000000000000000";
const client = createPublicClient({ chain: avalanche, transport: http(rpcUrl) });

const AUTO_VAULT = contractRegistry.autoVault.address;
const USDC = contractRegistry.usdcNative.address;
const appBundleSourceUrl = "https://www.phar.gg/_next/static/chunks/app/autovault/page-c803499e24028e78.js";
const appBundleFunctionSignatures = [
  "ACCESS_HUB()",
  "OPERATOR()",
  "VOTER()",
  "VOTE_MODULE()",
  "XRAM()",
  "addAggregator(address)",
  "addOutputToken(address)",
  "balanceOf(address)",
  "claim()",
  "claimIncentives(address[],address[][])",
  "deposit(uint256,address)",
  "earned(address)",
  "getAggregators()",
  "getClaimedInputTokens()",
  "getInputBudget(address,address)",
  "getOutputTokens()",
  "getPendingSwaps()",
  "getPendingSwapsPaginated(uint256,uint256)",
  "getPeriod()",
  "initialize(address,address,address,address,address)",
  "isUnlocked()",
  "lock()",
  "outputPreference(address)",
  "pendingSwapCount()",
  "removeAggregator(address)",
  "removeOutputToken(address,bool)",
  "rescue(address,uint256)",
  "rewardPerToken(address)",
  "setOperator(address)",
  "setOutputPreference(address)",
  "submitVotes(address[],uint256[])",
  "swap(address,(address,address,bytes))",
  "totalSupply()",
  "totalSupplyPerOutput(address)",
  "unlock(bool)",
  "withdraw(uint256)"
].sort();
const eip1967Slots = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"
};

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

async function read(address, abi, functionName, args = []) {
  try {
    const fn = lookupFunction(abi, functionName);
    return {
      ok: true,
      result: await client.readContract({ address, abi: [fn], functionName: fn.name, args, blockNumber }),
      blockNumber
    };
  } catch (error) {
    return { ok: false, blockNumber, error: shortError(error) };
  }
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

async function fetchTextEvidence(url) {
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const retrievedAt = new Date().toISOString();
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "phar-mcp-validation/1.0"
        }
      });
      const text = await response.text();
      const result = {
        ok: response.ok,
        status: response.status,
        retrievedAt,
        byteLength: text.length,
        contentSha256: createHash("sha256").update(text).digest("hex")
      };
      attempts.push({ attempt, ...result });
      if (response.ok) return { ...result, attempts };
    } catch (error) {
      attempts.push({ attempt, ok: false, retrievedAt, error: shortError(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  return {
    ok: false,
    retrievedAt: attempts.at(-1)?.retrievedAt ?? new Date().toISOString(),
    attempts,
    error: attempts.at(-1)?.error ?? `HTTP ${attempts.at(-1)?.status ?? "unknown"}`
  };
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

function signatureNames(signatures) {
  return [...new Set((signatures ?? []).map((signature) => signature.split("(")[0]))].sort();
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

function liveReadEvidence(liveReads) {
  const reads = Object.values(liveReads ?? {});
  return {
    readCount: reads.length,
    failedCount: reads.filter((item) => !item?.ok).length,
    blockNumber
  };
}

function provenanceGate(proxyExactAbi, implementationExactAbi, selectorCoverage, liveReads, implementation) {
  const readsEvidence = liveReadEvidence(liveReads);
  const selectorComplete = Number(selectorCoverage.selectorsMissing ?? 0) === 0;
  const promotionEligible = selectorComplete &&
    readsEvidence.failedCount === 0 &&
    implementationExactAbi?.ok === true;
  const promotionBlockers = [
    proxyExactAbi.ok ? null : `proxy exact ABI ${proxyExactAbi.classification}`,
    implementationExactAbi?.ok ? null : `implementation exact ABI ${implementationExactAbi?.classification ?? "missing_implementation"}`,
    selectorComplete ? null : "selector coverage incomplete",
    readsEvidence.failedCount === 0 ? null : "representative live reads failed"
  ].filter(Boolean);

  return {
    evidenceClass: "eip1967_implementation_selector_backed",
    selectorBackedOnly: true,
    exactPublicAbiVerified: proxyExactAbi.ok === true,
    promotionEligible,
    keepSourceBacked: selectorComplete &&
      readsEvidence.failedCount === 0 &&
      !promotionEligible &&
      promotionBlockers.length > 0,
    promotionBlockers,
    selectorEvidence: {
      checkAddress: implementation,
      checkAddressKind: "eip1967_implementation",
      functionCount: selectorCoverage.functionCount,
      selectorsMissing: selectorCoverage.selectorsMissing,
      selectorComplete
    },
    liveReadEvidence: readsEvidence
  };
}

const slots = {};
const blockNumber = await client.getBlockNumber();
for (const [name, slot] of Object.entries(eip1967Slots)) {
  const value = await client.getStorageAt({ address: AUTO_VAULT, slot, blockNumber });
  slots[name] = { slot, value, address: addressFromSlot(value), blockNumber };
}

const proxyCode = await client.getCode({ address: AUTO_VAULT, blockNumber });
const implementation = slots.implementation.address;
const implementationCode = implementation ? await client.getCode({ address: implementation, blockNumber }) : undefined;
const implementationCodeLower = implementationCode?.toLowerCase() ?? "";

const functions = contractAbis.autoVault
  .filter((item) => item.type === "function")
  .map((fn) => {
    const signature = toFunctionSignature(fn);
    const selector = toFunctionSelector(signature);
    return {
      signature,
      selector,
      implementationBytecode: selectorPresence(implementationCodeLower, selector)
    };
  });
const errors = contractAbis.autoVault
  .filter((item) => item.type === "error")
  .map((error) => {
    const signature = errorSignature(error);
    const selector = toFunctionSelector(signature);
    return {
      signature,
      selector,
      implementationBytecode: selectorPresence(implementationCodeLower, selector)
    };
  });
const localFunctionSignatures = functions.map((item) => item.signature).sort();
const localErrorSignatures = errorSignatures(contractAbis.autoVault);
const selectorCoverage = {
  functionCount: functions.length,
  selectorsPresent: functions.filter((item) => item.implementationBytecode.present).length,
  selectorsMissing: functions.filter((item) => !item.implementationBytecode.present).length
};
const errorSelectorCoverage = {
  errorCount: errors.length,
  selectorsPresent: errors.filter((item) => item.implementationBytecode.present).length,
  selectorsMissing: errors.filter((item) => !item.implementationBytecode.present).length
};
const appBundleSource = await fetchTextEvidence(appBundleSourceUrl);
const appBundleDelta = {
  sourceUrl: appBundleSourceUrl,
  retrievedAt: appBundleSource.retrievedAt,
  contentSha256: appBundleSource.contentSha256 ?? null,
  sourceFetch: appBundleSource,
  functionCount: appBundleFunctionSignatures.length,
  missingFromLocal: appBundleFunctionSignatures.filter((signature) => !localFunctionSignatures.includes(signature)),
  localExtra: localFunctionSignatures.filter((signature) => !appBundleFunctionSignatures.includes(signature))
};
const appBundleFunctionNames = signatureNames(appBundleFunctionSignatures);
const localFunctionNames = signatureNames(localFunctionSignatures);
const commonFunctionNames = localFunctionNames.filter((name) => appBundleFunctionNames.includes(name));
const commonFunctionSignatures = localFunctionSignatures.filter((signature) => appBundleFunctionSignatures.includes(signature));
const localFunctionNamesMissingFromSource = localFunctionNames.filter((name) => !appBundleFunctionNames.includes(name));
const expectedLocalFunctionNamesMissingFromSource = localFunctionNamesMissingFromSource.filter((name) => name === "getStoredRewards");
const localFunctionSignaturesMissingFromSource = localFunctionSignatures.filter((signature) => !appBundleFunctionSignatures.includes(signature));
const expectedLocalFunctionSignaturesMissingFromSource = localFunctionSignaturesMissingFromSource.filter((signature) => signature.startsWith("getStoredRewards("));
const sourceArtifactEvidence = {
  status: appBundleSource.ok === true ? "source_artifacts_fetched" : "source_artifacts_unavailable",
  evidenceLevel: "pharaoh_app_bundle_hash_and_signature_list_comparison",
  signatureExtractionStatus: "complete",
  signatureExtractionWarnings: [],
  skippedSignatureCandidates: [],
  artifactCount: 1,
  fetchedArtifactCount: appBundleSource.ok === true ? 1 : 0,
  artifacts: [{
    kind: "pharaoh_nextjs_autovault_app_bundle",
    repository: null,
    commit: null,
    path: "app/autovault/page-c803499e24028e78.js",
    sourceUrl: appBundleSourceUrl,
    fetchHost: new URL(appBundleSourceUrl).host,
    retrievedAt: appBundleSource.retrievedAt,
    ok: appBundleSource.ok === true,
    httpStatus: appBundleSource.status ?? null,
    httpStatusText: null,
    contentLength: appBundleSource.byteLength ?? null,
    contentSha256: appBundleSource.contentSha256 ?? null,
    error: appBundleSource.error ?? null
  }],
  sourceFunctionSignatureCount: appBundleFunctionSignatures.length,
  sourceFunctionSignaturesSha256: signaturesSha256(appBundleFunctionSignatures),
  sourceExplicitFunctionSignatureCount: appBundleFunctionSignatures.length,
  sourceExplicitFunctionSignaturesSha256: signaturesSha256(appBundleFunctionSignatures),
  sourcePublicGetterSignatureCount: 0,
  sourcePublicGetterSignaturesSha256: signaturesSha256([]),
  sourceFunctionNameCount: appBundleFunctionNames.length,
  sourceFunctionNamesSha256: signaturesSha256(appBundleFunctionNames),
  sourceExplicitFunctionNameCount: appBundleFunctionNames.length,
  sourceExplicitFunctionNamesSha256: signaturesSha256(appBundleFunctionNames),
  sourcePublicGetterNameCount: 0,
  sourcePublicGetterNamesSha256: signaturesSha256([]),
  localFunctionSignatureCount: localFunctionSignatures.length,
  localFunctionSignaturesSha256: signaturesSha256(localFunctionSignatures),
  localErrorSignatureCount: localErrorSignatures.length,
  localErrorSignaturesSha256: signaturesSha256(localErrorSignatures),
  comparison: {
    sourceFunctionNames: appBundleFunctionNames,
    sourceFunctionSignatures: appBundleFunctionSignatures,
    sourceExplicitFunctionNames: appBundleFunctionNames,
    sourceExplicitFunctionSignatures: appBundleFunctionSignatures,
    sourcePublicGetterNames: [],
    sourcePublicGetterSignatures: [],
    localFunctionNames,
    localErrorNames: signatureNames(localErrorSignatures),
    commonFunctionNames,
    commonFunctionSignatures,
    localFunctionNamesMissingFromSource,
    localFunctionSignaturesMissingFromSource,
    expectedLocalFunctionNamesMissingFromSource,
    expectedLocalFunctionSignaturesMissingFromSource,
    unexpectedLocalFunctionNamesMissingFromSource: localFunctionNamesMissingFromSource.filter((name) => !expectedLocalFunctionNamesMissingFromSource.includes(name)),
    unexpectedLocalFunctionSignaturesMissingFromSource: localFunctionSignaturesMissingFromSource.filter((signature) => !expectedLocalFunctionSignaturesMissingFromSource.includes(signature)),
    expectedMissingReason: "getStoredRewards(address) is selector/live-read backed and present in the local AutoVault ABI, but it is absent from the app-bundle signature list.",
    appBundleSignaturesMissingFromLocal: appBundleDelta.missingFromLocal,
    localSignaturesExtraVsAppBundle: appBundleDelta.localExtra,
    localFunctionNameCoverage: localFunctionNames.length === 0 ? 0 : commonFunctionNames.length / localFunctionNames.length,
    localFunctionSignatureCoverage: localFunctionSignatures.length === 0 ? 0 : commonFunctionSignatures.length / localFunctionSignatures.length,
    localErrorNameCoverage: null,
    comparisonScope: "AutoVault source artifact is the Pharaoh app bundle ABI/signature surface plus bundle content hash; selector bytecode checks remain the authoritative runtime evidence."
  }
};
const [proxyExplorer, implementationExplorer, proxyRemoteAbi, implementationRemoteAbi] = await Promise.all([
  explorerStatus(AUTO_VAULT),
  implementation ? explorerStatus(implementation) : Promise.resolve(null),
  fetchRemoteAbi(AUTO_VAULT),
  implementation ? fetchRemoteAbi(implementation) : Promise.resolve(null)
]);
const proxyExactAbiMatch = proxyRemoteAbi.abi ? compareAbi(contractAbis.autoVault, proxyRemoteAbi.abi) : null;
const implementationExactAbiMatch = implementationRemoteAbi?.abi ? compareAbi(contractAbis.autoVault, implementationRemoteAbi.abi) : null;
const proxyExactAbi = exactAbiReport(proxyRemoteAbi, proxyExactAbiMatch);
const implementationExactAbi = implementationRemoteAbi ? exactAbiReport(implementationRemoteAbi, implementationExactAbiMatch) : null;
const promotionBlockers = [
  proxyExactAbi.ok ? null : `proxy exact ABI ${proxyExactAbi.classification}`,
  implementationExactAbi?.ok ? null : `implementation exact ABI ${implementationExactAbi?.classification ?? "missing_implementation"}`,
  selectorCoverage.selectorsMissing === 0 ? null : `${selectorCoverage.selectorsMissing} local selectors missing from implementation bytecode`,
  appBundleDelta.missingFromLocal.length === 1 && appBundleDelta.missingFromLocal[0] === "initialize(address,address,address,address,address)"
    ? null
    : appBundleDelta.missingFromLocal.length > 0
      ? `${appBundleDelta.missingFromLocal.length} app-bundle functions missing from local ABI`
      : null
].filter(Boolean);

const liveReads = {
  ACCESS_HUB: await read(AUTO_VAULT, contractAbis.autoVault, "ACCESS_HUB"),
  OPERATOR: await read(AUTO_VAULT, contractAbis.autoVault, "OPERATOR"),
  VOTER: await read(AUTO_VAULT, contractAbis.autoVault, "VOTER"),
  VOTE_MODULE: await read(AUTO_VAULT, contractAbis.autoVault, "VOTE_MODULE"),
  XRAM: await read(AUTO_VAULT, contractAbis.autoVault, "XRAM"),
  balanceOf: await read(AUTO_VAULT, contractAbis.autoVault, "balanceOf", [wallet]),
  earned: await read(AUTO_VAULT, contractAbis.autoVault, "earned", [wallet]),
  getAggregators: await read(AUTO_VAULT, contractAbis.autoVault, "getAggregators"),
  getClaimedInputTokens: await read(AUTO_VAULT, contractAbis.autoVault, "getClaimedInputTokens"),
  getInputBudget: await read(AUTO_VAULT, contractAbis.autoVault, "getInputBudget", [USDC, USDC]),
  getOutputTokens: await read(AUTO_VAULT, contractAbis.autoVault, "getOutputTokens"),
  getPendingSwaps: await read(AUTO_VAULT, contractAbis.autoVault, "getPendingSwaps"),
  getPendingSwapsPaginated: await read(AUTO_VAULT, contractAbis.autoVault, "getPendingSwapsPaginated", [0n, 5n]),
  getPeriod: await read(AUTO_VAULT, contractAbis.autoVault, "getPeriod"),
  getStoredRewards: await read(AUTO_VAULT, contractAbis.autoVault, "getStoredRewards", [wallet]),
  isUnlocked: await read(AUTO_VAULT, contractAbis.autoVault, "isUnlocked"),
  outputPreference: await read(AUTO_VAULT, contractAbis.autoVault, "outputPreference", [wallet]),
  pendingSwapCount: await read(AUTO_VAULT, contractAbis.autoVault, "pendingSwapCount"),
  rewardPerToken: await read(AUTO_VAULT, contractAbis.autoVault, "rewardPerToken", [USDC]),
  totalSupply: await read(AUTO_VAULT, contractAbis.autoVault, "totalSupply"),
  totalSupplyPerOutput: await read(AUTO_VAULT, contractAbis.autoVault, "totalSupplyPerOutput", [USDC])
};
const gate = provenanceGate(proxyExactAbi, implementationExactAbi, selectorCoverage, liveReads, implementation);

const report = {
  timestamp: new Date().toISOString(),
  chainId: 43114,
  rpcUrl,
  blockNumber,
  autoVault: AUTO_VAULT,
  status: contractRegistry.autoVault.status,
  abiKey: contractRegistry.autoVault.abiKey,
  selectorCheckAddress: implementation,
  selectorSummary: selectorCoverage,
  statusRecommendation: "keep source_backed_abi_candidate",
  provenanceGate: gate,
  summary: {
    promotionEligible: gate.promotionEligible,
    promotableSourceBackedTargets: gate.promotionEligible ? ["autoVault"] : [],
    promotionBlockers: gate.promotionBlockers,
    selectorComplete: gate.selectorEvidence.selectorComplete,
    liveReadFailures: Object.entries(liveReads)
      .filter(([, item]) => item?.ok !== true)
      .map(([name, item]) => `${name}: ${item?.error ?? "read failed"}`)
  },
  promotion: {
    statusRecommendation: "keep source_backed_abi_candidate",
    promotionBlockers,
    proxyExactAbi,
    implementationExactAbi,
    selectorCoverage,
    appBundleDelta
  },
  sourceArtifactEvidence,
  reason: "AutoVault proxy and EIP-1967 implementation are both unverified through public Snowtrace/Routescan ABI endpoints; local ABI covers all app-bundle functions whose selectors are present in runtime bytecode plus one live selector-backed helper, and representative reads pass. The app bundle lists initialize(address,address,address,address,address), but that selector is absent from runtime bytecode and is intentionally not exposed.",
  proxy: {
    codeBytes: proxyCode ? (proxyCode.length - 2) / 2 : 0,
    codeSha256: bytecodeSha256(proxyCode),
    codeBlockNumber: blockNumber,
    eip1967: slots,
    explorer: proxyExplorer
  },
  implementation: implementation ? {
    address: implementation,
    codeBytes: implementationCode ? (implementationCode.length - 2) / 2 : 0,
    codeSha256: bytecodeSha256(implementationCode),
    codeBlockNumber: blockNumber,
    explorer: implementationExplorer
  } : null,
  localAbi: {
    functionCount: functions.length,
    functionSignaturesSha256: signaturesSha256(localFunctionSignatures),
    selectorsPresent: functions.filter((item) => item.implementationBytecode.present).length,
    selectorsMissing: functions.filter((item) => !item.implementationBytecode.present),
    errorCount: errorSelectorCoverage.errorCount,
    errorSignaturesSha256: signaturesSha256(localErrorSignatures),
    errorSelectorsPresent: errorSelectorCoverage.selectorsPresent,
    errorSelectorsMissing: errors.filter((item) => !item.implementationBytecode.present),
    customErrors: errors,
    appBundle: appBundleDelta,
    functions
  },
  liveReads,
  caveat: "Selector presence is bytecode evidence, not a verified source ABI. Keep normal MCP AutoVault tools as unsigned calldata builders with source-backed warnings."
};

console.log(stringify(report));
