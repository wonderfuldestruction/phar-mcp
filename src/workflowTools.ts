import { encodeFunctionData, type Abi } from "viem";
import { CHAIN_ID, type ContractKey } from "./contracts.js";
import {
  functionSignature,
  getContractAbi,
  lookupContract,
  lookupFunction,
  normalizeAddress,
  normalizeArgs,
  parseBigIntLike
} from "./lookup.js";

// === WARNINGS ===

export const unsignedCalldataWarning = "Unsigned calldata only. This server never signs, sends, or simulates a transaction.";

export const gaugeImplementationWarning =
  "Unsigned calldata only. clGaugeV3 is an implementation ABI; addressOverride is required and must be the deployed GaugeV3 address you intend to call. This server never signs, sends, or simulates a transaction.";

export const legacyGaugeInstanceWarning =
  "Unsigned calldata only. legacyGauge is a source-backed instance ABI; addressOverride is required and must be the deployed legacy gauge address you intend to call. This server never signs, sends, or simulates a transaction.";

export const sourceBackedAutoVaultWarning =
  "Unsigned calldata only. autoVault is source-backed from app/live-read evidence and selector-backed against its EIP-1967 implementation; the proxy and implementation ABIs are not verified on public explorer endpoints. Verify the target and calldata before signing elsewhere.";

export const p33OperatorAutomationWarning =
  "Unsigned calldata only. p33 operator/protocol automation action; the caller must be authorized and current protocol/claimability state should be checked with pharaoh_protocol_gates_read or pharaoh_reward_claimability_read before signing elsewhere. This server never signs, sends, or simulates a transaction.";

export const autoVaultOperatorAutomationWarning =
  "Unsigned calldata only. AutoVault operator/protocol automation action on a source-backed ABI candidate; the caller must be authorized and current claimability/readiness state should be checked with pharaoh_reward_claimability_read before signing elsewhere. This server never signs, sends, or simulates a transaction.";

export const gaugeAdminWarning =
  "Unsigned calldata only. Gauge reward/admin action on an implementation ABI; caller permissions and target deployed gauge address must be verified before signing elsewhere. This server never signs, sends, or simulates a transaction.";

export const legacyGaugeAdminWarning =
  "Unsigned calldata only. Legacy gauge reward/admin action on a source-backed instance ABI; caller permissions and target deployed gauge address must be verified before signing elsewhere. This server never signs, sends, or simulates a transaction.";

export const deprecatedClRewardReceiverWarning =
  "Unsigned calldata only. Deprecated compatibility alias: the 4-arg Voter claimClGaugeRewards overload takes NFP manager addresses, not reward receivers. Prefer claimClGaugeRewardsWithNfpManagers.";

// === TYPES ===

export type BigIntLikeInput = string | number;

export type UnsignedTxBuildInput = {
  contract: ContractKey | string;
  functionName: string;
  args?: unknown[];
  value?: BigIntLikeInput;
  addressOverride?: string;
  warning?: string;
};

export type UnsignedTxBuildResult = {
  chainId: typeof CHAIN_ID;
  contract: string;
  contractName: string;
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
  functionName: string;
  signature: string;
  args: unknown[];
  warning: string;
};

export type WorkflowActionMapping = {
  contract: ContractKey;
  functionName: string;
  requiresAddressOverride?: boolean;
  addressOverrideReason?: string;
  warning?: string;
};

// === BUILDERS ===

/** @summary Build unsigned calldata for a contract function call from contract key, function name, and args */

