#!/usr/bin/env node
import { createPublicClient, formatUnits, http, parseAbiItem, toFunctionSelector, zeroAddress } from "viem";
import { avalanche } from "viem/chains";
import { contractAbis } from "../dist/abis.js";
import { contractRegistry } from "../dist/contracts.js";
import { lookupFunction } from "../dist/lookup.js";
import { rewardClaimabilityRead } from "../dist/queryTools.js";
import {
  autoVaultActionMap,
  buildMappedWorkflowTx,
  dlmmActionMap,
  gaugeActionMap,
  voteActionMap
} from "../dist/workflowTools.js";

const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const client = createPublicClient({ chain: avalanche, transport: http(rpcUrl) });

const scanBlocks = BigInt(process.env.REWARD_FIXTURE_SCAN_BLOCKS ?? "50000");
const chunkSize = BigInt(process.env.REWARD_FIXTURE_CHUNK_SIZE ?? "1500");
const candidateLimit = Number(process.env.REWARD_FIXTURE_CANDIDATE_LIMIT ?? "25");
const assessmentLimit = Number(process.env.REWARD_FIXTURE_ASSESSMENT_LIMIT ?? "12");
const domainAssessmentLimit = Number(process.env.REWARD_FIXTURE_DOMAIN_ASSESSMENT_LIMIT ?? "48");
const legacyGaugeLimit = Number(process.env.REWARD_FIXTURE_LEGACY_GAUGE_LIMIT ?? "100");
const feeDistributorLimit = Number(process.env.REWARD_FIXTURE_FEE_DISTRIBUTOR_LIMIT ?? "12");
const dlmmRewarderLimit = Number(process.env.REWARD_FIXTURE_DLMM_REWARDER_LIMIT ?? "20");
const dlmmPairLimit = Number(process.env.REWARD_FIXTURE_DLMM_PAIR_LIMIT ?? "50");
const dlmmScanBlocks = BigInt(process.env.REWARD_FIXTURE_DLMM_SCAN_BLOCKS ?? "1000000");
const dlmmChunkSize = BigInt(process.env.REWARD_FIXTURE_DLMM_CHUNK_SIZE ?? "1500");
const fallbackChunkSize = BigInt(process.env.REWARD_FIXTURE_FALLBACK_CHUNK_SIZE ?? "1500");
const voterPeriodLookback = Number(process.env.REWARD_FIXTURE_VOTER_PERIODS ?? "4");
const p33HistoryPeriods = Number(process.env.REWARD_FIXTURE_P33_HISTORY_PERIODS ?? "64");
const p33HistoryPositiveLimit = Number(process.env.REWARD_FIXTURE_P33_HISTORY_POSITIVE_LIMIT ?? "25");

const erc20TransferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const erc721TransferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const transferSingleEvent = parseAbiItem("event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)");
const transferBatchEvent = parseAbiItem("event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)");
const autoVaultDepositEvent = parseAbiItem("event Deposit(address indexed account, uint256 amount, address indexed outputToken)");
const autoVaultWithdrawEvent = parseAbiItem("event Withdraw(address indexed account, uint256 amount)");
const autoVaultClaimedEvent = parseAbiItem("event Claimed(address indexed account, address indexed token, uint256 amount)");
const dlmmRewarderCreatedEvent = parseAbiItem("event DLMMRewarderCreated(address indexed pool, address indexed rewarder)");

const CL_WAVAX_USDC_10_POOL = "0xf01449C0bA930B6e2CaCA3DEF3CCBd7a3E589534";
const DLMM_REWARDED_POOL = "0x87206a5a6eDDd4e22423425BA66C2591551BFc6f";
const ramsesSourceBase = "https://github.com/code-423n4/2024-10-ramses-exchange/blob/main";
const clGaugeStaleNftErrorEvidence = [
  {
    signature: "ERC721NonexistentToken(uint256)",
    selector: toFunctionSelector("ERC721NonexistentToken(uint256)"),
    source: "OpenZeppelin ERC721 _requireOwned via RamsesV3PositionManager ownerOf(uint256)",
    sourceUrl: `${ramsesSourceBase}/contracts/CL/periphery/NonfungiblePositionManager.sol`
  },
  {
    signature: "InvalidTokenId(uint256)",
    selector: toFunctionSelector("InvalidTokenId(uint256)"),
    source: "RamsesV3PositionManager.positions(uint256) InvalidTokenId, bubbled through GaugeV3.earned(address,uint256)",
    sourceUrls: [
      `${ramsesSourceBase}/contracts/CL/periphery/interfaces/IPeripheryErrors.sol`,
      `${ramsesSourceBase}/contracts/CL/periphery/NonfungiblePositionManager.sol`,
      `${ramsesSourceBase}/contracts/CL/gauge/GaugeV3.sol`
    ]
  }
];

function shortError(error) {
  return describeError(error).error;
}

