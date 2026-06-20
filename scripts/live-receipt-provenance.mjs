#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, decodeFunctionData, http, parseAbi, toEventSelector, toFunctionSelector } from "viem";
import { avalanche } from "viem/chains";

const reportDir = "reports";
const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const wallet = (process.env.PHAR_MCP_WALLET ?? "0x0000000000000000000000000000000000000000").toLowerCase();
const client = createPublicClient({ chain: avalanche, transport: http(rpcUrl, { timeout: 120_000, retryCount: 1 }) });
const liveSources = [
  { file: "live-broadcast.latest.json", stepPhase: "live_broadcast" },
  { file: "p33-live.latest.json", stepPhase: "p33_live", optional: true },
  { file: "p33-mint-withdraw-live.latest.json", stepPhase: "p33_mint_withdraw_live", optional: true },
  { file: "mixed-route-live.latest.json", stepPhase: "mixed_route_live" },
  { file: "vote-live.latest.json", stepPhase: "vote_module_roundtrip" },
  { file: "xphar-exit.latest.json", stepPhase: "xphar_exit" },
  { file: "dlmm-multibin-live.latest.json", stepPhase: "dlmm_multibin_manual_live" },
  { file: "dlmm-close-live.latest.json", stepPhase: "dlmm_close_manual_live" }
];
const knownEventSelectors = Object.fromEntries([
  ["Transfer", "Transfer(address,address,uint256)"],
  ["Approval", "Approval(address,address,uint256)"],
  ["ApprovalForAll", "ApprovalForAll(address,address,bool)"],
  ["TransferSingle", "TransferSingle(address,address,address,uint256,uint256)"],
  ["TransferBatch", "TransferBatch(address,address,address,uint256[],uint256[])"],
  ["WAVAXDeposit", "Deposit(address,uint256)"],
  ["WAVAXWithdrawal", "Withdrawal(address,uint256)"],
  ["AutoVaultDeposit", "Deposit(address,uint256,address)"],
  ["AutoVaultWithdraw", "Withdraw(address,uint256)"],
  ["AutoVaultClaimed", "Claimed(address,address,uint256)"],
  ["P33Deposit", "Deposit(address,address,uint256,uint256)"],
  ["P33Withdraw", "Withdraw(address,address,address,uint256,uint256)"],
  ["LegacyPairSwap", "Swap(address,uint256,uint256,uint256,uint256,address)"],
  ["LegacyPairMint", "Mint(address,uint256,uint256)"],
  ["LegacyPairBurn", "Burn(address,uint256,uint256,address)"],
  ["LegacyPairSync", "Sync(uint112,uint112)"],
  ["XPharConverted", "Converted(address,uint256)"],
  ["XPharInstantExit", "InstantExit(address,uint256)"],
  ["VoterVoted", "Voted(address,uint256,address)"],
  ["VoterPoke", "Poke(address)"],
  ["RamsesV3PoolMint", "Mint(address,address,uint256,int24,int24,uint128,uint256,uint256)"],
  ["RamsesV3PoolBurn", "Burn(address,int24,int24,uint128,uint256,uint256)"],
  ["RamsesV3PoolCollect", "Collect(address,address,int24,int24,uint128,uint128)"],
  ["RamsesV3PoolSwap", "Swap(address,address,int256,int256,uint160,uint128,int24)"],
  ["RamsesV3PositionIncreaseLiquidity", "IncreaseLiquidity(uint256,uint128,uint256,uint256)"],
  ["RamsesV3PositionDecreaseLiquidity", "DecreaseLiquidity(uint256,uint128,uint256,uint256)"],
  ["RamsesV3PositionCollect", "Collect(uint256,address,uint256,uint256)"],
  ["DLMMPoolSwap", "Swap(address,address,uint24,bytes32,bytes32,uint24,bytes32,bytes32)"],
  ["DLMMCompositionFees", "CompositionFees(address,uint24,bytes32,bytes32)"],
  ["DLMMDepositedToBins", "DepositedToBins(address,address,uint256[],bytes32[])"],
  ["DLMMWithdrawnFromBins", "WithdrawnFromBins(address,address,uint256[],bytes32[])"]
].map(([name, signature]) => [toEventSelector(signature), { name, signature }]));
const knownContracts = Object.fromEntries([
  ["pharToken", "PHAR Token", "Token", "0x13A466998Ce03Db73aBc2d4DF3bBD845Ed1f28E7", "verified_abi_first_pass", ["erc20"]],
  ["xPharToken", "xPHAR Token", "Token", "0xE8164Ea89665DAb7a553e667F81F30CfDA736B9A", "verified_abi_first_pass", ["erc20"]],
  ["autoVault", "AutoVault", "Autovault", "0xFe99E92df71F53a26005d1bFbe54C941A3131Aa0", "source_backed_abi_candidate", []],
  ["p33", "p33", "p33", "0x26e9dbe75aed331e41272bece932ff1b48926ca9", "verified_abi_first_pass", ["erc20"]],
  ["voter", "Voter", "Voter", "0x922b9Ca8e2207bfB850B6FF647c054d4b58a2Aa7", "source_backed_abi_candidate", []],
  ["voteModule", "VoteModule", "Vote Module", "0x34F233F868CdB42446a18562710eE705d66f846b", "verified_abi_first_pass", []],
  ["ramsesV3PositionManager", "RamsesV3PositionManager", "Concentrated Liquidity", "0x0B4478e810D48B5882D4019D435A2f864Bab4F39", "verified_abi_first_pass", ["erc721"]],
  ["legacyPair", "Legacy Pair Instance ABI", "Legacy", "0x1cca95F17Eb953cd8c3D91fe81C7e8e815ac8ADd", "verified_abi_first_pass", ["erc20"]],
  ["router", "Router", "Legacy", "0x9CEE04bDcE127DA7E448A333f006DEFb3d5e38cC", "verified_abi_first_pass", []],
  ["dlmmRouter", "DLMMRouter", "DLMM", "0xff2BEFC4ff86CB0f3e8D3d9D6200B7A05BF5D93d", "source_backed_abi_candidate", []],
  ["dlmmWavaxUsdc5Pool", "DLMM WAVAX/USDC BinStep 5 Pool", "DLMM", "0x8aC5707f8D4BDe1d771d34c7AfD81c3922b73379", "source_backed_abi_candidate", ["erc1155"]],
  ["universalRouter", "UniversalRouter", "Concentrated Liquidity", "0x5AcC35397D2ce81Ac54A4B1c6D9e1FB29F8EC6C6", "verified_abi_first_pass", []],
  ["wavax", "WAVAX", "Token", "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", "verified_abi_first_pass", ["erc20"]],
  ["usdcNative", "Avalanche USDC", "Token", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", "official_address_only", ["erc20"]]
].map(([key, name, category, address, status, traits]) => [address.toLowerCase(), { key, name, category, address, status, traits }]));
const knownFunctionSelectorEntries = [
  { key: "erc20.approve", contractTrait: "erc20", name: "approve", signature: "approve(address,uint256)" },
  { key: "router.swapExactTokensForTokens", contractKey: "router", name: "swapExactTokensForTokens", signature: "swapExactTokensForTokens(uint256,uint256,(address,address,bool)[],address,uint256)" },
  { key: "router.addLiquidityETH", contractKey: "router", name: "addLiquidityETH", signature: "addLiquidityETH(address,bool,uint256,uint256,uint256,address,uint256)" },
  { key: "router.removeLiquidityETH", contractKey: "router", name: "removeLiquidityETH", signature: "removeLiquidityETH(address,bool,uint256,uint256,uint256,address,uint256)" },
  { key: "xPharToken.convertEmissionsToken", contractKey: "xPharToken", name: "convertEmissionsToken", signature: "convertEmissionsToken(uint256)" },
  { key: "xPharToken.exit", contractKey: "xPharToken", name: "exit", signature: "exit(uint256)" },
  { key: "p33.deposit", contractKey: "p33", name: "deposit", signature: "deposit(uint256,address)" },
  { key: "p33.mint", contractKey: "p33", name: "mint", signature: "mint(uint256,address)" },
  { key: "p33.redeem", contractKey: "p33", name: "redeem", signature: "redeem(uint256,address,address)" },
  { key: "p33.withdraw", contractKey: "p33", name: "withdraw", signature: "withdraw(uint256,address,address)" },
  { key: "autoVault.deposit", contractKey: "autoVault", name: "deposit", signature: "deposit(uint256,address)" },
  { key: "autoVault.withdraw", contractKey: "autoVault", name: "withdraw", signature: "withdraw(uint256)" },
  { key: "ramsesV3PositionManager.mint", contractKey: "ramsesV3PositionManager", name: "mint", signature: "mint((address,address,int24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))" },
  { key: "ramsesV3PositionManager.decreaseLiquidity", contractKey: "ramsesV3PositionManager", name: "decreaseLiquidity", signature: "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))" },
  { key: "ramsesV3PositionManager.collect", contractKey: "ramsesV3PositionManager", name: "collect", signature: "collect((uint256,address,uint128,uint128))" },
  { key: "ramsesV3PositionManager.burn", contractKey: "ramsesV3PositionManager", name: "burn", signature: "burn(uint256)" },
  { key: "dlmmRouter.swapExactNATIVEForTokens", contractKey: "dlmmRouter", name: "swapExactNATIVEForTokens", signature: "swapExactNATIVEForTokens(uint256,(uint256[],uint8[],address[]),address,uint256)" },
  { key: "dlmmRouter.addLiquidity", contractKey: "dlmmRouter", name: "addLiquidity", signature: "addLiquidity((address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,int256[],uint256[],uint256[],address,address,uint256))" },
  { key: "dlmmRouter.addLiquidityNATIVE", contractKey: "dlmmRouter", name: "addLiquidityNATIVE", signature: "addLiquidityNATIVE((address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,int256[],uint256[],uint256[],address,address,uint256))" },
  { key: "dlmmRouter.removeLiquidity", contractKey: "dlmmRouter", name: "removeLiquidity", signature: "removeLiquidity(address,address,uint16,uint256,uint256,uint256[],uint256[],address,uint256)" },
  { key: "dlmmRouter.removeLiquidityNATIVE", contractKey: "dlmmRouter", name: "removeLiquidityNATIVE", signature: "removeLiquidityNATIVE(address,uint16,uint256,uint256,uint256[],uint256[],address,uint256)" },
  { key: "dlmmPool.approveForAll", contractKey: "dlmmWavaxUsdc5Pool", name: "approveForAll", signature: "approveForAll(address,bool)" },
  { key: "universalRouter.executeDeadline", contractKey: "universalRouter", name: "execute", signature: "execute(bytes,bytes[],uint256)" },
  { key: "voteModule.deposit", contractKey: "voteModule", name: "deposit", signature: "deposit(uint256)" },
  { key: "voteModule.delegate", contractKey: "voteModule", name: "delegate", signature: "delegate(address)" },
  { key: "voteModule.withdraw", contractKey: "voteModule", name: "withdraw", signature: "withdraw(uint256)" },
  { key: "voter.vote", contractKey: "voter", name: "vote", signature: "vote(address,address[],uint256[])" },
  { key: "voter.reset", contractKey: "voter", name: "reset", signature: "reset(address)" }
].map((entry) => ({ ...entry, selector: toFunctionSelector(entry.signature) }));
const knownFunctionSelectors = knownFunctionSelectorEntries.reduce((map, entry) => {
  map[entry.selector] = [...(map[entry.selector] ?? []), entry];
  return map;
}, {});

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

function increment(map, key, amount = 1) {
  map[key] = (map[key] ?? 0) + amount;
}

function mergeCounts(target, source = {}) {
  for (const [key, value] of Object.entries(source)) increment(target, key, Number(value));
  return target;
}

function summarizeLogs(logs = []) {
  const topicCounts = {};
  const knownEventCounts = {};
  const addressCounts = {};
  const eventLogs = logs.map((log, index) => {
    const topic0 = log.topics?.[0] ?? null;
    const known = topic0 ? knownEventSelectors[topic0] ?? null : null;
    if (topic0) increment(topicCounts, topic0);
    if (known) increment(knownEventCounts, known.name);
    increment(addressCounts, log.address);

    return {
      index,
      address: log.address,
      logIndex: log.logIndex,
      transactionIndex: log.transactionIndex,
      topic0,
      knownEvent: known,
      topicsCount: log.topics?.length ?? 0,
      dataBytes: typeof log.data === "string" && log.data.startsWith("0x") ? Math.max(0, (log.data.length - 2) / 2) : null
    };
  });

  return {
    logsCount: eventLogs.length,
    knownLogCount: eventLogs.filter((log) => log.knownEvent).length,
    unknownLogCount: eventLogs.filter((log) => log.topic0 && !log.knownEvent).length,
    noTopicLogCount: eventLogs.filter((log) => !log.topic0).length,
    topicCounts,
    knownEventCounts,
    addressCounts,
    logs: eventLogs
  };
}

function calldataSha256(input) {
  if (typeof input !== "string" || !/^0x[0-9a-fA-F]*$/.test(input)) return null;
  return createHash("sha256").update(Buffer.from(input.slice(2), "hex")).digest("hex");
}

function functionAppliesToContract(candidate, knownContract) {
  if (!knownContract) return false;
  if (candidate.contractKey) return candidate.contractKey === knownContract.key;
  if (candidate.contractTrait) return (knownContract.traits ?? []).includes(candidate.contractTrait);
  return false;
}

function decodeSelectedFunction(input, selectedFunction, knownContract) {
  if (!selectedFunction) {
    return {
      ok: false,
      reason: "selector was not matched to exactly one contract-applicable function"
    };
  }
  try {
    const decoded = decodeFunctionData({
      abi: parseAbi([`function ${selectedFunction.signature}`]),
      data: input
    });
    return {
      ok: true,
      contractKey: knownContract?.key ?? selectedFunction.contractKey ?? selectedFunction.contractTrait ?? null,
      abiStatus: knownContract?.status ?? null,
      name: decoded.functionName,
      signature: selectedFunction.signature,
      selector: selectedFunction.selector,
      argsCount: decoded.args?.length ?? 0,
      args: decoded.args ?? []
    };
  } catch (error) {
    return {
      ok: false,
      contractKey: knownContract?.key ?? selectedFunction.contractKey ?? selectedFunction.contractTrait ?? null,
      abiStatus: knownContract?.status ?? null,
      signature: selectedFunction.signature,
      selector: selectedFunction.selector,
      reason: shortError(error)
    };
  }
}

function summarizeCall(transaction) {
  const input = transaction.input ?? "0x";
  const inputBytes = typeof input === "string" && input.startsWith("0x") ? Math.max(0, (input.length - 2) / 2) : null;
  const selector = Number(inputBytes ?? 0) >= 4 ? input.slice(0, 10).toLowerCase() : null;
  const knownContract = transaction.to ? knownContracts[transaction.to.toLowerCase()] ?? null : null;
  const selectorCandidates = selector ? knownFunctionSelectors[selector] ?? [] : [];
  const contractMatchedFunctions = selectorCandidates.filter((candidate) => functionAppliesToContract(candidate, knownContract));
  const selectedFunctions = contractMatchedFunctions.length > 0 ? contractMatchedFunctions : selectorCandidates;
  const selectedFunction = selectedFunctions.length === 1 ? selectedFunctions[0] : null;
  const decodedFunction = decodeSelectedFunction(input, selectedFunction, knownContract);

  return {
    input,
    inputBytes,
    inputSha256: calldataSha256(input),
    selector,
    selectorKnown: selectorCandidates.length > 0,
    selectorCandidates,
    targetKnownContract: knownContract,
    contractMatched: contractMatchedFunctions.length > 0,
    contractMatchedFunctions,
    selectedFunction,
    selectedFunctionKey: selectedFunction?.key ?? null,
    selectorEvidence: {
      matchedRegisteredAbi: contractMatchedFunctions.some((candidate) => candidate.contractKey),
      matchedApprovalFallback: contractMatchedFunctions.some((candidate) => candidate.contractTrait === "erc20" && candidate.name === "approve"),
      selectorKnown: selectorCandidates.length > 0,
      selectorSource: contractMatchedFunctions.length > 0 ? "registered_target_or_trait" : selectorCandidates.length > 0 ? "selector_only" : "unknown"
    },
    decodedFunction
  };
}

function txHashesFromReport(source, report) {
  const out = [];
  for (const [phaseIndex, phase] of (report?.phases ?? []).entries()) {
    for (const [stepIndex, step] of (phase.steps ?? []).entries()) {
      if (step?.hash) {
        out.push({
          source: `reports/${source.file}`,
          sourcePath: `phases.${phaseIndex}.steps.${stepIndex}.hash`,
          sourceTimestamp: report.timestamp ?? null,
          sourceMode: report.mode ?? null,
          phase: phase.name,
          label: step.label,
          hash: step.hash,
          reportedGasUsed: step.gasUsed ?? null
        });
      }
    }
  }
  for (const [stepIndex, step] of (report?.steps ?? []).entries()) {
    if (step?.hash) {
      out.push({
        source: `reports/${source.file}`,
        sourcePath: `steps.${stepIndex}.hash`,
        sourceTimestamp: report.timestamp ?? null,
        sourceMode: report.mode ?? null,
        phase: source.stepPhase,
        label: step.label,
        hash: step.hash,
        reportedGasUsed: step.gasUsed ?? null
      });
    }
  }
  return out;
}

async function txEvidence(item, chainId) {
  try {
    const [transaction, receipt] = await Promise.all([
      client.getTransaction({ hash: item.hash }),
      client.getTransactionReceipt({ hash: item.hash })
    ]);
    const fromMatchesWallet = transaction.from?.toLowerCase() === wallet;
    const receiptFromMatchesWallet = receipt.from?.toLowerCase() === wallet;
    const receiptHashMatches = receipt.transactionHash?.toLowerCase() === item.hash.toLowerCase();
    const blockHashMatches = transaction.blockHash === receipt.blockHash;
    const blockNumberMatches = transaction.blockNumber === receipt.blockNumber;
    const statusOk = receipt.status === "success";
    const gasUsedMatches = item.reportedGasUsed === null || String(receipt.gasUsed) === String(item.reportedGasUsed);
    const events = summarizeLogs(receipt.logs ?? []);
    const call = summarizeCall(transaction);
    return {
      ...item,
      ok: statusOk && fromMatchesWallet && receiptFromMatchesWallet && receiptHashMatches && blockHashMatches && blockNumberMatches && gasUsedMatches,
      chainId,
      transaction: {
        from: transaction.from,
        to: transaction.to,
        value: transaction.value,
        nonce: transaction.nonce,
        blockNumber: transaction.blockNumber,
        blockHash: transaction.blockHash,
        transactionIndex: transaction.transactionIndex,
        type: transaction.type ?? null,
        inputBytes: call.inputBytes,
        inputSha256: call.inputSha256,
        selector: call.selector
      },
      receipt: {
        transactionHash: receipt.transactionHash,
        status: receipt.status,
        from: receipt.from,
        to: receipt.to,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionIndex: receipt.transactionIndex,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice ?? null,
        contractAddress: receipt.contractAddress ?? null,
        logsCount: receipt.logs?.length ?? 0
      },
      events,
      call,
      checks: {
        statusOk,
        fromMatchesWallet,
        receiptFromMatchesWallet,
        receiptHashMatches,
        blockHashMatches,
        blockNumberMatches,
        gasUsedMatches,
        eventLogCountMatches: Number(receipt.logs?.length ?? 0) === events.logsCount,
        calldataPresent: Number(call.inputBytes ?? 0) >= 4,
        calldataSelectorKnown: call.selectorKnown === true,
        calldataTargetKnown: Boolean(call.targetKnownContract),
        calldataContractMatched: call.contractMatched === true,
        calldataFunctionDecoded: call.decodedFunction?.ok === true,
        reportedGasUsed: item.reportedGasUsed,
        receiptGasUsed: receipt.gasUsed
      }
    };
  } catch (error) {
    return {
      ...item,
      ok: false,
      chainId,
      error: shortError(error)
    };
  }
}

const sourceReports = liveSources.map((source) => ({ ...source, report: readJson(source.file) }));
const sourceFailures = sourceReports
  .flatMap((source) => {
    if (source.optional && !source.report) return [];
    return [
      source.report?.mode === "live" ? null : { source: `reports/${source.file}`, reason: `expected mode=live, got ${source.report?.mode ?? "missing"}` },
      source.report?.wallet?.toLowerCase?.() === wallet ? null : { source: `reports/${source.file}`, reason: `expected wallet ${wallet}, got ${source.report?.wallet ?? "missing"}` }
    ].filter(Boolean);
  });
const txs = sourceReports.flatMap((source) => txHashesFromReport(source, source.report));
const malformedHashes = txs
  .filter((tx) => !/^0x[0-9a-fA-F]{64}$/.test(tx.hash))
  .map((tx) => ({ source: tx.source, sourcePath: tx.sourcePath, hash: tx.hash, reason: "malformed transaction hash" }));
const duplicateHashes = [...txs.reduce((map, tx) => map.set(tx.hash, (map.get(tx.hash) ?? 0) + 1), new Map()).entries()]
  .filter(([, count]) => count > 1)
  .map(([hash, count]) => ({ hash, count }));
const chainId = await client.getChainId();
const blockNumber = await client.getBlockNumber();
const transactions = [];
for (const item of txs) {
  transactions.push(await txEvidence(item, chainId));
}

const failures = [
  ...sourceFailures,
  ...malformedHashes,
  ...duplicateHashes.map((item) => ({ hash: item.hash, reason: `duplicate hash appears ${item.count} times in live reports` })),
  ...transactions
    .filter((item) => !item.ok)
    .map((item) => ({
      source: item.source,
      phase: item.phase,
      label: item.label,
      hash: item.hash,
      reason: item.error ?? JSON.stringify(item.checks, (_, v) => typeof v === 'bigint' ? v.toString() : v)
    }))
];
const sourceSummaries = Object.fromEntries(liveSources.map((source) => {
  const sourcePath = `reports/${source.file}`;
  const items = transactions.filter((item) => item.source === sourcePath);
  const knownEventCounts = {};
  const topicCounts = {};
  const selectorCounts = {};
  const knownFunctionCounts = {};
  const targetContractCounts = {};
  for (const item of items) {
    mergeCounts(knownEventCounts, item.events?.knownEventCounts);
    mergeCounts(topicCounts, item.events?.topicCounts);
    if (item.call?.selector) increment(selectorCounts, item.call.selector);
    if (item.call?.selectedFunctionKey) increment(knownFunctionCounts, item.call.selectedFunctionKey);
    if (item.call?.targetKnownContract?.key) increment(targetContractCounts, item.call.targetKnownContract.key);
  }
  return [
    sourcePath,
    {
      mode: sourceReports.find((item) => item.file === source.file)?.report?.mode ?? null,
      txCount: items.length,
      okCount: items.filter((item) => item.ok).length,
      failedCount: items.filter((item) => !item.ok).length,
      allFromWallet: items.every((item) => item.checks?.fromMatchesWallet === true),
      allReceiptSuccess: items.every((item) => item.checks?.statusOk === true),
      calldataCount: items.filter((item) => Number(item.call?.inputBytes ?? 0) >= 4).length,
      knownSelectorCount: items.filter((item) => item.call?.selectorKnown === true).length,
      knownTargetCount: items.filter((item) => item.call?.targetKnownContract).length,
      contractMatchedFunctionCount: items.filter((item) => item.call?.contractMatched === true).length,
      decodedFunctionCount: items.filter((item) => item.call?.decodedFunction?.ok === true).length,
      logsCount: items.reduce((sum, item) => sum + Number(item.events?.logsCount ?? 0), 0),
      knownEventCounts,
      topicCounts,
      selectorCounts,
      knownFunctionCounts,
      targetContractCounts
    }
  ];
}));
const knownEventCounts = {};
const topicCounts = {};
const selectorCounts = {};
const knownFunctionCounts = {};
const targetContractCounts = {};
for (const item of transactions) {
  mergeCounts(knownEventCounts, item.events?.knownEventCounts);
  mergeCounts(topicCounts, item.events?.topicCounts);
  if (item.call?.selector) increment(selectorCounts, item.call.selector);
  if (item.call?.selectedFunctionKey) increment(knownFunctionCounts, item.call.selectedFunctionKey);
  if (item.call?.targetKnownContract?.key) increment(targetContractCounts, item.call.targetKnownContract.key);
}
const ok = chainId === 43114 &&
  sourceFailures.length === 0 &&
  malformedHashes.length === 0 &&
  duplicateHashes.length === 0 &&
  transactions.length > 0 &&
  transactions.every((item) => item.ok);

console.log(stringify({
  ok,
  timestamp: new Date().toISOString(),
  chainId,
  rpcUrl,
  blockNumber,
  wallet: `0x${wallet.slice(2)}`,
  summary: {
    sourceReportCount: liveSources.length,
    txCount: transactions.length,
    uniqueHashCount: new Set(transactions.map((item) => item.hash)).size,
    successCount: transactions.filter((item) => item.checks?.statusOk === true).length,
    fromWalletCount: transactions.filter((item) => item.checks?.fromMatchesWallet === true).length,
    gasUsedMatchCount: transactions.filter((item) => item.checks?.gasUsedMatches === true).length,
    eventLogCountMatchCount: transactions.filter((item) => item.checks?.eventLogCountMatches === true).length,
    calldataCount: transactions.filter((item) => Number(item.call?.inputBytes ?? 0) >= 4).length,
    knownSelectorCount: transactions.filter((item) => item.call?.selectorKnown === true).length,
    knownTargetCount: transactions.filter((item) => item.call?.targetKnownContract).length,
    contractMatchedFunctionCount: transactions.filter((item) => item.call?.contractMatched === true).length,
    decodedFunctionCount: transactions.filter((item) => item.call?.decodedFunction?.ok === true).length,
    unknownSelectorCount: transactions.filter((item) => item.call?.selector && item.call?.selectorKnown !== true).length,
    transactionsWithLogsCount: transactions.filter((item) => Number(item.events?.logsCount ?? 0) > 0).length,
    logsCount: transactions.reduce((sum, item) => sum + Number(item.events?.logsCount ?? 0), 0),
    knownLogCount: transactions.reduce((sum, item) => sum + Number(item.events?.knownLogCount ?? 0), 0),
    unknownLogCount: transactions.reduce((sum, item) => sum + Number(item.events?.unknownLogCount ?? 0), 0),
    knownEventCounts,
    topicCounts,
    selectorCounts,
    knownFunctionCounts,
    targetContractCounts,
    failureCount: failures.length,
    sourceSummaries
  },
  failures,
  transactions,
  caveat: "This report verifies historical live transaction hashes on Avalanche mainnet without rebroadcasting any transaction. It records public calldata, calldata hashes, target contract labels, function selectors, receipt log addresses/topics, and labels common event selectors, but it does not fully decode every protocol-specific event argument or prove business-level state deltas beyond what the original live reports recorded."
}));

if (!ok) process.exit(1);