export function buildUnsignedTx({
  contract,
  functionName,
  args,
  value,
  addressOverride,
  warning = unsignedCalldataWarning
}: UnsignedTxBuildInput): UnsignedTxBuildResult {
  const entry = lookupContract(contract);
  const abi = getContractAbi(entry);
  const fn = lookupFunction(abi, functionName);
  const to = addressOverride ? normalizeAddress(addressOverride, "addressOverride") : entry.address;
  const normalizedArgs = normalizeArgs(fn, args);
  const txValue = value === undefined ? 0n : parseBigIntLike(value, "value");
  const data = encodeFunctionData({
    abi: [fn] as Abi,
    functionName: fn.name,
    args: normalizedArgs
  } as never);

  return {
    chainId: CHAIN_ID,
    contract: entry.key,
    contractName: entry.name,
    to,
    data,
    value: txValue.toString(),
    functionName: fn.name,
    signature: functionSignature(fn),
    args: normalizedArgs,
    warning
  };
}

/** @summary Format unsigned transaction result with action label and underlying contract metadata */

export function workflowTxResult(tx: UnsignedTxBuildResult, action?: string) {
  return {
    action,
    chainId: tx.chainId,
    contract: tx.contract,
    contractName: tx.contractName,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    functionName: tx.functionName,
    signature: tx.signature,
    args: tx.args,
    underlying: {
      contract: tx.contract,
      contractName: tx.contractName,
      address: tx.to,
      functionName: tx.functionName,
      signature: tx.signature
    },
    warning: tx.warning
  };
}

/** @summary Build unsigned calldata from an action-to-contract mapping with address override support */

export function buildMappedWorkflowTx(
  action: string,
  actionMap: Record<string, WorkflowActionMapping>,
  input: {
    args?: unknown[];
    value?: BigIntLikeInput;
    addressOverride?: string;
  } = {}
) {
  const mapping = actionMap[action];
  if (!mapping) {
    throw new Error(`Unknown workflow action "${action}".`);
  }

  if (mapping.requiresAddressOverride && !input.addressOverride) {
    throw new Error(`${action} requires addressOverride. ${mapping.addressOverrideReason ?? "The selected ABI applies to deployed instances rather than a single registry address."}`);
  }

  const tx = buildUnsignedTx({
    contract: mapping.contract,
    functionName: mapping.functionName,
    args: input.args,
    value: input.value,
    addressOverride: input.addressOverride,
    warning: mapping.warning
  });

  return workflowTxResult(tx, action);
}

// === VOTE ACTIONS ===

export const voteBuildActions = [
  "deposit",
  "depositAll",
  "withdraw",
  "withdrawAll",
  "delegate",
  "vote",
  "reset",
  "poke",
  "claimRewards",
  "claimIncentives",
  "claimLegacyIncentives",
  "claimClGaugeRewards",
  "claimClGaugeRewardsWithNfpManagers",
  "claimClGaugeRewardsWithReceivers",
  "distribute",
  "distributeAll",
  "distributeForPeriod"
] as const;

export type VoteBuildAction = (typeof voteBuildActions)[number];

export const voteActionMap = {
  deposit: { contract: "voteModule", functionName: "deposit(uint256)" },
  depositAll: { contract: "voteModule", functionName: "depositAll()" },
  withdraw: { contract: "voteModule", functionName: "withdraw(uint256)" },
  withdrawAll: { contract: "voteModule", functionName: "withdrawAll()" },
  delegate: { contract: "voteModule", functionName: "delegate(address)" },
  vote: { contract: "voter", functionName: "vote(address,address[],uint256[])" },
  reset: { contract: "voter", functionName: "reset(address)" },
  poke: { contract: "voter", functionName: "poke(address)" },
  claimRewards: { contract: "voter", functionName: "claimRewards(address[],address[][])" },
  claimIncentives: { contract: "voter", functionName: "claimIncentives(address,address[],address[][])" },
  claimLegacyIncentives: { contract: "voter", functionName: "claimLegacyIncentives(address,address[],address[][])" },
  claimClGaugeRewards: { contract: "voter", functionName: "claimClGaugeRewards(address[],address[][],uint256[][])" },
  claimClGaugeRewardsWithNfpManagers: { contract: "voter", functionName: "claimClGaugeRewards(address[],address[][],uint256[][],address[])" },
  claimClGaugeRewardsWithReceivers: { contract: "voter", functionName: "claimClGaugeRewards(address[],address[][],uint256[][],address[])", warning: deprecatedClRewardReceiverWarning },
  distribute: { contract: "voter", functionName: "distribute(address)" },
  distributeAll: { contract: "voter", functionName: "distributeAll()" },
  distributeForPeriod: { contract: "voter", functionName: "distributeForPeriod(address,uint256)" }
} as const satisfies Record<VoteBuildAction, WorkflowActionMapping>;