function stringifyDecodedArg(value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function decodedError(error) {
  const data = error?.cause?.data ?? error?.data;
  const abiItem = data?.abiItem;
  if (!data?.errorName || !abiItem?.inputs) return undefined;
  const signature = `${data.errorName}(${abiItem.inputs.map((input) => input.type).join(",")})`;
  return {
    name: data.errorName,
    signature,
    selector: toFunctionSelector(signature),
    args: (data.args ?? []).map(stringifyDecodedArg)
  };
}

function describeError(error) {
  const decoded = decodedError(error);
  if (decoded) {
    return {
      error: `${decoded.signature} (${decoded.selector})`,
      decodedError: decoded
    };
  }
  return {
    error: error?.shortMessage ?? error?.message ?? String(error)
  };
}

function abiWithErrors(abi, fn) {
  return [fn, ...abi.filter((item) => item.type === "error")];
}

function stringify(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function isNonZeroAddress(address) {
  return Boolean(address) && address.toLowerCase() !== zeroAddress.toLowerCase();
}

function positive(value) {
  return typeof value === "bigint" && value > 0n;
}

function readValue(read) {
  return read.ok ? read.result : undefined;
}

function uniqueAddresses(addresses) {
  const seen = new Set();
  const out = [];
  for (const address of addresses) {
    if (!isNonZeroAddress(address)) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

function limited(values, limit) {
  return values.slice(0, Math.max(0, limit));
}

async function read(address, abi, functionName, args = []) {
  try {
    const fn = lookupFunction(abi, functionName);
    return {
      ok: true,
      result: await client.readContract({ address, abi: abiWithErrors(abi, fn), functionName: fn.name, args })
    };
  } catch (error) {
    const described = describeError(error);
    return {
      ok: false,
      error: described.error,
      ...(described.decodedError ? { decodedError: described.decodedError } : {})
    };
  }
}

async function tokenAmount(token, raw) {
  if (typeof raw !== "bigint") return undefined;
  const decimals = await read(token, contractAbis.erc20Read, "decimals");
  const symbol = await read(token, contractAbis.erc20Read, "symbol");
  const tokenDecimals = decimals.ok ? Number(decimals.result) : 18;
  return {
    token,
    raw: raw.toString(),
    formatted: formatUnits(raw, tokenDecimals),
    decimals: tokenDecimals,
    symbol: symbol.ok ? symbol.result : undefined
  };
}

async function staticCallBuiltTx(account, tx) {
  try {
    const result = await client.call({
      account,
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value)
    });
    return { ok: true, data: result.data ?? "0x" };
  } catch (error) {
    return { ok: false, error: shortError(error) };
  }
}

function collectBuildCalls(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectBuildCalls(item, out);
    return out;
  }
  if (typeof value === "object") {
    if (value.buildCall) out.push(value.buildCall);
    for (const item of Object.values(value)) collectBuildCalls(item, out);
  }
  return out;
}

async function plannerSummary(input) {
  try {
    const result = await rewardClaimabilityRead(client, { includeZero: false, ...input });
    return {
      ok: true,
      claimable: result.claimable,
      blockers: result.blockers,
      buildCalls: collectBuildCalls(result.domains)
    };
  } catch (error) {
    return { ok: false, error: shortError(error) };
  }
}

function addCandidate(map, account, evidence) {
  if (!isNonZeroAddress(account) || map.size >= candidateLimit) return;
  const key = account.toLowerCase();
  const current = map.get(key) ?? { account, evidence: [] };
  current.evidence.push(evidence);
  map.set(key, current);
}

function addTokenIdCandidate(map, account, tokenId, evidence) {
  if (!isNonZeroAddress(account) || map.size >= candidateLimit) return;
  const key = `${account.toLowerCase()}:${tokenId.toString()}`;
  const current = map.get(key) ?? { account, tokenId, evidence: [] };
  current.evidence.push(evidence);
  map.set(key, current);
}

function addDlmmCandidate(map, account, id, evidence) {
  if (!isNonZeroAddress(account) || map.size >= candidateLimit) return;
  const key = account.toLowerCase();
  const current = map.get(key) ?? { account, ids: [], evidence: [] };
  const idKey = BigInt(id).toString();
  if (!current.ids.some((value) => value.toString() === idKey)) current.ids.push(BigInt(id));
  current.evidence.push({ ...evidence, id: BigInt(id) });
  map.set(key, current);
}

async function scanBackward({ label, address, event, args, fromBlock, toBlock, scanChunkSize = chunkSize, stopWhen, onLog }) {
  const summary = {
    label,
    address,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    chunks: 0,
    logs: 0,
    errors: [],
    fallbackChunks: 0,
    fallbackChunkSize: fallbackChunkSize.toString(),
    stoppedEarly: false
  };
  async function scanRange(start, end, allowFallback) {
    try {
      const logs = await client.getLogs({ address, event, args, fromBlock: start, toBlock: end });
      summary.chunks += 1;
      summary.logs += logs.length;
      for (const log of logs.reverse()) onLog(log);
      return;
    } catch (error) {
      if (allowFallback && fallbackChunkSize > 0n && end - start + 1n > fallbackChunkSize) {
        for (let innerEnd = end; innerEnd >= start;) {
          const innerStart = innerEnd - fallbackChunkSize + 1n > start ? innerEnd - fallbackChunkSize + 1n : start;
          summary.fallbackChunks += 1;
          await scanRange(innerStart, innerEnd, false);
          if (stopWhen?.()) {
            summary.stoppedEarly = true;
            break;
          }
          if (innerStart === 0n) break;
          innerEnd = innerStart - 1n;
        }
        return;
      }
      summary.errors.push({ fromBlock: start.toString(), toBlock: end.toString(), error: shortError(error) });
    }
  }

  for (let end = toBlock; end >= fromBlock;) {
    const start = end - scanChunkSize + 1n > fromBlock ? end - scanChunkSize + 1n : fromBlock;
    await scanRange(start, end, true);
    if (stopWhen?.()) {
      summary.stoppedEarly = true;
      break;
    }
    if (start === 0n) break;
    end = start - 1n;
  }
  summary.scanHadErrors = summary.errors.length > 0;
  summary.scanComplete = !summary.scanHadErrors && !summary.stoppedEarly;
  return summary;
}

function summarizeScans(scans) {
  const present = scans.filter(Boolean);
  const errors = present.flatMap((scan) => scan.errors ?? []);
  return {
    scanComplete: present.length > 0 && present.every((scan) => scan.scanComplete === true),
    scanHadErrors: errors.length > 0,
    scanErrors: errors.length,
    stoppedEarly: present.some((scan) => scan.stoppedEarly === true),
    fallbackChunks: present.reduce((sum, scan) => sum + Number(scan.fallbackChunks ?? 0), 0),
    chunks: present.reduce((sum, scan) => sum + Number(scan.chunks ?? 0), 0),
    logs: present.reduce((sum, scan) => sum + Number(scan.logs ?? 0), 0)
  };
}

function summarizeDlmmRewarderScan(discoveries, candidatesFound) {
  const creationAggregate = summarizeScans(discoveries.map((discovery) => discovery.creation?.scan));
  const aggregate = summarizeScans(discoveries.flatMap((discovery) => discovery.scans));
  const allAggregate = summarizeScans(discoveries.flatMap((discovery) => [discovery.creation?.scan, ...discovery.scans]));
  const sampledErrors = discoveries
    .flatMap((discovery) => [discovery.creation?.scan, ...discovery.scans])
    .filter(Boolean)
    .flatMap((scan) => (scan.errors ?? []).map((error) => ({ label: scan.label, ...error })))
    .slice(0, 5);
  const hasRewarder = discoveries.some((discovery) => discovery.rewarder.ok && isNonZeroAddress(discovery.rewarder.result));
  const hasRewardedRange = discoveries.some((discovery) => discovery.rewardedRange.ok);
  let status;
  let zeroCandidateReason;
  const stoppedEarlyReason = aggregate.stoppedEarly
    ? candidatesFound >= candidateLimit
      ? "candidate_limit_reached"
      : "stop_condition_met"
    : undefined;
  if (aggregate.scanHadErrors) {
    status = "incomplete_scan_error";
    if (candidatesFound === 0) zeroCandidateReason = "scan_error";
  } else if (candidatesFound > 0) {
    status = aggregate.stoppedEarly ? "partial_with_candidates" : "complete_with_candidates";
  } else if (!hasRewarder) {
    status = "complete_no_candidates";
    zeroCandidateReason = "no_rewarder";
  } else if (!hasRewardedRange) {
    status = "complete_no_candidates";
    zeroCandidateReason = "no_rewarded_range";
  } else {
    status = "complete_no_candidates";
    zeroCandidateReason = "clean_no_logs";
  }
  return { ...aggregate, status, zeroCandidateReason, stoppedEarlyReason, creationScanStatus: creationAggregate, allScanStatus: allAggregate, sampledErrors };
}

async function discoverVoterSurfaces() {
  const [period, gaugesRead, feeDistributorsRead, poolsRead] = await Promise.all([
    read(contractRegistry.voter.address, contractAbis.voter, "getPeriod"),
    read(contractRegistry.voter.address, contractAbis.voter, "getAllGauges"),
    read(contractRegistry.voter.address, contractAbis.voter, "getAllFeeDistributors"),
    read(contractRegistry.voter.address, contractAbis.voter, "getAllPools")
  ]);
  const gauges = gaugesRead.ok ? gaugesRead.result : [];
  const classifiedGauges = await Promise.all(gauges.map(async (gauge) => {
    const [isLegacyGauge, isClGauge, isDLMMRewarder, isAlive, poolForGauge, feeDistributorForGauge] = await Promise.all([
      read(contractRegistry.voter.address, contractAbis.voter, "isLegacyGauge", [gauge]),
      read(contractRegistry.voter.address, contractAbis.voter, "isClGauge", [gauge]),
      read(contractRegistry.voter.address, contractAbis.voter, "isDLMMRewarder", [gauge]),
      read(contractRegistry.voter.address, contractAbis.voter, "isAlive", [gauge]),
      read(contractRegistry.voter.address, contractAbis.voter, "poolForGauge", [gauge]),
      read(contractRegistry.voter.address, contractAbis.voter, "feeDistributorForGauge", [gauge])
    ]);
    return {
      gauge,
      isLegacyGauge: readValue(isLegacyGauge) === true,
      isClGauge: readValue(isClGauge) === true,
      isDLMMRewarder: readValue(isDLMMRewarder) === true,
      isAlive: readValue(isAlive) === true,
      poolForGauge,
      feeDistributorForGauge
    };
  }));
  const feeDistributors = feeDistributorsRead.ok ? feeDistributorsRead.result : [];
  const pools = poolsRead.ok ? poolsRead.result : [];
  return {
    period,
    gauges: {
      read: gaugesRead,
      count: gauges.length,
      legacy: classifiedGauges.filter((item) => item.isLegacyGauge).length,
      cl: classifiedGauges.filter((item) => item.isClGauge).length,
      dlmmRewarder: classifiedGauges.filter((item) => item.isDLMMRewarder).length,
      alive: classifiedGauges.filter((item) => item.isAlive).length,
      classified: classifiedGauges
    },
    feeDistributors: {
      read: feeDistributorsRead,
      count: feeDistributors.length,
      addresses: feeDistributors
    },
    pools: {
      read: poolsRead,
      count: pools.length,
      addresses: pools
    }
  };
}

async function discoverVotingAccounts(fromBlock, toBlock, currentPeriod) {
  const candidates = new Map();
  const periodReads = [];
  if (currentPeriod !== undefined) {
    for (let offset = 0; offset < voterPeriodLookback; offset += 1) {
      const period = BigInt(currentPeriod) - BigInt(offset);
      if (period < 0n) break;
      const voters = await read(contractRegistry.voter.address, contractAbis.voter, "getAllVotersPerPeriod", [period]);
      periodReads.push({ period, voters });
      if (voters.ok) {
        for (const account of voters.result) {
          addCandidate(candidates, account, { event: "getAllVotersPerPeriod", period });
        }
      }
    }
  }
  const scan = await scanBackward({
    label: "voteModule Transfer voter probe",
    address: contractRegistry.voteModule.address,
    event: erc20TransferEvent,
    fromBlock,
    toBlock,
    stopWhen: () => candidates.size >= candidateLimit,
    onLog: (log) => {
      addCandidate(candidates, log.args.to, { event: "VoteModule Transfer.to", blockNumber: log.blockNumber, transactionHash: log.transactionHash });
      addCandidate(candidates, log.args.from, { event: "VoteModule Transfer.from", blockNumber: log.blockNumber, transactionHash: log.transactionHash });
    }
  });
  return { scan, periodReads, candidates: Array.from(candidates.values()).slice(0, assessmentLimit) };
}

async function discoverAutoVault(fromBlock, toBlock) {
  const candidates = new Map();
  const scans = [];
  scans.push(await scanBackward({
    label: "autoVault Deposit",
    address: contractRegistry.autoVault.address,
    event: autoVaultDepositEvent,
    fromBlock,
    toBlock,
    stopWhen: () => candidates.size >= candidateLimit,
    onLog: (log) => {
      addCandidate(candidates, log.args.account, {
        event: "Deposit.account",
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        amount: log.args.amount,
        outputToken: log.args.outputToken
      });
    }
  }));
  if (candidates.size < candidateLimit) {
    scans.push(await scanBackward({
      label: "autoVault Claimed",
      address: contractRegistry.autoVault.address,
      event: autoVaultClaimedEvent,
      fromBlock,
      toBlock,
      stopWhen: () => candidates.size >= candidateLimit,
      onLog: (log) => {
        addCandidate(candidates, log.args.account, {
          event: "Claimed.account",
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          amount: log.args.amount,
          token: log.args.token
        });
      }
    }));
  }
  if (candidates.size < candidateLimit) {
    scans.push(await scanBackward({
      label: "autoVault Withdraw",
      address: contractRegistry.autoVault.address,
      event: autoVaultWithdrawEvent,
      fromBlock,
      toBlock,
      stopWhen: () => candidates.size >= candidateLimit,
      onLog: (log) => {
        addCandidate(candidates, log.args.account, {
          event: "Withdraw.account",
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          amount: log.args.amount
        });
      }
    }));
  }
  return { scans, candidates: Array.from(candidates.values()).slice(0, assessmentLimit) };
}

async function assessAutoVault(candidate) {
  const [balanceOf, earned, storedRewards, outputPreference] = await Promise.all([
    read(contractRegistry.autoVault.address, contractAbis.autoVault, "balanceOf", [candidate.account]),
    read(contractRegistry.autoVault.address, contractAbis.autoVault, "earned", [candidate.account]),
    read(contractRegistry.autoVault.address, contractAbis.autoVault, "getStoredRewards", [candidate.account]),
    read(contractRegistry.autoVault.address, contractAbis.autoVault, "outputPreference", [candidate.account])
  ]);
  const claimable = positive(readValue(earned)) || positive(readValue(storedRewards));
  const tx = claimable ? buildMappedWorkflowTx("claim", autoVaultActionMap) : null;
  return {
    ...candidate,
    balanceOf,
    earned: earned.ok ? await tokenAmount(outputPreference.ok ? outputPreference.result : contractRegistry.usdcNative.address, earned.result) : earned,
    storedRewards: storedRewards.ok ? await tokenAmount(outputPreference.ok ? outputPreference.result : contractRegistry.usdcNative.address, storedRewards.result) : storedRewards,
    outputPreference,
    claimable,
    builder: tx,
    staticCall: tx ? await staticCallBuiltTx(candidate.account, tx) : null,
    planner: claimable ? await plannerSummary({ account: candidate.account, domains: ["autoVault"] }) : null
  };
}

async function discoverLegacyGauge(gauge, fromBlock, toBlock) {
  const stake = await read(gauge, contractAbis.legacyGauge, "stake");
  const candidates = new Map();
  const scans = [];
  if (stake.ok) {
    scans.push(await scanBackward({
      label: "legacy LP Transfer to gauge",
      address: stake.result,
      event: erc20TransferEvent,
      args: { to: gauge },
      fromBlock,
      toBlock,
      stopWhen: () => candidates.size >= candidateLimit,
      onLog: (log) => addCandidate(candidates, log.args.from, { event: "LP Transfer.toGauge", blockNumber: log.blockNumber, transactionHash: log.transactionHash })
    }));
    if (candidates.size < candidateLimit) {
      scans.push(await scanBackward({
        label: "legacy LP Transfer from gauge",
        address: stake.result,
        event: erc20TransferEvent,
        args: { from: gauge },
        fromBlock,
        toBlock,
        stopWhen: () => candidates.size >= candidateLimit,
        onLog: (log) => addCandidate(candidates, log.args.to, { event: "LP Transfer.fromGauge", blockNumber: log.blockNumber, transactionHash: log.transactionHash })
      }));
    }
  }
  return { gauge, stake, scans, candidates: Array.from(candidates.values()).slice(0, assessmentLimit) };
}

async function discoverLegacyGauges(gauges, fromBlock, toBlock) {
  const discoveries = [];
  for (const gauge of limited(gauges, legacyGaugeLimit)) {
    discoveries.push(await discoverLegacyGauge(gauge, fromBlock, toBlock));
  }
  return discoveries;
}

async function assessLegacyGauge(candidate, gauge) {
  const [balanceOf, rewardsList] = await Promise.all([
    read(gauge, contractAbis.legacyGauge, "balanceOf", [candidate.account]),
    read(gauge, contractAbis.legacyGauge, "rewardsList")
  ]);
  const rewardTokens = rewardsList.ok ? rewardsList.result : [];
  const earned = [];
  for (const token of rewardTokens) {
    const amount = await read(gauge, contractAbis.legacyGauge, "earned", [token, candidate.account]);
    earned.push({ token, amount: amount.ok ? await tokenAmount(token, amount.result) : amount });
  }
  const claimableTokens = earned.filter((item) => BigInt(item.amount?.raw ?? "0") > 0n).map((item) => item.token);
  const tx = claimableTokens.length
    ? buildMappedWorkflowTx("legacyGetReward", gaugeActionMap, { addressOverride: gauge, args: [candidate.account, claimableTokens] })
    : null;
  const voterClaimRewardsTx = claimableTokens.length
    ? buildMappedWorkflowTx("claimRewards", voteActionMap, { args: [[gauge], [claimableTokens]] })
    : null;
  return {
    ...candidate,
    gauge,
    balanceOf,
    rewardsList,
    earned,
    claimable: claimableTokens.length > 0,
    claimableTokens,
    builder: tx,
    staticCall: tx ? await staticCallBuiltTx(candidate.account, tx) : null,
    variantBuilders: {
      voterClaimRewards: voterClaimRewardsTx
    },
    variantStaticCalls: {
      voterClaimRewards: voterClaimRewardsTx ? await staticCallBuiltTx(candidate.account, voterClaimRewardsTx) : null
    },
    planner: tx ? await plannerSummary({ account: candidate.account, domains: ["legacyGauge"], legacyGauges: [gauge] }) : null
  };
}

async function discoverClGauge(fromBlock, toBlock) {
  const pool = CL_WAVAX_USDC_10_POOL;
  const gauge = await read(contractRegistry.voter.address, contractAbis.voter, "gaugeForPool", [pool]);
  const feeDistributor = gauge.ok
    ? await read(contractRegistry.voter.address, contractAbis.voter, "feeDistributorForGauge", [gauge.result])
    : { ok: false, error: "Gauge unavailable" };
  const candidates = new Map();
  const scan = await scanBackward({
    label: "CL NFT Transfer",
    address: contractRegistry.ramsesV3PositionManager.address,
    event: erc721TransferEvent,
    fromBlock,
    toBlock,
    stopWhen: () => candidates.size >= candidateLimit,
    onLog: (log) => addTokenIdCandidate(candidates, log.args.to, log.args.tokenId, { event: "NFT Transfer.to", blockNumber: log.blockNumber, transactionHash: log.transactionHash })
  });
  return { pool, gauge, feeDistributor, scan, candidates: Array.from(candidates.values()).slice(0, assessmentLimit) };
}

async function assessClGauge(candidate, gauge) {
  const [ownerOf, rewardTokens] = await Promise.all([
    read(contractRegistry.ramsesV3PositionManager.address, contractAbis.ramsesV3PositionManager, "ownerOf", [candidate.tokenId]),
    read(gauge, contractAbis.clGaugeV3, "getRewardTokens")
  ]);
  const staleCandidate = ownerOf.ok === false && ownerOf.decodedError?.name === "ERC721NonexistentToken";
  const currentOwner = ownerOf.ok ? ownerOf.result : null;
  const tokens = rewardTokens.ok ? rewardTokens.result : [];
  const earned = [];
  if (staleCandidate) {
    for (const token of tokens) {
      earned.push({
        token,
        amount: {
          ok: false,
          skipped: true,
          reason: "historical transfer candidate no longer exists in RamsesV3PositionManager; GaugeV3.earned(address,uint256) would bubble InvalidTokenId(uint256)",
          decodedErrorEvidence: clGaugeStaleNftErrorEvidence.find((item) => item.signature === "InvalidTokenId(uint256)")
        }
      });
    }
  } else {
    for (const token of tokens) {
      const amount = await read(gauge, contractAbis.clGaugeV3, "earned(address,uint256)", [token, candidate.tokenId]);
      earned.push({ token, amount: amount.ok ? await tokenAmount(token, amount.result) : amount });
    }
  }
  const claimableTokens = earned.filter((item) => BigInt(item.amount?.raw ?? "0") > 0n).map((item) => item.token);
  const tx = claimableTokens.length
    ? buildMappedWorkflowTx("claimClGaugeRewards", voteActionMap, { args: [[gauge], [claimableTokens], [[candidate.tokenId]]] })
    : null;
  const txWithNfpManagers = claimableTokens.length
    ? buildMappedWorkflowTx("claimClGaugeRewardsWithNfpManagers", voteActionMap, { args: [[gauge], [claimableTokens], [[candidate.tokenId]], [contractRegistry.ramsesV3PositionManager.address]] })
    : null;
  return {
    ...candidate,
    currentOwner,
    ownerStatus: ownerOf.ok ? "current_owner_read" : staleCandidate ? "stale_nonexistent_token" : "owner_read_failed",
    staleCandidate,
    gauge,
    ownerOf,
    rewardTokens,
    earned,
    claimable: claimableTokens.length > 0,
    claimableTokens,
    builder: tx,
    staticCall: tx && currentOwner ? await staticCallBuiltTx(currentOwner, tx) : null,
    variantBuilders: {
      claimClGaugeRewardsWithNfpManagers: txWithNfpManagers
    },
    variantStaticCalls: {
      claimClGaugeRewardsWithNfpManagers: txWithNfpManagers && currentOwner ? await staticCallBuiltTx(currentOwner, txWithNfpManagers) : null
    },
    planner: tx && currentOwner ? await plannerSummary({
      account: currentOwner,
      domains: ["clGauge"],
      clPools: [{ pool: CL_WAVAX_USDC_10_POOL, gauge, tokenIds: [candidate.tokenId] }]
    }) : null
  };
}

async function assessP33Incentives() {
  const operator = await read(contractRegistry.p33.address, contractAbis.p33, "operator");
  const caller = operator.ok ? operator.result : undefined;
  const history = await discoverP33IncentiveHistory();
  try {
    const result = await rewardClaimabilityRead(client, {
      account: contractRegistry.p33.address,
      domains: ["p33"],
      caller,
      includeZero: true
    });
    const p33 = result.domains?.p33;
    return {
      account: contractRegistry.p33.address,
      operator,
      caller,
      claimable: p33?.claimable === true,
      operatorClaimable: p33?.operatorClaimable === true,
      staticCall: p33?.operatorSimulation ?? null,
      history,
      result
    };
  } catch (error) {
    return {
      account: contractRegistry.p33.address,
      operator,
      caller,
      claimable: false,
      staticCall: { ok: false, error: shortError(error) },
      history,
      error: shortError(error)
    };
  }
}

async function assessAutoVaultIncentives() {
  const operator = await read(contractRegistry.autoVault.address, contractAbis.autoVault, "OPERATOR");
  const caller = operator.ok ? operator.result : undefined;
  try {
    const result = await rewardClaimabilityRead(client, {
      account: contractRegistry.autoVault.address,
      domains: ["autoVault"],
      caller,
      includeZero: true
    });
    const incentives = result.domains?.autoVault?.incentives;
    return {
      account: contractRegistry.autoVault.address,
      operator,
      caller,
      claimable: incentives?.claimable === true,
      operatorClaimable: incentives?.operatorClaimable === true,
      staticCall: incentives?.operatorSimulation ?? null,
      result
    };
  } catch (error) {
    return {
      account: contractRegistry.autoVault.address,
      operator,
      caller,
      claimable: false,
      operatorClaimable: false,
      staticCall: { ok: false, error: shortError(error) },
      error: shortError(error)
    };
  }
}

function readVotePools(readResult) {
  const value = readValue(readResult);
  if (!Array.isArray(value)) return [];
  const rawPools = Array.isArray(value[0]) ? value[0] : value;
  return uniqueAddresses(rawPools.filter((item) => typeof item === "string"));
}

async function discoverP33IncentiveHistory() {
  const currentPeriodRead = await read(contractRegistry.voter.address, contractAbis.voter, "getPeriod");
  const currentPeriod = currentPeriodRead.ok ? BigInt(currentPeriodRead.result) : 0n;
  const start = currentPeriod + 1n;
  const minimum = start > BigInt(p33HistoryPeriods) ? start - BigInt(p33HistoryPeriods) : 0n;
  const periodReads = [];
  const poolPeriods = [];
  const poolMap = new Map();

  for (let period = start; period >= minimum;) {
    const getVotes = await read(contractRegistry.voter.address, contractAbis.voter, "getVotes", [contractRegistry.p33.address, period]);
    const pools = readVotePools(getVotes);
    periodReads.push({ period, getVotes, pools });
    for (const pool of pools) {
      const key = pool.toLowerCase();
      const current = poolMap.get(key) ?? { pool, periods: [] };
      current.periods.push(period);
      poolMap.set(key, current);
      poolPeriods.push({ pool, period });
    }
    if (period === 0n) break;
    period -= 1n;
  }

  const poolSurfaces = [];
  for (const item of poolMap.values()) {
    const gauge = await read(contractRegistry.voter.address, contractAbis.voter, "gaugeForPool", [item.pool]);
    const gaugeAddress = readValue(gauge);
    const feeDistributor = isNonZeroAddress(gaugeAddress)
      ? await read(contractRegistry.voter.address, contractAbis.voter, "feeDistributorForGauge", [gaugeAddress])
      : { ok: false, error: "No gauge for p33-voted pool" };
    poolSurfaces.push({ ...item, gauge, feeDistributor });
  }

  const distributorMap = new Map();
  for (const surface of poolSurfaces) {
    const feeDistributor = readValue(surface.feeDistributor);
    if (!isNonZeroAddress(feeDistributor)) continue;
    const key = feeDistributor.toLowerCase();
    const current = distributorMap.get(key) ?? {
      address: feeDistributor,
      pools: [],
      periods: []
    };
    current.pools.push(surface.pool);
    current.periods.push(...surface.periods);
    distributorMap.set(key, current);
  }

  const historicalRows = [];
  const currentEarnedRows = [];
  let checkedHistoricalRows = 0;
  let checkedCurrentRows = 0;
  for (const distributor of distributorMap.values()) {
    distributor.periods = Array.from(new Set(distributor.periods.map((period) => period.toString()))).map((period) => BigInt(period)).sort((a, b) => Number(b - a));
    distributor.pools = uniqueAddresses(distributor.pools);
    const [firstPeriod, rewardTokensRead, balanceOfP33] = await Promise.all([
      read(distributor.address, contractAbis.feeDistributor, "firstPeriod"),
      read(distributor.address, contractAbis.feeDistributor, "getRewardTokens"),
      read(distributor.address, contractAbis.feeDistributor, "balanceOf", [contractRegistry.p33.address])
    ]);
    const rewardTokens = rewardTokensRead.ok ? rewardTokensRead.result : [];
    for (const token of rewardTokens) {
      checkedCurrentRows += 1;
      const earned = await read(distributor.address, contractAbis.feeDistributor, "earned", [token, contractRegistry.p33.address]);
      if (positive(readValue(earned))) {
        currentEarnedRows.push({
          feeDistributor: distributor.address,
          token,
          balanceOfP33,
          earned: await tokenAmount(token, earned.result)
        });
      }
    }

    for (const period of distributor.periods) {
      if (firstPeriod.ok && period < BigInt(firstPeriod.result)) continue;
      for (const token of rewardTokens) {
        checkedHistoricalRows += 1;
        const [userClaimed, userVotes, rewardSupply, lastClaimByToken] = await Promise.all([
          read(distributor.address, contractAbis.feeDistributor, "userClaimed", [period, contractRegistry.p33.address, token]),
          read(distributor.address, contractAbis.feeDistributor, "userVotes", [period, contractRegistry.p33.address]),
          read(distributor.address, contractAbis.feeDistributor, "rewardSupply", [period, token]),
          read(distributor.address, contractAbis.feeDistributor, "lastClaimByToken", [token, contractRegistry.p33.address])
        ]);
        if (positive(readValue(userClaimed)) && historicalRows.length < p33HistoryPositiveLimit) {
          historicalRows.push({
            period,
            feeDistributor: distributor.address,
            token,
            userClaimed: await tokenAmount(token, userClaimed.result),
            userVotes,
            rewardSupply,
            lastClaimByToken
          });
        }
      }
    }
  }

  return {
    currentPeriod: currentPeriodRead,
    periodWindow: {
      from: minimum,
      to: start,
      maxPeriods: p33HistoryPeriods
    },
    periodsWithVotes: periodReads.filter((item) => item.pools.length > 0).length,
    p33VotedPools: poolMap.size,
    p33PoolPeriods: poolPeriods.length,
    feeDistributors: distributorMap.size,
    checkedCurrentRows,
    checkedHistoricalRows,
    currentEarnedPositive: currentEarnedRows,
    historicalClaimedPositive: historicalRows,
    historicalClaimedPositiveTruncated: historicalRows.length >= p33HistoryPositiveLimit,
    evidence: "Historical positives use FeeDistributor.userClaimed(period,p33,token) and prove p33 incentive payout history. Current claimability still depends on earned(token,p33)>0 and operator-only p33.claimIncentives."
  };
}

async function discoverFeeDistributors(fromBlock, toBlock, feeDistributors, currentPeriod) {
  const accountDiscovery = await discoverVotingAccounts(fromBlock, toBlock, currentPeriod);
  return {
    feeDistributors: limited(uniqueAddresses(feeDistributors), feeDistributorLimit),
    accountDiscovery,
    candidates: accountDiscovery.candidates
  };
}

async function assessFeeDistributor(candidate, feeDistributor) {
  const [rewardTokens, balanceOf, poolForFeeDistributor] = await Promise.all([
    read(feeDistributor, contractAbis.feeDistributor, "getRewardTokens"),
    read(feeDistributor, contractAbis.feeDistributor, "balanceOf", [candidate.account]),
    read(contractRegistry.voter.address, contractAbis.voter, "poolForFeeDistributor", [feeDistributor])
  ]);
  const gaugeForPool = isNonZeroAddress(readValue(poolForFeeDistributor))
    ? await read(contractRegistry.voter.address, contractAbis.voter, "gaugeForPool", [poolForFeeDistributor.result])
    : { ok: false, error: "No pool for FeeDistributor." };
  const isLegacyGauge = isNonZeroAddress(readValue(gaugeForPool))
    ? await read(contractRegistry.voter.address, contractAbis.voter, "isLegacyGauge", [gaugeForPool.result])
    : { ok: false, error: "No gauge for FeeDistributor pool." };
  const tokens = rewardTokens.ok ? rewardTokens.result : [];
  const earned = [];
  for (const token of tokens) {
    const amount = await read(feeDistributor, contractAbis.feeDistributor, "earned", [token, candidate.account]);
    earned.push({ token, amount: amount.ok ? await tokenAmount(token, amount.result) : amount });
  }
  const claimableTokens = earned.filter((item) => BigInt(item.amount?.raw ?? "0") > 0n).map((item) => item.token);
  const tx = claimableTokens.length
    ? buildMappedWorkflowTx("claimIncentives", voteActionMap, { args: [candidate.account, [feeDistributor], [claimableTokens]] })
    : null;
  const legacyIncentivesTx = claimableTokens.length && readValue(isLegacyGauge) === true
    ? buildMappedWorkflowTx("claimLegacyIncentives", voteActionMap, { args: [candidate.account, [feeDistributor], [claimableTokens]] })
    : null;
  return {
    ...candidate,
    feeDistributor,
    poolForFeeDistributor,
    gaugeForPool,
    isLegacyGauge,
    balanceOf,
    rewardTokens,
    earned,
    claimable: claimableTokens.length > 0,
    claimableTokens,
    builder: tx,
    staticCall: tx ? await staticCallBuiltTx(candidate.account, tx) : null,
    variantBuilders: {
      claimLegacyIncentives: legacyIncentivesTx
    },
    variantStaticCalls: {
      claimLegacyIncentives: legacyIncentivesTx ? await staticCallBuiltTx(candidate.account, legacyIncentivesTx) : null
    },
    planner: tx ? await plannerSummary({
      account: candidate.account,
      domains: ["feeDistributor"],
      feeDistributors: [{ address: feeDistributor }]
    }) : null
  };
}

async function knownDlmmRewarderSurface() {
  const rewarder = await read(contractRegistry.dlmmRewarderFactory.address, contractAbis.dlmmRewarderFactory, "getRewarder", [DLMM_REWARDED_POOL]);
  return {
    source: "knownRewardedPool",
    pair: DLMM_REWARDED_POOL,
    rewarder: rewarder.ok ? rewarder.result : undefined,
    rewarderRead: rewarder
  };
}

async function dlmmRewarderSurfacesFromFactory() {
  const countRead = await read(contractRegistry.dlmmFactory.address, contractAbis.dlmmFactory, "getNumberOfLBPairs");
  const count = countRead.ok ? Number(countRead.result) : 0;
  const surfaces = [];
  for (let index = 0; index < Math.min(count, dlmmPairLimit); index += 1) {
    const pairRead = await read(contractRegistry.dlmmFactory.address, contractAbis.dlmmFactory, "getLBPairAtIndex", [BigInt(index)]);
    const pair = readValue(pairRead);
    if (!isNonZeroAddress(pair)) {
      surfaces.push({ source: "dlmmFactory.getLBPairAtIndex", index, pairRead, rewarderRead: { ok: false, error: "No pair" } });
      continue;
    }
    const [rewarder, tokenX, tokenY, binStep] = await Promise.all([
      read(contractRegistry.dlmmRewarderFactory.address, contractAbis.dlmmRewarderFactory, "getRewarder", [pair]),
      read(pair, contractAbis.dlmmPool, "getTokenX"),
      read(pair, contractAbis.dlmmPool, "getTokenY"),
      read(pair, contractAbis.dlmmPool, "getBinStep")
    ]);
    const rewarderAddress = readValue(rewarder);
    const [voterIsRewarder, poolForGauge, isAlive] = isNonZeroAddress(rewarderAddress)
      ? await Promise.all([
        read(contractRegistry.voter.address, contractAbis.voter, "isDLMMRewarder", [rewarderAddress]),
        read(contractRegistry.voter.address, contractAbis.voter, "poolForGauge", [rewarderAddress]),
        read(contractRegistry.voter.address, contractAbis.voter, "isAlive", [rewarderAddress])
      ])
      : [
        { ok: false, error: "No rewarder" },
        { ok: false, error: "No rewarder" },
        { ok: false, error: "No rewarder" }
      ];
    surfaces.push({
      source: "dlmmFactory.getLBPairAtIndex",
      index,
      pair,
      pairRead,
      tokenX,
      tokenY,
      binStep,
      rewarder: isNonZeroAddress(rewarderAddress) ? rewarderAddress : undefined,
      rewarderRead: rewarder,
      voterIsRewarder,
      poolForGauge,
      isAlive
    });
  }
  return {
    count: countRead,
    pairLimit: dlmmPairLimit,
    surfaces
  };
}

async function dlmmRewarderSurfaceFromGauge(gaugeInfo) {
  const rewarder = gaugeInfo.gauge;
  const pairRead = await read(rewarder, contractAbis.dlmmRewarder, "getLBPair");
  return {
    source: "voter.getAllGauges",
    pair: pairRead.ok ? pairRead.result : readValue(gaugeInfo.poolForGauge),
    rewarder,
    rewarderRead: { ok: true, result: rewarder },
    poolForGauge: gaugeInfo.poolForGauge,
    getLBPair: pairRead
  };
}

async function discoverDlmmRewarderCreation(rewarder, fromBlock, toBlock) {
  let found;
  const scan = await scanBackward({
    label: "DLMMRewarderCreated",
    address: contractRegistry.dlmmRewarderFactory.address,
    event: dlmmRewarderCreatedEvent,
    args: { rewarder },
    fromBlock,
    toBlock,
    scanChunkSize: dlmmChunkSize,
    stopWhen: () => Boolean(found),
    onLog: (log) => {
      found = {
        pool: log.args.pool,
        rewarder: log.args.rewarder,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash
      };
    }
  });
  return { scan, found };
}

async function discoverDlmmRewarder(surface, fromBlock, toBlock) {
  const pair = surface.pair;
  const rewarder = surface.rewarder
    ? { ok: true, result: surface.rewarder }
    : await read(contractRegistry.dlmmRewarderFactory.address, contractAbis.dlmmRewarderFactory, "getRewarder", [pair]);
  const creation = rewarder.ok && isNonZeroAddress(rewarder.result)
    ? await discoverDlmmRewarderCreation(rewarder.result, fromBlock, toBlock)
    : { scan: null, found: null };
  const discoveryFromBlock = creation.found?.blockNumber ?? fromBlock;
  const rewardedRange = rewarder.ok && isNonZeroAddress(rewarder.result)
    ? await read(rewarder.result, contractAbis.dlmmRewarder, "getRewardedRange")
    : { ok: false, error: "No rewarder" };
  const [rangeStart, rangeEnd] = rewardedRange.ok ? rewardedRange.result.map((value) => BigInt(value)) : [undefined, undefined];
  const candidates = new Map();
  const idInRange = (id) => rangeStart === undefined || (BigInt(id) >= rangeStart && BigInt(id) <= rangeEnd);
  const scans = [];
  scans.push(await scanBackward({
    label: "DLMM TransferSingle",
    address: pair,
    event: transferSingleEvent,
    fromBlock: discoveryFromBlock,
    toBlock,
    scanChunkSize: dlmmChunkSize,
    stopWhen: () => candidates.size >= candidateLimit,
    onLog: (log) => {
      if (idInRange(log.args.id)) addDlmmCandidate(candidates, log.args.to, log.args.id, { event: "TransferSingle.to", blockNumber: log.blockNumber, transactionHash: log.transactionHash });
      if (idInRange(log.args.id)) addDlmmCandidate(candidates, log.args.from, log.args.id, { event: "TransferSingle.from", blockNumber: log.blockNumber, transactionHash: log.transactionHash });
    }
  }));
  if (candidates.size < candidateLimit) {
    scans.push(await scanBackward({
      label: "DLMM TransferBatch",
      address: pair,
      event: transferBatchEvent,
      fromBlock: discoveryFromBlock,
      toBlock,
      scanChunkSize: dlmmChunkSize,
      stopWhen: () => candidates.size >= candidateLimit,
      onLog: (log) => {
        for (const id of log.args.ids) {
          if (idInRange(id)) addDlmmCandidate(candidates, log.args.to, id, { event: "TransferBatch.to", blockNumber: log.blockNumber, transactionHash: log.transactionHash });
          if (idInRange(id)) addDlmmCandidate(candidates, log.args.from, id, { event: "TransferBatch.from", blockNumber: log.blockNumber, transactionHash: log.transactionHash });
        }
      }
    }));
  }
  return { ...surface, pair, rewarder, creation, discoveryFromBlock, rewardedRange, scans, candidates: Array.from(candidates.values()).slice(0, assessmentLimit) };
}

async function discoverDlmmRewarders(surfaces, fromBlock, toBlock) {
  const discoveries = [];
  for (const surface of limited(surfaces, dlmmRewarderLimit)) {
    if (!isNonZeroAddress(surface.pair)) continue;
    discoveries.push(await discoverDlmmRewarder(surface, fromBlock, toBlock));
  }
  return discoveries;
}

async function assessDlmmRewarder(candidate, pair, rewarder) {
  const ids = candidate.ids?.length ? candidate.ids : [candidate.id];
  const [balances, rewardToken, pendingRewards] = await Promise.all([
    Promise.all(ids.map(async (id) => ({
      id,
      balanceOf: await read(pair, contractAbis.erc1155Read, "balanceOf", [candidate.account, id])
    }))),
    read(rewarder, contractAbis.dlmmRewarder, "getRewardToken"),
    read(rewarder, contractAbis.dlmmRewarder, "getPendingRewards", [candidate.account, ids])
  ]);
  const claimable = positive(readValue(pendingRewards));
  const tx = claimable
    ? buildMappedWorkflowTx("rewarderClaim", dlmmActionMap, { addressOverride: rewarder, args: [candidate.account, ids] })
    : null;
  return {
    ...candidate,
    ids,
    pair,
    rewarder,
    balances,
    rewardToken,
    pendingRewards: pendingRewards.ok && rewardToken.ok ? await tokenAmount(rewardToken.result, pendingRewards.result) : pendingRewards,
    claimable,
    builder: tx,
    staticCall: tx ? await staticCallBuiltTx(candidate.account, tx) : null,
    planner: tx ? await plannerSummary({
      account: candidate.account,
      domains: ["dlmmRewarder"],
      dlmmPairs: [{ pair, rewarder, ids }]
    }) : null
  };
}

const latestBlock = await client.getBlockNumber();
const fromBlock = latestBlock > scanBlocks ? latestBlock - scanBlocks : 0n;
const dlmmFromBlock = latestBlock > dlmmScanBlocks ? latestBlock - dlmmScanBlocks : 0n;

const voterSurfaces = await discoverVoterSurfaces();
const currentPeriod = readValue(voterSurfaces.period);
const autoVaultDiscovery = await discoverAutoVault(fromBlock, latestBlock);
const legacyGaugeAddresses = uniqueAddresses([
  ...voterSurfaces.gauges.classified.filter((item) => item.isLegacyGauge).map((item) => item.gauge),
  contractRegistry.legacyGauge.address
]);
const legacyDiscoveries = await discoverLegacyGauges(legacyGaugeAddresses, fromBlock, latestBlock);
const legacyAssessmentInputs = legacyDiscoveries
  .flatMap((discovery) => discovery.candidates.map((candidate) => ({ candidate, gauge: discovery.gauge })))
  .slice(0, domainAssessmentLimit);
const clDiscovery = await discoverClGauge(fromBlock, latestBlock);
const feeDistributorAddresses = uniqueAddresses([
  ...voterSurfaces.feeDistributors.addresses,
  clDiscovery.feeDistributor.ok ? clDiscovery.feeDistributor.result : undefined,
  contractRegistry.feeDistributor.address
]);
const feeDistributorDiscovery = await discoverFeeDistributors(fromBlock, latestBlock, feeDistributorAddresses, currentPeriod);
const feeDistributorAssessmentInputs = feeDistributorDiscovery.candidates
  .flatMap((candidate) => feeDistributorDiscovery.feeDistributors.map((feeDistributor) => ({ candidate, feeDistributor })))
  .slice(0, domainAssessmentLimit);
const voterDlmmSurfaces = await Promise.all(
  voterSurfaces.gauges.classified
    .filter((item) => item.isDLMMRewarder)
    .map(dlmmRewarderSurfaceFromGauge)
);
const factoryDlmmSurfaceDiscovery = await dlmmRewarderSurfacesFromFactory();
const factoryDlmmSurfaces = factoryDlmmSurfaceDiscovery.surfaces.filter((surface) => isNonZeroAddress(surface.rewarder));
const rawDlmmSurfaces = [...factoryDlmmSurfaces, ...voterDlmmSurfaces, await knownDlmmRewarderSurface()];
const dlmmSurfaceKeys = new Set();
const dlmmSurfaces = rawDlmmSurfaces.filter((surface) => {
  if (!isNonZeroAddress(surface.rewarder) || !isNonZeroAddress(surface.pair)) return false;
  const key = `${surface.rewarder}:${surface.pair}`.toLowerCase();
  if (dlmmSurfaceKeys.has(key)) return false;
  dlmmSurfaceKeys.add(key);
  return true;
});
const dlmmDiscoveries = await discoverDlmmRewarders(dlmmSurfaces, dlmmFromBlock, latestBlock);
const dlmmAssessmentInputs = dlmmDiscoveries
  .flatMap((discovery) => discovery.candidates.map((candidate) => ({
    candidate,
    pair: discovery.pair,
    rewarder: discovery.rewarder.ok ? discovery.rewarder.result : undefined
  })))
  .filter((input) => isNonZeroAddress(input.rewarder))
  .slice(0, domainAssessmentLimit);
const dlmmCandidatesFound = dlmmDiscoveries.reduce((sum, discovery) => sum + discovery.candidates.length, 0);
const dlmmScanStatus = summarizeDlmmRewarderScan(dlmmDiscoveries, dlmmCandidatesFound);
const autoVaultIncentiveAssessment = await assessAutoVaultIncentives();
const p33Assessment = await assessP33Incentives();

const report = {
  timestamp: new Date().toISOString(),
  chainId: 43114,
  rpcUrl,
  latestBlock,
  clGaugeStaleNftErrorEvidence,
  surfaceDiscovery: {
    voter: voterSurfaces,
    dlmmFactory: factoryDlmmSurfaceDiscovery
  },
  scan: {
    fromBlock,
    toBlock: latestBlock,
    scanBlocks: scanBlocks.toString(),
    chunkSize: chunkSize.toString(),
    dlmmFromBlock,
    dlmmScanBlocks: dlmmScanBlocks.toString(),
    dlmmChunkSize: dlmmChunkSize.toString(),
    fallbackChunkSize: fallbackChunkSize.toString(),
    candidateLimit,
    assessmentLimit,
    domainAssessmentLimit,
    legacyGaugeLimit,
    feeDistributorLimit,
    dlmmRewarderLimit,
    dlmmPairLimit,
    voterPeriodLookback
  },
  domains: {
    autoVault: {
      discovery: autoVaultDiscovery.scans,
      candidatesFound: autoVaultDiscovery.candidates.length,
      incentives: autoVaultIncentiveAssessment,
      assessments: await Promise.all(autoVaultDiscovery.candidates.map(assessAutoVault))
    },
    legacyGauge: {
      gaugesChecked: legacyDiscoveries.length,
      gaugesAvailable: legacyGaugeAddresses.length,
      discoveries: legacyDiscoveries.map((discovery) => ({
        gauge: discovery.gauge,
        stake: discovery.stake,
        discovery: discovery.scans,
        candidatesFound: discovery.candidates.length
      })),
      candidatesFound: legacyDiscoveries.reduce((sum, discovery) => sum + discovery.candidates.length, 0),
      assessments: await Promise.all(legacyAssessmentInputs.map(({ candidate, gauge }) => assessLegacyGauge(candidate, gauge)))
    },
    clGauge: {
      pool: clDiscovery.pool,
      gauge: clDiscovery.gauge,
      feeDistributor: clDiscovery.feeDistributor,
      discovery: clDiscovery.scan,
      candidatesFound: clDiscovery.candidates.length,
      assessments: clDiscovery.gauge.ok
        ? await Promise.all(clDiscovery.candidates.map((candidate) => assessClGauge(candidate, clDiscovery.gauge.result)))
        : []
    },
    feeDistributor: {
      feeDistributorsChecked: feeDistributorDiscovery.feeDistributors.length,
      feeDistributorsAvailable: feeDistributorAddresses.length,
      feeDistributors: feeDistributorDiscovery.feeDistributors,
      accountDiscovery: feeDistributorDiscovery.accountDiscovery,
      candidatesFound: feeDistributorDiscovery.candidates.length,
      assessments: await Promise.all(feeDistributorAssessmentInputs.map(({ candidate, feeDistributor }) => assessFeeDistributor(candidate, feeDistributor)))
    },
    dlmmRewarder: {
      rewardersChecked: dlmmDiscoveries.length,
      rewardersAvailable: dlmmSurfaces.length,
      discoveries: dlmmDiscoveries.map((discovery) => ({
        source: discovery.source,
        pair: discovery.pair,
        rewarder: discovery.rewarder,
        creation: discovery.creation,
        discoveryFromBlock: discovery.discoveryFromBlock,
        rewardedRange: discovery.rewardedRange,
        creationScanStatus: summarizeScans([discovery.creation?.scan]),
        scanStatus: summarizeScans(discovery.scans),
        discovery: discovery.scans,
        candidatesFound: discovery.candidates.length
      })),
      scanStatus: dlmmScanStatus,
      zeroCandidateReason: dlmmScanStatus.zeroCandidateReason,
      candidatesFound: dlmmCandidatesFound,
      assessments: await Promise.all(dlmmAssessmentInputs.map(({ candidate, pair, rewarder }) => assessDlmmRewarder(candidate, pair, rewarder)))
    },
    p33: {
      candidatesFound: 1,
      assessments: [p33Assessment]
    }
  },
  summary: {}
};

for (const [domain, value] of Object.entries(report.domains)) {
  const assessments = value.assessments ?? [];
  const variantStaticCalls = assessments.flatMap((item) => Object.values(item.variantStaticCalls ?? {}).filter(Boolean));
  const autoVaultIncentives = domain === "autoVault" ? value.incentives : undefined;
  const p33History = domain === "p33" ? assessments[0]?.history : undefined;
  const scanStatus = value.scanStatus;
  report.summary[domain] = {
    candidatesFound: value.candidatesFound,
    claimableCandidates: assessments.filter((item) => item.claimable).length,
    successfulStaticCalls: assessments.filter((item) => item.staticCall?.ok).length,
    failedStaticCalls: assessments.filter((item) => item.staticCall && !item.staticCall.ok).length,
    successfulVariantStaticCalls: variantStaticCalls.filter((item) => item.ok).length,
    failedVariantStaticCalls: variantStaticCalls.filter((item) => !item.ok).length,
    ...(autoVaultIncentives ? {
      incentiveClaimable: autoVaultIncentives.claimable === true,
      incentiveOperatorClaimable: autoVaultIncentives.operatorClaimable === true,
      incentiveStaticCallSucceeded: autoVaultIncentives.staticCall?.ok === true,
      incentiveVotedPools: autoVaultIncentives.result?.domains?.autoVault?.incentives?.votedPools?.length ?? 0,
      incentiveFeeDistributors: autoVaultIncentives.result?.domains?.autoVault?.incentives?.feeDistributors?.length ?? 0
    } : {}),
    ...(scanStatus ? {
      scanStatus: scanStatus.status,
      zeroCandidateReason: scanStatus.zeroCandidateReason,
      stoppedEarlyReason: scanStatus.stoppedEarlyReason,
      scanComplete: scanStatus.scanComplete,
      scanHadErrors: scanStatus.scanHadErrors,
      scanErrors: scanStatus.scanErrors,
      scanFallbackChunks: scanStatus.fallbackChunks
    } : {}),
    ...(p33History ? {
      currentEarnedPositive: p33History.currentEarnedPositive.length,
      historicalClaimedPositive: p33History.historicalClaimedPositive.length,
      historicalClaimedPositiveTruncated: p33History.historicalClaimedPositiveTruncated,
      periodsWithVotes: p33History.periodsWithVotes,
      p33VotedPools: p33History.p33VotedPools,
      p33PoolPeriods: p33History.p33PoolPeriods,
      feeDistributors: p33History.feeDistributors,
      checkedCurrentRows: p33History.checkedCurrentRows,
      checkedHistoricalRows: p33History.checkedHistoricalRows
    } : {})
  };
}

console.log(stringify(report));
