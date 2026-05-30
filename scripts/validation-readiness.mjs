#!/usr/bin/env node
import { createPublicClient, http } from "viem";
import { avalanche } from "viem/chains";
import { collectClaimabilityState } from "./claimability-state.mjs";
import { collectOperatorIncentiveWatch } from "./operator-incentive-watch.mjs";
import { collectProtocolGates } from "./protocol-gates.mjs";

if (process.env.LIVE_BROADCAST === "1") {
  throw new Error("validation-readiness is readonly and refuses LIVE_BROADCAST=1.");
}

const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const wallet = process.env.PHAR_MCP_WALLET ?? "0x0000000000000000000000000000000000000000";
const p33ProbeAssets = process.env.P33_PROBE_ASSETS ?? "30000000000000000";
const p33QuoteAssets = process.env.P33_QUOTE_ASSETS ?? p33ProbeAssets;
const periodsBack = Number(process.env.OPERATOR_INCENTIVE_PERIODS_BACK ?? 16);
const client = createPublicClient({ chain: avalanche, transport: http(rpcUrl) });

function stringify(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function positiveOperatorRows(operatorIncentives) {
  return [
    ...(operatorIncentives.positiveRows?.p33 ?? []).map((row) => ({ domain: "p33", ...row })),
    ...(operatorIncentives.positiveRows?.autoVault ?? []).map((row) => ({ domain: "autoVault", ...row }))
  ];
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === "string"))].sort();
}

function summarizeRewardDomain(value) {
  if (Array.isArray(value)) {
    return {
      kind: "list",
      entries: value.length,
      claimableEntries: value.filter((entry) => entry?.claimable === true).length,
      buildCallEntries: value.filter((entry) => entry?.buildCall).length,
      statuses: Object.fromEntries([...new Set(value.map((entry) => entry?.status ?? "unknown"))]
        .map((status) => [status, value.filter((entry) => (entry?.status ?? "unknown") === status).length])),
      blockers: uniqueStrings(value.flatMap((entry) => entry?.blockers ?? []))
    };
  }

  if (value && typeof value === "object") {
    const nestedClaimability = Object.fromEntries(Object.entries(value)
      .filter(([, child]) => child && typeof child === "object" && !Array.isArray(child) && Object.hasOwn(child, "claimable"))
      .map(([key, child]) => [key, summarizeRewardDomain(child)]));
    return {
      kind: "single",
      claimable: value.claimable === true,
      status: value.status ?? (value.claimable === true ? "claimable" : "blocked"),
      hasBuildCall: Boolean(value.buildCall),
      blockers: uniqueStrings(value.blockers ?? []),
      nestedClaimability
    };
  }

  return { kind: "missing", claimable: false, status: "missing", hasBuildCall: false, blockers: ["domain missing"] };
}

function summarizeRewardClaimability(claimabilityRead) {
  const domains = claimabilityRead?.domains ?? {};
  return {
    currentPeriod: claimabilityRead?.currentPeriod ?? null,
    claimable: claimabilityRead?.claimable ?? null,
    blockers: claimabilityRead?.blockers ?? [],
    domains: Object.fromEntries(Object.entries(domains).map(([key, value]) => [key, summarizeRewardDomain(value)]))
  };
}

function p33Readiness(protocolGates) {
  const gate = protocolGates.gates.p33LiveUnlock;
  return {
    ready: Boolean(gate.liveTxActionableForProbe),
    blockers: gate.blockers ?? [],
    evidence: {
      status: gate.status,
      period: gate.period,
      protocolOpen: gate.protocolOpen,
      walletReadyForProbe: gate.walletReadyForProbe,
      walletCanApproveAndDepositProbe: gate.walletCanApproveAndDepositProbe,
      previewDeposit: gate.previewDeposit
    },
    nextForkCommand: "PHAR_MCP_PHASES=phar_xphar_p33_roundtrip npm run --silent rehearse:fork:report",
    manualLiveFollowup: "Only after fork pass and explicit orchestrator approval: PHAR_MCP_LIVE_CONFIRM=<wallet> PHAR_MCP_PHASES=phar_xphar_p33_roundtrip npm run --silent validate:live:report"
  };
}

function dlmmReadiness(protocolGates) {
  const gate = protocolGates.gates.dlmmNormalUserPoolCreation;
  const ready = gate.status === "open_candidate_available";
  return {
    ready,
    blockers: ready ? [] : [
      gate.status === "blocked_no_open_presets"
        ? "DLMMFactory.getOpenBinSteps() returned no open presets."
        : `DLMM pool-creation gate is ${gate.status}.`
    ],
    evidence: {
      status: gate.status,
      openBinSteps: gate.openBinSteps,
      openAbsentCandidate: gate.openAbsentCandidate,
      binStepRows: gate.binStepRows
    },
    nextForkCommand: "npm run --silent rehearse:pool-creation:report",
    manualLiveFollowup: "Only after fork pass and explicit orchestrator approval: build and review a minimal createLBPair transaction with pharaoh_dlmm_build_tx."
  };
}