// === XPBAR ACTIONS ===

export const xPharActions = [
  "convert",
  "exit",
  "rebase",
  "approve",
  "transfer",
  "transferFrom"
] as const;

export type XPharAction = (typeof xPharActions)[number];

export const xPharActionMap = {
  convert: { contract: "xPharToken", functionName: "convertEmissionsToken(uint256)" },
  exit: { contract: "xPharToken", functionName: "exit(uint256)" },
  rebase: { contract: "xPharToken", functionName: "rebase()" },
  approve: { contract: "xPharToken", functionName: "approve(address,uint256)" },
  transfer: { contract: "xPharToken", functionName: "transfer(address,uint256)" },
  transferFrom: { contract: "xPharToken", functionName: "transferFrom(address,address,uint256)" }
} as const satisfies Record<XPharAction, WorkflowActionMapping>;

// === P33 ACTIONS ===

export const p33Actions = [
  "deposit",
  "mint",
  "withdraw",
  "redeem",
  "claimIncentives",
  "compound",
  "submitVotes",
  "swapIncentiveViaAggregator",
  "unlock",
  "approve",
  "transfer",
  "transferFrom"
] as const;

export type P33Action = (typeof p33Actions)[number];

export const p33ActionMap = {
  deposit: { contract: "p33", functionName: "deposit(uint256,address)" },
  mint: { contract: "p33", functionName: "mint(uint256,address)" },
  withdraw: { contract: "p33", functionName: "withdraw(uint256,address,address)" },
  redeem: { contract: "p33", functionName: "redeem(uint256,address,address)" },
  claimIncentives: { contract: "p33", functionName: "claimIncentives(address[],address[][])", warning: p33OperatorAutomationWarning },
  compound: { contract: "p33", functionName: "compound()", warning: p33OperatorAutomationWarning },
  submitVotes: { contract: "p33", functionName: "submitVotes(address[],uint256[])", warning: p33OperatorAutomationWarning },
  swapIncentiveViaAggregator: { contract: "p33", functionName: "swapIncentiveViaAggregator((address,address,uint256,uint256,bytes))", warning: p33OperatorAutomationWarning },
  unlock: { contract: "p33", functionName: "unlock()", warning: p33OperatorAutomationWarning },
  approve: { contract: "p33", functionName: "approve(address,uint256)" },
  transfer: { contract: "p33", functionName: "transfer(address,uint256)" },
  transferFrom: { contract: "p33", functionName: "transferFrom(address,address,uint256)" }
} as const satisfies Record<P33Action, WorkflowActionMapping>;

// === AUTO VAULT ACTIONS ===

export const autoVaultActions = [
  "deposit",
  "withdraw",
  "claim",
  "setOutputPreference",
  "claimIncentives",
  "submitVotes",
  "swap",
  "lock",
  "unlock",
  "addAggregator",
  "removeAggregator",
  "addOutputToken",
  "removeOutputToken",
  "setOperator",
  "rescue"
] as const;

export type AutoVaultAction = (typeof autoVaultActions)[number];

const autoVaultCall = (functionName: string): WorkflowActionMapping => ({
  contract: "autoVault",
  functionName,
  warning: sourceBackedAutoVaultWarning
});

const autoVaultOperatorCall = (functionName: string): WorkflowActionMapping => ({
  contract: "autoVault",
  functionName,
  warning: autoVaultOperatorAutomationWarning
});

export const autoVaultActionMap = {
  deposit: autoVaultCall("deposit(uint256,address)"),
  withdraw: autoVaultCall("withdraw(uint256)"),
  claim: autoVaultCall("claim()"),
  setOutputPreference: autoVaultCall("setOutputPreference(address)"),
  claimIncentives: autoVaultOperatorCall("claimIncentives(address[],address[][])"),
  submitVotes: autoVaultOperatorCall("submitVotes(address[],uint256[])"),
  swap: autoVaultOperatorCall("swap(address,(address,address,bytes))"),
  lock: autoVaultOperatorCall("lock()"),
  unlock: autoVaultOperatorCall("unlock(bool)"),
  addAggregator: autoVaultOperatorCall("addAggregator(address)"),
  removeAggregator: autoVaultOperatorCall("removeAggregator(address)"),
  addOutputToken: autoVaultOperatorCall("addOutputToken(address)"),
  removeOutputToken: autoVaultOperatorCall("removeOutputToken(address,bool)"),
  setOperator: autoVaultOperatorCall("setOperator(address)"),
  rescue: autoVaultOperatorCall("rescue(address,uint256)")
} as const satisfies Record<AutoVaultAction, WorkflowActionMapping>;

// === LEGACY LIQUIDITY ACTIONS ===

export const legacyLiquidityActions = [
  "createPair",
  "addLiquidity",
  "addLiquidityETH",
  "addLiquidityAndStake",
  "addLiquidityETHAndStake",
  "removeLiquidity",
  "removeLiquidityETH",
  "removeLiquidityETHSupportingFeeOnTransferTokens"
] as const;

export type LegacyLiquidityAction = (typeof legacyLiquidityActions)[number];

export const legacyLiquidityActionMap = {
  createPair: { contract: "pairFactory", functionName: "createPair(address,address,bool)" },
  addLiquidity: { contract: "router", functionName: "addLiquidity(address,address,bool,uint256,uint256,uint256,uint256,address,uint256)" },
  addLiquidityETH: { contract: "router", functionName: "addLiquidityETH(address,bool,uint256,uint256,uint256,address,uint256)" },
  addLiquidityAndStake: { contract: "router", functionName: "addLiquidityAndStake(address,address,bool,uint256,uint256,uint256,uint256,address,uint256)" },
  addLiquidityETHAndStake: { contract: "router", functionName: "addLiquidityETHAndStake(address,bool,uint256,uint256,uint256,address,uint256)" },
  removeLiquidity: { contract: "router", functionName: "removeLiquidity(address,address,bool,uint256,uint256,uint256,address,uint256)" },
  removeLiquidityETH: { contract: "router", functionName: "removeLiquidityETH(address,bool,uint256,uint256,uint256,address,uint256)" },
  removeLiquidityETHSupportingFeeOnTransferTokens: { contract: "router", functionName: "removeLiquidityETHSupportingFeeOnTransferTokens(address,bool,uint256,uint256,uint256,address,uint256)" }
} as const satisfies Record<LegacyLiquidityAction, WorkflowActionMapping>;

// === LEGACY SWAP ACTIONS ===

export const legacySwapFunctionNames = [
  "swapETHForExactTokens",
  "swapExactETHForTokens",
  "swapExactETHForTokensSupportingFeeOnTransferTokens",
  "swapExactTokensForETH",
  "swapExactTokensForETHSupportingFeeOnTransferTokens",
  "swapExactTokensForTokens",
  "swapExactTokensForTokensSupportingFeeOnTransferTokens",
  "swapTokensForExactETH",
  "swapTokensForExactTokens"
] as const;

export type LegacySwapFunctionName = (typeof legacySwapFunctionNames)[number];

// === CL LIQUIDITY ACTIONS ===

export const clLiquidityActions = [
  "createPool",
  "createAndInitializePoolIfNecessary",
  "mint",
  "increaseLiquidity",
  "decreaseLiquidity",
  "collect",
  "burn",
  "getReward",
  "getPeriodReward"
] as const;

export type ClLiquidityAction = (typeof clLiquidityActions)[number];