function walletRewardReadiness(claimability) {
  const rewardClaimability = claimability.rewardClaimability;
  const ready = rewardClaimability?.claimable === true;
  return {
    ready,
    blockers: ready ? [] : rewardClaimability?.blockers ?? ["No current wallet reward claims are claimable."],
    evidence: {
      source: "claimability.rewardClaimability",
      status: ready ? "current_wallet_rewards_claimable" : "blocked_no_current_wallet_claims",
      ...summarizeRewardClaimability(rewardClaimability)
    },
    nextForkCommand: "npm run --silent rehearse:reward-claims:report",
    manualLiveFollowup: "Only after current wallet claimability returns a positive build call, static-call proof, fork pass, and explicit orchestrator approval: submit the relevant wallet reward claim transaction."
  };
}

function operatorIncentiveReadiness(claimability, operatorIncentives) {
  const highLevel = claimability.operatorIncentiveClaimability;
  const positiveRows = highLevel?.positiveRowsFlat ?? positiveOperatorRows(operatorIncentives);
  return {
    ready: Boolean(highLevel?.ready ?? positiveRows.length > 0),
    blockers: highLevel?.blockers ?? (positiveRows.length > 0 ? [] : [
      "No current positive p33 or AutoVault operator incentive earned rows were found."
    ]),
    evidence: {
      source: highLevel ? "claimability.operatorIncentiveClaimability" : "operator-incentives.latest.json",
      status: highLevel?.status ?? (positiveRows.length > 0 ? "positive_current_earned_found" : "blocked_no_current_positive_earned"),
      periodsBack: highLevel?.periodsBack ?? operatorIncentives.periodsBack,
      summary: highLevel?.summary ?? operatorIncentives.summary,
      positiveRows,
      corroboratingWatchSummary: operatorIncentives.summary
    },
    nextForkCommand: "npm run --silent rehearse:reward-claims:report",
    manualLiveFollowup: "Only after positive current earned rows, static-call proof, fork pass, and explicit orchestrator approval: submit the relevant operator claim transaction."
  };
}

function recommendedNextAction(readiness) {
  if (readiness.p33LiveDepositReady.ready) return "run_fork_p33";
  if (readiness.dlmmPoolCreationReady.ready) return "run_pool_creation_fork";
  if (readiness.walletRewardClaimReady.ready) return "run_wallet_reward_claim_fork";
  if (readiness.operatorIncentiveClaimReady.ready) return "run_operator_claim_fork";
  return "wait_refresh_gates";
}

const [protocolGates, claimability, operatorIncentives] = await Promise.all([
  collectProtocolGates({ client, rpcUrl, wallet, p33ProbeAssets }),
  collectClaimabilityState({ client, rpcUrl, wallet, p33QuoteAssets }),
  collectOperatorIncentiveWatch({ client, rpcUrl, wallet, periodsBack })
]);

const readiness = {
  p33LiveDepositReady: p33Readiness(protocolGates),
  dlmmPoolCreationReady: dlmmReadiness(protocolGates),
  walletRewardClaimReady: walletRewardReadiness(claimability),
  operatorIncentiveClaimReady: operatorIncentiveReadiness(claimability, operatorIncentives)
};

const report = {
  timestamp: new Date().toISOString(),
  chainId: 43114,
  rpcUrl,
  safety: {
    readOnly: true,
    privateKeyRead: false,
    liveBroadcastAllowed: false
  },
  inputs: {
    wallet,
    p33ProbeAssets,
    p33QuoteAssets,
    periodsBack
  },
  protocolGates,
  claimability,
  operatorIncentives: {
    timestamp: operatorIncentives.timestamp,
    chainId: operatorIncentives.chainId,
    rpcUrl: operatorIncentives.rpcUrl,
    wallet: operatorIncentives.wallet,
    currentPeriod: operatorIncentives.currentPeriod,
    periodsBack: operatorIncentives.periodsBack,
    summary: operatorIncentives.summary,
    positiveRows: operatorIncentives.positiveRows,
    warning: operatorIncentives.warning
  },
  readiness,
  recommendedNextAction: recommendedNextAction(readiness),
  refreshCommands: {
    validationReadiness: "npm run --silent state:validation-readiness:report",
    protocolGates: "npm run --silent state:protocol-gates:report",
    claimability: "npm run --silent state:claimability:report",
    operatorIncentives: "npm run --silent state:operator-incentives:report"
  },
  warning: "Readonly continuation gate only. This script never reads the expendable wallet private key and refuses LIVE_BROADCAST=1."
};

console.log(stringify(report));