export const clLiquidityActionMap = {
  createPool: { contract: "ramsesV3Factory", functionName: "createPool(address,address,int24,uint160)" },
  createAndInitializePoolIfNecessary: { contract: "ramsesV3PositionManager", functionName: "createAndInitializePoolIfNecessary(address,address,int24,uint160)" },
  mint: { contract: "ramsesV3PositionManager", functionName: "mint((address,address,int24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))" },
  increaseLiquidity: { contract: "ramsesV3PositionManager", functionName: "increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))" },
  decreaseLiquidity: { contract: "ramsesV3PositionManager", functionName: "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))" },
  collect: { contract: "ramsesV3PositionManager", functionName: "collect((uint256,address,uint128,uint128))" },
  burn: { contract: "ramsesV3PositionManager", functionName: "burn(uint256)" },
  getReward: { contract: "ramsesV3PositionManager", functionName: "getReward(uint256,address[])" },
  getPeriodReward: { contract: "ramsesV3PositionManager", functionName: "getPeriodReward(uint256,uint256,address[],address)" }
} as const satisfies Record<ClLiquidityAction, WorkflowActionMapping>;

// === CL SWAP ACTIONS ===

export const clSwapFunctionNames = [
  "exactInput((bytes,address,uint256,uint256,uint256))",
  "exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))",
  "exactOutput((bytes,address,uint256,uint256,uint256))",
  "exactOutputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))",
  "multicall",
  "refundETH",
  "sweepToken",
  "sweepTokenWithFee",
  "unwrapWETH9",
  "unwrapWETH9WithFee"
] as const;

export type ClSwapFunctionName = (typeof clSwapFunctionNames)[number];

// === GAUGE ACTIONS ===

export const gaugeActions = [
  "createGauge",
  "createClGauge",
  "legacyDeposit",
  "legacyDepositAll",
  "legacyDepositFor",
  "legacyWithdraw",
  "legacyWithdrawAll",
  "legacyUnstakeAndClaimAll",
  "legacyGetReward",
  "legacyNotifyRewardAmount",
  "addRewards",
  "cachePeriodEarned",
  "getPeriodReward",
  "getReward",
  "getRewardForTokenIds",
  "getRewardForPosition",
  "getRewardForOwner",
  "getRewardForOwnerFromVoter",
  "initialize",
  "notifyRewardAmount",
  "notifyRewardAmountForPeriod",
  "notifyRewardAmountNextPeriod",
  "removeRewards",
  "syncCache"
] as const;

export type GaugeAction = (typeof gaugeActions)[number];

const deployedGaugeCall = (functionName: string): WorkflowActionMapping => ({
  contract: "clGaugeV3",
  functionName,
  requiresAddressOverride: true,
  addressOverrideReason: "clGaugeV3 is an implementation ABI, not a deployed gauge address.",
  warning: gaugeImplementationWarning
});

const deployedLegacyGaugeCall = (functionName: string): WorkflowActionMapping => ({
  contract: "legacyGauge",
  functionName,
  requiresAddressOverride: true,
  addressOverrideReason: "legacyGauge is an instance ABI; pass the deployed legacy gauge address you intend to call.",
  warning: legacyGaugeInstanceWarning
});

const deployedGaugeAdminCall = (functionName: string): WorkflowActionMapping => ({
  contract: "clGaugeV3",
  functionName,
  requiresAddressOverride: true,
  addressOverrideReason: "clGaugeV3 is an implementation ABI, not a deployed gauge address.",
  warning: gaugeAdminWarning
});

const deployedLegacyGaugeAdminCall = (functionName: string): WorkflowActionMapping => ({
  contract: "legacyGauge",
  functionName,
  requiresAddressOverride: true,
  addressOverrideReason: "legacyGauge is an instance ABI; pass the deployed legacy gauge address you intend to call.",
  warning: legacyGaugeAdminWarning
});

export const gaugeActionMap = {
  createGauge: { contract: "legacyGaugeFactory", functionName: "createGauge(address)" },
  createClGauge: { contract: "clGaugeFactory", functionName: "createGauge(address)" },
  legacyDeposit: deployedLegacyGaugeCall("deposit(uint256)"),
  legacyDepositAll: deployedLegacyGaugeCall("depositAll()"),
  legacyDepositFor: deployedLegacyGaugeCall("depositFor(address,uint256)"),
  legacyWithdraw: deployedLegacyGaugeCall("withdraw(uint256)"),
  legacyWithdrawAll: deployedLegacyGaugeCall("withdrawAll()"),
  legacyUnstakeAndClaimAll: deployedLegacyGaugeCall("unstakeAndClaimAll(address[])"),
  legacyGetReward: deployedLegacyGaugeCall("getReward(address,address[])"),
  legacyNotifyRewardAmount: deployedLegacyGaugeAdminCall("notifyRewardAmount(address,uint256)"),
  addRewards: deployedGaugeAdminCall("addRewards(address)"),
  cachePeriodEarned: deployedGaugeCall("cachePeriodEarned(uint256,address,address,uint256,int24,int24,bool)"),
  getPeriodReward: deployedGaugeCall("getPeriodReward(uint256,address[],address,uint256,int24,int24,address)"),
  getReward: deployedGaugeCall("getReward(uint256,address[])"),
  getRewardForTokenIds: deployedGaugeCall("getReward(uint256[],address[])"),
  getRewardForPosition: deployedGaugeCall("getReward(address,uint256,int24,int24,address[],address)"),
  getRewardForOwner: deployedGaugeCall("getRewardForOwner(uint256,address[])"),
  getRewardForOwnerFromVoter: deployedGaugeCall("getRewardForOwnerFromVoter(address,uint256,address[])"),
  initialize: deployedGaugeAdminCall("initialize(address,address,address,address)"),
  notifyRewardAmount: deployedGaugeAdminCall("notifyRewardAmount(address,uint256)"),
  notifyRewardAmountForPeriod: deployedGaugeAdminCall("notifyRewardAmountForPeriod(address,uint256,uint256)"),
  notifyRewardAmountNextPeriod: deployedGaugeAdminCall("notifyRewardAmountNextPeriod(address,uint256)"),
  removeRewards: deployedGaugeAdminCall("removeRewards(address)"),
  syncCache: deployedGaugeAdminCall("syncCache()")
} as const satisfies Record<GaugeAction, WorkflowActionMapping>;

// === DLMM ACTIONS ===

export const dlmmActions = [
  "addLiquidity",
  "addLiquidityNATIVE",
  "removeLiquidity",
  "removeLiquidityNATIVE",
  "routerCreateLBPair",
  "factoryCreateLBPair",
  "swapExactNATIVEForTokens",
  "swapExactNATIVEForTokensSupportingFeeOnTransferTokens",
  "swapExactTokensForNATIVE",
  "swapExactTokensForNATIVESupportingFeeOnTransferTokens",
  "swapExactTokensForTokens",
  "swapExactTokensForTokensSupportingFeeOnTransferTokens",
  "swapNATIVEForExactTokens",
  "swapTokensForExactNATIVE",
  "swapTokensForExactTokens",
  "approveForAll",
  "batchTransferFrom",
  "poolMint",
  "poolBurn",
  "rewarderClaim"
] as const;

export type DlmmAction = (typeof dlmmActions)[number];

const deployedDlmmPoolCall = (functionName: string): WorkflowActionMapping => ({
  contract: "dlmmPoolImplementation",
  functionName,
  requiresAddressOverride: true,
  addressOverrideReason: "dlmmPoolImplementation is an implementation ABI; pass the deployed DLMM pool address, for example the WAVAX/USDC binStep 5 pool.",
  warning: "Unsigned calldata only. dlmmPoolImplementation is an implementation ABI; addressOverride must be the deployed DLMM pool address. DLMM positions are ERC1155-like bin IDs and use approveForAll."
});

const deployedDlmmRewarderCall = (functionName: string): WorkflowActionMapping => ({
  contract: "dlmmRewarderImplementation",
  functionName,
  requiresAddressOverride: true,
  addressOverrideReason: "dlmmRewarderImplementation is an implementation ABI; pass the deployed DLMM rewarder address.",
  warning: "Unsigned calldata only. dlmmRewarderImplementation is an implementation ABI; addressOverride must be the deployed rewarder address."
});

export const dlmmActionMap = {
  addLiquidity: { contract: "dlmmRouter", functionName: "addLiquidity((address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,int256[],uint256[],uint256[],address,address,uint256))" },
  addLiquidityNATIVE: { contract: "dlmmRouter", functionName: "addLiquidityNATIVE((address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,int256[],uint256[],uint256[],address,address,uint256))" },
  removeLiquidity: { contract: "dlmmRouter", functionName: "removeLiquidity(address,address,uint16,uint256,uint256,uint256[],uint256[],address,uint256)" },
  removeLiquidityNATIVE: { contract: "dlmmRouter", functionName: "removeLiquidityNATIVE(address,uint16,uint256,uint256,uint256[],uint256[],address,uint256)" },
  routerCreateLBPair: { contract: "dlmmRouter", functionName: "createLBPair(address,address,uint24,uint16)" },
  factoryCreateLBPair: { contract: "dlmmFactory", functionName: "createLBPair(address,address,uint24,uint16)" },
  swapExactNATIVEForTokens: { contract: "dlmmRouter", functionName: "swapExactNATIVEForTokens(uint256,(uint256[],uint8[],address[]),address,uint256)" },
  swapExactNATIVEForTokensSupportingFeeOnTransferTokens: { contract: "dlmmRouter", functionName: "swapExactNATIVEForTokensSupportingFeeOnTransferTokens(uint256,(uint256[],uint8[],address[]),address,uint256)" },
  swapExactTokensForNATIVE: { contract: "dlmmRouter", functionName: "swapExactTokensForNATIVE(uint256,uint256,(uint256[],uint8[],address[]),address,uint256)" },
  swapExactTokensForNATIVESupportingFeeOnTransferTokens: { contract: "dlmmRouter", functionName: "swapExactTokensForNATIVESupportingFeeOnTransferTokens(uint256,uint256,(uint256[],uint8[],address[]),address,uint256)" },
  swapExactTokensForTokens: { contract: "dlmmRouter", functionName: "swapExactTokensForTokens(uint256,uint256,(uint256[],uint8[],address[]),address,uint256)" },
  swapExactTokensForTokensSupportingFeeOnTransferTokens: { contract: "dlmmRouter", functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,(uint256[],uint8[],address[]),address,uint256)" },
  swapNATIVEForExactTokens: { contract: "dlmmRouter", functionName: "swapNATIVEForExactTokens(uint256,(uint256[],uint8[],address[]),address,uint256)" },
  swapTokensForExactNATIVE: { contract: "dlmmRouter", functionName: "swapTokensForExactNATIVE(uint256,uint256,(uint256[],uint8[],address[]),address,uint256)" },
  swapTokensForExactTokens: { contract: "dlmmRouter", functionName: "swapTokensForExactTokens(uint256,uint256,(uint256[],uint8[],address[]),address,uint256)" },
  approveForAll: deployedDlmmPoolCall("approveForAll(address,bool)"),
  batchTransferFrom: deployedDlmmPoolCall("batchTransferFrom(address,address,uint256[],uint256[])"),
  poolMint: deployedDlmmPoolCall("mint(address,bytes32[],address)"),
  poolBurn: deployedDlmmPoolCall("burn(address,address,uint256[],uint256[])"),
  rewarderClaim: deployedDlmmRewarderCall("claim(address,uint256[])")
} as const satisfies Record<DlmmAction, WorkflowActionMapping>;
