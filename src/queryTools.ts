import { existsSync, readFileSync } from "node:fs";
import { encodeAbiParameters, encodeFunctionData, encodePacked, type Abi, type AbiFunction, type Address, type BlockTag, type Hex, type PublicClient, getAddress, isAddress } from "viem";
import { contractAbis } from "./abis.js";
import { CHAIN_ID, contractRegistry, type ContractKey } from "./contracts.js";
import {
  functionSignature,
  getContractAbi,
  lookupContract,
  lookupFunction,
  normalizeAddress,
  normalizeArgs,
  parseBigIntLike
} from "./lookup.js";
import { buildUnsignedTx, workflowTxResult } from "./workflowTools.js";

const DEFAULT_STATIC_ACCOUNT = "0x0000000000000000000000000000000000000001";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const UNIVERSAL_ROUTER_V3_SWAP_EXACT_IN = 0x00;
const UNIVERSAL_ROUTER_V2_SWAP_EXACT_IN = 0x08;
const UNIVERSAL_ROUTER_WRAP_ETH = 0x0b;
const UNIVERSAL_ROUTER_UNWRAP_WETH = 0x0c;
const UNIVERSAL_ROUTER_CONTRACT_BALANCE = 1n << 255n;
const MIXED_ROUTE_V2_STABLE_FLAG = 0x800000n;
const MIXED_ROUTE_V2_VOLATILE_FLAG = 0x800001n;
const DEFAULT_CL_WAVAX_USDC_10_POOL = "0xf01449C0bA930B6e2CaCA3DEF3CCBd7a3E589534";
const DEFAULT_DLMM_REWARDED_POOL = "0x87206a5a6eDDd4e22423425BA66C2591551BFc6f";
const ACCEPTANCE_AUDIT_REPORT = "reports/acceptance-audit.latest.json";

type ReadCallInput = {
  contract: string;
  functionName: string;
  args?: unknown[];
  addressOverride?: string;
  blockTag?: BlockTag;
  allowFailure?: boolean;
};

type TokenApprovalInput = {
  token: string;
  amount?: string | number;
  spender?: string;
};

type NftApprovalInput = {
  token: string;
  tokenId?: string | number;
  operator?: string;
  standard?: "erc721" | "erc1155";
};

function asAddress(value: unknown, label: string): Address {
  return normalizeAddress(value, label);
}

function maybeAddress(value: unknown): Address | undefined {
  return typeof value === "string" && isAddress(value, { strict: false }) ? getAddress(value) : undefined;
}

function isNativeToken(address: Address): boolean {
  return address.toLowerCase() === ZERO_ADDRESS;
}

function abiWithErrors(abi: Abi, fn: AbiFunction): Abi {
  return [fn, ...abi.filter((item) => item.type === "error")] as Abi;
}

async function runContractFunction(
  publicClient: PublicClient,
  input: ReadCallInput & { allowNonView?: boolean; staticAccount?: string }
) {
  const entry = lookupContract(input.contract);
  const abi = getContractAbi(entry);
  const fn = lookupFunction(abi, input.functionName);
  const address = input.addressOverride ? asAddress(input.addressOverride, "addressOverride") : entry.address;
  const args = normalizeArgs(fn, input.args);
  const callAbi = abiWithErrors(abi, fn);

  if (fn.stateMutability === "view" || fn.stateMutability === "pure") {
    const result = await publicClient.readContract({
      address,
      abi: callAbi,
      functionName: fn.name,
      args,
      blockTag: input.blockTag
    } as never);

    return {
      chainId: CHAIN_ID,
      contract: entry.key,
      address,
      functionName: fn.name,
      signature: functionSignature(fn),
      args,
      blockTag: input.blockTag ?? "latest",
      result
    };
  }

  if (!input.allowNonView) {
    throw new Error(`${functionSignature(fn)} is ${fn.stateMutability}. Use a quote/static-call helper or pharaoh_build_tx for non-view functions.`);
  }

  const simulation = await publicClient.simulateContract({
    account: asAddress(input.staticAccount ?? DEFAULT_STATIC_ACCOUNT, "staticAccount"),
    address,
    abi: callAbi,
    functionName: fn.name,
    args
  } as never);

  return {
    chainId: CHAIN_ID,
    contract: entry.key,
    address,
    functionName: fn.name,
    signature: functionSignature(fn),
    args,
    result: simulation.result,
    warning: "Static simulation only. No transaction was signed or broadcast."
  };
}

// === BATCH READS ===

/** @summary Execute multiple readonly contract calls in a single multicall batch */

export async function readBatch(publicClient: PublicClient, calls: ReadCallInput[], blockTag?: BlockTag) {
  const results = [];

  for (const [index, call] of calls.entries()) {
    try {
      results.push({
        index,
        ok: true,
        ...(await runContractFunction(publicClient, { ...call, blockTag: call.blockTag ?? blockTag }))
      });
    } catch (error) {
      if (!call.allowFailure) {
        throw error;
      }
      results.push({
        index,
        ok: false,
        contract: call.contract,
        functionName: call.functionName,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { chainId: CHAIN_ID, blockTag: blockTag ?? "latest", results };
}

async function tryRead(
  publicClient: PublicClient,
  address: Address,
  abi: Abi,
  functionName: string,
  args: unknown[] = [],
  blockTag?: BlockTag
) {
  try {
    return {
      ok: true,
      result: await publicClient.readContract({ address, abi, functionName, args, blockTag } as never)
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function tryRunContractFunction(
  publicClient: PublicClient,
  input: ReadCallInput & { allowNonView?: boolean; staticAccount?: string }
) {
  try {
    const call = await runContractFunction(publicClient, input);
    return {
      ok: true,
      result: call.result,
      call
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function tryAsync<T>(operation: () => Promise<T>) {
  try {
    return { ok: true, result: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function readResultBigInt(read: { ok: boolean; result?: unknown }): bigint | undefined {
  if (!read.ok) return undefined;
  if (typeof read.result === "bigint") return read.result;
  if (typeof read.result === "number" && Number.isSafeInteger(read.result)) return BigInt(read.result);
  if (typeof read.result === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(read.result)) return BigInt(read.result);
  return undefined;
}

function readResultAddress(read: { ok: boolean; result?: unknown }): Address | undefined {
  return read.ok && typeof read.result === "string" && isAddress(read.result, { strict: false })
    ? getAddress(read.result)
    : undefined;
}

function readResultAddresses(read: { ok: boolean; result?: unknown }): Address[] {
  return read.ok && Array.isArray(read.result)
    ? read.result.filter((value): value is string => typeof value === "string" && isAddress(value, { strict: false })).map((value) => getAddress(value))
    : [];
}

function resultField(value: unknown, index: number, key: string): unknown {
  if (Array.isArray(value)) return value[index];
  if (value && typeof value === "object") return (value as Record<string, unknown>)[key];
  return undefined;
}

function uniqueAddresses(addresses: Array<Address | undefined>): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];

  for (const address of addresses) {
    if (!address || address.toLowerCase() === ZERO_ADDRESS) continue;
    const normalized = getAddress(address);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }

  return out;
}

function hasPositiveRead(read: { ok: boolean; result?: unknown }): boolean {
  return (readResultBigInt(read) ?? 0n) > 0n;
}

function claimDomainStatus(claimable: boolean, blockers: string[]) {
  return {
    claimable,
    status: claimable ? "claimable" : "blocked",
    blockers
  };
}

function compactError(message: string): string {
  if (message.includes("LOCKED()")) return "LOCKED() (0xa1422f69)";
  if (message.includes("0xa1422f69")) return "LOCKED() (0xa1422f69)";
  if (message.includes("DepositTooSmall()")) return "DepositTooSmall() (0x6ba4a1c7)";
  if (message.includes("0x6ba4a1c7")) return "DepositTooSmall() (0x6ba4a1c7)";
  if (message.includes("LBFactory__PresetIsLockedForUsers")) return "LBFactory__PresetIsLockedForUsers(address,uint256) (0x09f85fce)";
  if (message.includes("0x09f85fce")) return "LBFactory__PresetIsLockedForUsers(address,uint256) (0x09f85fce)";
  return message.split("\n")[0] ?? message;
}

function p33ActionBuildCall(action: "deposit" | "mint" | "withdraw" | "redeem", args: unknown[], canSubmit: boolean, blockers: string[]) {
  return {
    tool: "pharaoh_p33_build_tx",
    arguments: { action, args },
    status: canSubmit ? "actionable" : "blocked",
    blocked: !canSubmit,
    blockers: canSubmit ? [] : blockers,
    warning: canSubmit
      ? "Unsigned calldata only. Recheck p33 state immediately before signing elsewhere."
      : "Do not sign this p33 action while quote.canSubmit=false. Resolve quote.blockers and rerun pharaoh_p33_read before building or signing the transaction elsewhere."
  };
}

function blockedBuildSuppressionReason(action: string, includesApproval = false) {
  return `${action}${includesApproval ? " and approval" : ""} calldata ${includesApproval ? "are" : "is"} suppressed while quote.canSubmit=false; use blockers${includesApproval ? ", approvalRequired, and shortfall fields" : ""} to identify required state changes.`;
}

function asHex(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error(`${label} must be a 0x-prefixed hex string.`);
  }
  return value as Hex;
}

// === TOKEN READS ===

/** @summary Read ERC20 token state (balance, allowance, metadata) for an account */

export async function tokenRead(
  publicClient: PublicClient,
  input: {
    tokenAddress?: string;
    account?: string;
    spender?: string;
    includeMetadata?: boolean;
    includeNativeBalance?: boolean;
    blockTag?: BlockTag;
  }
) {
  const account = input.account ? asAddress(input.account, "account") : undefined;
  const spender = input.spender ? asAddress(input.spender, "spender") : undefined;
  const blockTag = input.blockTag;

  const nativeBalance = input.includeNativeBalance && account
    ? await publicClient.getBalance({ address: account, blockTag })
    : undefined;

  if (!input.tokenAddress) {
    return {
      chainId: CHAIN_ID,
      account,
      nativeBalance,
      warning: "No tokenAddress supplied; returned native AVAX balance only."
    };
  }

  const tokenAddress = asAddress(input.tokenAddress, "tokenAddress");
  const metadata = input.includeMetadata ?? true
    ? {
      name: await tryRead(publicClient, tokenAddress, contractAbis.erc20Read as Abi, "name", [], blockTag),
      symbol: await tryRead(publicClient, tokenAddress, contractAbis.erc20Read as Abi, "symbol", [], blockTag),
      decimals: await tryRead(publicClient, tokenAddress, contractAbis.erc20Read as Abi, "decimals", [], blockTag),
      totalSupply: await tryRead(publicClient, tokenAddress, contractAbis.erc20Read as Abi, "totalSupply", [], blockTag)
    }
    : undefined;

  return {
    chainId: CHAIN_ID,
    tokenAddress,
    account,
    spender,
    blockTag: blockTag ?? "latest",
    nativeBalance,
    metadata,
    balance: account ? await tryRead(publicClient, tokenAddress, contractAbis.erc20Read as Abi, "balanceOf", [account], blockTag) : undefined,
    allowance: account && spender ? await tryRead(publicClient, tokenAddress, contractAbis.erc20Read as Abi, "allowance", [account, spender], blockTag) : undefined
  };
}

// === SIMULATION ===

/** @summary Simulate a transaction on-chain via eth_call to verify expected behavior before signing */

export async function simulateTx(
  publicClient: PublicClient,
  input: {
    account: string;
    contract?: string;
    functionName?: string;
    args?: unknown[];
    addressOverride?: string;
    to?: string;
    data?: string;
    value?: string | number;
    includeGasEstimate?: boolean;
    blockTag?: BlockTag;
  }
) {
  const account = asAddress(input.account, "account");
  const value = input.value === undefined ? 0n : parseBigIntLike(input.value, "value");

  if (input.contract || input.functionName) {
    if (!input.contract || !input.functionName) {
      throw new Error("Both contract and functionName are required for ABI-aware simulation.");
    }
    const entry = lookupContract(input.contract);
    const abi = getContractAbi(entry);
    const fn = lookupFunction(abi, input.functionName);
    const address = input.addressOverride ? asAddress(input.addressOverride, "addressOverride") : entry.address;
    const args = normalizeArgs(fn, input.args);
    const data = encodeFunctionData({
      abi: [fn] as Abi,
      functionName: fn.name,
      args
    } as never);
    const callAbi = abiWithErrors(abi, fn);

    const simulation = await tryAsync(() => publicClient.simulateContract({
      account,
      address,
      abi: callAbi,
      functionName: fn.name,
      args,
      value,
      blockTag: input.blockTag
    } as never));
    const gasEstimate = input.includeGasEstimate
      ? await tryAsync(() => publicClient.estimateGas({ account, to: address, data, value, blockTag: input.blockTag } as never))
      : undefined;

    return {
      chainId: CHAIN_ID,
      ok: simulation.ok,
      mode: "abi",
      account,
      contract: entry.key,
      address,
      functionName: fn.name,
      signature: functionSignature(fn),
      args,
      value,
      data,
      simulation,
      gasEstimate,
      warning: "Readonly eth_call/simulateContract only. This server did not sign or broadcast a transaction; successful simulation does not guarantee future inclusion or MEV/slippage safety."
    };
  }

  if (!input.to || !input.data) {
    throw new Error("Either contract/functionName or raw to/data is required.");
  }

  const to = asAddress(input.to, "to");
  const data = asHex(input.data, "data");
  const call = await tryAsync(() => publicClient.call({ account, to, data, value, blockTag: input.blockTag } as never));
  const gasEstimate = input.includeGasEstimate
    ? await tryAsync(() => publicClient.estimateGas({ account, to, data, value, blockTag: input.blockTag } as never))
    : undefined;

  return {
    chainId: CHAIN_ID,
    ok: call.ok,
    mode: "raw",
    account,
    to,
    data,
    value,
    call,
    gasEstimate,
    warning: "Readonly eth_call only. This server did not sign or broadcast a transaction; raw call output is not ABI-decoded."
  };
}

// === XPBAR ===

/** @summary Read xPHAR token state: supply, user balance, staking info, lock status */

export async function xpharRead(
  publicClient: PublicClient,
  input: {
    action: "summary" | "convertQuote" | "exitQuote";
    account?: string;
    amount?: string | number;
    simulate?: boolean;
    blockTag?: BlockTag;
  }
) {
  const account = input.account ? asAddress(input.account, "account") : undefined;
  const xphar = contractRegistry.xPharToken.address;
  const phar = contractRegistry.pharToken.address;

  const [basisRead, slashingPenaltyRead, pausedRead, balanceResidingRead, totalSupplyRead] = await Promise.all([
    tryRead(publicClient, xphar, contractAbis.xPharToken as Abi, "BASIS", [], input.blockTag),
    tryRead(publicClient, xphar, contractAbis.xPharToken as Abi, "SLASHING_PENALTY", [], input.blockTag),
    tryRead(publicClient, xphar, contractAbis.xPharToken as Abi, "paused", [], input.blockTag),
    tryRead(publicClient, xphar, contractAbis.xPharToken as Abi, "getBalanceResiding", [], input.blockTag),
    tryRead(publicClient, xphar, contractAbis.xPharToken as Abi, "totalSupply", [], input.blockTag)
  ]);
  const basis = readResultBigInt(basisRead);
  const slashingPenalty = readResultBigInt(slashingPenaltyRead);
  const paused = pausedRead.ok && pausedRead.result === true;
  const balanceResiding = readResultBigInt(balanceResidingRead);
  const totalSupply = readResultBigInt(totalSupplyRead);

  const accountState = account
    ? {
      pharBalance: await tryRead(publicClient, phar, contractAbis.erc20Read as Abi, "balanceOf", [account], input.blockTag),
      pharAllowanceToXPhar: await tryRead(publicClient, phar, contractAbis.erc20Read as Abi, "allowance", [account, xphar], input.blockTag),
      xpharBalance: await tryRead(publicClient, xphar, contractAbis.erc20Read as Abi, "balanceOf", [account], input.blockTag),
      isExempt: await tryRead(publicClient, xphar, contractAbis.xPharToken as Abi, "isExempt", [account], input.blockTag),
      isExemptTo: await tryRead(publicClient, xphar, contractAbis.xPharToken as Abi, "isExemptTo", [account], input.blockTag)
    }
    : undefined;

  const base = {
    chainId: CHAIN_ID,
    action: input.action,
    xphar,
    phar,
    blockTag: input.blockTag ?? "latest",
    constants: { basis, slashingPenalty, paused, balanceResiding, totalSupply },
    constantReads: { basis: basisRead, slashingPenalty: slashingPenaltyRead, paused: pausedRead, balanceResiding: balanceResidingRead, totalSupply: totalSupplyRead },
    account,
    accountState
  };

  if (input.action === "summary") {
    return base;
  }

  const amount = parseBigIntLike(input.amount, "amount");
  if (input.action === "convertQuote") {
    if (!account) {
      throw new Error("account is required for xPHAR convertQuote.");
    }
    const pharBalance = accountState ? readResultBigInt(accountState.pharBalance) : undefined;
    const allowance = accountState ? readResultBigInt(accountState.pharAllowanceToXPhar) : undefined;
    const approvalShortfall = allowance !== undefined && allowance < amount ? amount - allowance : 0n;
    const blockers = [
      ...(pausedRead.ok ? [] : [`could not read xPHAR paused state: ${compactError(String("error" in pausedRead ? pausedRead.error : "missing result"))}`]),
      ...(paused ? ["xPHAR conversions are paused."] : []),
      ...(pharBalance !== undefined && pharBalance >= amount ? [] : ["insufficient PHAR balance."]),
      ...(allowance !== undefined && allowance >= amount ? [] : ["insufficient PHAR allowance to xPHAR."])
    ];
    const simulation = input.simulate
      ? await tryRunContractFunction(publicClient, {
        contract: "xPharToken",
        functionName: "convertEmissionsToken(uint256)",
        args: [amount],
        allowNonView: true,
        staticAccount: account,
        blockTag: input.blockTag
      })
      : undefined;
    const quoteBlockers = [
      ...blockers,
      ...(simulation && !simulation.ok ? [`simulation failed: ${compactError(String(simulation.error))}`] : [])
    ];
    const canSubmit = quoteBlockers.length === 0 && (simulation ? simulation.ok : true);
    const convertBuildCalls = {
      approval: approvalShortfall > 0n
        ? { tool: "pharaoh_encode_approval", arguments: { standard: "erc20", tokenAddress: phar, spender: xphar, amount: approvalShortfall } }
        : null,
      convert: { tool: "pharaoh_xphar_build_tx", arguments: { action: "convert", args: [amount] } }
    };
    return {
      ...base,
      amount,
      expectedXPharOut: amount,
      quote: {
        amount,
        expectedXPharOut: amount,
        approvalRequired: approvalShortfall > 0n,
        approvalShortfall,
        canSubmit,
        blockers: quoteBlockers,
        buildCalls: canSubmit ? convertBuildCalls : null,
        buildCallsStatus: canSubmit ? "actionable" : "blocked_canSubmit_false",
        buildCallsSuppressedReason: canSubmit ? null : blockedBuildSuppressionReason("xPHAR convert", true)
      },
      simulation,
      warning: "convertEmissionsToken(uint256) converts PHAR to xPHAR. This read only preflights balances/allowance and optional static simulation; use pharaoh_xphar_build_tx to build unsigned calldata."
    };
  }

  if (basis === undefined || slashingPenalty === undefined) {
    const blockers = [
      ...(basis === undefined ? [`could not read xPHAR BASIS: ${compactError(String("error" in basisRead ? basisRead.error : "missing result"))}`] : []),
      ...(slashingPenalty === undefined ? [`could not read xPHAR SLASHING_PENALTY: ${compactError(String("error" in slashingPenaltyRead ? slashingPenaltyRead.error : "missing result"))}`] : [])
    ];
    return {
      ...base,
      amount,
      expectedPharOut: undefined,
      penalty: undefined,
      simulatedPharOut: undefined,
      approvalRequired: false,
      quote: {
        amount,
        expectedPharOut: undefined,
        penalty: undefined,
        simulatedPharOut: undefined,
        approvalRequired: false,
        canSubmit: false,
        blockers,
        buildCalls: null,
        buildCallsStatus: "blocked_canSubmit_false",
        buildCallsSuppressedReason: blockedBuildSuppressionReason("xPHAR exit")
      },
      simulation: undefined,
      warning: "exit(uint256) is a live write that burns/spends caller xPHAR and returns PHAR minus the current slashing penalty. This read could not derive the penalty constants, so no builder hint was emitted."
    };
  }

  const penalty = amount * slashingPenalty / basis;
  const expectedPharOut = amount - penalty;
  const xpharBalance = accountState ? readResultBigInt(accountState.xpharBalance) : undefined;
  const exitBlockers = [
    ...(account ? [] : ["account is required to determine xPHAR exit submit readiness."]),
    ...(account ? xpharBalance !== undefined && xpharBalance >= amount ? [] : ["insufficient xPHAR balance."] : [])
  ];
  const simulation = account && input.simulate !== false
    ? await tryRunContractFunction(publicClient, {
      contract: "xPharToken",
      functionName: "exit",
      args: [amount],
      allowNonView: true,
      staticAccount: account,
      blockTag: input.blockTag
    })
    : undefined;
  const quoteBlockers = [
    ...exitBlockers,
    ...(simulation && !simulation.ok ? [`simulation failed: ${compactError(String(simulation.error))}`] : [])
  ];
  const canSubmit = quoteBlockers.length === 0 && (simulation ? simulation.ok : true);
  const exitBuildCalls = {
    exit: { tool: "pharaoh_xphar_build_tx", arguments: { action: "exit", args: [amount] } }
  };

  return {
    ...base,
    amount,
    expectedPharOut,
    penalty,
    simulatedPharOut: simulation?.ok ? simulation.result : undefined,
    approvalRequired: false,
    quote: {
      amount,
      expectedPharOut,
      penalty,
      simulatedPharOut: simulation?.ok ? simulation.result : undefined,
      approvalRequired: false,
      canSubmit,
      blockers: quoteBlockers,
      buildCalls: canSubmit ? exitBuildCalls : null,
      buildCallsStatus: canSubmit ? "actionable" : "blocked_canSubmit_false",
      buildCallsSuppressedReason: canSubmit ? null : blockedBuildSuppressionReason("xPHAR exit")
    },
    simulation,
    warning: "exit(uint256) is a live write that burns/spends caller xPHAR and returns PHAR minus the current slashing penalty. This read only quotes/static-simulates; use pharaoh_xphar_build_tx to build unsigned calldata."
  };
}

// === P33 ===

/** @summary Read P33 vault state: total value, user shares, APY, deposit/withdraw limits */

export async function p33Read(
  publicClient: PublicClient,
  input: {
    action: "summary" | "depositQuote" | "mintQuote" | "withdrawQuote" | "redeemQuote";
    account?: string;
    assets?: string | number;
    shares?: string | number;
    receiver?: string;
    owner?: string;
    simulate?: boolean;
    blockTag?: BlockTag;
  }
) {
  const account = input.account ? asAddress(input.account, "account") : undefined;
  const receiver = input.receiver ? asAddress(input.receiver, "receiver") : account;
  const owner = input.owner ? asAddress(input.owner, "owner") : account;
  const p33 = contractRegistry.p33.address;
  const xphar = contractRegistry.xPharToken.address;

  const [asset, xPhar, operator, period, isUnlocked, isCooldownActive, totalAssets, totalSupply] = await Promise.all([
    tryRead(publicClient, p33, contractAbis.p33 as Abi, "asset", [], input.blockTag),
    tryRead(publicClient, p33, contractAbis.p33 as Abi, "xPhar", [], input.blockTag),
    tryRead(publicClient, p33, contractAbis.p33 as Abi, "operator", [], input.blockTag),
    tryRead(publicClient, p33, contractAbis.p33 as Abi, "getPeriod", [], input.blockTag),
    tryRead(publicClient, p33, contractAbis.p33 as Abi, "isUnlocked", [], input.blockTag),
    tryRead(publicClient, p33, contractAbis.p33 as Abi, "isCooldownActive", [], input.blockTag),
    tryRead(publicClient, p33, contractAbis.p33 as Abi, "totalAssets", [], input.blockTag),
    tryRead(publicClient, p33, contractAbis.p33 as Abi, "totalSupply", [], input.blockTag)
  ]);
  const periodValue = readResultBigInt(period);
  const periodUnlockStatus = periodValue !== undefined
    ? await tryRead(publicClient, p33, contractAbis.p33 as Abi, "periodUnlockStatus", [periodValue], input.blockTag)
    : { ok: false, error: "p33.getPeriod() failed; cannot read periodUnlockStatus." };

  const accountState = account
    ? {
      assetBalance: await tryRead(publicClient, xphar, contractAbis.erc20Read as Abi, "balanceOf", [account], input.blockTag),
      assetAllowanceToP33: await tryRead(publicClient, xphar, contractAbis.erc20Read as Abi, "allowance", [account, p33], input.blockTag),
      p33Balance: await tryRead(publicClient, p33, contractAbis.p33 as Abi, "balanceOf", [account], input.blockTag),
      maxDeposit: await tryRead(publicClient, p33, contractAbis.p33 as Abi, "maxDeposit", [account], input.blockTag),
      maxMint: await tryRead(publicClient, p33, contractAbis.p33 as Abi, "maxMint", [account], input.blockTag),
      maxWithdraw: await tryRead(publicClient, p33, contractAbis.p33 as Abi, "maxWithdraw", [account], input.blockTag),
      maxRedeem: await tryRead(publicClient, p33, contractAbis.p33 as Abi, "maxRedeem", [account], input.blockTag)
    }
    : undefined;

  const base = {
    chainId: CHAIN_ID,
    action: input.action,
    blockTag: input.blockTag ?? "latest",
    p33,
    asset,
    xPhar,
    operator,
    period,
    isUnlocked,
    isCooldownActive,
    periodUnlockStatus,
    totalAssets,
    totalSupply,
    account,
    accountState
  };

  if (input.action === "summary") {
    return base;
  }

  if (!account || !receiver || !owner) {
    throw new Error("account is required for p33 quote actions unless receiver/owner are supplied.");
  }
  const assetBalance = accountState ? readResultBigInt(accountState.assetBalance) : undefined;
  const allowance = accountState ? readResultBigInt(accountState.assetAllowanceToP33) : undefined;
  const p33Balance = accountState ? readResultBigInt(accountState.p33Balance) : undefined;
  const lockOpen = isUnlocked.ok && isUnlocked.result === true && periodUnlockStatus.ok && periodUnlockStatus.result === true;
  const depositBlockers = (assets: bigint) => [
    ...(lockOpen ? [] : ["LOCKED: p33.isUnlocked() or periodUnlockStatus(getPeriod()) is false."]),
    ...(assetBalance !== undefined && assetBalance >= assets ? [] : ["insufficient xPHAR asset balance."]),
    ...(allowance !== undefined && allowance >= assets ? [] : ["insufficient xPHAR allowance to p33."])
  ];

  if (input.action === "depositQuote") {
    const assets = parseBigIntLike(input.assets, "assets");
    const [previewDeposit, convertToShares] = await Promise.all([
      tryRead(publicClient, p33, contractAbis.p33 as Abi, "previewDeposit", [assets], input.blockTag),
      tryRead(publicClient, p33, contractAbis.p33 as Abi, "convertToShares", [assets], input.blockTag)
    ]);
    const blockers = depositBlockers(assets);
    const simulation = input.simulate
      ? await tryRunContractFunction(publicClient, {
        contract: "p33",
        functionName: "deposit(uint256,address)",
        args: [assets, receiver],
        allowNonView: true,
        staticAccount: account,
        blockTag: input.blockTag
      })
      : undefined;
    const simulationOk = simulation ? simulation.ok : true;
    const approvalShortfall = allowance !== undefined && allowance < assets ? assets - allowance : 0n;
    const quoteBlockers = [
      ...blockers,
      ...(simulation && !simulation.ok ? [`simulation failed: ${compactError(String(simulation.error))}`] : [])
    ];
    const canSubmit = quoteBlockers.length === 0 && simulationOk;
    const depositBuildCall = p33ActionBuildCall("deposit", [assets, receiver], canSubmit, quoteBlockers);

    return {
      ...base,
      quote: {
        assets,
        receiver,
        previewDeposit,
        convertToShares,
        approvalRequired: approvalShortfall > 0n,
        approvalShortfall,
        canSubmit,
        blockers: quoteBlockers,
        buildCalls: canSubmit ? { approval: null, deposit: depositBuildCall } : null,
        buildCallsStatus: canSubmit ? "actionable" : "blocked_canSubmit_false",
        buildCallsSuppressedReason: canSubmit
          ? null
          : "p33 action and approval calldata are suppressed while quote.canSubmit=false; use blockers, approvalRequired, and approvalShortfall to identify required state changes."
      },
      simulation,
      warning: "p33 deposit uses xPHAR as the asset. maxDeposit/maxMint can be nonzero while the current protocol period is locked, so isUnlocked and periodUnlockStatus are treated as authoritative."
    };
  }

  if (input.action === "mintQuote") {
    const shares = parseBigIntLike(input.shares, "shares");
    const [previewMint, convertToAssets] = await Promise.all([
      tryRead(publicClient, p33, contractAbis.p33 as Abi, "previewMint", [shares], input.blockTag),
      tryRead(publicClient, p33, contractAbis.p33 as Abi, "convertToAssets", [shares], input.blockTag)
    ]);
    const assetsRequired = readResultBigInt(previewMint) ?? readResultBigInt(convertToAssets);
    const blockers = assetsRequired === undefined
      ? ["previewMint and convertToAssets failed; cannot derive xPHAR assets required."]
      : depositBlockers(assetsRequired);
    const simulation = input.simulate
      ? await tryRunContractFunction(publicClient, {
        contract: "p33",
        functionName: "mint(uint256,address)",
        args: [shares, receiver],
        allowNonView: true,
        staticAccount: account,
        blockTag: input.blockTag
      })
      : undefined;
    const approvalShortfall = assetsRequired !== undefined && allowance !== undefined && allowance < assetsRequired ? assetsRequired - allowance : 0n;
    const quoteBlockers = [
      ...blockers,
      ...(simulation && !simulation.ok ? [`simulation failed: ${compactError(String(simulation.error))}`] : [])
    ];
    const canSubmit = quoteBlockers.length === 0 && (simulation ? simulation.ok : true);
    const mintBuildCall = p33ActionBuildCall("mint", [shares, receiver], canSubmit, quoteBlockers);

    return {
      ...base,
      quote: {
        shares,
        receiver,
        previewMint,
        convertToAssets,
        assetsRequired,
        approvalRequired: approvalShortfall > 0n,
        approvalShortfall,
        canSubmit,
        blockers: quoteBlockers,
        buildCalls: canSubmit ? { approval: null, mint: mintBuildCall } : null,
        buildCallsStatus: canSubmit ? "actionable" : "blocked_canSubmit_false",
        buildCallsSuppressedReason: canSubmit
          ? null
          : "p33 action and approval calldata are suppressed while quote.canSubmit=false; use blockers, approvalRequired, and approvalShortfall to identify required state changes."
      },
      simulation,
      warning: "p33 mint uses xPHAR as the asset required by previewMint. isUnlocked and periodUnlockStatus are treated as authoritative before submission."
    };
  }

  if (input.action === "withdrawQuote") {
    const assets = parseBigIntLike(input.assets, "assets");
    const [previewWithdraw, convertToShares] = await Promise.all([
      tryRead(publicClient, p33, contractAbis.p33 as Abi, "previewWithdraw", [assets], input.blockTag),
      tryRead(publicClient, p33, contractAbis.p33 as Abi, "convertToShares", [assets], input.blockTag)
    ]);
    const maxWithdraw = accountState ? readResultBigInt(accountState.maxWithdraw) : undefined;
    const blockers = [
      ...(maxWithdraw !== undefined && maxWithdraw >= assets ? [] : ["requested assets exceed maxWithdraw for owner/account."])
    ];
    const simulation = input.simulate
      ? await tryRunContractFunction(publicClient, {
        contract: "p33",
        functionName: "withdraw(uint256,address,address)",
        args: [assets, receiver, owner],
        allowNonView: true,
        staticAccount: account,
        blockTag: input.blockTag
      })
      : undefined;
    const quoteBlockers = [
      ...blockers,
      ...(simulation && !simulation.ok ? [`simulation failed: ${compactError(String(simulation.error))}`] : [])
    ];
    const canSubmit = quoteBlockers.length === 0 && (simulation ? simulation.ok : true);
    const withdrawBuildCall = p33ActionBuildCall("withdraw", [assets, receiver, owner], canSubmit, quoteBlockers);

    return {
      ...base,
      quote: {
        assets,
        receiver,
        owner,
        previewWithdraw,
        convertToShares,
        canSubmit,
        blockers: quoteBlockers,
        buildCalls: canSubmit ? { withdraw: withdrawBuildCall } : null,
        buildCallsStatus: canSubmit ? "actionable" : "blocked_canSubmit_false",
        buildCallsSuppressedReason: canSubmit
          ? null
          : "p33 action calldata is suppressed while quote.canSubmit=false; use blockers to identify required state changes."
      },
      simulation,
      warning: "p33 withdraw burns p33 shares for xPHAR assets. This read quotes previewWithdraw/maxWithdraw and optional static simulation only."
    };
  }

  const shares = parseBigIntLike(input.shares, "shares");
  const [previewRedeem, convertToAssets] = await Promise.all([
    tryRead(publicClient, p33, contractAbis.p33 as Abi, "previewRedeem", [shares], input.blockTag),
    tryRead(publicClient, p33, contractAbis.p33 as Abi, "convertToAssets", [shares], input.blockTag)
  ]);
  const maxRedeem = accountState ? readResultBigInt(accountState.maxRedeem) : undefined;
  const blockers = [
    ...(p33Balance !== undefined && p33Balance >= shares ? [] : ["insufficient p33 share balance."]),
    ...(maxRedeem !== undefined && maxRedeem >= shares ? [] : ["requested shares exceed maxRedeem for owner/account."])
  ];
  const simulation = input.simulate
    ? await tryRunContractFunction(publicClient, {
      contract: "p33",
      functionName: "redeem(uint256,address,address)",
      args: [shares, receiver, owner],
      allowNonView: true,
      staticAccount: account,
      blockTag: input.blockTag
    })
    : undefined;
  const quoteBlockers = [
    ...blockers,
    ...(simulation && !simulation.ok ? [`simulation failed: ${compactError(String(simulation.error))}`] : [])
  ];
  const canSubmit = quoteBlockers.length === 0 && (simulation ? simulation.ok : true);
  const redeemBuildCall = p33ActionBuildCall("redeem", [shares, receiver, owner], canSubmit, quoteBlockers);

  return {
    ...base,
    quote: {
      shares,
      receiver,
      owner,
      previewRedeem,
      convertToAssets,
      canSubmit,
      blockers: quoteBlockers,
      buildCalls: canSubmit ? { redeem: redeemBuildCall } : null,
      buildCallsStatus: canSubmit ? "actionable" : "blocked_canSubmit_false",
      buildCallsSuppressedReason: canSubmit
        ? null
        : "p33 action calldata is suppressed while quote.canSubmit=false; use blockers to identify required state changes."
    },
    simulation,
    warning: "p33 redeem burns p33 shares for xPHAR assets. This read quotes previewRedeem/maxRedeem and optional static simulation only."
  };
}

function readResultTrue(read: { ok: boolean; result?: unknown }): boolean {
  return read.ok && read.result === true;
}

function readResultValue(read: { ok: boolean; result?: unknown }): unknown | null {
  return read.ok ? read.result ?? null : null;
}

function parseDlmmPreset(value: unknown) {
  const pick = (index: number, key: string) => Array.isArray(value)
    ? value[index]
    : typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;

  return {
    baseFactor: pick(0, "baseFactor"),
    filterPeriod: pick(1, "filterPeriod"),
    decayPeriod: pick(2, "decayPeriod"),
    reductionFactor: pick(3, "reductionFactor"),
    variableFeeControl: pick(4, "variableFeeControl"),
    protocolShare: pick(5, "protocolShare"),
    maxVolatilityAccumulator: pick(6, "maxVolatilityAccumulator"),
    isOpen: pick(7, "isOpen") === true
  };
}

// === PROTOCOL GATES ===

/** @summary Read protocol governance gates: paused status, fee tiers, oracle status, circuit breakers */

export async function protocolGatesRead(
  publicClient: PublicClient,
  input: {
    account?: string;
    p33ProbeAssets?: string | number;
    tokenA?: string;
    tokenB?: string;
    activeId?: string | number;
    blockTag?: BlockTag;
  } = {}
) {
  const account = input.account ? asAddress(input.account, "account") : undefined;
  const p33ProbeAssets = parseBigIntLike(input.p33ProbeAssets ?? "30000000000000000", "p33ProbeAssets");
  const tokenA = input.tokenA ? asAddress(input.tokenA, "tokenA") : contractRegistry.pharToken.address;
  const tokenB = input.tokenB ? asAddress(input.tokenB, "tokenB") : contractRegistry.xPharToken.address;
  const activeId = parseBigIntLike(input.activeId ?? 8_388_608, "activeId");
  const p33 = contractRegistry.p33.address;
  const xphar = contractRegistry.xPharToken.address;

  const p33Period = await tryRunContractFunction(publicClient, {
    contract: "p33",
    functionName: "getPeriod",
    blockTag: input.blockTag
  });
  const p33PeriodValue = readResultBigInt(p33Period) ?? 0n;

  const [
    p33Asset,
    p33XPhar,
    p33Operator,
    p33IsUnlocked,
    p33IsCooldownActive,
    p33PeriodUnlockStatus,
    p33MaxDeposit,
    p33MaxMint,
    p33PreviewDeposit,
    accountXpharBalance,
    accountXpharAllowanceToP33,
    allBinStepsRead,
    openBinStepsRead
  ] = await Promise.all([
    tryRunContractFunction(publicClient, { contract: "p33", functionName: "asset", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "p33", functionName: "xPhar", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "p33", functionName: "operator", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "p33", functionName: "isUnlocked", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "p33", functionName: "isCooldownActive", blockTag: input.blockTag }),
    p33Period.ok
      ? tryRunContractFunction(publicClient, { contract: "p33", functionName: "periodUnlockStatus", args: [p33PeriodValue], blockTag: input.blockTag })
      : Promise.resolve({ ok: false, error: "p33.getPeriod() failed; cannot read periodUnlockStatus." }),
    account
      ? tryRunContractFunction(publicClient, { contract: "p33", functionName: "maxDeposit", args: [account], blockTag: input.blockTag })
      : Promise.resolve(undefined),
    account
      ? tryRunContractFunction(publicClient, { contract: "p33", functionName: "maxMint", args: [account], blockTag: input.blockTag })
      : Promise.resolve(undefined),
    tryRunContractFunction(publicClient, { contract: "p33", functionName: "previewDeposit", args: [p33ProbeAssets], blockTag: input.blockTag }),
    account
      ? tryAsync(() => publicClient.readContract({ address: xphar, abi: contractAbis.erc20Read as Abi, functionName: "balanceOf", args: [account], blockTag: input.blockTag } as never))
      : Promise.resolve(undefined),
    account
      ? tryAsync(() => publicClient.readContract({ address: xphar, abi: contractAbis.erc20Read as Abi, functionName: "allowance", args: [account, p33], blockTag: input.blockTag } as never))
      : Promise.resolve(undefined),
    tryRunContractFunction(publicClient, { contract: "dlmmFactory", functionName: "getAllBinSteps", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "dlmmFactory", functionName: "getOpenBinSteps", blockTag: input.blockTag })
  ]);

  const p33Balance = accountXpharBalance ? readResultBigInt(accountXpharBalance) : undefined;
  const p33Allowance = accountXpharAllowanceToP33 ? readResultBigInt(accountXpharAllowanceToP33) : undefined;
  const p33HasProbeBalance = p33Balance !== undefined && p33Balance >= p33ProbeAssets;
  const p33HasProbeAllowance = p33Allowance !== undefined && p33Allowance >= p33ProbeAssets;
  const p33ProtocolOpen = readResultTrue(p33IsUnlocked) && readResultTrue(p33PeriodUnlockStatus);
  const p33ReadError = [
    p33Period,
    p33Asset,
    p33XPhar,
    p33Operator,
    p33IsUnlocked,
    p33IsCooldownActive,
    p33PeriodUnlockStatus,
    p33PreviewDeposit,
    ...(account ? [p33MaxDeposit, p33MaxMint, accountXpharBalance, accountXpharAllowanceToP33] : [])
  ].some((item) => !item?.ok);
  const p33GateStatus = p33ReadError
    ? "read_error"
    : !p33ProtocolOpen
      ? "blocked_protocol_locked"
      : !account
        ? "protocol_open_account_not_checked"
        : !p33HasProbeBalance
          ? "protocol_open_wallet_insufficient_balance"
          : !p33HasProbeAllowance
            ? "actionable_after_approval"
            : "actionable";
  const p33ProtocolBlockers = [
    ...(readResultValue(p33IsUnlocked) === false ? ["p33.isUnlocked() is false"] : []),
    ...(readResultValue(p33PeriodUnlockStatus) === false ? ["p33.periodUnlockStatus(getPeriod()) is false"] : []),
    ...(p33ReadError ? ["one or more p33 gate reads failed"] : [])
  ];
  const p33WalletBlockers = account
    ? [
      ...(!p33HasProbeBalance ? ["wallet xPHAR balance is below probe deposit amount"] : []),
      ...(!p33HasProbeAllowance ? ["wallet xPHAR allowance to p33 is below probe deposit amount"] : [])
    ]
    : ["account was not supplied; wallet balance and approval readiness were not checked"];
  const p33CurrentBlockers = p33ReadError || !p33ProtocolOpen
    ? p33ProtocolBlockers
    : p33WalletBlockers;
  const p33DeferredWalletBlockers = p33ProtocolOpen ? [] : p33WalletBlockers;
  const p33BuildHintsStatus = p33ReadError
    ? "read_error"
    : !p33ProtocolOpen
      ? "blocked_protocol_locked"
      : !account
        ? "account_not_checked"
        : !p33HasProbeBalance
          ? "blocked_wallet_insufficient_balance"
          : !p33HasProbeAllowance
            ? "actionable_after_approval"
            : "actionable";
  const p33BuildHintsSuppressedReason = p33BuildHintsStatus === "blocked_protocol_locked"
    ? "p33 protocol is locked; approval/deposit builder hints are suppressed until isUnlocked() and periodUnlockStatus(getPeriod()) are true."
    : p33BuildHintsStatus === "blocked_wallet_insufficient_balance"
      ? "wallet xPHAR balance is below the probe amount; deposit builder hints are suppressed until the wallet can fund the probe."
      : p33BuildHintsStatus === "account_not_checked"
        ? "account was not supplied; wallet-specific approval/deposit builder hints are suppressed."
        : p33BuildHintsStatus === "read_error"
          ? "one or more p33 gate reads failed; builder hints are suppressed until the gate can be read."
          : null;
  const p33BuildHints = p33ProtocolOpen && account && p33HasProbeBalance
    ? {
      approval: p33HasProbeAllowance ? null : { tool: "pharaoh_encode_approval", arguments: { standard: "erc20", tokenAddress: xphar, spender: p33, amount: p33ProbeAssets } },
      deposit: { tool: "pharaoh_p33_build_tx", arguments: { action: "deposit", args: [p33ProbeAssets, account] } },
      redeemAfterDeposit: {
        tool: "pharaoh_p33_build_tx",
        action: "redeem",
        requiredArgs: ["shares", "receiver", "owner"],
        fixedArgs: { receiver: account, owner: account }
      }
    }
    : null;

  const allBinSteps = readResultBigInts(allBinStepsRead);
  const openBinSteps = readResultBigInts(openBinStepsRead);
  const openBinStepKeys = new Set(openBinSteps.map((binStep) => binStep.toString()));
  const dlmmRows = await Promise.all(allBinSteps.map(async (binStep) => {
    const [pairInformationRead, presetRead] = await Promise.all([
      tryRunContractFunction(publicClient, {
        contract: "dlmmFactory",
        functionName: "getLBPairInformation",
        args: [tokenA, tokenB, binStep],
        blockTag: input.blockTag
      }),
      tryRunContractFunction(publicClient, {
        contract: "dlmmFactory",
        functionName: "getPreset",
        args: [binStep],
        blockTag: input.blockTag
      })
    ]);
    const pairInformation = parseDlmmPairInfo(pairInformationRead.ok ? pairInformationRead.result : undefined);
    const preset = presetRead.ok ? parseDlmmPreset(presetRead.result) : null;
    const pairExists = pairInformation.pair.toLowerCase() !== ZERO_ADDRESS;
    const isOpen = preset?.isOpen === true;

    return {
      binStep,
      pairInformationRead,
      presetRead,
      pairInformation,
      preset,
      isOpen,
      pairExists,
      openByGetOpenBinSteps: openBinStepKeys.has(binStep.toString()),
      normalUserCreateCandidate: isOpen && !pairExists
    };
  }));
  const dlmmOpenAbsentCandidates = dlmmRows.filter((row) => row.normalUserCreateCandidate);
  const dlmmReadError = !allBinStepsRead.ok || !openBinStepsRead.ok || dlmmRows.some((row) => !row.pairInformationRead.ok || !row.presetRead.ok);
  const dlmmGateStatus = dlmmReadError
    ? "read_error"
    : dlmmOpenAbsentCandidates.length > 0
      ? "open_candidate_available"
      : openBinSteps.length === 0
        ? "blocked_no_open_presets"
        : "blocked_no_absent_open_pair_for_test_tokens";
  const p33ActionAvailable = p33GateStatus === "actionable" || p33GateStatus === "actionable_after_approval";

  return {
    schemaVersion: 1,
    chainId: CHAIN_ID,
    blockTag: input.blockTag ?? "latest",
    account,
    overallStatus: p33ActionAvailable || dlmmGateStatus === "open_candidate_available" ? "open_action_available" : "blocked",
    gates: {
      p33LiveUnlock: {
        status: p33GateStatus,
        contract: "p33",
        address: p33,
        period: readResultValue(p33Period),
        asset: p33Asset,
        xPhar: p33XPhar,
        operator: p33Operator,
        isUnlocked: readResultValue(p33IsUnlocked),
        periodUnlockStatus: readResultValue(p33PeriodUnlockStatus),
        isCooldownActive: readResultValue(p33IsCooldownActive),
        maxDeposit: p33MaxDeposit ? readResultValue(p33MaxDeposit) : null,
        maxMint: p33MaxMint ? readResultValue(p33MaxMint) : null,
        previewDeposit: p33PreviewDeposit,
        protocolOpen: p33ProtocolOpen,
        walletReadyForProbe: account ? p33HasProbeBalance && p33HasProbeAllowance : null,
        walletCanApproveAndDepositProbe: account ? p33ProtocolOpen && p33HasProbeBalance : null,
        liveTxActionableForProbe: account ? p33ProtocolOpen && p33HasProbeBalance : null,
        protocolBlockers: p33ProtocolBlockers,
        walletBlockers: p33WalletBlockers,
        deferredWalletBlockers: p33DeferredWalletBlockers,
        blockers: p33CurrentBlockers,
        allBlockers: [...p33ProtocolBlockers, ...p33WalletBlockers],
        buildHintsStatus: p33BuildHintsStatus,
        buildHintsSuppressedReason: p33BuildHintsSuppressedReason,
        buildHints: p33BuildHints
      },
      dlmmNormalUserPoolCreation: {
        status: dlmmGateStatus,
        factory: contractRegistry.dlmmFactory.address,
        router: contractRegistry.dlmmRouter.address,
        tokenX: tokenA,
        tokenY: tokenB,
        activeId,
        allBinSteps,
        openBinSteps,
        openAbsentCandidate: dlmmOpenAbsentCandidates[0]
          ? {
            binStep: dlmmOpenAbsentCandidates[0].binStep,
            pair: dlmmOpenAbsentCandidates[0].pairInformation.pair,
            pairInformation: dlmmOpenAbsentCandidates[0].pairInformation,
            preset: dlmmOpenAbsentCandidates[0].preset
          }
          : null,
        binStepRows: dlmmRows.map((row) => ({
          binStep: row.binStep,
          pair: row.pairInformation.pair,
          pairExists: row.pairExists,
          presetIsOpen: row.isOpen,
          openByGetOpenBinSteps: row.openByGetOpenBinSteps
        })),
        builderHints: dlmmOpenAbsentCandidates[0]
          ? {
            router: {
              tool: "pharaoh_dlmm_build_tx",
              arguments: { action: "routerCreateLBPair", args: [tokenA, tokenB, activeId, dlmmOpenAbsentCandidates[0].binStep] }
            },
            factory: {
              tool: "pharaoh_dlmm_build_tx",
              arguments: { action: "factoryCreateLBPair", args: [tokenA, tokenB, activeId, dlmmOpenAbsentCandidates[0].binStep] }
            }
          }
          : null
      }
    },
    probes: {
      p33Assets: p33ProbeAssets,
      dlmmPairTokens: { tokenA, tokenB }
    },
    summary: {
      p33: {
        period: p33Period,
        protocolOpen: p33ProtocolOpen,
        walletReadyForProbe: account ? p33HasProbeBalance && p33HasProbeAllowance : null,
        walletCanApproveAndDepositProbe: account ? p33ProtocolOpen && p33HasProbeBalance : null,
        walletHasProbeBalance: account ? p33HasProbeBalance : null,
        walletHasProbeAllowance: account ? p33HasProbeAllowance : null,
        status: p33GateStatus
      },
      dlmmPoolCreation: {
        allBinSteps,
        openBinSteps,
        openAbsentCandidates: dlmmOpenAbsentCandidates.map((row) => ({
          binStep: row.binStep,
          pairInformation: row.pairInformation,
          preset: row.preset
        })),
        normalUserCreationStatus: dlmmGateStatus
      }
    },
    warning: "Readonly protocol-gates report only. It does not sign or broadcast. Use fork rehearsal before any live transaction when a gate opens."
  };
}

function p33ValidationReadiness(protocolGates: Record<string, any>) {
  const gate = protocolGates.gates?.p33LiveUnlock ?? {};
  const ready = Boolean(gate.liveTxActionableForProbe);

  return {
    ready,
    status: gate.status ?? "unknown",
    blockers: ready ? [] : gate.blockers ?? ["p33 live-deposit gate is not currently actionable"],
    evidence: {
      period: gate.period ?? null,
      protocolOpen: gate.protocolOpen ?? null,
      walletReadyForProbe: gate.walletReadyForProbe ?? null,
      walletCanApproveAndDepositProbe: gate.walletCanApproveAndDepositProbe ?? null,
      buildHintsStatus: gate.buildHintsStatus ?? null,
      buildHintsSuppressedReason: gate.buildHintsSuppressedReason ?? null,
      previewDeposit: gate.previewDeposit ?? null,
      buildHints: gate.buildHints ?? null
    },
    nextForkCommand: "PHAR_MCP_PHASES=phar_xphar_p33_roundtrip npm run --silent rehearse:fork:report",
    liveFollowup: "Only after fork pass and explicit operator approval: PHAR_MCP_LIVE_CONFIRM=<wallet> PHAR_MCP_PHASES=phar_xphar_p33_roundtrip npm run --silent validate:live:report"
  };
}

function dlmmPoolCreationValidationReadiness(protocolGates: Record<string, any>) {
  const gate = protocolGates.gates?.dlmmNormalUserPoolCreation ?? {};
  const ready = gate.status === "open_candidate_available";

  return {
    ready,
    status: gate.status ?? "unknown",
    blockers: ready ? [] : [
      gate.status === "blocked_no_open_presets"
        ? "DLMMFactory.getOpenBinSteps() returned no open presets."
        : `DLMM pool-creation gate is ${gate.status ?? "unknown"}.`
    ],
    evidence: {
      openBinSteps: gate.openBinSteps ?? [],
      openAbsentCandidate: gate.openAbsentCandidate ?? null,
      binStepRows: gate.binStepRows ?? [],
      builderHints: gate.builderHints ?? null
    },
    nextForkCommand: "npm run --silent rehearse:pool-creation:report",
    liveFollowup: "Only after fork pass and explicit operator approval: build and review a minimal createLBPair transaction with pharaoh_dlmm_build_tx."
  };
}

function rewardValidationReadiness(claimability: Record<string, any> | null) {
  if (!claimability) {
    return {
      ready: false,
      status: "account_not_supplied_or_claimability_disabled",
      blockers: ["account was not supplied or reward claimability was disabled"],
      walletRewards: {
        ready: false,
        status: "account_not_supplied_or_claimability_disabled",
        blockers: ["account was not supplied or reward claimability was disabled"],
        buildHints: {}
      },
      operatorIncentives: {
        ready: false,
        status: "account_not_supplied_or_claimability_disabled",
        blockers: ["account was not supplied or reward claimability was disabled"],
        buildHints: { autoVault: null, p33: null }
      },
      evidence: null,
      nextForkCommand: "npm run --silent rehearse:reward-claims:report",
      liveFollowup: "Supply account and inspect pharaoh_reward_claimability_read before any live claim."
    };
  }

  const autoVaultIncentives = claimability.domains?.autoVault?.incentives;
  const p33Incentives = claimability.domains?.p33;
  const operatorClaimable = Boolean(autoVaultIncentives?.claimable || p33Incentives?.claimable);
  const walletRewardsReady = claimability.claimable === true;
  const domainStatuses = Object.fromEntries(Object.entries(claimability.domains ?? {}).map(([domain, value]) => {
    const item = value as Record<string, any>;
    return [domain, Array.isArray(item)
      ? {
        entries: item.length,
        claimableEntries: item.filter((entry) => entry?.claimable === true).length,
        blockers: item.flatMap((entry) => entry?.blockers ?? [])
      }
      : {
        claimable: item.claimable ?? false,
        status: item.status ?? null,
        blockers: item.blockers ?? []
      }];
  }));

  return {
    ready: walletRewardsReady || operatorClaimable,
    status: walletRewardsReady || operatorClaimable ? "actionable" : "blocked",
    blockers: walletRewardsReady || operatorClaimable ? [] : [
      ...(claimability.blockers ?? []),
      ...(autoVaultIncentives?.blockers ?? []),
      ...(p33Incentives?.blockers ?? [])
    ],
    walletRewards: {
      ready: walletRewardsReady,
      status: walletRewardsReady ? "claimable" : "blocked_no_current_wallet_claims",
      blockers: walletRewardsReady ? [] : claimability.blockers ?? [],
      buildHints: Object.fromEntries(Object.entries(claimability.domains ?? {}).map(([domain, value]) => {
        const item = value as Record<string, any>;
        return [domain, Array.isArray(item)
          ? item.map((entry) => entry?.buildCall ?? null).filter(Boolean)
          : item.buildCall ?? null];
      }))
    },
    operatorIncentives: {
      ready: operatorClaimable,
      status: operatorClaimable ? "claimable" : "blocked_no_current_positive_earned_or_caller_not_authorized",
      blockers: [
        ...(autoVaultIncentives?.claimable ? [] : (autoVaultIncentives?.blockers ?? [])),
        ...(p33Incentives?.claimable ? [] : (p33Incentives?.blockers ?? []))
      ],
      buildHints: {
        autoVault: autoVaultIncentives?.buildCall ?? null,
        p33: p33Incentives?.buildCall ?? null
      }
    },
    evidence: {
      currentPeriod: claimability.currentPeriod ?? null,
      domains: domainStatuses
    },
    nextForkCommand: "npm run --silent rehearse:reward-claims:report",
    liveFollowup: "Only after claimability returns build hints, static/fork proof passes, and explicit operator approval: submit the relevant claim transaction."
  };
}

function validationRecommendedNextAction(readiness: Record<string, any>) {
  if (readiness.p33LiveDeposit.ready) return "run_p33_fork_rehearsal";
  if (readiness.dlmmPoolCreation.ready) return "run_dlmm_pool_creation_fork_rehearsal";
  if (readiness.rewardClaims.walletRewards?.ready) return "run_reward_claim_fork_rehearsal";
  if (readiness.rewardClaims.operatorIncentives?.ready) return "run_operator_claim_fork_rehearsal";
  return "wait_refresh_gates";
}

function readOptionalJsonReport(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

function compactBlocker(blocker: Record<string, any>) {
  return {
    key: blocker.key ?? null,
    category: blocker.category ?? null,
    status: blocker.status ?? null,
    completionBlocking: blocker.completionBlocking ?? true,
    blockers: blocker.blockers ?? []
  };
}

function acceptanceCoverageStatus() {
  try {
    const report = readOptionalJsonReport(ACCEPTANCE_AUDIT_REPORT);
    if (!report) {
      return {
        available: false,
        source: ACCEPTANCE_AUDIT_REPORT,
        reason: "acceptance audit report not found"
      };
    }

    const currentState = report.finalOutput?.continuationJsonPrompt?.current_state ?? report.finalOutput?.currentState ?? {};
    const caveatCriterion = (report.acceptanceCriteria ?? [])
      .find((item: Record<string, any>) => item?.criterion === "Incomplete or caveated components are either resolved or documented with precise blockers.");
    const evidence = caveatCriterion?.evidence ?? [];
    const structuredCoverageContext = report.coverageContext ?? report.finalOutput?.coverageContext ?? null;
    const p33Complete = typeof structuredCoverageContext?.p33Complete === "boolean"
      ? structuredCoverageContext.p33Complete
      : evidence.includes("p33Complete=true");

    return {
      available: true,
      source: ACCEPTANCE_AUDIT_REPORT,
      timestamp: report.timestamp ?? null,
      overallStatus: report.overallStatus ?? null,
      goalComplete: report.goalComplete === true,
      reportFreshness: report.reportFreshness ?? null,
      recommendedNextAction: currentState.recommendedNextAction ?? null,
      currentStateRecommendedNextAction: currentState.currentStateRecommendedNextAction ?? null,
      p33Complete,
      coverageContext: structuredCoverageContext
        ? {
          ...structuredCoverageContext,
          incompleteComponentsStatus: caveatCriterion
            ? {
              status: caveatCriterion.status ?? null,
              completionLevel: caveatCriterion.completionLevel ?? null,
              evidence
            }
            : null
        }
        : null,
      incompleteComponentsStatus: caveatCriterion
        ? {
          status: caveatCriterion.status ?? null,
          completionLevel: caveatCriterion.completionLevel ?? null,
          evidence
        }
        : null,
      remainingBlockers: (report.remainingBlockers ?? []).map(compactBlocker),
      warning: "Coverage-aware status is sourced from the latest local acceptance audit report. Refresh reports before using it for live decisions."
    };
  } catch (error) {
    return {
      available: false,
      source: ACCEPTANCE_AUDIT_REPORT,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

// === ACCEPTANCE STATUS ===

/** @summary Read current acceptance audit status from reports */

export function acceptanceStatusRead(input: {
  includeContinuationPrompt?: boolean;
  includeCompletionBlockers?: boolean;
  includeFinalOutputSummary?: boolean;
} = {}) {
  const report = readOptionalJsonReport(ACCEPTANCE_AUDIT_REPORT);
  if (!report) {
    return {
      schemaVersion: 1,
      source: ACCEPTANCE_AUDIT_REPORT,
      available: false,
      reason: "acceptance audit report not found",
      warning: "Run npm run reports:acceptance-audit before using this MCP tool for continuation planning."
    };
  }

  const coverageStatus = acceptanceCoverageStatus();
  const currentState = report.finalOutput?.continuationJsonPrompt?.current_state ?? report.finalOutput?.currentState ?? {};
  const includeContinuationPrompt = input.includeContinuationPrompt === true;
  const includeCompletionBlockers = input.includeCompletionBlockers !== false;
  const includeFinalOutputSummary = input.includeFinalOutputSummary === true;
  const finalOutput = report.finalOutput ?? {};
  return {
    schemaVersion: 1,
    source: ACCEPTANCE_AUDIT_REPORT,
    available: true,
    safety: {
      readOnly: true,
      privateKeyRead: false,
      liveBroadcastAllowed: false
    },
    timestamp: report.timestamp ?? null,
    ok: report.ok === true,
    goalComplete: report.goalComplete === true,
    overallStatus: report.overallStatus ?? null,
    reportFreshness: report.reportFreshness ?? null,
    recommendedNextAction: currentState.recommendedNextAction ?? coverageStatus.recommendedNextAction ?? null,
    currentStateRecommendedNextAction: currentState.currentStateRecommendedNextAction ?? coverageStatus.currentStateRecommendedNextAction ?? null,
    coverageContext: coverageStatus.coverageContext ?? {
      p33Complete: coverageStatus.p33Complete === true,
      incompleteComponentsStatus: coverageStatus.incompleteComponentsStatus ?? null
    },
    remainingBlockers: (report.remainingBlockers ?? []).map(compactBlocker),
    completionBlockingItems: includeCompletionBlockers
      ? (report.completionBlockingItems ?? []).map(compactBlocker)
      : undefined,
	    finalOutputSummary: includeFinalOutputSummary
	      ? {
	        readinessStatement: finalOutput.readinessStatement ?? null,
	        coverageSummaryByDomain: finalOutput.coverageSummaryByDomain ?? null,
	        userFlowCoverageMatrix: finalOutput.userFlowCoverageMatrix ?? finalOutput.coverageSummaryByDomain?.userFlows ?? null,
	        resolvedVsRemainingIncompleteComponents: finalOutput.resolvedVsRemainingIncompleteComponents ?? null,
	        liveTransactionHashes: finalOutput.liveTransactionHashes ?? [],
        forkSimulationSummary: finalOutput.forkSimulationSummary ?? null,
        verificationCommandsAndResults: finalOutput.verificationCommandsAndResults ?? [],
        verificationCommands: finalOutput.verificationCommands ?? report.verificationCommands ?? finalOutput.continuationJsonPrompt?.verification_commands ?? [],
        filesChanged: finalOutput.filesChanged ?? null,
        currentWalletBalancesAndApprovals: finalOutput.currentWalletBalancesAndApprovals ?? null,
        fundingTopUpRequest: finalOutput.fundingTopUpRequest ?? report.finalOutput?.continuationJsonPrompt?.fundingTopUpRequest ?? null,
        verificationWarnings: finalOutput.verificationWarnings ?? []
      }
      : undefined,
    continuationPrompt: includeContinuationPrompt
      ? report.finalOutput?.continuationJsonPrompt ?? null
      : undefined,
    refreshCommands: {
      acceptance: "npm run --silent reports:acceptance-audit",
      integrity: "npm run --silent reports:integrity",
      validationReadiness: "npm run --silent state:validation-readiness:report",
      protocolGates: "npm run --silent state:protocol-gates:report",
      claimability: "npm run --silent state:claimability:report",
      operatorIncentives: "npm run --silent state:operator-incentives:report",
      wallet: "npm run --silent state:wallet:report"
    },
    warning: "Coverage-aware continuation status is sourced from the latest local acceptance audit report. Refresh reports before live decisions."
  };
}

// === VALIDATION READINESS ===

/** @summary Check if protocol is ready for validation (gates, oracles, liquidity thresholds) */

export async function validationReadinessRead(
  publicClient: PublicClient,
  input: {
    account?: string;
    caller?: string;
    includeWalletPositions?: boolean;
    includeRewardClaimability?: boolean;
    p33ProbeAssets?: string | number;
    tokenA?: string;
    tokenB?: string;
    activeId?: string | number;
    rewardDomains?: Array<"autoVault" | "legacyGauge" | "clGauge" | "feeDistributor" | "dlmmRewarder" | "p33">;
    legacyGauges?: string[];
    clPools?: Array<{ pool?: string; gauge?: string; tokenIds?: Array<string | number>; maxTokenIds?: number }>;
    feeDistributors?: Array<{ address?: string; period?: string | number }>;
    dlmmPairs?: Array<{ pair?: string; rewarder?: string; ids?: Array<string | number>; scanRewardedRange?: boolean; maxIds?: number }>;
    autoVaultFeeDistributors?: Array<{ address: string; period?: string | number }>;
    autoVaultVotePeriodsBack?: number;
    autoVaultIncludeNextPeriod?: boolean;
    p33FeeDistributors?: Array<{ address: string; period?: string | number }>;
    p33VotePeriodsBack?: number;
    p33IncludeNextPeriod?: boolean;
    includeZero?: boolean;
    maxClTokenIds?: number;
    walletDlmmPools?: Array<{
      pair?: string;
      ids?: Array<string | number>;
      scanRewardedRange?: boolean;
      maxIds?: number;
      operator?: string;
    }>;
    blockTag?: BlockTag;
  } = {}
) {
  const account = input.account ? asAddress(input.account, "account") : undefined;
  const includeRewardClaimability = input.includeRewardClaimability !== false && Boolean(account);
  const includeWalletPositions = input.includeWalletPositions !== false && Boolean(account);

  const [protocolGates, walletPositions, rewardClaimability] = await Promise.all([
    protocolGatesRead(publicClient, {
      account,
      p33ProbeAssets: input.p33ProbeAssets,
      tokenA: input.tokenA,
      tokenB: input.tokenB,
      activeId: input.activeId,
      blockTag: input.blockTag
    }),
    includeWalletPositions
      ? tryAsync(() => walletPositionsRead(publicClient, {
        account: account!,
        includeAllowances: true,
        includeProtocol: true,
        includeRewards: false,
        maxClTokenIds: input.maxClTokenIds,
        dlmmPools: input.walletDlmmPools,
        blockTag: input.blockTag
      }))
      : Promise.resolve(null),
    includeRewardClaimability
      ? tryAsync(() => rewardClaimabilityRead(publicClient, {
        account: account!,
        caller: input.caller,
        domains: input.rewardDomains,
        legacyGauges: input.legacyGauges,
        clPools: input.clPools,
        feeDistributors: input.feeDistributors,
        dlmmPairs: input.dlmmPairs,
        autoVaultFeeDistributors: input.autoVaultFeeDistributors,
        autoVaultVotePeriodsBack: input.autoVaultVotePeriodsBack,
        autoVaultIncludeNextPeriod: input.autoVaultIncludeNextPeriod,
        p33FeeDistributors: input.p33FeeDistributors,
        p33VotePeriodsBack: input.p33VotePeriodsBack,
        p33IncludeNextPeriod: input.p33IncludeNextPeriod,
        includeZero: input.includeZero,
        blockTag: input.blockTag
      }))
      : Promise.resolve(null)
  ]);
  const claimabilityResult = rewardClaimability?.ok === true ? rewardClaimability.result as Record<string, any> : null;
  const readiness = {
    p33LiveDeposit: p33ValidationReadiness(protocolGates),
    dlmmPoolCreation: dlmmPoolCreationValidationReadiness(protocolGates),
    rewardClaims: rewardValidationReadiness(claimabilityResult)
  };

  return {
    schemaVersion: 1,
    chainId: CHAIN_ID,
    blockTag: input.blockTag ?? "latest",
    account: account ?? null,
    caller: input.caller ? asAddress(input.caller, "caller") : null,
    safety: {
      readOnly: true,
      privateKeyRead: false,
      liveBroadcastAllowed: false
    },
    inputs: {
      p33ProbeAssets: input.p33ProbeAssets ?? "30000000000000000",
      rewardClaimabilityIncluded: includeRewardClaimability,
      walletPositionsIncluded: includeWalletPositions
    },
    protocolGates,
    walletPositions,
    rewardClaimability,
    readiness,
    recommendedNextAction: validationRecommendedNextAction(readiness),
    refreshCommands: {
      mcp: "call pharaoh_validation_readiness_read with the same account/caller inputs",
      report: "npm run --silent state:validation-readiness:report",
      protocolGates: "npm run --silent state:protocol-gates:report",
      claimability: "npm run --silent state:claimability:report",
      operatorIncentives: "npm run --silent state:operator-incentives:report"
    },
    warning: "Readonly validation-readiness report only. This MCP tool never signs or broadcasts and should be refreshed before any fork or live transaction."
  };
}

// === AUTO VAULT ===

/** @summary Read auto-compounding vault state: TVL, shares, performance fee, harvest status */

export async function autoVaultRead(
  publicClient: PublicClient,
  input: {
    action: "summary" | "depositQuote" | "withdrawQuote" | "claimQuote";
    account?: string;
    amount?: string | number;
    outputToken?: string;
    simulate?: boolean;
    pendingSwapsStart?: string | number;
    pendingSwapsMax?: string | number;
    blockTag?: BlockTag;
  }
) {
  const account = input.account ? asAddress(input.account, "account") : undefined;
  const autoVault = contractRegistry.autoVault.address;
  const xphar = contractRegistry.xPharToken.address;
  const minimumDeposit = 1_000_000_000_000_000_000n;
  const [accessHub, operator, voter, voteModule, xram, isUnlocked, outputTokens, aggregators, claimedInputTokens, period, pendingSwapCount, totalSupply, pendingSwaps] = await Promise.all([
    tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "ACCESS_HUB", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "OPERATOR", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "VOTER", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "VOTE_MODULE", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "XRAM", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "isUnlocked", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "getOutputTokens", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "getAggregators", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "getClaimedInputTokens", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "getPeriod", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "pendingSwapCount", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "totalSupply", blockTag: input.blockTag }),
    input.pendingSwapsMax !== undefined
      ? tryRunContractFunction(publicClient, {
        contract: "autoVault",
        functionName: "getPendingSwapsPaginated",
        args: [
          parseBigIntLike(input.pendingSwapsStart ?? 0, "pendingSwapsStart"),
          parseBigIntLike(input.pendingSwapsMax, "pendingSwapsMax")
        ],
        blockTag: input.blockTag
      })
      : tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "getPendingSwaps", blockTag: input.blockTag })
  ]);
  const outputTokenAddresses = readResultAddresses(outputTokens);
  const accountState = account
    ? {
      xpharBalance: await tryRead(publicClient, xphar, contractAbis.erc20Read as Abi, "balanceOf", [account], input.blockTag),
      xpharAllowanceToAutoVault: await tryRead(publicClient, xphar, contractAbis.erc20Read as Abi, "allowance", [account, autoVault], input.blockTag),
      sharesBalance: await tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "balanceOf", args: [account], blockTag: input.blockTag }),
      earned: await tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "earned", args: [account], blockTag: input.blockTag }),
      storedRewards: await tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "getStoredRewards", args: [account], blockTag: input.blockTag }),
      outputPreference: await tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "outputPreference", args: [account], blockTag: input.blockTag })
    }
    : undefined;
  const base = {
    chainId: CHAIN_ID,
    action: input.action,
    blockTag: input.blockTag ?? "latest",
    autoVault,
    asset: xphar,
    provenanceStatus: contractRegistry.autoVault.status,
    minimumDeposit,
    accessHub,
    operator,
    voter,
    voteModule,
    xram,
    isUnlocked,
    outputTokens,
    aggregators,
    claimedInputTokens,
    period,
    pendingSwapCount,
    pendingSwaps,
    totalSupply,
    account,
    accountState,
    caveat: "AutoVault is source_backed_abi_candidate: public explorer ABIs are unavailable for the proxy/implementation, but integrated selectors are bytecode-backed and fork/live-tested."
  };

  if (input.action === "summary") {
    return base;
  }
  if (!account || !accountState) {
    throw new Error("account is required for AutoVault quote actions.");
  }

  if (input.action === "depositQuote") {
    const amount = parseBigIntLike(input.amount, "amount");
    const selectedOutputToken = input.outputToken
      ? asAddress(input.outputToken, "outputToken")
      : outputTokenAddresses[0];
    if (!selectedOutputToken) {
      throw new Error("AutoVault output token could not be selected; pass outputToken explicitly.");
    }
    const xpharBalance = readResultBigInt(accountState.xpharBalance);
    const allowance = readResultBigInt(accountState.xpharAllowanceToAutoVault);
    const approvalShortfall = allowance !== undefined && allowance < amount ? amount - allowance : 0n;
    const outputTokenSupported = outputTokenAddresses.some((token) => token.toLowerCase() === selectedOutputToken.toLowerCase());
    const unlocked = isUnlocked.ok && isUnlocked.result === true;
    const simulation = input.simulate
      ? await tryRunContractFunction(publicClient, {
        contract: "autoVault",
        functionName: "deposit",
        args: [amount, selectedOutputToken],
        allowNonView: true,
        staticAccount: account,
        blockTag: input.blockTag
      })
      : undefined;
    const blockers = [
      ...(unlocked ? [] : ["AutoVault isUnlocked() is false"]),
      ...(amount >= minimumDeposit ? [] : ["amount is below the fork-proven 1 xPHAR minimum deposit"]),
      ...(outputTokenSupported ? [] : ["outputToken is not currently listed by getOutputTokens()"]),
      ...(xpharBalance !== undefined && xpharBalance >= amount ? [] : ["insufficient xPHAR balance"]),
      ...(allowance !== undefined && allowance >= amount ? [] : ["insufficient xPHAR allowance to AutoVault"]),
      ...(simulation && !simulation.ok ? [`simulation failed: ${compactError(String(simulation.error))}`] : [])
    ];
    const canSubmit = blockers.length === 0;
    const depositBuildCalls = {
      approval: approvalShortfall > 0n
        ? { tool: "pharaoh_encode_approval", arguments: { standard: "erc20", tokenAddress: xphar, spender: autoVault, amount: approvalShortfall } }
        : null,
      deposit: { tool: "pharaoh_autovault_build_tx", arguments: { action: "deposit", args: [amount, selectedOutputToken] } }
    };

    return {
      ...base,
      quote: {
        amount,
        outputToken: selectedOutputToken,
        outputTokenSupported,
        approvalRequired: approvalShortfall > 0n,
        approvalShortfall,
        canSubmit,
        blockers,
        buildCalls: canSubmit ? depositBuildCalls : null,
        buildCallsStatus: canSubmit ? "actionable" : "blocked_canSubmit_false",
        buildCallsSuppressedReason: canSubmit ? null : blockedBuildSuppressionReason("AutoVault deposit", true)
      },
      simulation
    };
  }

  if (input.action === "withdrawQuote") {
    const amount = parseBigIntLike(input.amount, "amount");
    const sharesBalance = readResultBigInt(accountState.sharesBalance);
    const simulation = input.simulate
      ? await tryRunContractFunction(publicClient, {
        contract: "autoVault",
        functionName: "withdraw",
        args: [amount],
        allowNonView: true,
        staticAccount: account,
        blockTag: input.blockTag
      })
      : undefined;
    const blockers = [
      ...(sharesBalance !== undefined && sharesBalance >= amount ? [] : ["insufficient AutoVault share balance"]),
      ...(simulation && !simulation.ok ? [`simulation failed: ${compactError(String(simulation.error))}`] : [])
    ];
    const canSubmit = blockers.length === 0;
    const withdrawBuildCall = { tool: "pharaoh_autovault_build_tx", arguments: { action: "withdraw", args: [amount] } };

    return {
      ...base,
      quote: {
        amount,
        canSubmit,
        blockers,
        buildCall: canSubmit ? withdrawBuildCall : null,
        buildCallStatus: canSubmit ? "actionable" : "blocked_canSubmit_false",
        buildCallSuppressedReason: canSubmit ? null : blockedBuildSuppressionReason("AutoVault withdraw")
      },
      simulation
    };
  }

  const earned = accountState.earned;
  const storedRewards = accountState.storedRewards;
  const claimable = hasPositiveRead(earned) || hasPositiveRead(storedRewards);
  const simulation = input.simulate
    ? await tryRunContractFunction(publicClient, {
      contract: "autoVault",
      functionName: "claim",
      args: [],
      allowNonView: true,
      staticAccount: account,
      blockTag: input.blockTag
    })
    : undefined;
  const blockers = [
    ...(claimable ? [] : ["no positive AutoVault earned or stored rewards"]),
    ...(simulation && !simulation.ok ? [`simulation failed: ${compactError(String(simulation.error))}`] : [])
  ];
  const canSubmit = blockers.length === 0;
  const claimBuildCall = { tool: "pharaoh_autovault_build_tx", arguments: { action: "claim", args: [] } };

  return {
    ...base,
    quote: {
      claimable,
      canSubmit,
      blockers,
      buildCall: canSubmit ? claimBuildCall : null,
      buildCallStatus: canSubmit ? "actionable" : "blocked_canSubmit_false",
      buildCallSuppressedReason: canSubmit ? null : blockedBuildSuppressionReason("AutoVault claim")
    },
    simulation
  };
}

// === LEGACY QUOTES ===

/** @summary Get swap quote from legacy (constant product) pools */

export async function legacyQuote(
  publicClient: PublicClient,
  input: {
    action: "getAmountsOut" | "getAmountsIn" | "getAmountOut" | "quoteAddLiquidity" | "quoteRemoveLiquidity" | "getReserves" | "pairFor";
    amountIn?: string | number;
    amountOut?: string | number;
    routes?: unknown[];
    tokenIn?: string;
    tokenOut?: string;
    tokenA?: string;
    tokenB?: string;
    stable?: boolean;
    amountADesired?: string | number;
    amountBDesired?: string | number;
    liquidity?: string | number;
    blockTag?: BlockTag;
  }
) {
  const routeArgs = () => input.routes ?? [];
  const tokenA = () => asAddress(input.tokenA, "tokenA");
  const tokenB = () => asAddress(input.tokenB, "tokenB");
  const stable = () => {
    if (typeof input.stable !== "boolean") throw new Error("stable is required for this legacy quote action.");
    return input.stable;
  };

  const argsByAction = (): unknown[] => {
    switch (input.action) {
      case "getAmountsOut":
        return [parseBigIntLike(input.amountIn, "amountIn"), routeArgs()];
      case "getAmountsIn":
        return [parseBigIntLike(input.amountOut, "amountOut"), routeArgs()];
      case "getAmountOut":
        return [parseBigIntLike(input.amountIn, "amountIn"), asAddress(input.tokenIn, "tokenIn"), asAddress(input.tokenOut, "tokenOut")];
      case "quoteAddLiquidity":
        return [tokenA(), tokenB(), stable(), parseBigIntLike(input.amountADesired, "amountADesired"), parseBigIntLike(input.amountBDesired, "amountBDesired")];
      case "quoteRemoveLiquidity":
        return [tokenA(), tokenB(), stable(), parseBigIntLike(input.liquidity, "liquidity")];
      case "getReserves":
        return [tokenA(), tokenB(), stable()];
      case "pairFor":
        return [tokenA(), tokenB(), stable()];
    }
  };

  return runContractFunction(publicClient, {
    contract: "router",
    functionName: input.action,
    args: argsByAction(),
    blockTag: input.blockTag
  });
}

async function clV3QuotePreflight(
  publicClient: PublicClient,
  input: { tokenIn: Address; tokenOut: Address; tickSpacing: bigint },
  blockTag?: BlockTag
) {
  const poolRead = await tryRunContractFunction(publicClient, {
    contract: "ramsesV3Factory",
    functionName: "getPool",
    args: [input.tokenIn, input.tokenOut, input.tickSpacing],
    blockTag
  });
  const pool = readResultAddress(poolRead) ?? ZERO_ADDRESS;
  const poolExists = pool !== ZERO_ADDRESS;
  const [isPairV3, slot0, liquidity] = poolExists
    ? await Promise.all([
      tryRunContractFunction(publicClient, { contract: "ramsesV3Factory", functionName: "isPairV3", args: [pool], blockTag }),
      tryRunContractFunction(publicClient, { contract: "ramsesV3Pool", functionName: "slot0", addressOverride: pool, blockTag }),
      tryRunContractFunction(publicClient, { contract: "ramsesV3Pool", functionName: "liquidity", addressOverride: pool, blockTag })
    ])
    : [
      { ok: false, error: "Pool does not exist for token pair and tick spacing." },
      { ok: false, error: "Pool does not exist for token pair and tick spacing." },
      { ok: false, error: "Pool does not exist for token pair and tick spacing." }
    ];
  const liquidityValue = readResultBigInt(liquidity);
  const sqrtPriceX96 = (() => {
    const result = slot0.ok ? slot0.result : undefined;
    if (Array.isArray(result)) return typeof result[0] === "bigint" ? result[0] : BigInt(String(result[0]));
    if (typeof result === "object" && result !== null && "sqrtPriceX96" in result) {
      const value = (result as { sqrtPriceX96?: unknown }).sqrtPriceX96;
      return typeof value === "bigint" ? value : value === undefined ? undefined : BigInt(String(value));
    }
    return undefined;
  })();
  const blockers = [
    ...(poolRead.ok ? [] : [{ code: "pool_read_failed", severity: "error", message: "RamsesV3Factory.getPool read failed for tokenIn/tokenOut/tickSpacing." }]),
    ...(poolRead.ok && !poolExists ? [{ code: "pool_not_found", severity: "error", message: "RamsesV3Factory.getPool returned the zero address for tokenIn/tokenOut/tickSpacing." }] : []),
    ...(isPairV3.ok && isPairV3.result === false ? [{ code: "pool_not_registered", severity: "error", message: "Factory getPool returned an address that is not registered as a V3 pair." }] : []),
    ...(poolExists && !slot0.ok ? [{ code: "pool_read_failed", severity: "error", message: "Pool slot0 read failed; quote was not attempted because initialized price state could not be inspected." }] : []),
    ...(poolExists && sqrtPriceX96 === 0n ? [{ code: "pool_uninitialized", severity: "error", message: "Pool slot0 sqrtPriceX96 is zero; the pool is not initialized for quoting." }] : []),
    ...(poolExists && !liquidity.ok ? [{ code: "pool_read_failed", severity: "error", message: "Pool liquidity read failed; quote was not attempted because liquidity state could not be inspected." }] : []),
    ...(poolExists && liquidityValue !== undefined && liquidityValue === 0n ? [{ code: "pool_no_liquidity", severity: "error", message: "Pool exists but current pool liquidity is zero; single-hop quote is expected to revert or return no route." }] : [])
  ];

  return {
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    tickSpacing: input.tickSpacing,
    poolRead,
    pool,
    poolExists,
    isPairV3,
    slot0,
    sqrtPriceX96,
    liquidity,
    blockers
  };
}

// === CL QUOTES ===

/** @summary Get swap quote from concentrated liquidity (CL) pools */

export async function clQuote(
  publicClient: PublicClient,
  input: {
    quoter?: "quoterV2" | "quoter" | "mixedRouteQuoterV1";
    action: string;
    args?: unknown[];
    path?: string;
    tokenIn?: string;
    tokenOut?: string;
    amountIn?: string | number;
    amountOut?: string | number;
    tickSpacing?: string | number;
    sqrtPriceLimitX96?: string | number;
    stable?: boolean;
    preflight?: boolean;
    staticAccount?: string;
    blockTag?: BlockTag;
  }
) {
  const quoter = input.quoter ?? "quoterV2";
  const sqrtPriceLimitX96 = parseBigIntLike(input.sqrtPriceLimitX96 ?? 0, "sqrtPriceLimitX96");
  let args = input.args;
  let functionName = input.action;
  let v3PreflightInput: { tokenIn: Address; tokenOut: Address; tickSpacing: bigint } | undefined;
  const setV3PreflightInput = (tokenIn: Address, tokenOut: Address, tickSpacing: bigint) => {
    v3PreflightInput = { tokenIn, tokenOut, tickSpacing };
  };

  if (!args) {
    if (input.action === "quoteExactInput" || input.action === "quoteExactOutput") {
      args = [
        input.path,
        parseBigIntLike(input.action === "quoteExactInput" ? input.amountIn : input.amountOut, input.action === "quoteExactInput" ? "amountIn" : "amountOut")
      ];
    } else if (input.action === "quoteExactInputSingle" && quoter === "quoterV2") {
      const tokenIn = asAddress(input.tokenIn, "tokenIn");
      const tokenOut = asAddress(input.tokenOut, "tokenOut");
      const tickSpacing = parseBigIntLike(input.tickSpacing, "tickSpacing");
      args = [{
        tokenIn,
        tokenOut,
        amountIn: parseBigIntLike(input.amountIn, "amountIn"),
        tickSpacing,
        sqrtPriceLimitX96
      }];
      setV3PreflightInput(tokenIn, tokenOut, tickSpacing);
    } else if (input.action === "quoteExactOutputSingle" && quoter === "quoterV2") {
      const tokenIn = asAddress(input.tokenIn, "tokenIn");
      const tokenOut = asAddress(input.tokenOut, "tokenOut");
      const tickSpacing = parseBigIntLike(input.tickSpacing, "tickSpacing");
      args = [{
        tokenIn,
        tokenOut,
        amount: parseBigIntLike(input.amountOut ?? input.amountIn, "amount"),
        tickSpacing,
        sqrtPriceLimitX96
      }];
      setV3PreflightInput(tokenIn, tokenOut, tickSpacing);
    } else if ((input.action === "quoteExactInputSingle" || input.action === "quoteExactOutputSingle") && quoter === "quoter") {
      const tokenIn = asAddress(input.tokenIn, "tokenIn");
      const tokenOut = asAddress(input.tokenOut, "tokenOut");
      const tickSpacing = parseBigIntLike(input.tickSpacing, "tickSpacing");
      args = [
        tokenIn,
        tokenOut,
        tickSpacing,
        parseBigIntLike(input.action === "quoteExactInputSingle" ? input.amountIn : input.amountOut, input.action === "quoteExactInputSingle" ? "amountIn" : "amountOut"),
        sqrtPriceLimitX96
      ];
      setV3PreflightInput(tokenIn, tokenOut, tickSpacing);
    } else if (input.action === "quoteExactInputSingleV2" && quoter === "mixedRouteQuoterV1") {
      if (typeof input.stable !== "boolean") throw new Error("stable is required for mixedRouteQuoterV1 quoteExactInputSingleV2.");
      args = [{
        tokenIn: asAddress(input.tokenIn, "tokenIn"),
        tokenOut: asAddress(input.tokenOut, "tokenOut"),
        amountIn: parseBigIntLike(input.amountIn, "amountIn"),
        stable: input.stable
      }];
    } else if (input.action === "quoteExactInputSingleV3" && quoter === "mixedRouteQuoterV1") {
      const tokenIn = asAddress(input.tokenIn, "tokenIn");
      const tokenOut = asAddress(input.tokenOut, "tokenOut");
      const tickSpacing = parseBigIntLike(input.tickSpacing, "tickSpacing");
      args = [{
        tokenIn,
        tokenOut,
        amountIn: parseBigIntLike(input.amountIn, "amountIn"),
        tickSpacing,
        sqrtPriceLimitX96
      }];
      setV3PreflightInput(tokenIn, tokenOut, tickSpacing);
    } else {
      throw new Error("args is required for this CL quote action.");
    }
  }

  if (quoter === "quoterV2" && input.action === "quoteExactInputSingle") {
    functionName = "quoteExactInputSingle((address,address,uint256,int24,uint160))";
  } else if (quoter === "quoterV2" && input.action === "quoteExactOutputSingle") {
    functionName = "quoteExactOutputSingle((address,address,uint256,int24,uint160))";
  }

  const preflight = input.preflight === false || !v3PreflightInput
    ? undefined
    : await clV3QuotePreflight(publicClient, v3PreflightInput, input.blockTag);
  const hardBlockers = preflight?.blockers.filter((blocker) => blocker.severity === "error") ?? [];
  if (hardBlockers.length > 0) {
    return {
      chainId: CHAIN_ID,
      ok: false,
      quoter,
      action: input.action,
      functionName,
      args,
      preflight,
      quote: null,
      warning: "CL quote was not attempted because preflight found a hard blocker. Fix the pool/tick-spacing/liquidity input or pass preflight=false to force a raw quoter call."
    };
  }

  const quote = await tryRunContractFunction(publicClient, {
    contract: quoter,
    functionName,
    args,
    allowNonView: true,
    staticAccount: input.staticAccount,
    blockTag: input.blockTag
  });

  return {
    chainId: CHAIN_ID,
    ok: quote.ok,
    quoter,
    action: input.action,
    functionName,
    args,
    preflight,
    quote,
    warning: quote.ok
      ? undefined
      : "CL quoter call failed. Inspect quote.error and preflight for likely causes such as wrong tick spacing, missing liquidity, invalid path, or sqrt price limit."
  };
}

type PoolGaugeInfo = {
  gauge: ReturnType<typeof tryRunContractFunction> extends Promise<infer T> ? T : never;
  gaugeAddress: Address;
  feeDistributor?: ReturnType<typeof tryRunContractFunction> extends Promise<infer T> ? T : never;
  isGauge?: ReturnType<typeof tryRunContractFunction> extends Promise<infer T> ? T : never;
  isAlive?: ReturnType<typeof tryRunContractFunction> extends Promise<infer T> ? T : never;
  isLegacyGauge?: ReturnType<typeof tryRunContractFunction> extends Promise<infer T> ? T : never;
  isClGauge?: ReturnType<typeof tryRunContractFunction> extends Promise<infer T> ? T : never;
} | null;

function uniqueBigInts(values: bigint[]): bigint[] {
  return Array.from(new Set(values.map((value) => value.toString()))).map((value) => BigInt(value));
}

function readResultBigInts(read: { ok: boolean; result?: unknown }): bigint[] {
  if (!read.ok || !Array.isArray(read.result)) return [];
  return read.result.map((value) => BigInt(String(value)));
}

function parseDlmmPairInfo(value: unknown) {
  const binStep = Array.isArray(value)
    ? value[0]
    : typeof value === "object" && value !== null
      ? (value as { binStep?: unknown }).binStep
      : undefined;
  const pair = Array.isArray(value)
    ? value[1]
    : typeof value === "object" && value !== null
      ? (value as { LBPair?: unknown; lbPair?: unknown }).LBPair ?? (value as { LBPair?: unknown; lbPair?: unknown }).lbPair
      : undefined;
  const createdByOwner = Array.isArray(value)
    ? value[2]
    : typeof value === "object" && value !== null
      ? (value as { createdByOwner?: unknown }).createdByOwner
      : undefined;
  const ignoredForRouting = Array.isArray(value)
    ? value[3]
    : typeof value === "object" && value !== null
      ? (value as { ignoredForRouting?: unknown }).ignoredForRouting
      : undefined;

  return {
    binStep: binStep === undefined ? undefined : BigInt(String(binStep)),
    pair: typeof pair === "string" && isAddress(pair, { strict: false }) ? getAddress(pair) : ZERO_ADDRESS,
    createdByOwner: createdByOwner === true,
    ignoredForRouting: ignoredForRouting === true
  };
}

function readDlmmPairInfos(read: { ok: boolean; result?: unknown }) {
  if (!read.ok || !Array.isArray(read.result)) return [];
  return read.result.map(parseDlmmPairInfo).filter((item) => item.binStep !== undefined);
}

async function discoverGaugeForPool(
  publicClient: PublicClient,
  pool: Address,
  blockTag?: BlockTag
): Promise<PoolGaugeInfo> {
  if (pool === ZERO_ADDRESS) return null;

  const gauge = await tryRunContractFunction(publicClient, {
    contract: "voter",
    functionName: "gaugeForPool",
    args: [pool],
    blockTag
  });
  const gaugeAddress = readResultAddress(gauge) ?? ZERO_ADDRESS;
  if (gaugeAddress === ZERO_ADDRESS) {
    return { gauge, gaugeAddress };
  }

  const [feeDistributor, isGauge, isAlive, isLegacyGauge, isClGauge] = await Promise.all([
    tryRunContractFunction(publicClient, { contract: "voter", functionName: "feeDistributorForGauge", args: [gaugeAddress], blockTag }),
    tryRunContractFunction(publicClient, { contract: "voter", functionName: "isGauge", args: [gaugeAddress], blockTag }),
    tryRunContractFunction(publicClient, { contract: "voter", functionName: "isAlive", args: [gaugeAddress], blockTag }),
    tryRunContractFunction(publicClient, { contract: "voter", functionName: "isLegacyGauge", args: [gaugeAddress], blockTag }),
    tryRunContractFunction(publicClient, { contract: "voter", functionName: "isClGauge", args: [gaugeAddress], blockTag })
  ]);

  return {
    gauge,
    gaugeAddress,
    feeDistributor,
    isGauge,
    isAlive,
    isLegacyGauge,
    isClGauge
  };
}

// === POOL DISCOVERY ===

/** @summary Discover relevant pools for a token pair across all pool types */

export async function poolDiscover(
  publicClient: PublicClient,
  input: {
    tokenA: string;
    tokenB: string;
    protocols?: Array<"legacy" | "cl" | "dlmm">;
    stableTypes?: boolean[];
    tickSpacings?: Array<string | number>;
    binSteps?: Array<string | number>;
    includeState?: boolean;
    includeGauges?: boolean;
    blockTag?: BlockTag;
  }
) {
  const tokenA = asAddress(input.tokenA, "tokenA");
  const tokenB = asAddress(input.tokenB, "tokenB");
  const protocols = new Set(input.protocols ?? ["legacy", "cl", "dlmm"]);
  const includeState = input.includeState !== false;
  const includeGauges = input.includeGauges !== false;
  const warnings: string[] = [];
  const out: Record<string, unknown> = {
    chainId: CHAIN_ID,
    tokenA,
    tokenB,
    blockTag: input.blockTag ?? "latest",
    warnings
  };

  if (protocols.has("legacy")) {
    const stableTypes = input.stableTypes?.length ? input.stableTypes : [false, true];
    out.legacy = await Promise.all(stableTypes.map(async (stable) => {
      const [factoryPair, routerPair] = await Promise.all([
        tryRunContractFunction(publicClient, { contract: "pairFactory", functionName: "getPair", args: [tokenA, tokenB, stable], blockTag: input.blockTag }),
        tryRunContractFunction(publicClient, { contract: "router", functionName: "pairFor", args: [tokenA, tokenB, stable], blockTag: input.blockTag })
      ]);
      const pair = readResultAddress(factoryPair) ?? ZERO_ADDRESS;
      const exists = pair !== ZERO_ADDRESS;
      const [isPair, pairFee, metadata, reserves, totalSupply, gauge] = exists
        ? await Promise.all([
          includeState ? tryRunContractFunction(publicClient, { contract: "pairFactory", functionName: "isPair", args: [pair], blockTag: input.blockTag }) : undefined,
          includeState ? tryRunContractFunction(publicClient, { contract: "pairFactory", functionName: "pairFee", args: [pair], blockTag: input.blockTag }) : undefined,
          includeState ? tryRunContractFunction(publicClient, { contract: "legacyPair", functionName: "metadata", addressOverride: pair, blockTag: input.blockTag }) : undefined,
          includeState ? tryRunContractFunction(publicClient, { contract: "legacyPair", functionName: "getReserves", addressOverride: pair, blockTag: input.blockTag }) : undefined,
          includeState ? tryRunContractFunction(publicClient, { contract: "legacyPair", functionName: "totalSupply", addressOverride: pair, blockTag: input.blockTag }) : undefined,
          includeGauges ? discoverGaugeForPool(publicClient, pair, input.blockTag) : undefined
        ])
        : [undefined, undefined, undefined, undefined, undefined, undefined];

      return {
        protocol: "legacy",
        stable,
        pair,
        exists,
        factoryPair,
        routerPair,
        isPair,
        pairFee,
        metadata,
        reserves,
        totalSupply,
        gauge,
        buildHints: {
          createPair: exists ? null : { tool: "pharaoh_legacy_liquidity_build_tx", arguments: { action: "createPair", args: [tokenA, tokenB, stable] } },
          addLiquidity: {
            tool: "pharaoh_legacy_liquidity_build_tx",
            action: "addLiquidity",
            requiredArgs: ["tokenA", "tokenB", "stable", "amountADesired", "amountBDesired", "amountAMin", "amountBMin", "to", "deadline"],
            fixedArgs: { tokenA, tokenB, stable }
          }
        }
      };
    }));
  }

  if (protocols.has("cl")) {
    const voterTickSpacings = await tryRunContractFunction(publicClient, {
      contract: "voter",
      functionName: "tickSpacingsForPair",
      args: [tokenA, tokenB],
      blockTag: input.blockTag
    });
    const tickSpacings = uniqueBigInts(input.tickSpacings?.length
      ? input.tickSpacings.map((tickSpacing, index) => parseBigIntLike(tickSpacing, `tickSpacings[${index}]`))
      : readResultBigInts(voterTickSpacings));
    if (tickSpacings.length === 0) {
      warnings.push("No CL tick spacings were returned by Voter.tickSpacingsForPair; pass tickSpacings to inspect unregistered or ungauged CL pools.");
    }

    out.cl = await Promise.all(tickSpacings.map(async (tickSpacing) => {
      const preflight = includeState
        ? await clV3QuotePreflight(publicClient, { tokenIn: tokenA, tokenOut: tokenB, tickSpacing }, input.blockTag)
        : undefined;
      const poolRead = preflight?.poolRead ?? await tryRunContractFunction(publicClient, {
        contract: "ramsesV3Factory",
        functionName: "getPool",
        args: [tokenA, tokenB, tickSpacing],
        blockTag: input.blockTag
      });
      const pool = readResultAddress(poolRead) ?? preflight?.pool ?? ZERO_ADDRESS;
      const exists = pool !== ZERO_ADDRESS;
      const [initialFee, poolFeeProtocol, voterGaugeForClPool, clGaugeFactoryGauge, gauge] = await Promise.all([
        tryRunContractFunction(publicClient, { contract: "ramsesV3Factory", functionName: "tickSpacingInitialFee", args: [tickSpacing], blockTag: input.blockTag }),
        exists && includeState ? tryRunContractFunction(publicClient, { contract: "ramsesV3Factory", functionName: "poolFeeProtocol", args: [pool], blockTag: input.blockTag }) : undefined,
        includeGauges ? tryRunContractFunction(publicClient, { contract: "voter", functionName: "gaugeForClPool", args: [tokenA, tokenB, tickSpacing], blockTag: input.blockTag }) : undefined,
        exists && includeGauges ? tryRunContractFunction(publicClient, { contract: "clGaugeFactory", functionName: "getGauge", args: [pool], blockTag: input.blockTag }) : undefined,
        exists && includeGauges ? discoverGaugeForPool(publicClient, pool, input.blockTag) : undefined
      ]);

      return {
        protocol: "cl",
        tickSpacing,
        pool,
        exists,
        voterTickSpacings,
        poolRead,
        initialFee,
        preflight,
        poolFeeProtocol,
        voterGaugeForClPool,
        clGaugeFactoryGauge,
        gauge,
        buildHints: {
          createPool: exists ? null : {
            tool: "pharaoh_cl_liquidity_build_tx",
            action: "createPool",
            requiredArgs: ["tokenA", "tokenB", "tickSpacing", "sqrtPriceX96"],
            fixedArgs: { tokenA, tokenB, tickSpacing }
          },
          createAndInitializePoolIfNecessary: {
            tool: "pharaoh_cl_liquidity_build_tx",
            action: "createAndInitializePoolIfNecessary",
            requiredArgs: ["tokenA", "tokenB", "tickSpacing", "sqrtPriceX96"],
            fixedArgs: { tokenA, tokenB, tickSpacing }
          },
          mint: {
            tool: "pharaoh_cl_liquidity_build_tx",
            action: "mint",
            requiredTupleFields: ["token0", "token1", "tickSpacing", "tickLower", "tickUpper", "amount0Desired", "amount1Desired", "amount0Min", "amount1Min", "recipient", "deadline"],
            fixedTupleFields: { token0: tokenA, token1: tokenB, tickSpacing }
          }
        }
      };
    }));
  }

  if (protocols.has("dlmm")) {
    const [allPairsForward, allPairsReverse] = await Promise.all([
      tryRunContractFunction(publicClient, { contract: "dlmmFactory", functionName: "getAllLBPairs", args: [tokenA, tokenB], blockTag: input.blockTag }),
      tryRunContractFunction(publicClient, { contract: "dlmmFactory", functionName: "getAllLBPairs", args: [tokenB, tokenA], blockTag: input.blockTag })
    ]);
    const discoveredPairInfos = [
      ...readDlmmPairInfos(allPairsForward),
      ...readDlmmPairInfos(allPairsReverse)
    ];
    const discoveredBinSteps = new Set(discoveredPairInfos.map((info) => info.binStep?.toString()).filter(Boolean));
    const pairInfos = [
      ...discoveredPairInfos,
      ...(input.binSteps ?? []).filter((binStep) => !discoveredBinSteps.has(BigInt(String(binStep)).toString())).map((binStep, index) => ({
        binStep: parseBigIntLike(binStep, `binSteps[${index}]`),
        pair: ZERO_ADDRESS as Address,
        createdByOwner: false,
        ignoredForRouting: false
      }))
    ];
    const deduped = new Map<string, { binStep?: bigint; pair: Address; createdByOwner: boolean; ignoredForRouting: boolean }>();
    for (const info of pairInfos) {
      if (info.binStep === undefined) continue;
      const key = `${info.binStep}:${info.pair.toLowerCase()}`;
      if (!deduped.has(key)) deduped.set(key, info);
    }

    out.dlmm = await Promise.all([...deduped.values()].map(async (info) => {
      const pairInformation = await tryRunContractFunction(publicClient, {
        contract: "dlmmFactory",
        functionName: "getLBPairInformation",
        args: [tokenA, tokenB, info.binStep],
        blockTag: input.blockTag
      });
      const pairFromInformation = parseDlmmPairInfo(pairInformation.ok ? pairInformation.result : undefined).pair;
      const pair = info.pair !== ZERO_ADDRESS ? info.pair : pairFromInformation;
      const exists = pair !== ZERO_ADDRESS;
      const [isPool, preset, activeId, reserves, tokenX, tokenY, binStepRead, rewarder, voterCheck] = await Promise.all([
        exists ? tryRunContractFunction(publicClient, { contract: "dlmmFactory", functionName: "isPool", args: [pair], blockTag: input.blockTag }) : undefined,
        tryRunContractFunction(publicClient, { contract: "dlmmFactory", functionName: "getPreset", args: [info.binStep], blockTag: input.blockTag }),
        exists && includeState ? tryRunContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getActiveId", addressOverride: pair, blockTag: input.blockTag }) : undefined,
        exists && includeState ? tryRunContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getReserves", addressOverride: pair, blockTag: input.blockTag }) : undefined,
        exists && includeState ? tryRunContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getTokenX", addressOverride: pair, blockTag: input.blockTag }) : undefined,
        exists && includeState ? tryRunContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getTokenY", addressOverride: pair, blockTag: input.blockTag }) : undefined,
        exists && includeState ? tryRunContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getBinStep", addressOverride: pair, blockTag: input.blockTag }) : undefined,
        exists && includeGauges ? tryRunContractFunction(publicClient, { contract: "dlmmRewarderFactory", functionName: "getRewarder", args: [pair], blockTag: input.blockTag }) : undefined,
        undefined
      ]);
      const rewarderAddress = rewarder ? readResultAddress(rewarder) ?? ZERO_ADDRESS : ZERO_ADDRESS;
      const checkedRewarder = rewarderAddress !== ZERO_ADDRESS && includeGauges
        ? await tryRunContractFunction(publicClient, { contract: "voter", functionName: "isDLMMRewarder", args: [rewarderAddress], blockTag: input.blockTag })
        : voterCheck;

      return {
        protocol: "dlmm",
        binStep: info.binStep,
        pair,
        exists,
        createdByOwner: info.createdByOwner,
        ignoredForRouting: info.ignoredForRouting,
        allPairsForward,
        allPairsReverse,
        pairInformation,
        isPool,
        preset,
        activeId,
        reserves,
        tokenX,
        tokenY,
        binStepRead,
        rewarder,
        rewarderAddress,
        voterCheck: checkedRewarder,
        buildHints: {
          createLBPair: exists ? null : {
            tool: "pharaoh_dlmm_build_tx",
            action: "routerCreateLBPair",
            requiredArgs: ["tokenX", "tokenY", "activeId", "binStep"],
            fixedArgs: { tokenX: tokenA, tokenY: tokenB, binStep: info.binStep }
          },
          addLiquidity: {
            tool: "pharaoh_dlmm_build_tx",
            action: "addLiquidity",
            requiredTupleFields: ["tokenX", "tokenY", "binStep", "amountX", "amountY", "amountXMin", "amountYMin", "activeIdDesired", "idSlippage", "deltaIds", "distributionX", "distributionY", "to", "refundTo", "deadline"],
            fixedTupleFields: { tokenX: tokenA, tokenY: tokenB, binStep: info.binStep }
          }
        }
      };
    }));
  }

  return out;
}

async function resolveDlmmPair(
  publicClient: PublicClient,
  input: { pair?: string; tokenX?: string; tokenY?: string; binStep?: string | number; blockTag?: BlockTag }
) {
  const explicitPair = maybeAddress(input.pair);
  if (explicitPair) return { pair: explicitPair, pairInformation: undefined };

  const tokenX = asAddress(input.tokenX, "tokenX");
  const tokenY = asAddress(input.tokenY, "tokenY");
  const binStep = parseBigIntLike(input.binStep, "binStep");
  const pairInformation = await runContractFunction(publicClient, {
    contract: "dlmmFactory",
    functionName: "getLBPairInformation",
    args: [tokenX, tokenY, binStep],
    blockTag: input.blockTag
  });
  const pairResult = pairInformation.result;
  const pair = Array.isArray(pairResult)
    ? pairResult[1]
    : (pairResult as { LBPair?: Address; lbPair?: Address }).LBPair ?? (pairResult as { LBPair?: Address; lbPair?: Address }).lbPair;

  if (!pair || !isAddress(String(pair), { strict: false })) {
    throw new Error("DLMM pair could not be resolved from factory response.");
  }

  return { pair: getAddress(String(pair)), pairInformation };
}

// === DLMM QUOTES ===

/** @summary Get swap quote from DLMM (discrete liquidity market maker) pools */

export async function dlmmQuote(
  publicClient: PublicClient,
  input: {
    action: "findPair" | "getSwapOut" | "getSwapIn" | "getPriceFromId" | "getIdFromPrice" | "poolState" | "binState" | "rewarderForPair";
    source?: "router" | "pool";
    pair?: string;
    tokenX?: string;
    tokenY?: string;
    binStep?: string | number;
    amountIn?: string | number;
    amountOut?: string | number;
    swapForY?: boolean;
    id?: string | number;
    price?: string | number;
    blockTag?: BlockTag;
  }
) {
  const resolved = await resolveDlmmPair(publicClient, input);
  const source = input.source ?? "router";

  if (input.action === "findPair") {
    return { chainId: CHAIN_ID, ...resolved };
  }

  if (input.action === "rewarderForPair") {
    const rewarder = await runContractFunction(publicClient, {
      contract: "dlmmRewarderFactory",
      functionName: "getRewarder",
      args: [resolved.pair],
      blockTag: input.blockTag
    });
    const rewarderAddress = String(rewarder.result);
    const voterCheck = rewarderAddress !== ZERO_ADDRESS
      ? await runContractFunction(publicClient, {
        contract: "voter",
        functionName: "isDLMMRewarder",
        args: [rewarderAddress],
        blockTag: input.blockTag
      })
      : undefined;

    return {
      chainId: CHAIN_ID,
      pair: resolved.pair,
      pairInformation: resolved.pairInformation,
      rewarder,
      voterCheck,
      warning: rewarderAddress === ZERO_ADDRESS ? "No DLMM rewarder registered for this pair." : undefined
    };
  }

  if (input.action === "poolState") {
    const [activeId, reserves, tokenX, tokenY, hooksParameters] = await Promise.all([
      runContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getActiveId", addressOverride: resolved.pair, blockTag: input.blockTag }),
      runContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getReserves", addressOverride: resolved.pair, blockTag: input.blockTag }),
      runContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getTokenX", addressOverride: resolved.pair, blockTag: input.blockTag }),
      runContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getTokenY", addressOverride: resolved.pair, blockTag: input.blockTag }),
      runContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getLBHooksParameters", addressOverride: resolved.pair, blockTag: input.blockTag })
    ]);
    const hooks = String(hooksParameters.result);
    const hookAddress = /^0x[0-9a-fA-F]{64}$/.test(hooks) ? getAddress(`0x${hooks.slice(-40)}`) : undefined;

    return {
      chainId: CHAIN_ID,
      pair: resolved.pair,
      pairInformation: resolved.pairInformation,
      activeId: activeId.result,
      reserves: reserves.result,
      tokenX: tokenX.result,
      tokenY: tokenY.result,
      hooksParameters: hooksParameters.result,
      decodedHookAddress: hookAddress,
      warning: hookAddress && hookAddress !== ZERO_ADDRESS ? "Decoded hook address should be verified against voter.isDLMMRewarder or rewarder source before reward claims." : undefined
    };
  }

  if (input.action === "binState") {
    return runContractFunction(publicClient, {
      contract: "dlmmPoolImplementation",
      functionName: "getBin",
      args: [parseBigIntLike(input.id, "id")],
      addressOverride: resolved.pair,
      blockTag: input.blockTag
    });
  }

  if (source === "pool") {
    const functionName = input.action === "getSwapOut" ? "getSwapOut"
      : input.action === "getSwapIn" ? "getSwapIn"
        : input.action === "getPriceFromId" ? "getPriceFromId"
          : "getIdFromPrice";
    const args = input.action === "getSwapOut"
      ? [parseBigIntLike(input.amountIn, "amountIn"), input.swapForY]
      : input.action === "getSwapIn"
        ? [parseBigIntLike(input.amountOut, "amountOut"), input.swapForY]
        : input.action === "getPriceFromId"
          ? [parseBigIntLike(input.id, "id")]
          : [parseBigIntLike(input.price, "price")];

    return runContractFunction(publicClient, {
      contract: "dlmmPoolImplementation",
      functionName,
      args,
      addressOverride: resolved.pair,
      blockTag: input.blockTag
    });
  }

  const functionName = input.action;
  const args = input.action === "getSwapOut"
    ? [resolved.pair, parseBigIntLike(input.amountIn, "amountIn"), input.swapForY]
    : input.action === "getSwapIn"
      ? [resolved.pair, parseBigIntLike(input.amountOut, "amountOut"), input.swapForY]
      : input.action === "getPriceFromId"
        ? [resolved.pair, parseBigIntLike(input.id, "id")]
        : [resolved.pair, parseBigIntLike(input.price, "price")];

  return runContractFunction(publicClient, {
    contract: "dlmmRouter",
    functionName,
    args,
    blockTag: input.blockTag
  });
}

function applySlippageDown(amount: bigint, slippageBps: bigint): bigint {
  return amount * (10_000n - slippageBps) / 10_000n;
}

function applySlippageUp(amount: bigint, slippageBps: bigint): bigint {
  return (amount * (10_000n + slippageBps) + 9_999n) / 10_000n;
}

function normalizeSwapToken(value: string, label: string) {
  const address = asAddress(value, label);
  return {
    address,
    isNative: isNativeToken(address),
    wrappedAddress: isNativeToken(address) ? contractRegistry.wavax.address : address
  };
}

function lastBigIntFromArray(read: { ok: boolean; result?: unknown }): bigint | undefined {
  return read.ok && Array.isArray(read.result) && read.result.length > 0
    ? BigInt(String(read.result[read.result.length - 1]))
    : undefined;
}

function firstBigIntFromArray(read: { ok: boolean; result?: unknown }): bigint | undefined {
  return read.ok && Array.isArray(read.result) && read.result.length > 0
    ? BigInt(String(read.result[0]))
    : undefined;
}

function tupleBigIntAt(read: { ok: boolean; result?: unknown }, index: number): bigint | undefined {
  return read.ok && Array.isArray(read.result) && read.result.length > index
    ? BigInt(String(read.result[index]))
    : undefined;
}

function validateSignedBits(value: bigint, bits: number, label: string) {
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (value < min || value > max) {
    throw new Error(`${label} must fit int${bits}.`);
  }
}

function validateUnsignedBits(value: bigint, bits: number, label: string) {
  if (value < 0n || value > (1n << BigInt(bits)) - 1n) {
    throw new Error(`${label} must fit uint${bits}.`);
  }
}

async function approvalPlan(
  publicClient: PublicClient,
  account: Address | undefined,
  token: Address,
  spender: Address,
  amount: bigint | undefined,
  blockTag?: BlockTag
) {
  if (isNativeToken(token)) {
    return {
      token,
      spender,
      amount,
      native: true,
      approvalRequired: false,
      check: null,
      buildCall: null
    };
  }

  const allowance = account
    ? await tryRead(publicClient, token, contractAbis.erc20Read as Abi, "allowance", [account, spender], blockTag)
    : undefined;
  const allowanceValue = allowance ? readResultBigInt(allowance) : undefined;
  const approvalRequired = amount !== undefined
    ? allowanceValue === undefined ? true : allowanceValue < amount
    : account ? allowanceValue === undefined || allowanceValue === 0n : true;
  const approvalAmount = amount ?? 0n;

  return {
    token,
    spender,
    amount,
    native: false,
    check: allowance,
    approvalRequired,
    buildCall: approvalRequired && amount !== undefined
      ? { tool: "pharaoh_encode_approval", arguments: { standard: "erc20", tokenAddress: token, spender, amount: approvalAmount } }
      : null
  };
}

function suppressNestedBuildCallIfBlocked<T>(entry: T, canBuild: boolean, label: string): T {
  if (canBuild || !entry || typeof entry !== "object") return entry;
  const record = entry as Record<string, unknown>;
  if (!("buildCall" in record)) return entry;

  return {
    ...record,
    buildCall: null,
    buildCallStatus: "blocked_canBuild_false",
    buildCallSuppressedReason: `${label} buildCall is suppressed while the parent plan canBuild=false; resolve blockers and rerun the planner.`
  } as T;
}

function suppressNestedBuildCallsIfBlocked<T>(entries: T[], canBuild: boolean, label: string): T[] {
  return entries.map((entry) => suppressNestedBuildCallIfBlocked(entry, canBuild, label));
}

function swapPlanTx(
  contract: string,
  functionName: string,
  args: unknown[],
  value: bigint | undefined,
  action = functionName
) {
  return workflowTxResult(buildUnsignedTx({
    contract,
    functionName,
    args,
    value: (value ?? 0n).toString()
  }), action);
}

function encodeSwapRouterCall(functionName: string, args: unknown[] = []): Hex {
  const fn = lookupFunction(contractAbis.swapRouter as Abi, functionName);
  return encodeFunctionData({
    abi: [fn] as Abi,
    functionName: fn.name,
    args: normalizeArgs(fn, args)
  } as never);
}

function normalizedSwap(tokenIn: ReturnType<typeof normalizeSwapToken>, tokenOut: ReturnType<typeof normalizeSwapToken>) {
  return {
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    wrappedTokenIn: tokenIn.wrappedAddress,
    wrappedTokenOut: tokenOut.wrappedAddress,
    nativeIn: tokenIn.isNative,
    nativeOut: tokenOut.isNative
  };
}

type SwapHopInput = {
  tokenIn: string;
  tokenOut: string;
  stable?: boolean;
  tickSpacing?: string | number;
  binStep?: string | number;
  pair?: string;
  dlmmVersion?: string | number;
};

type NormalizedSwapHop = {
  index: number;
  tokenIn: ReturnType<typeof normalizeSwapToken>;
  tokenOut: ReturnType<typeof normalizeSwapToken>;
  stable?: boolean;
  tickSpacing?: bigint;
  binStep?: bigint;
  pair?: Address;
  dlmmVersion?: number;
};

function normalizeSwapHops(
  hops: SwapHopInput[],
  boundaryTokenIn: ReturnType<typeof normalizeSwapToken>,
  boundaryTokenOut: ReturnType<typeof normalizeSwapToken>,
  defaults: {
    stable?: boolean;
    tickSpacing?: string | number;
    binStep?: string | number;
    dlmmVersion?: string | number;
  } = {}
) {
  if (hops.length === 0) {
    throw new Error("hops must contain at least one hop when supplied.");
  }

  const normalized = hops.map((hop, index): NormalizedSwapHop => {
    const tokenIn = normalizeSwapToken(hop.tokenIn, `hops[${index}].tokenIn`);
    const tokenOut = normalizeSwapToken(hop.tokenOut, `hops[${index}].tokenOut`);
    if (tokenIn.wrappedAddress.toLowerCase() === tokenOut.wrappedAddress.toLowerCase()) {
      throw new Error(`hops[${index}] tokenIn and tokenOut resolve to the same token.`);
    }

    const tickSpacing = hop.tickSpacing ?? defaults.tickSpacing;
    const binStep = hop.binStep ?? defaults.binStep;
    const dlmmVersion = hop.dlmmVersion ?? defaults.dlmmVersion ?? 2;

    return {
      index,
      tokenIn,
      tokenOut,
      stable: hop.stable ?? defaults.stable,
      tickSpacing: tickSpacing === undefined ? undefined : parseBigIntLike(tickSpacing, `hops[${index}].tickSpacing`),
      binStep: binStep === undefined ? undefined : parseBigIntLike(binStep, `hops[${index}].binStep`),
      pair: hop.pair ? asAddress(hop.pair, `hops[${index}].pair`) : undefined,
      dlmmVersion: Number(parseBigIntLike(dlmmVersion, `hops[${index}].dlmmVersion`))
    };
  });

  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (first.tokenIn.wrappedAddress.toLowerCase() !== boundaryTokenIn.wrappedAddress.toLowerCase()) {
    throw new Error("hops[0].tokenIn must match tokenIn after native AVAX wrapping.");
  }
  if (last.tokenOut.wrappedAddress.toLowerCase() !== boundaryTokenOut.wrappedAddress.toLowerCase()) {
    throw new Error("last hop tokenOut must match tokenOut after native AVAX wrapping.");
  }

  for (let index = 0; index < normalized.length - 1; index += 1) {
    const left = normalized[index];
    const right = normalized[index + 1];
    if (left.tokenOut.wrappedAddress.toLowerCase() !== right.tokenIn.wrappedAddress.toLowerCase()) {
      throw new Error(`hops[${index}].tokenOut must match hops[${index + 1}].tokenIn after native AVAX wrapping.`);
    }
  }

  return normalized;
}

function encodeClRoutePath(hops: NormalizedSwapHop[], side: "exactIn" | "exactOut") {
  const ordered = side === "exactIn" ? hops : [...hops].reverse().map((hop) => ({
    ...hop,
    tokenIn: hop.tokenOut,
    tokenOut: hop.tokenIn
  }));
  const types: Array<"address" | "int24"> = [];
  const values: Array<Address | number> = [];

  ordered.forEach((hop, index) => {
    if (hop.tickSpacing === undefined) throw new Error(`hops[${hop.index}].tickSpacing is required for CL route planning.`);
    validateSignedBits(hop.tickSpacing, 24, `hops[${hop.index}].tickSpacing`);
    if (index === 0) {
      types.push("address");
      values.push(hop.tokenIn.wrappedAddress);
    }
    types.push("int24", "address");
    values.push(Number(hop.tickSpacing), hop.tokenOut.wrappedAddress);
  });

  return encodePacked(types, values);
}

function routeTokens(hops: NormalizedSwapHop[]) {
  return [
    hops[0].tokenIn.wrappedAddress,
    ...hops.map((hop) => hop.tokenOut.wrappedAddress)
  ];
}

// === SWAP PLANNING ===

/** @summary Plan a swap: compose reads, quotes, approval checks, and builder hints into actionable plan */

export async function swapPlan(
  publicClient: PublicClient,
  input: {
    protocol?: "legacy" | "cl" | "dlmm";
    side: "exactIn" | "exactOut";
    account?: string;
    recipient?: string;
    tokenIn: string;
    tokenOut: string;
    amountIn?: string | number;
    amountOut?: string | number;
    amountOutMin?: string | number;
    amountInMax?: string | number;
    slippageBps?: string | number;
    deadline?: string | number;
    stable?: boolean;
    tickSpacing?: string | number;
    sqrtPriceLimitX96?: string | number;
    binStep?: string | number;
    pair?: string;
    dlmmVersion?: string | number;
    hops?: SwapHopInput[];
    blockTag?: BlockTag;
  }
) {
  const protocol = input.protocol ?? "legacy";
  const side = input.side;
  const account = input.account ? asAddress(input.account, "account") : undefined;
  const recipient = input.recipient ? asAddress(input.recipient, "recipient") : account;
  const tokenIn = normalizeSwapToken(input.tokenIn, "tokenIn");
  const tokenOut = normalizeSwapToken(input.tokenOut, "tokenOut");
  const slippageBps = parseBigIntLike(input.slippageBps ?? 50, "slippageBps");
  if (slippageBps < 0n || slippageBps > 10_000n) {
    throw new Error("slippageBps must be between 0 and 10000.");
  }
  const deadline = input.deadline !== undefined
    ? parseBigIntLike(input.deadline, "deadline")
    : BigInt(Math.floor(Date.now() / 1000) + 1800);
  const warnings = [
    "Readonly swap planner only. It quotes current state and returns approval/build hints; it never signs or broadcasts. Re-quote immediately before signing because routes, reserves, active bins, and slippage can change."
  ];

  if (!recipient) {
    throw new Error("recipient or account is required for swap planning.");
  }
  if (tokenIn.wrappedAddress.toLowerCase() === tokenOut.wrappedAddress.toLowerCase()) {
    throw new Error("tokenIn and tokenOut resolve to the same token.");
  }
  if (protocol === "cl" && (tokenIn.isNative || tokenOut.isNative)) {
    warnings.push("CL native AVAX endpoints are planned through the verified SwapRouter payable WETH9 payment path; native-output and exact-output native-input plans use SwapRouter.multicall with unwrapWETH9/refundETH.");
  }

  if (protocol === "legacy") {
    const amount = side === "exactIn"
      ? parseBigIntLike(input.amountIn, "amountIn")
      : parseBigIntLike(input.amountOut, "amountOut");
    const hops = input.hops
      ? normalizeSwapHops(input.hops, tokenIn, tokenOut, { stable: input.stable ?? false })
      : undefined;
    const stable = input.stable ?? false;
    const routes = hops
      ? hops.map((hop) => ({ from: hop.tokenIn.wrappedAddress, to: hop.tokenOut.wrappedAddress, stable: hop.stable ?? false }))
      : [{ from: tokenIn.wrappedAddress, to: tokenOut.wrappedAddress, stable }];
    const quote = await tryRunContractFunction(publicClient, {
      contract: "router",
      functionName: side === "exactIn" ? "getAmountsOut" : "getAmountsIn",
      args: [amount, routes],
      blockTag: input.blockTag
    });
    const quotedOut = side === "exactIn" ? lastBigIntFromArray(quote) : undefined;
    const quotedIn = side === "exactOut" ? firstBigIntFromArray(quote) : undefined;
    const amountIn = side === "exactIn" ? amount : input.amountInMax !== undefined ? parseBigIntLike(input.amountInMax, "amountInMax") : quotedIn === undefined ? undefined : applySlippageUp(quotedIn, slippageBps);
    const amountOut = side === "exactOut" ? amount : quotedOut;
    const amountOutMin = side === "exactIn"
      ? input.amountOutMin !== undefined ? parseBigIntLike(input.amountOutMin, "amountOutMin") : quotedOut === undefined ? undefined : applySlippageDown(quotedOut, slippageBps)
      : undefined;
    const amountInMax = side === "exactOut" ? amountIn : undefined;
    const functionName = side === "exactIn"
      ? tokenIn.isNative ? "swapExactETHForTokens"
        : tokenOut.isNative ? "swapExactTokensForETH"
          : "swapExactTokensForTokens"
      : tokenIn.isNative ? "swapETHForExactTokens"
        : tokenOut.isNative ? "swapTokensForExactETH"
          : "swapTokensForExactTokens";
    const args = side === "exactIn"
      ? tokenIn.isNative
        ? [amountOutMin, routes, recipient, deadline]
        : [amountIn, amountOutMin, routes, recipient, deadline]
      : tokenIn.isNative
        ? [amountOut, routes, recipient, deadline]
        : [amountOut, amountInMax, routes, recipient, deadline];
    const value = tokenIn.isNative ? (side === "exactIn" ? amountIn : amountInMax) : 0n;
    const approval = await approvalPlan(publicClient, account, tokenIn.address, contractRegistry.router.address, tokenIn.isNative ? undefined : amountIn, input.blockTag);
    const blockers = [
      ...(quote.ok ? [] : [`legacy quote failed: ${compactError(String(quote.error))}`]),
      ...(side === "exactIn" && amountOutMin === undefined ? ["could not derive amountOutMin; pass amountOutMin explicitly"] : []),
      ...(side === "exactOut" && amountInMax === undefined ? ["could not derive amountInMax; pass amountInMax explicitly"] : [])
    ];
    const canBuild = blockers.length === 0;
    const tx = canBuild ? swapPlanTx("router", functionName, args, value, functionName) : null;

    return {
      chainId: CHAIN_ID,
      protocol,
      side,
      account,
      recipient,
      normalized: normalizedSwap(tokenIn, tokenOut),
      tokenIn,
      tokenOut,
      blockTag: input.blockTag ?? "latest",
      route: { stable, routes, hops: hops ?? null },
      quote,
      amounts: { amountIn, amountOut, amountOutMin, amountInMax, slippageBps },
      approval: suppressNestedBuildCallIfBlocked(approval, canBuild, "legacy swap approval"),
      buildCall: canBuild
        ? { tool: "pharaoh_legacy_swap_build_tx", arguments: { functionName, args, value: value?.toString() ?? "0" } }
        : null,
      tx,
      simulateCall: canBuild && account
        ? { tool: "pharaoh_simulate_tx", arguments: { account, contract: "router", functionName, args, value: value?.toString() ?? "0" } }
        : null,
      canBuild,
      blockers,
      warnings
    };
  }

  if (protocol === "cl") {
    const amount = side === "exactIn"
      ? parseBigIntLike(input.amountIn, "amountIn")
      : parseBigIntLike(input.amountOut, "amountOut");
    const sqrtPriceLimitX96 = parseBigIntLike(input.sqrtPriceLimitX96 ?? 0, "sqrtPriceLimitX96");
    const hops = input.hops
      ? normalizeSwapHops(input.hops, tokenIn, tokenOut, { tickSpacing: input.tickSpacing })
      : undefined;
    const tickSpacing = hops ? undefined : parseBigIntLike(input.tickSpacing, "tickSpacing");
    if (tickSpacing !== undefined) validateSignedBits(tickSpacing, 24, "tickSpacing");
    const encodedPath = hops ? encodeClRoutePath(hops, side) : undefined;
    const hopPreflights = hops
      ? await Promise.all(hops.map((hop) => clV3QuotePreflight(publicClient, {
        tokenIn: hop.tokenIn.wrappedAddress,
        tokenOut: hop.tokenOut.wrappedAddress,
        tickSpacing: hop.tickSpacing ?? 0n
      }, input.blockTag)))
      : undefined;
    const routePreflightBlockers = hopPreflights?.flatMap((preflight, index) => preflight.blockers
      .filter((blocker) => blocker.severity === "error")
      .map((blocker) => `hops[${index}] ${blocker.code}: ${blocker.message}`)) ?? [];
    const quote = await clQuote(publicClient, hops
      ? {
        quoter: "quoterV2",
        action: side === "exactIn" ? "quoteExactInput" : "quoteExactOutput",
        path: encodedPath,
        amountIn: side === "exactIn" ? amount.toString() : undefined,
        amountOut: side === "exactOut" ? amount.toString() : undefined,
        preflight: false,
        blockTag: input.blockTag
      }
      : {
        quoter: "quoterV2",
        action: side === "exactIn" ? "quoteExactInputSingle" : "quoteExactOutputSingle",
        tokenIn: tokenIn.wrappedAddress,
        tokenOut: tokenOut.wrappedAddress,
        tickSpacing: tickSpacing?.toString(),
        amountIn: side === "exactIn" ? amount.toString() : undefined,
        amountOut: side === "exactOut" ? amount.toString() : undefined,
        sqrtPriceLimitX96: sqrtPriceLimitX96.toString(),
        blockTag: input.blockTag
      });
    const quoteRead = { ok: Boolean((quote as { ok?: boolean }).ok), result: (quote as { quote?: { result?: unknown } }).quote?.result };
    const quoted = tupleBigIntAt(quoteRead, 0) ?? readResultBigInt(quoteRead);
    const amountIn = side === "exactIn" ? amount : input.amountInMax !== undefined ? parseBigIntLike(input.amountInMax, "amountInMax") : quoted === undefined ? undefined : applySlippageUp(quoted, slippageBps);
    const amountOut = side === "exactOut" ? amount : quoted;
    const amountOutMin = side === "exactIn"
      ? input.amountOutMin !== undefined ? parseBigIntLike(input.amountOutMin, "amountOutMin") : amountOut === undefined ? undefined : applySlippageDown(amountOut, slippageBps)
      : undefined;
    const amountInMax = side === "exactOut" ? amountIn : undefined;
    const params = hops
      ? side === "exactIn"
        ? {
          path: encodedPath,
          recipient: tokenOut.isNative ? asAddress(ZERO_ADDRESS, "swapRouterNativeRecipient") : recipient,
          deadline,
          amountIn,
          amountOutMinimum: amountOutMin
        }
        : {
          path: encodedPath,
          recipient: tokenOut.isNative ? asAddress(ZERO_ADDRESS, "swapRouterNativeRecipient") : recipient,
          deadline,
          amountOut,
          amountInMaximum: amountInMax
        }
      : side === "exactIn"
        ? {
        tokenIn: tokenIn.wrappedAddress,
        tokenOut: tokenOut.wrappedAddress,
        tickSpacing: tickSpacing as bigint,
        recipient: tokenOut.isNative ? asAddress(ZERO_ADDRESS, "swapRouterNativeRecipient") : recipient,
        deadline,
        amountIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96
      }
      : {
        tokenIn: tokenIn.wrappedAddress,
        tokenOut: tokenOut.wrappedAddress,
        tickSpacing: tickSpacing as bigint,
        recipient: tokenOut.isNative ? asAddress(ZERO_ADDRESS, "swapRouterNativeRecipient") : recipient,
        deadline,
        amountOut,
        amountInMaximum: amountInMax,
        sqrtPriceLimitX96
      };
    const functionName = hops
      ? side === "exactIn"
        ? "exactInput((bytes,address,uint256,uint256,uint256))"
        : "exactOutput((bytes,address,uint256,uint256,uint256))"
      : side === "exactIn"
        ? "exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))"
        : "exactOutputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))";
    const args = [params];
    const value = tokenIn.isNative ? (side === "exactIn" ? amountIn : amountInMax) : 0n;
    const approval = await approvalPlan(publicClient, account, tokenIn.address, contractRegistry.swapRouter.address, tokenIn.isNative ? undefined : amountIn, input.blockTag);
    const quoteOk = Boolean((quote as { ok?: boolean }).ok);
    const blockers = [
      ...routePreflightBlockers,
      ...(quoteOk ? [] : ["CL quote failed; inspect quote.preflight and quote.quote.error"]),
      ...(side === "exactIn" && amountOutMin === undefined ? ["could not derive amountOutMinimum; pass amountOutMin explicitly"] : []),
      ...(side === "exactOut" && amountInMax === undefined ? ["could not derive amountInMaximum; pass amountInMax explicitly"] : [])
    ];
    const canBuild = blockers.length === 0;
    let executionFunctionName = functionName;
    let executionArgs: unknown[] = args;
    let nativeHandling: Record<string, unknown> | null = null;

    if (canBuild && (tokenOut.isNative || (tokenIn.isNative && side === "exactOut"))) {
      const innerCalls = [
        {
          label: functionName,
          data: encodeSwapRouterCall(functionName, args)
        }
      ];
      if (tokenOut.isNative) {
        const amountMinimum = side === "exactIn" ? amountOutMin : amountOut;
        innerCalls.push({
          label: "unwrapWETH9(uint256,address)",
          data: encodeSwapRouterCall("unwrapWETH9(uint256,address)", [amountMinimum, recipient])
        });
      }
      if (tokenIn.isNative && side === "exactOut") {
        innerCalls.push({
          label: "refundETH()",
          data: encodeSwapRouterCall("refundETH()")
        });
      }
      executionFunctionName = "multicall";
      executionArgs = [innerCalls.map((call) => call.data)];
      nativeHandling = {
        mode: "swaprouter_multicall",
        reason: [
          tokenOut.isNative ? "native output requires SwapRouter to receive WETH9 and unwrapWETH9 to the final recipient" : null,
          tokenIn.isNative && side === "exactOut" ? "exact-output native input sends amountInMaximum as msg.value and refunds unused AVAX" : null
        ].filter(Boolean),
        swapRecipient: tokenOut.isNative ? ZERO_ADDRESS : recipient,
        innerCalls
      };
    } else if (tokenIn.isNative) {
      nativeHandling = {
        mode: "direct_payable_swap",
        reason: "SwapRouter.pay wraps native AVAX into WETH9 when tokenIn is WETH9 and msg.value covers the required input.",
        swapRecipient: recipient
      };
    }

    const tx = canBuild ? swapPlanTx("swapRouter", executionFunctionName, executionArgs, value, executionFunctionName) : null;

    return {
      chainId: CHAIN_ID,
      protocol,
      side,
      account,
      recipient,
      normalized: normalizedSwap(tokenIn, tokenOut),
      tokenIn,
      tokenOut,
      blockTag: input.blockTag ?? "latest",
      route: hops
        ? { hops, path: encodedPath, tokens: routeTokens(hops), hopPreflights }
        : { tickSpacing, sqrtPriceLimitX96 },
      quote,
      amounts: { amountIn, amountOut, amountOutMin, amountInMax, slippageBps },
      approval: suppressNestedBuildCallIfBlocked(approval, canBuild, "CL swap approval"),
      nativeHandling,
      buildCall: canBuild
        ? { tool: "pharaoh_cl_swap_build_tx", arguments: { functionName: executionFunctionName, args: executionArgs, value: value?.toString() ?? "0" } }
        : null,
      tx,
      simulateCall: canBuild && account
        ? { tool: "pharaoh_simulate_tx", arguments: { account, contract: "swapRouter", functionName: executionFunctionName, args: executionArgs, value: value?.toString() ?? "0" } }
        : null,
      canBuild,
      blockers,
      warnings
    };
  }

  const amount = side === "exactIn"
    ? parseBigIntLike(input.amountIn, "amountIn")
    : parseBigIntLike(input.amountOut, "amountOut");
  validateUnsignedBits(amount, 128, side === "exactIn" ? "amountIn" : "amountOut");
  const hops = input.hops
    ? normalizeSwapHops(input.hops, tokenIn, tokenOut, { binStep: input.binStep, dlmmVersion: input.dlmmVersion ?? 2 })
    : normalizeSwapHops([{ tokenIn: input.tokenIn, tokenOut: input.tokenOut, binStep: input.binStep, pair: input.pair, dlmmVersion: input.dlmmVersion ?? 2 }], tokenIn, tokenOut);

  for (const hop of hops) {
    if (hop.binStep === undefined) throw new Error(`hops[${hop.index}].binStep is required for DLMM route planning.`);
    validateUnsignedBits(hop.binStep, 16, `hops[${hop.index}].binStep`);
    validateUnsignedBits(BigInt(hop.dlmmVersion ?? 2), 8, `hops[${hop.index}].dlmmVersion`);
  }

  const resolvedHops = await Promise.all(hops.map(async (hop) => {
    const pairForward = hop.pair ? undefined : await tryRunContractFunction(publicClient, {
      contract: "dlmmFactory",
      functionName: "getLBPairInformation",
      args: [hop.tokenIn.wrappedAddress, hop.tokenOut.wrappedAddress, hop.binStep],
      blockTag: input.blockTag
    });
    const pairReverse = hop.pair || (pairForward && parseDlmmPairInfo(pairForward.ok ? pairForward.result : undefined).pair !== ZERO_ADDRESS)
      ? undefined
      : await tryRunContractFunction(publicClient, {
        contract: "dlmmFactory",
        functionName: "getLBPairInformation",
        args: [hop.tokenOut.wrappedAddress, hop.tokenIn.wrappedAddress, hop.binStep],
        blockTag: input.blockTag
      });
    const pair = hop.pair
      ? hop.pair
      : parseDlmmPairInfo(pairForward?.ok ? pairForward.result : undefined).pair !== ZERO_ADDRESS
        ? parseDlmmPairInfo(pairForward?.ok ? pairForward.result : undefined).pair
        : parseDlmmPairInfo(pairReverse?.ok ? pairReverse.result : undefined).pair;
    const [tokenXRead, tokenYRead] = pair !== ZERO_ADDRESS
      ? await Promise.all([
        tryRunContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getTokenX", addressOverride: pair, blockTag: input.blockTag }),
        tryRunContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getTokenY", addressOverride: pair, blockTag: input.blockTag })
      ])
      : [{ ok: false, error: "DLMM pair not found." }, { ok: false, error: "DLMM pair not found." }];
    const tokenX = readResultAddress(tokenXRead);
    const tokenY = readResultAddress(tokenYRead);
    const swapForY = tokenX && tokenY
      ? hop.tokenIn.wrappedAddress.toLowerCase() === tokenX.toLowerCase() && hop.tokenOut.wrappedAddress.toLowerCase() === tokenY.toLowerCase()
        ? true
        : hop.tokenIn.wrappedAddress.toLowerCase() === tokenY.toLowerCase() && hop.tokenOut.wrappedAddress.toLowerCase() === tokenX.toLowerCase()
          ? false
          : undefined
      : undefined;

    return { ...hop, pairForward, pairReverse, pair, tokenXRead, tokenYRead, tokenX, tokenY, swapForY };
  }));

  const quoteSteps = [];
  let quoteOk = true;
  let quotedIn: bigint | undefined;
  let quotedOut: bigint | undefined;
  if (side === "exactIn") {
    let runningAmount = amount;
    for (const hop of resolvedHops) {
      if (hop.pair === ZERO_ADDRESS || hop.swapForY === undefined) {
        quoteOk = false;
        quoteSteps.push({ hop: hop.index, ok: false, error: "DLMM pair missing or token direction does not match pair tokenX/tokenY." });
        break;
      }
      const hopQuoteResult = await tryAsync(() => dlmmQuote(publicClient, {
        action: "getSwapOut",
        source: "router",
        pair: hop.pair,
        amountIn: runningAmount.toString(),
        swapForY: hop.swapForY,
        blockTag: input.blockTag
      }));
      if (!hopQuoteResult.ok) {
        quoteOk = false;
        quoteSteps.push({ hop: hop.index, ok: false, error: compactError(String(hopQuoteResult.error)), amountIn: runningAmount });
        break;
      }
      const hopQuote = hopQuoteResult.result;
      const hopRecord = hopQuote && typeof hopQuote === "object" ? hopQuote as { ok?: boolean; result?: unknown } : {};
      const hopOk = hopRecord.ok === undefined || Boolean(hopRecord.ok);
      const hopRead = { ok: hopOk, result: hopRecord.result };
      const hopOut = tupleBigIntAt(hopRead, 1);
      quoteSteps.push({ hop: hop.index, quote: hopQuote, amountIn: runningAmount, amountOut: hopOut });
      if (!hopOk || hopOut === undefined) {
        quoteOk = false;
        break;
      }
      runningAmount = hopOut;
    }
    quotedOut = quoteOk ? runningAmount : undefined;
  } else {
    let runningAmount = amount;
    for (const hop of [...resolvedHops].reverse()) {
      if (hop.pair === ZERO_ADDRESS || hop.swapForY === undefined) {
        quoteOk = false;
        quoteSteps.push({ hop: hop.index, ok: false, error: "DLMM pair missing or token direction does not match pair tokenX/tokenY." });
        break;
      }
      const hopQuoteResult = await tryAsync(() => dlmmQuote(publicClient, {
        action: "getSwapIn",
        source: "router",
        pair: hop.pair,
        amountOut: runningAmount.toString(),
        swapForY: hop.swapForY,
        blockTag: input.blockTag
      }));
      if (!hopQuoteResult.ok) {
        quoteOk = false;
        quoteSteps.push({ hop: hop.index, ok: false, error: compactError(String(hopQuoteResult.error)), amountOut: runningAmount });
        break;
      }
      const hopQuote = hopQuoteResult.result;
      const hopRecord = hopQuote && typeof hopQuote === "object" ? hopQuote as { ok?: boolean; result?: unknown } : {};
      const hopOk = hopRecord.ok === undefined || Boolean(hopRecord.ok);
      const hopRead = { ok: hopOk, result: hopRecord.result };
      const hopIn = tupleBigIntAt(hopRead, 0);
      quoteSteps.push({ hop: hop.index, quote: hopQuote, amountOut: runningAmount, amountIn: hopIn });
      if (!hopOk || hopIn === undefined) {
        quoteOk = false;
        break;
      }
      runningAmount = hopIn;
    }
    quotedIn = quoteOk ? runningAmount : undefined;
  }
  const amountIn = side === "exactIn" ? amount : input.amountInMax !== undefined ? parseBigIntLike(input.amountInMax, "amountInMax") : quotedIn === undefined ? undefined : applySlippageUp(quotedIn, slippageBps);
  if (amountIn !== undefined && side === "exactOut") validateUnsignedBits(amountIn, 128, "amountInMax");
  const amountOut = side === "exactOut" ? amount : quotedOut;
  const amountOutMin = side === "exactIn"
    ? input.amountOutMin !== undefined ? parseBigIntLike(input.amountOutMin, "amountOutMin") : quotedOut === undefined ? undefined : applySlippageDown(quotedOut, slippageBps)
    : undefined;
  const amountInMax = side === "exactOut" ? amountIn : undefined;
  const path = {
    pairBinSteps: resolvedHops.map((hop) => hop.binStep as bigint),
    versions: resolvedHops.map((hop) => hop.dlmmVersion ?? 2),
    tokenPath: routeTokens(resolvedHops)
  };
  const functionName = side === "exactIn"
    ? tokenIn.isNative ? "swapExactNATIVEForTokens"
      : tokenOut.isNative ? "swapExactTokensForNATIVE"
        : "swapExactTokensForTokens"
    : tokenIn.isNative ? "swapNATIVEForExactTokens"
      : tokenOut.isNative ? "swapTokensForExactNATIVE"
        : "swapTokensForExactTokens";
  const args = side === "exactIn"
    ? tokenIn.isNative
      ? [amountOutMin, path, recipient, deadline]
      : [amountIn, amountOutMin, path, recipient, deadline]
    : tokenIn.isNative
      ? [amountOut, path, recipient, deadline]
      : [amountOut, amountInMax, path, recipient, deadline];
  const value = tokenIn.isNative ? (side === "exactIn" ? amountIn : amountInMax) : 0n;
  const approval = await approvalPlan(publicClient, account, tokenIn.address, contractRegistry.dlmmRouter.address, tokenIn.isNative ? undefined : amountIn, input.blockTag);
  const blockers = [
    ...resolvedHops.flatMap((hop) => [
      ...(hop.pair !== ZERO_ADDRESS ? [] : [`hops[${hop.index}] DLMM pair not found for token pair/binStep`]),
      ...(hop.swapForY !== undefined ? [] : [`hops[${hop.index}] token direction does not match DLMM pool tokenX/tokenY`])
    ]),
    ...(quoteOk ? [] : ["DLMM route quote failed; inspect quote.steps for the failing hop"]),
    ...(side === "exactIn" && amountOutMin === undefined ? ["could not derive amountOutMin; pass amountOutMin explicitly"] : []),
    ...(side === "exactOut" && amountInMax === undefined ? ["could not derive amountInMax; pass amountInMax explicitly"] : [])
  ];
  const canBuild = blockers.length === 0;
  const tx = canBuild ? swapPlanTx("dlmmRouter", functionName, args, value, functionName) : null;

  return {
    chainId: CHAIN_ID,
    protocol,
    side,
    account,
    recipient,
    normalized: normalizedSwap(tokenIn, tokenOut),
    tokenIn,
    tokenOut,
    blockTag: input.blockTag ?? "latest",
    route: { hops: resolvedHops, path },
    quote: { ok: quoteOk, steps: quoteSteps },
    amounts: { amountIn, amountOut, amountOutMin, amountInMax, slippageBps },
    approval: suppressNestedBuildCallIfBlocked(approval, canBuild, "DLMM swap approval"),
    buildCall: canBuild
      ? { tool: "pharaoh_dlmm_build_tx", arguments: { action: functionName, args, value: value?.toString() ?? "0" } }
      : null,
    tx,
    simulateCall: canBuild && account
      ? { tool: "pharaoh_simulate_tx", arguments: { account, contract: "dlmmRouter", functionName, args, value: value?.toString() ?? "0" } }
      : null,
    canBuild,
    blockers,
    warnings
  };
}

type SwapRouteProtocol = "legacy" | "cl" | "dlmm";

type SwapRouteHopOption = {
  protocol: SwapRouteProtocol;
  hopIndex: number;
  tokenIn: Address;
  tokenOut: Address;
  stable?: boolean;
  tickSpacing?: bigint;
  binStep?: bigint;
  pair?: Address;
  pool?: Address;
};

type SwapRouteCandidateProtocol = SwapRouteProtocol | "mixed";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function recordRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row)) : [];
}

function boolField(row: Record<string, unknown>, key: string): boolean | undefined {
  return typeof row[key] === "boolean" ? row[key] : undefined;
}

function bigintField(row: Record<string, unknown>, key: string): bigint | undefined {
  const value = row[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) return BigInt(value);
  return undefined;
}

function addressField(row: Record<string, unknown>, key: string): Address | undefined {
  const value = row[key];
  return typeof value === "string" && isAddress(value, { strict: false }) ? getAddress(value) : undefined;
}

function protocolOrder(protocol: SwapRouteCandidateProtocol): number {
  return protocol === "legacy" ? 0 : protocol === "cl" ? 1 : protocol === "dlmm" ? 2 : 3;
}

function defaultIntermediateTokens() {
  return [
    contractRegistry.wavax.address,
    contractRegistry.usdcNative.address,
    contractRegistry.pharToken.address,
    contractRegistry.xPharToken.address
  ];
}

function swapRoutePathKey(tokens: Address[]) {
  return tokens.map((token) => normalizeSwapToken(token, "pathToken").wrappedAddress.toLowerCase()).join(">");
}

function swapRoutePaths(tokenIn: Address, tokenOut: Address, intermediateTokens: Address[], maxHops: number) {
  const paths: Address[][] = [[tokenIn, tokenOut]];
  if (maxHops < 2) return paths;

  const inWrapped = normalizeSwapToken(tokenIn, "tokenIn").wrappedAddress.toLowerCase();
  const outWrapped = normalizeSwapToken(tokenOut, "tokenOut").wrappedAddress.toLowerCase();
  for (const intermediate of intermediateTokens) {
    const bridgeWrapped = normalizeSwapToken(intermediate, "intermediateToken").wrappedAddress.toLowerCase();
    if (bridgeWrapped === inWrapped || bridgeWrapped === outWrapped) continue;
    paths.push([tokenIn, intermediate, tokenOut]);
  }

  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = swapRoutePathKey(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function amountForRanking(plan: unknown, side: "exactIn" | "exactOut"): bigint | undefined {
  const amounts = asRecord(asRecord(plan)?.amounts);
  const value = side === "exactIn" ? amounts?.amountOut : amounts?.amountIn;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) return BigInt(value);
  return undefined;
}

function amountField(plan: unknown, key: "amountIn" | "amountOut"): unknown {
  return asRecord(asRecord(plan)?.amounts)?.[key];
}

function routeHopInput(option: SwapRouteHopOption): SwapHopInput {
  return {
    tokenIn: option.tokenIn,
    tokenOut: option.tokenOut,
    stable: option.stable,
    tickSpacing: option.tickSpacing?.toString(),
    binStep: option.binStep?.toString(),
    pair: option.pair,
    dlmmVersion: option.protocol === "dlmm" ? 2 : undefined
  };
}

function mixedRouteHopInput(option: SwapRouteHopOption): MixedRouteHopInput {
  if (option.protocol !== "legacy" && option.protocol !== "cl") {
    throw new Error("mixed route discovery only supports legacy and CL hops.");
  }
  return {
    protocol: option.protocol,
    tokenIn: option.tokenIn,
    tokenOut: option.tokenOut,
    stable: option.stable,
    tickSpacing: option.tickSpacing?.toString()
  };
}

function routePlanInput(input: {
  side: "exactIn" | "exactOut";
  account?: string;
  recipient?: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn?: string | number;
  amountOut?: string | number;
  slippageBps?: string | number;
  deadline?: string | number;
  blockTag?: BlockTag;
}, protocol: SwapRouteProtocol, path: Address[], options: SwapRouteHopOption[]) {
  const common = {
    protocol,
    side: input.side,
    account: input.account,
    recipient: input.recipient,
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    amountIn: input.amountIn,
    amountOut: input.amountOut,
    slippageBps: input.slippageBps,
    deadline: input.deadline,
    blockTag: input.blockTag
  };

  if (path.length > 2) {
    return {
      ...common,
      hops: options.map(routeHopInput)
    };
  }

  const option = options[0];
  return {
    ...common,
    stable: option.stable,
    tickSpacing: option.tickSpacing?.toString(),
    binStep: option.binStep?.toString(),
    pair: option.pair
  };
}

function mixedRoutePlanInput(input: {
  account?: string;
  recipient?: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string | number;
  slippageBps?: string | number;
  deadline?: string | number;
  blockTag?: BlockTag;
}, options: SwapRouteHopOption[]) {
  return {
    account: input.account,
    recipient: input.recipient,
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    amountIn: input.amountIn,
    slippageBps: input.slippageBps,
    deadline: input.deadline,
    hops: options.map(mixedRouteHopInput),
    blockTag: input.blockTag
  };
}

function mixedProtocolSequences(protocols: SwapRouteProtocol[], hopCount: number): MixedRouteProtocol[][] {
  if (hopCount < 2 || !protocols.includes("legacy") || !protocols.includes("cl")) return [];
  const sequences: MixedRouteProtocol[][] = [];

  function walk(current: MixedRouteProtocol[]) {
    if (current.length === hopCount) {
      const set = new Set(current);
      if (set.has("legacy") && set.has("cl")) sequences.push(current);
      return;
    }
    walk([...current, "legacy"]);
    walk([...current, "cl"]);
  }

  walk([]);
  return sequences;
}

function combineHopOptions(groups: SwapRouteHopOption[][], limit: number) {
  let capped = false;
  let combinations: SwapRouteHopOption[][] = [[]];
  for (const group of groups) {
    const next: SwapRouteHopOption[][] = [];
    for (const current of combinations) {
      for (const option of group) {
        if (next.length >= limit) {
          capped = true;
          break;
        }
        next.push([...current, option]);
      }
      if (capped) break;
    }
    combinations = next;
    if (capped) break;
  }
  return { combinations, capped };
}

async function discoverSwapRouteHopOptions(
  publicClient: PublicClient,
  input: {
    protocol: SwapRouteProtocol;
    hopIndex: number;
    tokenIn: Address;
    tokenOut: Address;
    stableTypes?: boolean[];
    tickSpacings?: Array<string | number>;
    binSteps?: Array<string | number>;
    maxVariantsPerHop: number;
    blockTag?: BlockTag;
  }
) {
  const tokenIn = normalizeSwapToken(input.tokenIn, `hops[${input.hopIndex}].tokenIn`).wrappedAddress;
  const tokenOut = normalizeSwapToken(input.tokenOut, `hops[${input.hopIndex}].tokenOut`).wrappedAddress;
  const discovery = asRecord(await poolDiscover(publicClient, {
    tokenA: tokenIn,
    tokenB: tokenOut,
    protocols: [input.protocol],
    stableTypes: input.protocol === "legacy" ? input.stableTypes : undefined,
    tickSpacings: input.protocol === "cl" ? input.tickSpacings : undefined,
    binSteps: input.protocol === "dlmm" ? input.binSteps : undefined,
    includeState: true,
    includeGauges: false,
    blockTag: input.blockTag
  })) ?? {};

  const options: SwapRouteHopOption[] = [];
  if (input.protocol === "legacy") {
    for (const row of recordRows(discovery.legacy)) {
      if (boolField(row, "exists") !== true) continue;
      options.push({
        protocol: input.protocol,
        hopIndex: input.hopIndex,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        stable: boolField(row, "stable") ?? false,
        pair: addressField(row, "pair")
      });
    }
  } else if (input.protocol === "cl") {
    for (const row of recordRows(discovery.cl)) {
      const tickSpacing = bigintField(row, "tickSpacing");
      if (boolField(row, "exists") !== true || tickSpacing === undefined) continue;
      options.push({
        protocol: input.protocol,
        hopIndex: input.hopIndex,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        tickSpacing,
        pool: addressField(row, "pool")
      });
    }
  } else {
    for (const row of recordRows(discovery.dlmm)) {
      const binStep = bigintField(row, "binStep");
      const pair = addressField(row, "pair");
      if (boolField(row, "exists") !== true || boolField(row, "ignoredForRouting") === true || binStep === undefined || !pair) continue;
      options.push({
        protocol: input.protocol,
        hopIndex: input.hopIndex,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        binStep,
        pair
      });
    }
  }

  return {
    options: options.slice(0, input.maxVariantsPerHop),
    discovered: options.length,
    capped: options.length > input.maxVariantsPerHop
  };
}

// === SWAP ROUTES ===

/** @summary Find optimal swap routes across legacy/CL/DLMM pools with multi-hop support */

export async function swapRoutesFind(
  publicClient: PublicClient,
  input: {
    side: "exactIn" | "exactOut";
    account?: string;
    recipient?: string;
    tokenIn: string;
    tokenOut: string;
    amountIn?: string | number;
    amountOut?: string | number;
    protocols?: SwapRouteProtocol[];
    intermediateTokens?: string[];
    maxHops?: string | number;
    stableTypes?: boolean[];
    tickSpacings?: Array<string | number>;
    binSteps?: Array<string | number>;
    slippageBps?: string | number;
    deadline?: string | number;
    includeBlocked?: boolean;
    includeMixed?: boolean;
    maxRoutes?: string | number;
    maxPlanAttempts?: string | number;
    maxVariantsPerHop?: string | number;
    blockTag?: BlockTag;
  }
) {
  const side = input.side;
  const tokenIn = asAddress(input.tokenIn, "tokenIn");
  const tokenOut = asAddress(input.tokenOut, "tokenOut");
  const normalizedIn = normalizeSwapToken(tokenIn, "tokenIn");
  const normalizedOut = normalizeSwapToken(tokenOut, "tokenOut");
  if (normalizedIn.wrappedAddress.toLowerCase() === normalizedOut.wrappedAddress.toLowerCase()) {
    throw new Error("tokenIn and tokenOut resolve to the same token.");
  }
  if (!input.account && !input.recipient) {
    throw new Error("recipient or account is required for route finding because route plans include executable calldata hints.");
  }
  if (side === "exactIn") parseBigIntLike(input.amountIn, "amountIn");
  if (side === "exactOut") parseBigIntLike(input.amountOut, "amountOut");

  const protocols: SwapRouteProtocol[] = input.protocols?.length ? input.protocols : ["legacy", "cl", "dlmm"];
  const maxHops = Number(parseBigIntLike(input.maxHops ?? 2, "maxHops"));
  if (![1, 2].includes(maxHops)) throw new Error("maxHops must be 1 or 2.");
  const maxRoutes = Number(parseBigIntLike(input.maxRoutes ?? 5, "maxRoutes"));
  if (!Number.isInteger(maxRoutes) || maxRoutes < 1 || maxRoutes > 25) throw new Error("maxRoutes must be between 1 and 25.");
  const maxPlanAttempts = Number(parseBigIntLike(input.maxPlanAttempts ?? 48, "maxPlanAttempts"));
  if (!Number.isInteger(maxPlanAttempts) || maxPlanAttempts < 1 || maxPlanAttempts > 200) throw new Error("maxPlanAttempts must be between 1 and 200.");
  const maxVariantsPerHop = Number(parseBigIntLike(input.maxVariantsPerHop ?? 8, "maxVariantsPerHop"));
  if (!Number.isInteger(maxVariantsPerHop) || maxVariantsPerHop < 1 || maxVariantsPerHop > 32) throw new Error("maxVariantsPerHop must be between 1 and 32.");
  const includeBlocked = input.includeBlocked === true;
  const includeMixed = input.includeMixed === true;
  const intermediateTokens = uniqueAddresses((input.intermediateTokens?.length ? input.intermediateTokens : defaultIntermediateTokens())
    .map((token, index) => asAddress(token, `intermediateTokens[${index}]`)));
  const paths = swapRoutePaths(tokenIn, tokenOut, intermediateTokens, maxHops);
  const warnings = [
    includeMixed
      ? "Readonly route finder only. It discovers direct and two-hop same-protocol candidates plus exact-in mixed legacy/CL candidates when includeMixed=true, returns executable hints, and never signs or broadcasts."
      : "Readonly route finder only. It discovers direct and two-hop same-protocol candidates, calls pharaoh_swap_plan for executable hints, and never signs or broadcasts.",
    includeMixed
      ? "Mixed legacy/CL discovery is exact-in only and uses MixedRouteQuoterV1 plus UniversalRouter command encoding."
      : "Mixed-protocol routes are excluded unless includeMixed=true."
  ];
  const routes: Array<Record<string, unknown>> = [];
  const blockedRoutes: Array<Record<string, unknown>> = [];
  let candidateIndex = 0;
  let attemptedPlanCount = 0;
  let capped = false;

  for (const path of paths) {
    const hopPairs = path.slice(0, -1).map((from, index) => ({ tokenIn: from, tokenOut: path[index + 1] }));
    for (const protocol of protocols) {
      if (attemptedPlanCount >= maxPlanAttempts) {
        capped = true;
        continue;
      }
      const hopDiscoveries = await Promise.all(hopPairs.map((hop, hopIndex) => discoverSwapRouteHopOptions(publicClient, {
        protocol,
        hopIndex,
        tokenIn: hop.tokenIn,
        tokenOut: hop.tokenOut,
        stableTypes: input.stableTypes,
        tickSpacings: input.tickSpacings,
        binSteps: input.binSteps,
        maxVariantsPerHop,
        blockTag: input.blockTag
      })));
      for (const [hopIndex, discovery] of hopDiscoveries.entries()) {
        if (discovery.capped) warnings.push(`${protocol} route ${swapRoutePathKey(path)} hop ${hopIndex} had ${discovery.discovered} variants; using first ${maxVariantsPerHop}.`);
      }
      const missingHops = hopDiscoveries
        .map((discovery, hopIndex) => ({ hopIndex, discovered: discovery.discovered }))
        .filter((discovery) => discovery.discovered === 0);
      if (missingHops.length > 0) {
        blockedRoutes.push({
          index: candidateIndex++,
          protocol,
          hopCount: path.length - 1,
          tokens: path,
          canBuild: false,
          blockers: [`no ${protocol} pool candidates discovered for every hop`],
          missingHops
        });
        continue;
      }

      const remainingAttempts = maxPlanAttempts - attemptedPlanCount;
      const { combinations, capped: combinationsCapped } = combineHopOptions(hopDiscoveries.map((discovery) => discovery.options), remainingAttempts);
      if (combinationsCapped) {
        capped = true;
        warnings.push(`${protocol} route ${swapRoutePathKey(path)} exceeded maxPlanAttempts; remaining combinations were skipped.`);
      }

      for (const options of combinations) {
        const index = candidateIndex++;
        attemptedPlanCount += 1;
        try {
          const plan = await swapPlan(publicClient, routePlanInput({
            side,
            account: input.account,
            recipient: input.recipient,
            tokenIn,
            tokenOut,
            amountIn: input.amountIn,
            amountOut: input.amountOut,
            slippageBps: input.slippageBps,
            deadline: input.deadline,
            blockTag: input.blockTag
          }, protocol, path, options));
          const planRecord = asRecord(plan) ?? {};
          const canBuild = planRecord.canBuild === true;
          const blockers = Array.isArray(planRecord.blockers) ? planRecord.blockers : [];
          const route = {
            index,
            protocol,
            hopCount: path.length - 1,
            tokens: path,
            hops: options.map((option) => ({
              tokenIn: option.tokenIn,
              tokenOut: option.tokenOut,
              stable: option.stable,
              tickSpacing: option.tickSpacing,
              binStep: option.binStep,
              pair: option.pair,
              pool: option.pool
            })),
            amountIn: amountField(plan, "amountIn"),
            amountOut: amountField(plan, "amountOut"),
            rankAmount: amountForRanking(plan, side),
            canBuild,
            blockers,
            plan
          };
          if (canBuild && route.rankAmount !== undefined) {
            routes.push(route);
          } else {
            blockedRoutes.push(route);
          }
        } catch (error) {
          blockedRoutes.push({
            index,
            protocol,
            hopCount: path.length - 1,
            tokens: path,
            hops: options.map((option) => ({
              tokenIn: option.tokenIn,
              tokenOut: option.tokenOut,
              stable: option.stable,
              tickSpacing: option.tickSpacing,
              binStep: option.binStep,
              pair: option.pair,
              pool: option.pool
            })),
            canBuild: false,
            blockers: [error instanceof Error ? error.message : String(error)]
          });
        }
      }
    }

    if (includeMixed && side === "exactIn" && path.length > 2) {
      for (const sequence of mixedProtocolSequences(protocols, path.length - 1)) {
        if (attemptedPlanCount >= maxPlanAttempts) {
          capped = true;
          continue;
        }
        const routeProtocolLabel = `mixed:${sequence.join(">")}`;
        const hopDiscoveries = await Promise.all(hopPairs.map((hop, hopIndex) => discoverSwapRouteHopOptions(publicClient, {
          protocol: sequence[hopIndex],
          hopIndex,
          tokenIn: hop.tokenIn,
          tokenOut: hop.tokenOut,
          stableTypes: input.stableTypes,
          tickSpacings: input.tickSpacings,
          maxVariantsPerHop,
          blockTag: input.blockTag
        })));
        for (const [hopIndex, discovery] of hopDiscoveries.entries()) {
          if (discovery.capped) warnings.push(`${routeProtocolLabel} route ${swapRoutePathKey(path)} hop ${hopIndex} had ${discovery.discovered} variants; using first ${maxVariantsPerHop}.`);
        }
        const missingHops = hopDiscoveries
          .map((discovery, hopIndex) => ({ hopIndex, protocol: sequence[hopIndex], discovered: discovery.discovered }))
          .filter((discovery) => discovery.discovered === 0);
        if (missingHops.length > 0) {
          blockedRoutes.push({
            index: candidateIndex++,
            protocol: "mixed",
            routeProtocol: routeProtocolLabel,
            hopCount: path.length - 1,
            tokens: path,
            canBuild: false,
            blockers: ["no mixed legacy/CL pool candidates discovered for every hop"],
            missingHops
          });
          continue;
        }

        const remainingAttempts = maxPlanAttempts - attemptedPlanCount;
        const { combinations, capped: combinationsCapped } = combineHopOptions(hopDiscoveries.map((discovery) => discovery.options), remainingAttempts);
        if (combinationsCapped) {
          capped = true;
          warnings.push(`${routeProtocolLabel} route ${swapRoutePathKey(path)} exceeded maxPlanAttempts; remaining combinations were skipped.`);
        }

        for (const options of combinations) {
          const index = candidateIndex++;
          attemptedPlanCount += 1;
          try {
            const plan = await mixedRouteSwapPlan(publicClient, mixedRoutePlanInput({
              account: input.account,
              recipient: input.recipient,
              tokenIn,
              tokenOut,
              amountIn: input.amountIn as string | number,
              slippageBps: input.slippageBps,
              deadline: input.deadline,
              blockTag: input.blockTag
            }, options));
            const planRecord = asRecord(plan) ?? {};
            const canBuild = planRecord.canBuild === true;
            const blockers = Array.isArray(planRecord.blockers) ? planRecord.blockers : [];
            const route = {
              index,
              protocol: "mixed",
              routeProtocol: routeProtocolLabel,
              hopCount: path.length - 1,
              tokens: path,
              hops: options.map((option) => ({
                protocol: option.protocol,
                tokenIn: option.tokenIn,
                tokenOut: option.tokenOut,
                stable: option.stable,
                tickSpacing: option.tickSpacing,
                pair: option.pair,
                pool: option.pool
              })),
              amountIn: amountField(plan, "amountIn"),
              amountOut: amountField(plan, "amountOut"),
              rankAmount: amountForRanking(plan, side),
              canBuild,
              blockers,
              plan
            };
            if (canBuild && route.rankAmount !== undefined) {
              routes.push(route);
            } else {
              blockedRoutes.push(route);
            }
          } catch (error) {
            blockedRoutes.push({
              index,
              protocol: "mixed",
              routeProtocol: routeProtocolLabel,
              hopCount: path.length - 1,
              tokens: path,
              hops: options.map((option) => ({
                protocol: option.protocol,
                tokenIn: option.tokenIn,
                tokenOut: option.tokenOut,
                stable: option.stable,
                tickSpacing: option.tickSpacing,
                pair: option.pair,
                pool: option.pool
              })),
              canBuild: false,
              blockers: [error instanceof Error ? error.message : String(error)]
            });
          }
        }
      }
    } else if (includeMixed && side !== "exactIn") {
      warnings.push("Mixed legacy/CL route discovery skipped for exactOut because MixedRouteQuoterV1 only supports exact-input quoting.");
    }
  }

  if (capped) warnings.push("Candidate planning was capped; raise maxPlanAttempts or reduce protocols/intermediateTokens for a wider search.");
  routes.sort((left, right) => {
    const leftAmount = left.rankAmount as bigint;
    const rightAmount = right.rankAmount as bigint;
    if (leftAmount !== rightAmount) {
      return side === "exactIn"
        ? leftAmount > rightAmount ? -1 : 1
        : leftAmount < rightAmount ? -1 : 1;
    }
    const leftHops = Number(left.hopCount);
    const rightHops = Number(right.hopCount);
    if (leftHops !== rightHops) return leftHops - rightHops;
    const protocolDiff = protocolOrder(left.protocol as SwapRouteCandidateProtocol) - protocolOrder(right.protocol as SwapRouteCandidateProtocol);
    if (protocolDiff !== 0) return protocolDiff;
    return Number(left.index) - Number(right.index);
  });

  const rankedRoutes = routes.slice(0, maxRoutes).map((route, rank) => ({ rank: rank + 1, ...route }));
  const sampledBlockedRoutes = blockedRoutes.slice(0, maxRoutes);

  return {
    chainId: CHAIN_ID,
    side,
    tokenIn,
    tokenOut,
    normalized: normalizedSwap(normalizedIn, normalizedOut),
    blockTag: input.blockTag ?? "latest",
    search: {
      protocols,
      maxHops,
      intermediateTokens,
      candidatePaths: paths,
      maxRoutes,
      maxPlanAttempts,
      maxVariantsPerHop,
      includeMixed
    },
    candidateCount: routes.length + blockedRoutes.length,
    buildableCount: routes.length,
    blockedCount: blockedRoutes.length,
    attemptedPlanCount,
    bestRoute: rankedRoutes[0] ?? null,
    routes: rankedRoutes,
    blockedRoutes: includeBlocked || rankedRoutes.length === 0 ? sampledBlockedRoutes : undefined,
    warnings
  };
}

type MixedRouteProtocol = "legacy" | "cl";

type MixedRouteHopInput = {
  protocol: MixedRouteProtocol;
  tokenIn: string;
  tokenOut: string;
  stable?: boolean;
  tickSpacing?: string | number;
};

type NormalizedMixedRouteHop = {
  index: number;
  protocol: MixedRouteProtocol;
  tokenIn: ReturnType<typeof normalizeSwapToken>;
  tokenOut: ReturnType<typeof normalizeSwapToken>;
  stable?: boolean;
  tickSpacing?: bigint;
  routeCode: bigint;
};

type MixedRouteSegment = {
  index: number;
  protocol: MixedRouteProtocol;
  start: number;
  end: number;
  hops: NormalizedMixedRouteHop[];
};

function universalRouterCommandHex(commands: number[]) {
  return `0x${commands.map((command) => command.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function mixedRouteLegacyCode(stable: boolean) {
  return stable ? MIXED_ROUTE_V2_STABLE_FLAG : MIXED_ROUTE_V2_VOLATILE_FLAG;
}

function encodeMixedQuotePath(hops: NormalizedMixedRouteHop[]) {
  const types: Array<"address" | "uint24"> = ["address"];
  const values: Array<Address | number> = [hops[0].tokenIn.wrappedAddress];

  for (const hop of hops) {
    validateUnsignedBits(hop.routeCode, 24, `hops[${hop.index}].routeCode`);
    types.push("uint24", "address");
    values.push(Number(hop.routeCode), hop.tokenOut.wrappedAddress);
  }

  return encodePacked(types, values);
}

function encodeUniversalRouterV3Path(hops: NormalizedMixedRouteHop[]) {
  const types: Array<"address" | "int24"> = ["address"];
  const values: Array<Address | number> = [hops[0].tokenIn.wrappedAddress];

  for (const hop of hops) {
    if (hop.protocol !== "cl" || hop.tickSpacing === undefined) {
      throw new Error("encodeUniversalRouterV3Path only accepts CL hops.");
    }
    validateSignedBits(hop.tickSpacing, 24, `hops[${hop.index}].tickSpacing`);
    types.push("int24", "address");
    values.push(Number(hop.tickSpacing), hop.tokenOut.wrappedAddress);
  }

  return encodePacked(types, values);
}

function encodeUniversalRouterV2Path(hops: NormalizedMixedRouteHop[]) {
  return encodeAbiParameters(
    [{
      type: "tuple[]",
      components: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "stable", type: "bool" }
      ]
    }],
    [hops.map((hop) => ({
      from: hop.tokenIn.wrappedAddress,
      to: hop.tokenOut.wrappedAddress,
      stable: hop.stable ?? false
    }))]
  );
}

function encodeUniversalRouterSwapInput(input: {
  recipient: Address;
  amountIn: bigint;
  amountOutMin: bigint;
  path: Hex;
  payerIsUser: boolean;
}) {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes" },
      { type: "bool" }
    ],
    [input.recipient, input.amountIn, input.amountOutMin, input.path, input.payerIsUser]
  );
}

function encodeUniversalRouterPaymentInput(input: {
  recipient: Address;
  amountMinimum: bigint;
}) {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" }
    ],
    [input.recipient, input.amountMinimum]
  );
}

function mixedRouteSegments(hops: NormalizedMixedRouteHop[]) {
  const segments: MixedRouteSegment[] = [];
  let start = 0;
  for (let index = 1; index <= hops.length; index += 1) {
    if (index === hops.length || hops[index].protocol !== hops[start].protocol) {
      segments.push({
        index: segments.length,
        protocol: hops[start].protocol,
        start,
        end: index - 1,
        hops: hops.slice(start, index)
      });
      start = index;
    }
  }
  return segments;
}

function normalizeMixedRouteHops(input: {
  tokenIn: string;
  tokenOut: string;
  hops: MixedRouteHopInput[];
}) {
  if (input.hops.length < 2) throw new Error("mixed route planning requires at least two hops.");
  if (input.hops.length > 6) throw new Error("mixed route planning is capped at 6 hops.");

  const boundaryIn = normalizeSwapToken(input.tokenIn, "tokenIn");
  const boundaryOut = normalizeSwapToken(input.tokenOut, "tokenOut");
  const hops = input.hops.map((hop, index): NormalizedMixedRouteHop => {
    const tokenIn = normalizeSwapToken(hop.tokenIn, `hops[${index}].tokenIn`);
    const tokenOut = normalizeSwapToken(hop.tokenOut, `hops[${index}].tokenOut`);
    if (tokenIn.wrappedAddress.toLowerCase() === tokenOut.wrappedAddress.toLowerCase()) {
      throw new Error(`hops[${index}] tokenIn and tokenOut resolve to the same token.`);
    }

    if (hop.protocol === "legacy") {
      if (typeof hop.stable !== "boolean") throw new Error(`hops[${index}].stable is required for legacy mixed route hops.`);
      return {
        index,
        protocol: hop.protocol,
        tokenIn,
        tokenOut,
        stable: hop.stable,
        routeCode: mixedRouteLegacyCode(hop.stable)
      };
    }

    if (hop.protocol !== "cl") throw new Error(`hops[${index}].protocol must be legacy or cl.`);
    const tickSpacing = parseBigIntLike(hop.tickSpacing, `hops[${index}].tickSpacing`);
    validateSignedBits(tickSpacing, 24, `hops[${index}].tickSpacing`);
    if (tickSpacing < 0n) throw new Error(`hops[${index}].tickSpacing must be non-negative for mixed route encoding.`);
    return {
      index,
      protocol: hop.protocol,
      tokenIn,
      tokenOut,
      tickSpacing,
      routeCode: tickSpacing
    };
  });

  if (hops[0].tokenIn.wrappedAddress.toLowerCase() !== boundaryIn.wrappedAddress.toLowerCase()) {
    throw new Error("hops[0].tokenIn must match tokenIn after native AVAX wrapping.");
  }
  if (hops[hops.length - 1].tokenOut.wrappedAddress.toLowerCase() !== boundaryOut.wrappedAddress.toLowerCase()) {
    throw new Error("last hop tokenOut must match tokenOut after native AVAX wrapping.");
  }
  for (let index = 0; index < hops.length - 1; index += 1) {
    if (hops[index].tokenOut.wrappedAddress.toLowerCase() !== hops[index + 1].tokenIn.wrappedAddress.toLowerCase()) {
      throw new Error(`hops[${index}].tokenOut must match hops[${index + 1}].tokenIn after native AVAX wrapping.`);
    }
  }
  const protocolSet = new Set(hops.map((hop) => hop.protocol));
  if (!protocolSet.has("legacy") || !protocolSet.has("cl")) {
    throw new Error("pharaoh_mixed_route_swap_plan requires at least one legacy hop and one CL hop; use pharaoh_swap_plan for same-protocol routes.");
  }

  return { boundaryIn, boundaryOut, hops, segments: mixedRouteSegments(hops) };
}

async function preflightMixedRouteHop(
  publicClient: PublicClient,
  hop: NormalizedMixedRouteHop,
  blockTag?: BlockTag
) {
  if (hop.protocol === "legacy") {
    const pairRead = await tryRunContractFunction(publicClient, {
      contract: "pairFactory",
      functionName: "getPair",
      args: [hop.tokenIn.wrappedAddress, hop.tokenOut.wrappedAddress, hop.stable ?? false],
      blockTag
    });
    const pair = readResultAddress(pairRead) ?? ZERO_ADDRESS;
    const metadata = pair !== ZERO_ADDRESS
      ? await tryRunContractFunction(publicClient, {
        contract: "legacyPair",
        functionName: "metadata",
        addressOverride: pair,
        blockTag
      })
      : undefined;
    return {
      hop: hop.index,
      protocol: hop.protocol,
      pair,
      pairRead,
      metadata,
      blockers: [
        ...(pairRead.ok ? [] : [`hops[${hop.index}] legacy pair read failed: ${compactError(String(pairRead.error))}`]),
        ...(pair !== ZERO_ADDRESS ? [] : [`hops[${hop.index}] legacy pair does not exist for stable=${hop.stable}`])
      ]
    };
  }

  const preflight = await clV3QuotePreflight(publicClient, {
    tokenIn: hop.tokenIn.wrappedAddress,
    tokenOut: hop.tokenOut.wrappedAddress,
    tickSpacing: hop.tickSpacing ?? 0n
  }, blockTag);
  return {
    hop: hop.index,
    protocol: hop.protocol,
    pool: preflight.pool,
    preflight,
    blockers: preflight.blockers
      .filter((blocker) => blocker.severity === "error")
      .map((blocker) => `hops[${hop.index}] ${blocker.code}: ${blocker.message}`)
  };
}

function segmentFirstPair(segment: MixedRouteSegment, preflights: Array<Record<string, unknown>>) {
  if (segment.protocol !== "legacy") return undefined;
  const row = preflights[segment.start];
  const pair = row?.pair;
  return typeof pair === "string" && isAddress(pair, { strict: false }) ? getAddress(pair) : undefined;
}

function buildUniversalRouterSegments(input: {
  nativeIn: boolean;
  nativeOut: boolean;
  segments: MixedRouteSegment[];
  preflights: Array<Record<string, unknown>>;
  recipient: Address;
  amountIn: bigint;
  amountOutMin: bigint;
}) {
  const commands: number[] = [];
  const encodedInputs: Hex[] = [];
  const decodedInputs = [];

  if (input.nativeIn) {
    commands.push(UNIVERSAL_ROUTER_WRAP_ETH);
    encodedInputs.push(encodeUniversalRouterPaymentInput({
      recipient: asAddress(ADDRESS_THIS, "ADDRESS_THIS"),
      amountMinimum: input.amountIn
    }));
    decodedInputs.push({
      command: "WRAP_ETH",
      commandByte: "0x0b",
      recipient: ADDRESS_THIS,
      amountMinimum: input.amountIn
    });
  }

  for (const [index, segment] of input.segments.entries()) {
    const nextSegment = input.segments[index + 1];
    const isFirst = index === 0;
    const isFinal = index === input.segments.length - 1;
    const nextFirstPair = nextSegment ? segmentFirstPair(nextSegment, input.preflights) : undefined;
    const recipient = isFinal
      ? input.nativeOut ? asAddress(ADDRESS_THIS, "ADDRESS_THIS") : input.recipient
      : nextSegment?.protocol === "legacy" && nextFirstPair
        ? nextFirstPair
        : asAddress(ADDRESS_THIS, "ADDRESS_THIS");
    const amountIn = isFirst
      ? input.amountIn
      : segment.protocol === "legacy"
        ? 0n
        : UNIVERSAL_ROUTER_CONTRACT_BALANCE;
    const amountOutMin = isFinal ? input.amountOutMin : 0n;
    const payerIsUser = isFirst && !input.nativeIn;

    if (segment.protocol === "legacy") {
      commands.push(UNIVERSAL_ROUTER_V2_SWAP_EXACT_IN);
      const path = encodeUniversalRouterV2Path(segment.hops);
      encodedInputs.push(encodeUniversalRouterSwapInput({ recipient, amountIn, amountOutMin, path, payerIsUser }));
      decodedInputs.push({
        command: "V2_SWAP_EXACT_IN",
        commandByte: "0x08",
        recipient,
        amountIn,
        amountOutMin,
        payerIsUser,
        path: segment.hops.map((hop) => ({
          from: hop.tokenIn.wrappedAddress,
          to: hop.tokenOut.wrappedAddress,
          stable: hop.stable ?? false
        })),
        encodedPath: path
      });
    } else {
      commands.push(UNIVERSAL_ROUTER_V3_SWAP_EXACT_IN);
      const path = encodeUniversalRouterV3Path(segment.hops);
      encodedInputs.push(encodeUniversalRouterSwapInput({ recipient, amountIn, amountOutMin, path, payerIsUser }));
      decodedInputs.push({
        command: "V3_SWAP_EXACT_IN",
        commandByte: "0x00",
        recipient,
        amountIn,
        amountOutMin,
        payerIsUser,
        path: segment.hops.map((hop) => ({
          tokenIn: hop.tokenIn.wrappedAddress,
          tokenOut: hop.tokenOut.wrappedAddress,
          tickSpacing: hop.tickSpacing
        })),
        encodedPath: path
      });
    }
  }

  if (input.nativeOut) {
    commands.push(UNIVERSAL_ROUTER_UNWRAP_WETH);
    encodedInputs.push(encodeUniversalRouterPaymentInput({
      recipient: input.recipient,
      amountMinimum: input.amountOutMin
    }));
    decodedInputs.push({
      command: "UNWRAP_WETH",
      commandByte: "0x0c",
      recipient: input.recipient,
      amountMinimum: input.amountOutMin
    });
  }

  return {
    commands: universalRouterCommandHex(commands),
    inputs: encodedInputs,
    decodedInputs
  };
}

// === MIXED ROUTE PLANNING ===

/** @summary Plan a swap using mixed routes combining legacy and CL pools in single transaction */

export async function mixedRouteSwapPlan(
  publicClient: PublicClient,
  input: {
    side?: "exactIn";
    account?: string;
    recipient?: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string | number;
    amountOutMin?: string | number;
    slippageBps?: string | number;
    deadline?: string | number;
    hops: MixedRouteHopInput[];
    blockTag?: BlockTag;
  }
) {
  if (input.side && input.side !== "exactIn") throw new Error("pharaoh_mixed_route_swap_plan currently supports exactIn only; MixedRouteQuoterV1 does not support exactOutput.");
  const account = input.account ? asAddress(input.account, "account") : undefined;
  const recipient = input.recipient ? asAddress(input.recipient, "recipient") : account;
  if (!recipient) throw new Error("recipient or account is required for mixed route planning.");
  const amountIn = parseBigIntLike(input.amountIn, "amountIn");
  const slippageBps = parseBigIntLike(input.slippageBps ?? 50, "slippageBps");
  if (slippageBps < 0n || slippageBps > 10_000n) throw new Error("slippageBps must be between 0 and 10000.");
  const deadline = input.deadline !== undefined
    ? parseBigIntLike(input.deadline, "deadline")
    : BigInt(Math.floor(Date.now() / 1000) + 1800);
  const normalized = normalizeMixedRouteHops(input);
  const lastHopIndex = normalized.hops.length - 1;
  const nativeUnsupported = normalized.hops.some((hop) => (
    (hop.tokenIn.isNative && !(hop.index === 0 && normalized.boundaryIn.isNative)) ||
    (hop.tokenOut.isNative && !(hop.index === lastHopIndex && normalized.boundaryOut.isNative))
  ));
  const preflights = await Promise.all(normalized.hops.map((hop) => preflightMixedRouteHop(publicClient, hop, input.blockTag)));
  const preflightBlockers = preflights.flatMap((preflight) => preflight.blockers);
  const blockers = [
    ...(nativeUnsupported ? ["native AVAX is only supported at mixed route endpoints; internal hops must use ERC20/WAVAX addresses."] : []),
    ...preflightBlockers
  ];
  const quotePath = encodeMixedQuotePath(normalized.hops);
  const quote = blockers.length === 0
    ? await clQuote(publicClient, {
      quoter: "mixedRouteQuoterV1",
      action: "quoteExactInput",
      path: quotePath,
      amountIn: amountIn.toString(),
      preflight: false,
      blockTag: input.blockTag
    })
    : null;
  const quoteOk = quote ? Boolean((quote as { ok?: boolean }).ok) : false;
  const quoteRead = quote ? { ok: quoteOk, result: (quote as { quote?: { result?: unknown } }).quote?.result } : { ok: false, result: undefined };
  const amountOut = tupleBigIntAt(quoteRead, 0);
  const amountOutMin = input.amountOutMin !== undefined
    ? parseBigIntLike(input.amountOutMin, "amountOutMin")
    : amountOut === undefined ? undefined : applySlippageDown(amountOut, slippageBps);
  if (quote && !quoteOk) blockers.push("mixed route quote failed; inspect quote.quote.error");
  if (amountOutMin === undefined) blockers.push("could not derive amountOutMin; pass amountOutMin explicitly");

  const universal = amountOutMin !== undefined && blockers.length === 0
    ? buildUniversalRouterSegments({
      nativeIn: normalized.boundaryIn.isNative,
      nativeOut: normalized.boundaryOut.isNative,
      segments: normalized.segments,
      preflights: preflights as Array<Record<string, unknown>>,
      recipient,
      amountIn,
      amountOutMin
    })
    : null;
  const args = universal ? [universal.commands, universal.inputs, deadline] : null;
  const txValue = normalized.boundaryIn.isNative ? amountIn : 0n;
  const approval = await approvalPlan(publicClient, account, normalized.boundaryIn.address, contractRegistry.universalRouter.address, amountIn, input.blockTag);
  const tx = args ? swapPlanTx("universalRouter", "execute(bytes,bytes[],uint256)", args, txValue, "execute") : null;
  const canBuild = blockers.length === 0 && Boolean(args);

  return {
    chainId: CHAIN_ID,
    protocol: "mixed",
    side: "exactIn",
    account,
    recipient,
    universalRouter: contractRegistry.universalRouter.address,
    normalized: normalizedSwap(normalized.boundaryIn, normalized.boundaryOut),
    blockTag: input.blockTag ?? "latest",
    route: {
      hops: normalized.hops.map((hop) => ({
        index: hop.index,
        protocol: hop.protocol,
        tokenIn: hop.tokenIn.wrappedAddress,
        tokenOut: hop.tokenOut.wrappedAddress,
        stable: hop.stable,
        tickSpacing: hop.tickSpacing,
        routeCode: hop.routeCode
      })),
      segments: normalized.segments.map((segment) => ({
        index: segment.index,
        protocol: segment.protocol,
        start: segment.start,
        end: segment.end
      })),
      quotePath
    },
    preflights,
    quote,
    amounts: { amountIn, amountOut, amountOutMin, slippageBps },
    approval: suppressNestedBuildCallIfBlocked(approval, canBuild, "mixed-route swap approval"),
    universalRouterPlan: universal,
    buildCall: canBuild
      ? { tool: "pharaoh_universal_router_build_tx", arguments: { functionName: "execute(bytes,bytes[],uint256)", commands: universal?.commands, inputs: universal?.inputs, deadline: deadline.toString(), value: txValue.toString() } }
      : null,
    tx: canBuild ? tx : null,
    simulateCall: canBuild && account
      ? { tool: "pharaoh_simulate_tx", arguments: { account, contract: "universalRouter", functionName: "execute(bytes,bytes[],uint256)", args: args as unknown[], value: txValue.toString() } }
      : null,
    canBuild,
    blockers,
    warnings: [
      "Readonly mixed route planner only. It quotes current state, encodes UniversalRouter command inputs, and never signs or broadcasts.",
      "Exact-output mixed routes remain intentionally blocked in this version because MixedRouteQuoterV1 only exposes exact-input quoting.",
      "Native AVAX route endpoints are wrapped/unwrapped through UniversalRouter WRAP_ETH and UNWRAP_WETH commands; internal route hops use WAVAX.",
      "UniversalRouter command bytes and V2/V3 input schemas are source-backed from the verified Pharaoh UniversalRouter deployment."
    ],
    sourceEvidence: {
      universalRouter: "Routescan/Snowtrace verified source for 0x5AcC35397D2ce81Ac54A4B1c6D9e1FB29F8EC6C6: Commands.sol and Dispatcher.sol",
      mixedRouteQuoter: "Routescan/Snowtrace verified source for 0x3265d621c7d993151C8EB2aCd4902CdA0499A8a0: MixedRouteQuoterV1.sol"
    }
  };
}

function normalizeLiquidityToken(value: string | undefined, label: string) {
  if (value === undefined) throw new Error(`${label} is required.`);
  return normalizeSwapToken(value, label);
}

function minWithOptional(value: string | number | undefined, fallback: bigint, label: string) {
  return value === undefined ? fallback : parseBigIntLike(value, label);
}

function planWarnings(domain: string) {
  return [
    `Readonly ${domain} liquidity planner only. It returns approval/build/simulation hints and never signs or broadcasts.`,
    "Re-read pool state and recalculate slippage bounds immediately before signing because reserves, ticks, active bins, balances, and approvals can change."
  ];
}

function planTx(contract: string, functionName: string, args: unknown[], value: bigint | undefined, action = functionName) {
  return workflowTxResult(buildUnsignedTx({
    contract,
    functionName,
    args,
    value: (value ?? 0n).toString()
  }), action);
}

async function erc1155ApprovalPlan(
  publicClient: PublicClient,
  account: Address | undefined,
  pool: Address,
  operator: Address,
  blockTag?: BlockTag
) {
  const check = account
    ? await tryRead(publicClient, pool, contractAbis.dlmmPool as Abi, "isApprovedForAll", [account, operator], blockTag)
    : undefined;
  const approvalRequired = check ? !(check.ok && check.result === true) : true;

  return {
    pool,
    operator,
    check,
    approvalRequired,
    buildCall: approvalRequired
      ? { tool: "pharaoh_encode_approval", arguments: { standard: "dlmmPool", tokenAddress: pool, operator, approved: true } }
      : null
  };
}

async function legacyLiquidityPlan(
  publicClient: PublicClient,
  input: {
    action: "add" | "remove";
    account?: Address;
    recipient: Address;
    tokenA?: string;
    tokenB?: string;
    stable?: boolean;
    amountA?: string | number;
    amountB?: string | number;
    amountAMin?: string | number;
    amountBMin?: string | number;
    liquidity?: string | number;
    slippageBps: bigint;
    deadline: bigint;
    blockTag?: BlockTag;
  }
) {
  const tokenA = normalizeLiquidityToken(input.tokenA, "tokenA");
  const tokenB = normalizeLiquidityToken(input.tokenB, "tokenB");
  if (tokenA.wrappedAddress.toLowerCase() === tokenB.wrappedAddress.toLowerCase()) {
    throw new Error("tokenA and tokenB resolve to the same token.");
  }
  if (tokenA.isNative && tokenB.isNative) {
    throw new Error("Only one side of a legacy liquidity plan can be native AVAX.");
  }
  const stable = input.stable ?? false;
  const pairRead = await tryRunContractFunction(publicClient, {
    contract: "pairFactory",
    functionName: "getPair",
    args: [tokenA.wrappedAddress, tokenB.wrappedAddress, stable],
    blockTag: input.blockTag
  });
  const pair = readResultAddress(pairRead) ?? ZERO_ADDRESS;
  const pairExists = pair !== ZERO_ADDRESS;

  if (input.action === "add") {
    const amountADesired = parseBigIntLike(input.amountA, "amountA");
    const amountBDesired = parseBigIntLike(input.amountB, "amountB");
    const quote = await tryRunContractFunction(publicClient, {
      contract: "router",
      functionName: "quoteAddLiquidity",
      args: [tokenA.wrappedAddress, tokenB.wrappedAddress, stable, amountADesired, amountBDesired],
      blockTag: input.blockTag
    });
    const quotedA = tupleBigIntAt(quote, 0) ?? amountADesired;
    const quotedB = tupleBigIntAt(quote, 1) ?? amountBDesired;
    const amountAMin = minWithOptional(input.amountAMin, applySlippageDown(quotedA, input.slippageBps), "amountAMin");
    const amountBMin = minWithOptional(input.amountBMin, applySlippageDown(quotedB, input.slippageBps), "amountBMin");
    const nativeSide = tokenA.isNative ? "A" : tokenB.isNative ? "B" : null;
    const approvals = await Promise.all([
      tokenA.isNative ? undefined : approvalPlan(publicClient, input.account, tokenA.address, contractRegistry.router.address, amountADesired, input.blockTag),
      tokenB.isNative ? undefined : approvalPlan(publicClient, input.account, tokenB.address, contractRegistry.router.address, amountBDesired, input.blockTag)
    ]);
    const functionName = nativeSide ? "addLiquidityETH" : "addLiquidity";
    const args = nativeSide === "A"
      ? [tokenB.wrappedAddress, stable, amountBDesired, amountBMin, amountAMin, input.recipient, input.deadline]
      : nativeSide === "B"
        ? [tokenA.wrappedAddress, stable, amountADesired, amountAMin, amountBMin, input.recipient, input.deadline]
        : [tokenA.wrappedAddress, tokenB.wrappedAddress, stable, amountADesired, amountBDesired, amountAMin, amountBMin, input.recipient, input.deadline];
    const value = nativeSide === "A" ? amountADesired : nativeSide === "B" ? amountBDesired : 0n;
    const blockers = [
      ...(quote.ok ? [] : [`legacy add-liquidity quote failed: ${compactError(String(quote.error))}`])
    ];
    const canBuild = blockers.length === 0;

    return {
      protocol: "legacy",
      action: input.action,
      tokenA,
      tokenB,
      stable,
      pair,
      pairExists,
      pairRead,
      quote,
      amounts: { amountADesired, amountBDesired, quotedA, quotedB, amountAMin, amountBMin, slippageBps: input.slippageBps },
      approvals: suppressNestedBuildCallsIfBlocked(approvals.filter(Boolean), canBuild, "legacy add-liquidity approval"),
      buildCall: canBuild
        ? { tool: "pharaoh_legacy_liquidity_build_tx", arguments: { action: functionName, args, value: value.toString() } }
        : null,
      tx: canBuild ? planTx("router", functionName, args, value, functionName) : null,
      simulateCall: canBuild && input.account
        ? { tool: "pharaoh_simulate_tx", arguments: { account: input.account, contract: "router", functionName, args, value: value.toString() } }
        : null,
      canBuild,
      blockers,
      warnings: planWarnings("legacy")
    };
  }

  const liquidity = parseBigIntLike(input.liquidity, "liquidity");
  const quote = await tryRunContractFunction(publicClient, {
    contract: "router",
    functionName: "quoteRemoveLiquidity",
    args: [tokenA.wrappedAddress, tokenB.wrappedAddress, stable, liquidity],
    blockTag: input.blockTag
  });
  const quotedA = tupleBigIntAt(quote, 0);
  const quotedB = tupleBigIntAt(quote, 1);
  const amountAMin = minWithOptional(input.amountAMin, quotedA === undefined ? 0n : applySlippageDown(quotedA, input.slippageBps), "amountAMin");
  const amountBMin = minWithOptional(input.amountBMin, quotedB === undefined ? 0n : applySlippageDown(quotedB, input.slippageBps), "amountBMin");
  const approval = pair !== ZERO_ADDRESS
    ? await approvalPlan(publicClient, input.account, pair, contractRegistry.router.address, liquidity, input.blockTag)
    : null;
  const nativeSide = tokenA.isNative ? "A" : tokenB.isNative ? "B" : null;
  const functionName = nativeSide ? "removeLiquidityETH" : "removeLiquidity";
  const args = nativeSide === "A"
    ? [tokenB.wrappedAddress, stable, liquidity, amountBMin, amountAMin, input.recipient, input.deadline]
    : nativeSide === "B"
      ? [tokenA.wrappedAddress, stable, liquidity, amountAMin, amountBMin, input.recipient, input.deadline]
      : [tokenA.wrappedAddress, tokenB.wrappedAddress, stable, liquidity, amountAMin, amountBMin, input.recipient, input.deadline];
  const blockers = [
    ...(pairExists ? [] : ["legacy pair does not exist for tokenA/tokenB/stable"]),
    ...(quote.ok ? [] : [`legacy remove-liquidity quote failed: ${compactError(String(quote.error))}`]),
    ...(quotedA === undefined && input.amountAMin === undefined ? ["could not derive amountAMin; pass amountAMin explicitly"] : []),
    ...(quotedB === undefined && input.amountBMin === undefined ? ["could not derive amountBMin; pass amountBMin explicitly"] : [])
  ];
  const canBuild = blockers.length === 0;

  return {
    protocol: "legacy",
    action: input.action,
    tokenA,
    tokenB,
    stable,
    pair,
    pairExists,
    pairRead,
    quote,
    amounts: { liquidity, quotedA, quotedB, amountAMin, amountBMin, slippageBps: input.slippageBps },
    approvals: approval ? suppressNestedBuildCallsIfBlocked([approval], canBuild, "legacy remove-liquidity approval") : [],
    buildCall: canBuild
      ? { tool: "pharaoh_legacy_liquidity_build_tx", arguments: { action: functionName, args, value: "0" } }
      : null,
    tx: canBuild ? planTx("router", functionName, args, 0n, functionName) : null,
    simulateCall: canBuild && input.account
      ? { tool: "pharaoh_simulate_tx", arguments: { account: input.account, contract: "router", functionName, args, value: "0" } }
      : null,
    canBuild,
    blockers,
    warnings: planWarnings("legacy")
  };
}

async function clLiquidityPlan(
  publicClient: PublicClient,
  input: {
    action: "mint" | "increase" | "decrease" | "collect" | "burn";
    account?: Address;
    recipient: Address;
    tokenA?: string;
    tokenB?: string;
    tickSpacing?: string | number;
    tickLower?: string | number;
    tickUpper?: string | number;
    tokenId?: string | number;
    liquidity?: string | number;
    amountA?: string | number;
    amountB?: string | number;
    amountAMin?: string | number;
    amountBMin?: string | number;
    amount0Max?: string | number;
    amount1Max?: string | number;
    sqrtPriceX96?: string | number;
    slippageBps: bigint;
    deadline: bigint;
    blockTag?: BlockTag;
  }
) {
  const warnings = planWarnings("CL");

  if (input.action === "mint") {
    const token0 = normalizeLiquidityToken(input.tokenA, "tokenA");
    const token1 = normalizeLiquidityToken(input.tokenB, "tokenB");
    if (token0.isNative || token1.isNative) warnings.push("CL mint planning uses ERC20 tokens. Use WAVAX instead of native AVAX for position-manager liquidity actions.");
    const tickSpacing = parseBigIntLike(input.tickSpacing, "tickSpacing");
    const tickLower = parseBigIntLike(input.tickLower, "tickLower");
    const tickUpper = parseBigIntLike(input.tickUpper, "tickUpper");
    validateSignedBits(tickSpacing, 24, "tickSpacing");
    validateSignedBits(tickLower, 24, "tickLower");
    validateSignedBits(tickUpper, 24, "tickUpper");
    const amount0Desired = parseBigIntLike(input.amountA, "amountA");
    const amount1Desired = parseBigIntLike(input.amountB, "amountB");
    const amount0Min = minWithOptional(input.amountAMin, applySlippageDown(amount0Desired, input.slippageBps), "amountAMin");
    const amount1Min = minWithOptional(input.amountBMin, applySlippageDown(amount1Desired, input.slippageBps), "amountBMin");
    const preflight = await clV3QuotePreflight(publicClient, { tokenIn: token0.wrappedAddress, tokenOut: token1.wrappedAddress, tickSpacing }, input.blockTag);
    const approvals = await Promise.all([
      approvalPlan(publicClient, input.account, token0.address, contractRegistry.ramsesV3PositionManager.address, amount0Desired, input.blockTag),
      approvalPlan(publicClient, input.account, token1.address, contractRegistry.ramsesV3PositionManager.address, amount1Desired, input.blockTag)
    ]);
    const params = {
      token0: token0.wrappedAddress,
      token1: token1.wrappedAddress,
      tickSpacing,
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      amount0Min,
      amount1Min,
      recipient: input.recipient,
      deadline: input.deadline
    };
    const args = [params];
    const sqrtPriceX96 = input.sqrtPriceX96 === undefined ? undefined : parseBigIntLike(input.sqrtPriceX96, "sqrtPriceX96");
    const createAndInitializeCall = !preflight.poolExists && sqrtPriceX96 !== undefined
      ? {
        tool: "pharaoh_cl_liquidity_build_tx",
        arguments: {
          action: "createAndInitializePoolIfNecessary",
          args: [token0.wrappedAddress, token1.wrappedAddress, tickSpacing, sqrtPriceX96],
          value: "0"
        }
      }
      : null;
    const blockers = [
      ...(token0.isNative || token1.isNative ? ["CL mint requires ERC20 token addresses; use WAVAX rather than native AVAX."] : []),
      ...(tickLower < tickUpper ? [] : ["tickLower must be below tickUpper"]),
      ...(preflight.poolExists ? [] : ["CL pool does not exist; create/initialize it before minting"]),
      ...preflight.blockers.filter((blocker) => blocker.code !== "pool_no_liquidity").map((blocker) => blocker.message)
    ];
    const canBuild = blockers.length === 0;

    return {
      protocol: "cl",
      action: input.action,
      token0,
      token1,
      route: { tickSpacing, tickLower, tickUpper },
      preflight,
      createAndInitializeCall,
      amounts: { amount0Desired, amount1Desired, amount0Min, amount1Min, slippageBps: input.slippageBps },
      approvals: suppressNestedBuildCallsIfBlocked(approvals, canBuild, "CL mint approval"),
      buildCall: canBuild
        ? { tool: "pharaoh_cl_liquidity_build_tx", arguments: { action: "mint", args, value: "0" } }
        : null,
      tx: canBuild ? planTx("ramsesV3PositionManager", "mint((address,address,int24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))", args, 0n, "mint") : null,
      simulateCall: canBuild && input.account
        ? { tool: "pharaoh_simulate_tx", arguments: { account: input.account, contract: "ramsesV3PositionManager", functionName: "mint((address,address,int24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))", args, value: "0" } }
        : null,
      canBuild,
      blockers,
      warnings
    };
  }

  const tokenId = parseBigIntLike(input.tokenId, "tokenId");
  const position = await tryRunContractFunction(publicClient, { contract: "ramsesV3PositionManager", functionName: "positions", args: [tokenId], blockTag: input.blockTag });
  const ownerOf = await tryRead(publicClient, contractRegistry.ramsesV3PositionManager.address, contractAbis.erc721Read as Abi, "ownerOf", [tokenId], input.blockTag);
  const token0 = maybeAddress(resultField(position.ok ? position.result : undefined, 0, "token0"));
  const token1 = maybeAddress(resultField(position.ok ? position.result : undefined, 1, "token1"));
  const currentLiquidity = (() => {
    const raw = resultField(position.ok ? position.result : undefined, 5, "liquidity");
    return raw === undefined ? undefined : BigInt(String(raw));
  })();

  if (input.action === "increase") {
    const amount0Desired = parseBigIntLike(input.amountA, "amountA");
    const amount1Desired = parseBigIntLike(input.amountB, "amountB");
    const amount0Min = minWithOptional(input.amountAMin, applySlippageDown(amount0Desired, input.slippageBps), "amountAMin");
    const amount1Min = minWithOptional(input.amountBMin, applySlippageDown(amount1Desired, input.slippageBps), "amountBMin");
    const approvals = await Promise.all([
      token0 ? approvalPlan(publicClient, input.account, token0, contractRegistry.ramsesV3PositionManager.address, amount0Desired, input.blockTag) : undefined,
      token1 ? approvalPlan(publicClient, input.account, token1, contractRegistry.ramsesV3PositionManager.address, amount1Desired, input.blockTag) : undefined
    ]);
    const params = { tokenId, amount0Desired, amount1Desired, amount0Min, amount1Min, deadline: input.deadline };
    const args = [params];
    const blockers = [
      ...(position.ok ? [] : [`CL position read failed: ${compactError(String(position.error))}`]),
      ...(token0 && token1 ? [] : ["could not derive position token0/token1 for approval planning"])
    ];
    const canBuild = blockers.length === 0;

    return {
      protocol: "cl",
      action: input.action,
      tokenId,
      position,
      ownerOf,
      token0,
      token1,
      amounts: { amount0Desired, amount1Desired, amount0Min, amount1Min, slippageBps: input.slippageBps },
      approvals: suppressNestedBuildCallsIfBlocked(approvals.filter(Boolean), canBuild, "CL increase approval"),
      buildCall: canBuild ? { tool: "pharaoh_cl_liquidity_build_tx", arguments: { action: "increaseLiquidity", args, value: "0" } } : null,
      tx: canBuild ? planTx("ramsesV3PositionManager", "increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))", args, 0n, "increaseLiquidity") : null,
      simulateCall: canBuild && input.account
        ? { tool: "pharaoh_simulate_tx", arguments: { account: input.account, contract: "ramsesV3PositionManager", functionName: "increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))", args, value: "0" } }
        : null,
      canBuild,
      blockers,
      warnings
    };
  }

  if (input.action === "decrease") {
    const liquidity = parseBigIntLike(input.liquidity, "liquidity");
    const amount0Min = parseBigIntLike(input.amountAMin ?? 0, "amountAMin");
    const amount1Min = parseBigIntLike(input.amountBMin ?? 0, "amountBMin");
    const params = { tokenId, liquidity, amount0Min, amount1Min, deadline: input.deadline };
    const args = [params];
    const blockers = [
      ...(position.ok ? [] : [`CL position read failed: ${compactError(String(position.error))}`]),
      ...(currentLiquidity === undefined || currentLiquidity >= liquidity ? [] : ["requested liquidity exceeds current position liquidity"])
    ];

    return {
      protocol: "cl",
      action: input.action,
      tokenId,
      position,
      ownerOf,
      currentLiquidity,
      amounts: { liquidity, amount0Min, amount1Min },
      approvals: [],
      buildCall: blockers.length === 0 ? { tool: "pharaoh_cl_liquidity_build_tx", arguments: { action: "decreaseLiquidity", args, value: "0" } } : null,
      tx: blockers.length === 0 ? planTx("ramsesV3PositionManager", "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))", args, 0n, "decreaseLiquidity") : null,
      simulateCall: blockers.length === 0 && input.account
        ? { tool: "pharaoh_simulate_tx", arguments: { account: input.account, contract: "ramsesV3PositionManager", functionName: "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))", args, value: "0" } }
        : null,
      canBuild: blockers.length === 0,
      blockers,
      warnings
    };
  }

  if (input.action === "collect") {
    const amount0Max = parseBigIntLike(input.amount0Max ?? ((1n << 128n) - 1n), "amount0Max");
    const amount1Max = parseBigIntLike(input.amount1Max ?? ((1n << 128n) - 1n), "amount1Max");
    validateUnsignedBits(amount0Max, 128, "amount0Max");
    validateUnsignedBits(amount1Max, 128, "amount1Max");
    const params = { tokenId, recipient: input.recipient, amount0Max, amount1Max };
    const args = [params];
    const blockers = [
      ...(position.ok ? [] : [`CL position read failed: ${compactError(String(position.error))}`])
    ];

    return {
      protocol: "cl",
      action: input.action,
      tokenId,
      position,
      ownerOf,
      amounts: { amount0Max, amount1Max },
      approvals: [],
      buildCall: blockers.length === 0 ? { tool: "pharaoh_cl_liquidity_build_tx", arguments: { action: "collect", args, value: "0" } } : null,
      tx: blockers.length === 0 ? planTx("ramsesV3PositionManager", "collect((uint256,address,uint128,uint128))", args, 0n, "collect") : null,
      simulateCall: blockers.length === 0 && input.account
        ? { tool: "pharaoh_simulate_tx", arguments: { account: input.account, contract: "ramsesV3PositionManager", functionName: "collect((uint256,address,uint128,uint128))", args, value: "0" } }
        : null,
      canBuild: blockers.length === 0,
      blockers,
      warnings
    };
  }

  const args = [tokenId];
  const blockers = [
    ...(position.ok ? [] : [`CL position read failed: ${compactError(String(position.error))}`]),
    ...(currentLiquidity === undefined || currentLiquidity === 0n ? [] : ["position still has nonzero liquidity; decrease and collect before burn"])
  ];

  return {
    protocol: "cl",
    action: input.action,
    tokenId,
    position,
    ownerOf,
    currentLiquidity,
    approvals: [],
    buildCall: blockers.length === 0 ? { tool: "pharaoh_cl_liquidity_build_tx", arguments: { action: "burn", args, value: "0" } } : null,
    tx: blockers.length === 0 ? planTx("ramsesV3PositionManager", "burn(uint256)", args, 0n, "burn") : null,
    simulateCall: blockers.length === 0 && input.account
      ? { tool: "pharaoh_simulate_tx", arguments: { account: input.account, contract: "ramsesV3PositionManager", functionName: "burn", args, value: "0" } }
      : null,
    canBuild: blockers.length === 0,
    blockers,
    warnings
  };
}

async function dlmmLiquidityPlan(
  publicClient: PublicClient,
  input: {
    action: "add" | "remove";
    account?: Address;
    recipient: Address;
    refundTo: Address;
    tokenX?: string;
    tokenY?: string;
    pair?: string;
    binStep?: string | number;
    amountX?: string | number;
    amountY?: string | number;
    amountXMin?: string | number;
    amountYMin?: string | number;
    activeIdDesired?: string | number;
    idSlippage?: string | number;
    deltaIds?: Array<string | number>;
    distributionX?: Array<string | number>;
    distributionY?: Array<string | number>;
    ids?: Array<string | number>;
    amounts?: Array<string | number>;
    slippageBps: bigint;
    deadline: bigint;
    blockTag?: BlockTag;
  }
) {
  const tokenX = normalizeLiquidityToken(input.tokenX, "tokenX");
  const tokenY = normalizeLiquidityToken(input.tokenY, "tokenY");
  if (tokenX.wrappedAddress.toLowerCase() === tokenY.wrappedAddress.toLowerCase()) {
    throw new Error("tokenX and tokenY resolve to the same token.");
  }
  if (tokenX.isNative && tokenY.isNative) {
    throw new Error("Only one side of a DLMM liquidity plan can be native AVAX.");
  }
  const binStep = parseBigIntLike(input.binStep, "binStep");
  validateUnsignedBits(binStep, 16, "binStep");
  const pairInfo = input.pair ? undefined : await tryRunContractFunction(publicClient, {
    contract: "dlmmFactory",
    functionName: "getLBPairInformation",
    args: [tokenX.wrappedAddress, tokenY.wrappedAddress, binStep],
    blockTag: input.blockTag
  });
  const pair = input.pair ? asAddress(input.pair, "pair") : parseDlmmPairInfo(pairInfo?.ok ? pairInfo.result : undefined).pair;
  const pairExists = pair !== ZERO_ADDRESS;
  const [activeIdRead, tokenXRead, tokenYRead] = pairExists
    ? await Promise.all([
      tryRunContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getActiveId", addressOverride: pair, blockTag: input.blockTag }),
      tryRunContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getTokenX", addressOverride: pair, blockTag: input.blockTag }),
      tryRunContractFunction(publicClient, { contract: "dlmmPoolImplementation", functionName: "getTokenY", addressOverride: pair, blockTag: input.blockTag })
    ])
    : [{ ok: false, error: "DLMM pair not found." }, { ok: false, error: "DLMM pair not found." }, { ok: false, error: "DLMM pair not found." }];
  const poolTokenX = readResultAddress(tokenXRead);
  const poolTokenY = readResultAddress(tokenYRead);
  const tokenDirectionOk = poolTokenX && poolTokenY
    ? poolTokenX.toLowerCase() === tokenX.wrappedAddress.toLowerCase() && poolTokenY.toLowerCase() === tokenY.wrappedAddress.toLowerCase()
    : false;
  const warnings = planWarnings("DLMM");

  if (input.action === "add") {
    const amountX = parseBigIntLike(input.amountX, "amountX");
    const amountY = parseBigIntLike(input.amountY, "amountY");
    validateUnsignedBits(amountX, 128, "amountX");
    validateUnsignedBits(amountY, 128, "amountY");
    const amountXMin = minWithOptional(input.amountXMin, applySlippageDown(amountX, input.slippageBps), "amountXMin");
    const amountYMin = minWithOptional(input.amountYMin, applySlippageDown(amountY, input.slippageBps), "amountYMin");
    const activeIdDesired = input.activeIdDesired === undefined
      ? readResultBigInt(activeIdRead)
      : parseBigIntLike(input.activeIdDesired, "activeIdDesired");
    const idSlippage = parseBigIntLike(input.idSlippage ?? 20, "idSlippage");
    const deltaIds = (input.deltaIds ?? [0]).map((value, index) => {
      const parsed = parseBigIntLike(value, `deltaIds[${index}]`);
      validateSignedBits(parsed, 256, `deltaIds[${index}]`);
      return parsed;
    });
    const distributionX = (input.distributionX ?? [amountX > 0n ? 1_000_000_000_000_000_000n : 0n]).map((value, index) => parseBigIntLike(value, `distributionX[${index}]`));
    const distributionY = (input.distributionY ?? [amountY > 0n ? 1_000_000_000_000_000_000n : 0n]).map((value, index) => parseBigIntLike(value, `distributionY[${index}]`));
    const approvals = await Promise.all([
      tokenX.isNative ? undefined : approvalPlan(publicClient, input.account, tokenX.address, contractRegistry.dlmmRouter.address, amountX, input.blockTag),
      tokenY.isNative ? undefined : approvalPlan(publicClient, input.account, tokenY.address, contractRegistry.dlmmRouter.address, amountY, input.blockTag)
    ]);
    const params = {
      tokenX: tokenX.wrappedAddress,
      tokenY: tokenY.wrappedAddress,
      binStep,
      amountX,
      amountY,
      amountXMin,
      amountYMin,
      activeIdDesired,
      idSlippage,
      deltaIds,
      distributionX,
      distributionY,
      to: input.recipient,
      refundTo: input.refundTo,
      deadline: input.deadline
    };
    const nativeSide = tokenX.isNative ? "X" : tokenY.isNative ? "Y" : null;
    const functionName = nativeSide ? "addLiquidityNATIVE" : "addLiquidity";
    const value = nativeSide === "X" ? amountX : nativeSide === "Y" ? amountY : 0n;
    const args = [params];
    const blockers = [
      ...(pairExists ? [] : ["DLMM pair does not exist for tokenX/tokenY/binStep"]),
      ...(tokenDirectionOk ? [] : ["tokenX/tokenY direction does not match the deployed DLMM pair"]),
      ...(activeIdDesired !== undefined ? [] : ["could not derive activeIdDesired; pass activeIdDesired explicitly"]),
      ...(deltaIds.length === distributionX.length && deltaIds.length === distributionY.length ? [] : ["deltaIds, distributionX, and distributionY must have the same length"])
    ];
    const canBuild = blockers.length === 0;

    return {
      protocol: "dlmm",
      action: input.action,
      tokenX,
      tokenY,
      pair,
      pairExists,
      pairInfo,
      activeId: activeIdRead,
      poolTokens: { tokenX: poolTokenX, tokenY: poolTokenY, tokenDirectionOk },
      amounts: { amountX, amountY, amountXMin, amountYMin, activeIdDesired, idSlippage, deltaIds, distributionX, distributionY, slippageBps: input.slippageBps },
      approvals: suppressNestedBuildCallsIfBlocked(approvals.filter(Boolean), canBuild, "DLMM add-liquidity approval"),
      buildCall: canBuild ? { tool: "pharaoh_dlmm_build_tx", arguments: { action: functionName, args, value: value.toString() } } : null,
      tx: canBuild ? planTx("dlmmRouter", `${functionName}((address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,int256[],uint256[],uint256[],address,address,uint256))`, args, value, functionName) : null,
      simulateCall: canBuild && input.account
        ? { tool: "pharaoh_simulate_tx", arguments: { account: input.account, contract: "dlmmRouter", functionName, args, value: value.toString() } }
        : null,
      canBuild,
      blockers,
      warnings
    };
  }

  const ids = (input.ids ?? []).map((value, index) => parseBigIntLike(value, `ids[${index}]`));
  const amounts = (input.amounts ?? []).map((value, index) => parseBigIntLike(value, `amounts[${index}]`));
  const amountXMin = parseBigIntLike(input.amountXMin ?? 0, "amountXMin");
  const amountYMin = parseBigIntLike(input.amountYMin ?? 0, "amountYMin");
  const approval = pairExists ? await erc1155ApprovalPlan(publicClient, input.account, pair, contractRegistry.dlmmRouter.address, input.blockTag) : null;
  const nativeSide = tokenX.isNative || tokenY.isNative;
  const functionName = nativeSide ? "removeLiquidityNATIVE" : "removeLiquidity";
  const args = nativeSide
    ? [
      tokenX.isNative ? tokenY.wrappedAddress : tokenX.wrappedAddress,
      binStep,
      tokenX.isNative ? amountYMin : amountXMin,
      tokenX.isNative ? amountXMin : amountYMin,
      ids,
      amounts,
      input.recipient,
      input.deadline
    ]
    : [tokenX.wrappedAddress, tokenY.wrappedAddress, binStep, amountXMin, amountYMin, ids, amounts, input.recipient, input.deadline];
  const blockers = [
    ...(pairExists ? [] : ["DLMM pair does not exist for tokenX/tokenY/binStep"]),
    ...(tokenDirectionOk ? [] : ["tokenX/tokenY direction does not match the deployed DLMM pair"]),
    ...(ids.length > 0 ? [] : ["ids are required for DLMM remove"]),
    ...(ids.length === amounts.length ? [] : ["ids and amounts must have the same length"])
  ];
  const canBuild = blockers.length === 0;

  return {
    protocol: "dlmm",
    action: input.action,
    tokenX,
    tokenY,
    pair,
    pairExists,
    pairInfo,
    activeId: activeIdRead,
    poolTokens: { tokenX: poolTokenX, tokenY: poolTokenY, tokenDirectionOk },
    amounts: { amountXMin, amountYMin, ids, amounts },
    approvals: approval ? suppressNestedBuildCallsIfBlocked([approval], canBuild, "DLMM remove-liquidity approval") : [],
    buildCall: canBuild ? { tool: "pharaoh_dlmm_build_tx", arguments: { action: functionName, args, value: "0" } } : null,
    tx: canBuild ? planTx("dlmmRouter", functionName, args, 0n, functionName) : null,
    simulateCall: canBuild && input.account
      ? { tool: "pharaoh_simulate_tx", arguments: { account: input.account, contract: "dlmmRouter", functionName, args, value: "0" } }
      : null,
    canBuild,
    blockers,
    warnings
  };
}

// === LIQUIDITY PLANNING ===

/** @summary Plan liquidity provision: quote, approval checks, position parameters for CL/DLMM/legacy */

export async function liquidityPlan(
  publicClient: PublicClient,
  input: {
    protocol: "legacy" | "cl" | "dlmm";
    action: "add" | "remove" | "mint" | "increase" | "decrease" | "collect" | "burn";
    account?: string;
    recipient?: string;
    refundTo?: string;
    tokenA?: string;
    tokenB?: string;
    tokenX?: string;
    tokenY?: string;
    pair?: string;
    stable?: boolean;
    tickSpacing?: string | number;
    tickLower?: string | number;
    tickUpper?: string | number;
    tokenId?: string | number;
    binStep?: string | number;
    amountA?: string | number;
    amountB?: string | number;
    amountAMin?: string | number;
    amountBMin?: string | number;
    amountX?: string | number;
    amountY?: string | number;
    amountXMin?: string | number;
    amountYMin?: string | number;
    amount0Max?: string | number;
    amount1Max?: string | number;
    liquidity?: string | number;
    sqrtPriceX96?: string | number;
    activeIdDesired?: string | number;
    idSlippage?: string | number;
    deltaIds?: Array<string | number>;
    distributionX?: Array<string | number>;
    distributionY?: Array<string | number>;
    ids?: Array<string | number>;
    amounts?: Array<string | number>;
    slippageBps?: string | number;
    deadline?: string | number;
    blockTag?: BlockTag;
  }
) {
  const account = input.account ? asAddress(input.account, "account") : undefined;
  const recipient = input.recipient ? asAddress(input.recipient, "recipient") : account;
  if (!recipient) throw new Error("recipient or account is required for liquidity planning.");
  const refundTo = input.refundTo ? asAddress(input.refundTo, "refundTo") : recipient;
  const slippageBps = parseBigIntLike(input.slippageBps ?? 50, "slippageBps");
  if (slippageBps < 0n || slippageBps > 10_000n) {
    throw new Error("slippageBps must be between 0 and 10000.");
  }
  const deadline = input.deadline !== undefined
    ? parseBigIntLike(input.deadline, "deadline")
    : BigInt(Math.floor(Date.now() / 1000) + 1800);

  const base = {
    chainId: CHAIN_ID,
    account,
    recipient,
    refundTo,
    blockTag: input.blockTag ?? "latest"
  };

  if (input.protocol === "legacy") {
    if (input.action !== "add" && input.action !== "remove") throw new Error("Legacy liquidity plan supports action add or remove.");
    return {
      ...base,
      ...(await legacyLiquidityPlan(publicClient, { ...input, action: input.action, account, recipient, slippageBps, deadline }))
    };
  }

  if (input.protocol === "cl") {
    if (!["mint", "increase", "decrease", "collect", "burn"].includes(input.action)) {
      throw new Error("CL liquidity plan supports action mint, increase, decrease, collect, or burn.");
    }
    return {
      ...base,
      ...(await clLiquidityPlan(publicClient, { ...input, action: input.action as "mint" | "increase" | "decrease" | "collect" | "burn", account, recipient, slippageBps, deadline }))
    };
  }

  if (input.action !== "add" && input.action !== "remove") throw new Error("DLMM liquidity plan supports action add or remove.");
  return {
    ...base,
    ...(await dlmmLiquidityPlan(publicClient, {
      ...input,
      action: input.action,
      account,
      recipient,
      refundTo,
      tokenX: input.tokenX ?? input.tokenA,
      tokenY: input.tokenY ?? input.tokenB,
      slippageBps,
      deadline
    }))
  };
}

// === REWARDS ===

/** @summary Read reward balances, claimable amounts, and gauge info for an account */

export async function rewardsRead(
  publicClient: PublicClient,
  input: {
    domain: "legacyGauge" | "clGauge" | "feeDistributor" | "dlmmRewarder" | "autoVault" | "p33";
    action: string;
    addressOverride?: string;
    args?: unknown[];
    account?: string;
    token?: string;
    outputToken?: string;
    tokenId?: string | number;
    period?: string | number;
    ids?: Array<string | number>;
    blockTag?: BlockTag;
  }
) {
  const account = input.account ? asAddress(input.account, "account") : undefined;
  const token = input.token ? asAddress(input.token, "token") : undefined;
  const outputToken = input.outputToken ? asAddress(input.outputToken, "outputToken") : undefined;

  const mapped = (() => {
    if (input.domain === "legacyGauge") {
      const argsByAction = {
        rewardsList: [],
        rewardsListLength: [],
        earned: [token, account],
        rewardData: [token],
        left: [token],
        balanceOf: [account]
      } as Record<string, unknown[]>;
      return { contract: "legacyGauge", functionName: input.action, args: input.args ?? argsByAction[input.action] };
    }
    if (input.domain === "clGauge") {
      const argsByAction = {
        getRewardTokens: [],
        earned: token && account && input.tokenId !== undefined ? [token, account, parseBigIntLike(input.tokenId, "tokenId")] : [token, parseBigIntLike(input.tokenId, "tokenId")],
        periodEarned: input.period !== undefined && token && input.tokenId !== undefined ? [parseBigIntLike(input.period, "period"), token, parseBigIntLike(input.tokenId, "tokenId")] : undefined,
        left: [token],
        rewardRate: [token]
      } as Record<string, unknown[] | undefined>;
      return { contract: "clGaugeV3", functionName: input.action, args: input.args ?? argsByAction[input.action] };
    }
    if (input.domain === "feeDistributor") {
      const argsByAction = {
        getRewardTokens: [],
        earned: [token, account],
        balanceOf: [account],
        rewardSupply: () => [parseBigIntLike(input.period, "period"), token],
        userVotes: () => [parseBigIntLike(input.period, "period"), account]
      } as Record<string, unknown[] | (() => unknown[])>;
      const mappedArgs = input.args ?? argsByAction[input.action];
      return { contract: "feeDistributor", functionName: input.action, args: typeof mappedArgs === "function" ? mappedArgs() : mappedArgs };
    }
    if (input.domain === "dlmmRewarder") {
      const ids = (input.ids ?? []).map((id, index) => parseBigIntLike(id, `ids[${index}]`));
      const argsByAction = {
        getPendingRewards: [account, ids],
        getRewardToken: [],
        getRemainingRewards: [],
        getRewardedRange: [],
        getRewarderParameter: [],
        getLBPair: []
      } as Record<string, unknown[]>;
      return { contract: "dlmmRewarderImplementation", functionName: input.action, args: input.args ?? argsByAction[input.action] };
    }
    if (input.domain === "autoVault") {
      const argsByAction = {
        earned: [account],
        balanceOf: [account],
        getOutputTokens: [],
        outputPreference: [account],
        isUnlocked: [],
        getAggregators: [],
        getClaimedInputTokens: [],
        getInputBudget: token && outputToken ? [token, outputToken] : undefined,
        getPeriod: [],
        getPendingSwaps: [],
        getPendingSwapsPaginated: undefined,
        getStoredRewards: [account],
        pendingSwapCount: [],
        rewardPerToken: [token],
        totalSupply: [],
        totalSupplyPerOutput: [outputToken ?? token]
      } as Record<string, unknown[] | undefined>;
      return { contract: "autoVault", functionName: input.action, args: input.args ?? argsByAction[input.action] };
    }
    const argsByAction = {
      balanceOf: [account],
      maxRedeem: [account],
      maxWithdraw: [account],
      totalAssets: [],
      totalSupply: [],
      isUnlocked: [],
      isCooldownActive: [],
      getPeriod: [],
      periodUnlockStatus: () => [parseBigIntLike(input.period, "period")]
    } as Record<string, unknown[] | (() => unknown[])>;
    const mappedArgs = input.args ?? argsByAction[input.action];
    return { contract: "p33", functionName: input.action, args: typeof mappedArgs === "function" ? mappedArgs() : mappedArgs };
  })();

  if (!mapped.args) {
    throw new Error(`No argument mapping for ${input.domain}.${input.action}; pass raw args.`);
  }

  return runContractFunction(publicClient, {
    contract: mapped.contract,
    functionName: mapped.functionName,
    args: mapped.args,
    addressOverride: input.addressOverride,
    blockTag: input.blockTag
  });
}

async function discoverClTokenIds(
  publicClient: PublicClient,
  account: Address,
  maxTokenIds: number,
  blockTag?: BlockTag
) {
  const balanceRead = await tryRead(publicClient, contractRegistry.ramsesV3PositionManager.address, contractAbis.ramsesV3PositionManager as Abi, "balanceOf", [account], blockTag);
  const balance = readResultBigInt(balanceRead) ?? 0n;
  const count = Number(balance > BigInt(maxTokenIds) ? BigInt(maxTokenIds) : balance);
  const tokenIds = [];

  for (let index = 0; index < count; index += 1) {
    const tokenId = await tryRead(publicClient, contractRegistry.ramsesV3PositionManager.address, contractAbis.ramsesV3PositionManager as Abi, "tokenOfOwnerByIndex", [account, BigInt(index)], blockTag);
    if (tokenId.ok) tokenIds.push(tokenId.result);
  }

  return {
    balance: balanceRead,
    tokenIds,
    truncated: balance > BigInt(count)
  };
}

async function walletRewardContext(
  publicClient: PublicClient,
  clNfts: { ok: boolean; result?: unknown },
  dlmmPools: unknown,
  blockTag?: BlockTag
) {
  const clByPool = new Map<string, {
    pool: Address;
    tokenIds: string[];
    sourcePositions: Array<{ tokenId: string; token0: Address; token1: Address; tickSpacing: string }>;
  }>();
  const clWarnings = [];

  if (clNfts.ok && clNfts.result && typeof clNfts.result === "object") {
    const positions = (clNfts.result as { positions?: unknown }).positions;
    if (Array.isArray(positions)) {
      for (const positionEntry of positions) {
        if (!positionEntry || typeof positionEntry !== "object") continue;
        const { tokenId, position } = positionEntry as { tokenId?: unknown; position?: { ok?: boolean; result?: unknown } };
        if (tokenId === undefined || !position?.ok) continue;
        const token0 = maybeAddress(resultField(position.result, 0, "token0"));
        const token1 = maybeAddress(resultField(position.result, 1, "token1"));
        const tickSpacingValue = resultField(position.result, 2, "tickSpacing");
        if (!token0 || !token1 || tickSpacingValue === undefined) {
          clWarnings.push({ tokenId: String(tokenId), warning: "Could not derive token0/token1/tickSpacing from CL position." });
          continue;
        }
        const poolRead = await tryRunContractFunction(publicClient, {
          contract: "ramsesV3Factory",
          functionName: "getPool",
          args: [token0, token1, tickSpacingValue],
          blockTag
        });
        const pool = readResultAddress(poolRead);
        if (!pool || pool === ZERO_ADDRESS) {
          clWarnings.push({ tokenId: String(tokenId), token0, token1, tickSpacing: String(tickSpacingValue), warning: "Could not resolve CL pool for position." });
          continue;
        }
        const key = pool.toLowerCase();
        const current = clByPool.get(key) ?? { pool, tokenIds: [], sourcePositions: [] };
        current.tokenIds.push(String(tokenId));
        current.sourcePositions.push({ tokenId: String(tokenId), token0, token1, tickSpacing: String(tickSpacingValue) });
        clByPool.set(key, current);
      }
    }
  }

  const dlmmPairs = [];
  if (Array.isArray(dlmmPools)) {
    for (const poolEntry of dlmmPools) {
      if (!poolEntry || typeof poolEntry !== "object") continue;
      const entry = poolEntry as {
        pair?: unknown;
        rewarder?: unknown;
        nonzeroBalances?: Array<{ id?: unknown }>;
      };
      const pair = maybeAddress(entry.pair);
      if (!pair) continue;
      const ids = (entry.nonzeroBalances ?? [])
        .map((balance) => balance.id)
        .filter((id) => id !== undefined)
        .map((id) => String(id));
      if (ids.length === 0) continue;
      const rewarder = maybeAddress(entry.rewarder);
      dlmmPairs.push({
        pair,
        rewarder,
        ids
      });
    }
  }

  return {
    clPools: Array.from(clByPool.values()).map(({ pool, tokenIds, sourcePositions }) => ({ pool, tokenIds, sourcePositions })),
    dlmmPairs,
    warnings: clWarnings,
    note: "Derived from bounded wallet position discovery. Empty arrays mean no owned CL NFTs or nonzero DLMM bins were found in the supplied scan scope."
  };
}

// === WALLET POSITIONS ===

/** @summary Read all wallet positions across LP pools, gauges, vaults, and NFT holdings */

export async function walletPositionsRead(
  publicClient: PublicClient,
  input: {
    account: string;
    includeAllowances?: boolean;
    includeProtocol?: boolean;
    includeRewards?: boolean;
    extraTokens?: Array<{ symbol?: string; address: string; decimals?: string | number }>;
    spenders?: Array<{ name?: string; address: string }>;
    maxClTokenIds?: number;
    dlmmPools?: Array<{
      pair?: string;
      ids?: Array<string | number>;
      scanRewardedRange?: boolean;
      maxIds?: number;
      operator?: string;
    }>;
    blockTag?: BlockTag;
  }
) {
  const account = asAddress(input.account, "account");
  const includeAllowances = input.includeAllowances !== false;
  const includeProtocol = input.includeProtocol !== false;
  const includeRewards = input.includeRewards === true;
  const tokenInputs = [
    { symbol: "WAVAX", address: contractRegistry.wavax.address, decimals: 18, erc20Metadata: true, erc20Allowances: true, unsupportedReason: undefined },
    { symbol: "USDC", address: contractRegistry.usdcNative.address, decimals: 6, erc20Metadata: true, erc20Allowances: true, unsupportedReason: undefined },
    { symbol: "PHAR", address: contractRegistry.pharToken.address, decimals: 18, erc20Metadata: true, erc20Allowances: true, unsupportedReason: undefined },
    { symbol: "xPHAR", address: contractRegistry.xPharToken.address, decimals: 18, erc20Metadata: true, erc20Allowances: true, unsupportedReason: undefined },
    { symbol: "p33", address: contractRegistry.p33.address, decimals: 18, erc20Metadata: true, erc20Allowances: true, unsupportedReason: undefined },
    {
      symbol: "AutoVault",
      address: contractRegistry.autoVault.address,
      decimals: 18,
      erc20Metadata: false,
      erc20Allowances: false,
      unsupportedReason: "AutoVault exposes source-backed share balance and deposit/withdraw functions, but not standard ERC20 symbol()/allowance(). xPHAR approval to AutoVault is tracked by AutoVault quote/read tools."
    },
    ...(input.extraTokens ?? []).map((token, index) => ({
      symbol: token.symbol ?? `extraToken${index}`,
      address: asAddress(token.address, `extraTokens[${index}].address`),
      decimals: token.decimals === undefined ? undefined : Number(parseBigIntLike(token.decimals, `extraTokens[${index}].decimals`)),
      erc20Metadata: true,
      erc20Allowances: true,
      unsupportedReason: undefined
    }))
  ];
  const dedupedTokens = Array.from(new Map(tokenInputs.map((token) => [token.address.toLowerCase(), token])).values());
  const spenderInputs = input.spenders?.length
    ? input.spenders.map((spender, index) => ({
      name: spender.name ?? `spender${index}`,
      address: asAddress(spender.address, `spenders[${index}].address`)
    }))
    : [
      { name: "legacyRouter", address: contractRegistry.router.address },
      { name: "swapRouter", address: contractRegistry.swapRouter.address },
      { name: "positionManager", address: contractRegistry.ramsesV3PositionManager.address },
      { name: "dlmmRouter", address: contractRegistry.dlmmRouter.address },
      { name: "xPharToken", address: contractRegistry.xPharToken.address },
      { name: "p33", address: contractRegistry.p33.address },
      { name: "voteModule", address: contractRegistry.voteModule.address },
      { name: "autoVault", address: contractRegistry.autoVault.address }
    ];

  const nativeBalance = await tryAsync(() => publicClient.getBalance({ address: account, blockTag: input.blockTag }));
  const tokens = await Promise.all(dedupedTokens.map(async (token) => {
    const unsupportedRead = (functionName: string) => ({
      ok: false,
      skipped: true,
      reason: token.unsupportedReason ?? `${functionName} is not supported by this tracked token surface.`
    });
    const [balance, symbolRead, decimalsRead] = await Promise.all([
      tryRead(publicClient, token.address, contractAbis.erc20Read as Abi, "balanceOf", [account], input.blockTag),
      token.erc20Metadata === false
        ? Promise.resolve(unsupportedRead("symbol()"))
        : tryRead(publicClient, token.address, contractAbis.erc20Read as Abi, "symbol", [], input.blockTag),
      token.decimals === undefined
        ? tryRead(publicClient, token.address, contractAbis.erc20Read as Abi, "decimals", [], input.blockTag)
        : Promise.resolve({ ok: true, result: BigInt(token.decimals) })
    ]);
    const allowances = includeAllowances
      ? token.erc20Allowances === false
        ? []
        : await Promise.all(spenderInputs.map(async (spender) => ({
          spender: spender.address,
          spenderName: spender.name,
          allowance: await tryRead(publicClient, token.address, contractAbis.erc20Read as Abi, "allowance", [account, spender.address], input.blockTag)
        })))
      : undefined;

    return {
      symbol: token.symbol,
      address: token.address,
      erc20MetadataSupported: token.erc20Metadata !== false,
      erc20AllowancesSupported: token.erc20Allowances !== false,
      unsupportedReason: token.erc20Metadata === false || token.erc20Allowances === false ? token.unsupportedReason : undefined,
      chainSymbol: symbolRead,
      decimals: decimalsRead,
      balance,
      allowances
    };
  }));

  const clNfts = includeProtocol
    ? await tryAsync(async () => {
      const discovered = await discoverClTokenIds(publicClient, account, input.maxClTokenIds ?? 50, input.blockTag);
      const tokenIds = discovered.tokenIds.map((tokenId) => BigInt(String(tokenId)));
      const positions = await Promise.all(tokenIds.map(async (tokenId) => ({
        tokenId,
        position: await tryRunContractFunction(publicClient, {
          contract: "ramsesV3PositionManager",
          functionName: "positions",
          args: [tokenId],
          blockTag: input.blockTag
        }),
        owner: await tryRead(publicClient, contractRegistry.ramsesV3PositionManager.address, contractAbis.erc721Read as Abi, "ownerOf", [tokenId], input.blockTag),
        approvedToPositionManager: await tryRead(
          publicClient,
          contractRegistry.ramsesV3PositionManager.address,
          contractAbis.erc721Read as Abi,
          "isApprovedForAll",
          [account, contractRegistry.ramsesV3PositionManager.address],
          input.blockTag
        )
      })));
      return { ...discovered, positions };
    })
    : undefined;

  const dlmmPools = includeProtocol
    ? await Promise.all((input.dlmmPools?.length ? input.dlmmPools : [{ pair: contractRegistry.dlmmWavaxUsdc5Pool.address, ids: [], scanRewardedRange: false }]).map(async (poolInput, index) => {
      const pair = poolInput.pair ? asAddress(poolInput.pair, `dlmmPools[${index}].pair`) : contractRegistry.dlmmWavaxUsdc5Pool.address;
      const operator = poolInput.operator ? asAddress(poolInput.operator, `dlmmPools[${index}].operator`) : contractRegistry.dlmmRouter.address;
      const rewarder = readResultAddress(await tryRunContractFunction(publicClient, {
        contract: "dlmmRewarderFactory",
        functionName: "getRewarder",
        args: [pair],
        blockTag: input.blockTag
      })) ?? ZERO_ADDRESS;
      const rewardedRange = rewarder !== ZERO_ADDRESS
        ? await tryRunContractFunction(publicClient, {
          contract: "dlmmRewarderImplementation",
          functionName: "getRewardedRange",
          addressOverride: rewarder,
          blockTag: input.blockTag
        })
        : undefined;
      let ids = (poolInput.ids ?? []).map((id, idIndex) => parseBigIntLike(id, `dlmmPools[${index}].ids[${idIndex}]`));
      let rangeScanTruncated = false;
      if (ids.length === 0 && poolInput.scanRewardedRange && rewardedRange?.ok && Array.isArray(rewardedRange.result)) {
        const [start, end] = rewardedRange.result.map((value) => BigInt(String(value)));
        const maxIds = BigInt(poolInput.maxIds ?? 200);
        const upper = end - start + 1n > maxIds ? start + maxIds - 1n : end;
        rangeScanTruncated = upper < end;
        ids = [];
        for (let id = start; id <= upper; id += 1n) ids.push(id);
      }
      const balances = await Promise.all(ids.map(async (id) => ({
        id,
        balance: await tryRead(publicClient, pair, contractAbis.erc1155Read as Abi, "balanceOf", [account, id], input.blockTag)
      })));
      const nonzeroBalances = balances.filter((entry) => hasPositiveRead(entry.balance));

      return {
        pair,
        operator,
        rewarder,
        rewardedRange,
        idsChecked: ids,
        rangeScanTruncated,
        balances,
        nonzeroBalances,
        isApprovedForAll: await tryRead(publicClient, pair, contractAbis.dlmmPool as Abi, "isApprovedForAll", [account, operator], input.blockTag),
        warning: ids.length === 0 ? "No DLMM ids were supplied or scanned; pass ids or scanRewardedRange for bin balances." : undefined
      };
    }))
    : undefined;

  const rewardContext = includeProtocol && includeRewards
    ? await walletRewardContext(publicClient, clNfts ?? { ok: false }, dlmmPools, input.blockTag)
    : undefined;

  const protocol = includeProtocol
    ? {
      xphar: await tryAsync(() => xpharRead(publicClient, { action: "summary", account, blockTag: input.blockTag })),
      p33: await tryAsync(() => p33Read(publicClient, { action: "summary", account, blockTag: input.blockTag })),
      autoVault: await tryAsync(() => autoVaultRead(publicClient, { action: "summary", account, blockTag: input.blockTag })),
      vote: await tryAsync(() => voteRead(publicClient, { action: "summary", account, blockTag: input.blockTag })),
      clNfts,
      dlmmPools,
      rewardContext,
      rewards: includeRewards
        ? await tryAsync(() => rewardClaimabilityRead(publicClient, {
          account,
          includeZero: true,
          clPools: rewardContext?.clPools.length ? rewardContext.clPools : undefined,
          dlmmPairs: rewardContext?.dlmmPairs.length ? rewardContext.dlmmPairs : undefined,
          blockTag: input.blockTag
        }))
        : undefined
    }
    : undefined;

  return {
    chainId: CHAIN_ID,
    account,
    blockTag: input.blockTag ?? "latest",
    nativeBalance,
    tokens,
    spenders: includeAllowances ? spenderInputs : undefined,
    protocol,
    warning: "Wallet inventory is readonly and bounded. CL NFT and DLMM bin discovery can be truncated or incomplete; pass explicit token ids/bin ids for exhaustive checks."
  };
}

async function legacyGaugeClaimability(
  publicClient: PublicClient,
  account: Address,
  gauge: Address,
  blockTag?: BlockTag
) {
  const [stakedBalance, rewardsList] = await Promise.all([
    tryRunContractFunction(publicClient, { contract: "legacyGauge", functionName: "balanceOf", args: [account], addressOverride: gauge, blockTag }),
    tryRunContractFunction(publicClient, { contract: "legacyGauge", functionName: "rewardsList", addressOverride: gauge, blockTag })
  ]);
  const rewardTokens = readResultAddresses(rewardsList);
  const earned = await Promise.all(rewardTokens.map(async (token) => ({
    token,
    amount: await tryRunContractFunction(publicClient, { contract: "legacyGauge", functionName: "earned", args: [token, account], addressOverride: gauge, blockTag })
  })));
  const claimableTokens = earned.filter((item) => hasPositiveRead(item.amount)).map((item) => item.token);
  const warnings = [
    ...(hasPositiveRead(stakedBalance) ? [] : ["no legacy gauge stake for account; positive earned rewards may still be claimable after unstaking"])
  ];
  const blockers = claimableTokens.length > 0 ? [] : ["no positive legacy gauge earned token amounts"];
  const claimable = claimableTokens.length > 0 && blockers.length === 0;

  return {
    gauge,
    stakedBalance,
    rewardTokens,
    earned,
    claimableTokens,
    warnings,
    ...claimDomainStatus(claimable, blockers),
    buildCall: claimable
      ? { tool: "pharaoh_gauge_build_tx", arguments: { action: "legacyGetReward", addressOverride: gauge, args: [account, claimableTokens] } }
      : null
  };
}

async function feeDistributorClaimability(
  publicClient: PublicClient,
  account: Address,
  feeDistributor: Address,
  period?: bigint,
  blockTag?: BlockTag
) {
  const [rewardTokensRead, balanceOf] = await Promise.all([
    tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "getRewardTokens", addressOverride: feeDistributor, blockTag }),
    tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "balanceOf", args: [account], addressOverride: feeDistributor, blockTag })
  ]);
  const rewardTokens = readResultAddresses(rewardTokensRead);
  const earned = await Promise.all(rewardTokens.map(async (token) => ({
    token,
    amount: await tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "earned", args: [token, account], addressOverride: feeDistributor, blockTag }),
    userVotes: period !== undefined
      ? await tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "userVotes", args: [period, account], addressOverride: feeDistributor, blockTag })
      : undefined,
    rewardSupply: period !== undefined
      ? await tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "rewardSupply", args: [period, token], addressOverride: feeDistributor, blockTag })
      : undefined
  })));
  const claimableTokens = earned.filter((item) => hasPositiveRead(item.amount)).map((item) => item.token);
  const warnings = [
    ...(hasPositiveRead(balanceOf) ? [] : ["no current fee distributor voting balance for account; historical earned rewards may still be claimable"])
  ];
  const blockers = claimableTokens.length > 0 ? [] : ["no positive fee distributor earned token amounts"];
  const claimable = claimableTokens.length > 0 && blockers.length === 0;

  return {
    address: feeDistributor,
    period,
    balanceOf,
    rewardTokens,
    earned,
    claimableTokens,
    warnings,
    ...claimDomainStatus(claimable, blockers),
    buildCall: claimable
      ? { tool: "pharaoh_vote_build_tx", arguments: { action: "claimIncentives", args: [account, [feeDistributor], [claimableTokens]] } }
      : null
  };
}

function readVotePools(read: { ok: boolean; result?: unknown }): Address[] {
  if (!read.ok) return [];
  const result = read.result;
  const pools = Array.isArray(result)
    ? result[0]
    : typeof result === "object" && result !== null
      ? (result as { votes?: unknown }).votes
      : undefined;

  return Array.isArray(pools)
    ? pools.filter((value): value is string => typeof value === "string" && isAddress(value, { strict: false })).map((value) => getAddress(value))
    : [];
}

async function p33IncentiveClaimability(
  publicClient: PublicClient,
  input: {
    userAccount: Address;
    caller?: Address;
    currentPeriod: bigint;
    periodsBack?: number;
    includeNextPeriod?: boolean;
    feeDistributors?: Array<{ address: string; period?: string | number }>;
    blockTag?: BlockTag;
  }
) {
  const p33 = contractRegistry.p33.address;
  const [userBalanceOf, userMaxRedeem, userMaxWithdraw, balanceOf, operator, asset, isUnlocked] = await Promise.all([
    tryRunContractFunction(publicClient, { contract: "p33", functionName: "balanceOf", args: [input.userAccount], blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "p33", functionName: "maxRedeem", args: [input.userAccount], blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "p33", functionName: "maxWithdraw", args: [input.userAccount], blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "p33", functionName: "balanceOf", args: [p33], blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "p33", functionName: "operator", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "p33", functionName: "asset", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "p33", functionName: "isUnlocked", blockTag: input.blockTag })
  ]);
  const operatorAddress = readResultAddress(operator);
  const callerIsOperator = input.caller && operatorAddress ? input.caller.toLowerCase() === operatorAddress.toLowerCase() : undefined;
  const periodsBack = Math.max(0, Math.min(input.periodsBack ?? 4, 16));
  const votePeriods = Array.from(new Set([
    ...(input.includeNextPeriod === false ? [] : [input.currentPeriod + 1n]),
    ...Array.from({ length: periodsBack + 1 }, (_value, index) => input.currentPeriod - BigInt(index)).filter((period) => period >= 0n)
  ].map((period) => period.toString()))).map((period) => BigInt(period));

  const voteReads = await Promise.all(votePeriods.map(async (period) => ({
    period,
    getVotes: await tryRunContractFunction(publicClient, {
      contract: "voter",
      functionName: "getVotes",
      args: [p33, period],
      blockTag: input.blockTag
    })
  })));

  const votePools = uniqueAddresses(voteReads.flatMap((vote) => readVotePools(vote.getVotes)));
  const derivedDistributors = await Promise.all(votePools.map(async (pool) => {
    const gauge = await tryRunContractFunction(publicClient, {
      contract: "voter",
      functionName: "gaugeForPool",
      args: [pool],
      blockTag: input.blockTag
    });
    const gaugeAddress = readResultAddress(gauge);
    const feeDistributor = gaugeAddress
      ? await tryRunContractFunction(publicClient, {
        contract: "voter",
        functionName: "feeDistributorForGauge",
        args: [gaugeAddress],
        blockTag: input.blockTag
      })
      : { ok: false, error: "No gauge for voted pool." };

    return {
      source: "voter.getVotes(p33,period)",
      pool,
      gauge,
      feeDistributor
    };
  }));

  const explicitDistributors = input.feeDistributors?.map((fd, index) => ({
    source: "input.p33FeeDistributors",
    address: asAddress(fd.address, `p33FeeDistributors[${index}].address`),
    period: fd.period === undefined ? input.currentPeriod : parseBigIntLike(fd.period, `p33FeeDistributors[${index}].period`)
  })) ?? [];
  const distributorAddresses = uniqueAddresses([
    ...explicitDistributors.map((fd) => fd.address),
    ...derivedDistributors.map((item) => readResultAddress(item.feeDistributor))
  ]);

  const feeDistributors = await Promise.all(distributorAddresses.map(async (feeDistributor) => {
    const explicit = explicitDistributors.find((fd) => fd.address.toLowerCase() === feeDistributor.toLowerCase());
    const period = explicit?.period ?? input.currentPeriod;
    const [rewardTokensRead, balanceOfP33] = await Promise.all([
      tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "getRewardTokens", addressOverride: feeDistributor, blockTag: input.blockTag }),
      tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "balanceOf", args: [p33], addressOverride: feeDistributor, blockTag: input.blockTag })
    ]);
    const rewardTokens = readResultAddresses(rewardTokensRead);
    const earned = await Promise.all(rewardTokens.map(async (token) => ({
      token,
      amount: await tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "earned", args: [token, p33], addressOverride: feeDistributor, blockTag: input.blockTag }),
      userVotes: await tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "userVotes", args: [period, p33], addressOverride: feeDistributor, blockTag: input.blockTag }),
      rewardSupply: await tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "rewardSupply", args: [period, token], addressOverride: feeDistributor, blockTag: input.blockTag })
    })));
    const claimableTokens = earned.filter((item) => hasPositiveRead(item.amount)).map((item) => item.token);

    return {
      address: feeDistributor,
      period,
      source: explicit?.source ?? "derived from p33 voted pools",
      balanceOfP33,
      rewardTokens,
      earned,
      claimableTokens,
      claimable: claimableTokens.length > 0
    };
  }));

  const claimableFeeDistributors = feeDistributors.filter((feeDistributor) => feeDistributor.claimable);
  const operatorClaimable = claimableFeeDistributors.length > 0;
  const buildArgs = operatorClaimable
    ? [
      claimableFeeDistributors.map((feeDistributor) => feeDistributor.address),
      claimableFeeDistributors.map((feeDistributor) => feeDistributor.claimableTokens)
    ]
    : null;
  const simulation = buildArgs && operatorAddress
    ? await tryRunContractFunction(publicClient, {
      contract: "p33",
      functionName: "claimIncentives",
      args: buildArgs,
      allowNonView: true,
      staticAccount: operatorAddress,
      blockTag: input.blockTag
    })
    : undefined;
  const blockers = [
    ...(operatorClaimable ? [] : ["no current p33 FeeDistributor earned rewards for checked voted pools"]),
    ...(callerIsOperator === true ? [] : ["p33 incentive claims are operator-only; caller is not p33 operator or no caller was supplied"]),
    ...(simulation && !simulation.ok ? [`operator static call failed: ${compactError(String(simulation.error))}`] : [])
  ];
  const claimable = blockers.length === 0;

  return {
    account: p33,
    userAccount: input.userAccount,
    userPosition: {
      balanceOf: userBalanceOf,
      maxRedeem: userMaxRedeem,
      maxWithdraw: userMaxWithdraw
    },
    balanceOf,
    operator,
    asset,
    isUnlocked,
    caller: input.caller,
    callerIsOperator,
    votePeriodsChecked: votePeriods,
    voteReads,
    votedPools: votePools,
    derivedDistributors,
    feeDistributors,
    operatorClaimable,
    operatorSimulationMode: simulation ? "claimableRewards" : null,
    operatorSimulation: simulation,
    caveat: "p33 claimIncentives is an operator/protocol automation path. The planner only simulates positive earned FeeDistributor rows; no-payout all-token static calls are intentionally skipped so zero current earned state is reported as a state gate, not a revert.",
    ...claimDomainStatus(claimable, blockers),
    buildCall: claimable
      ? {
        tool: "pharaoh_p33_build_tx",
        arguments: { action: "claimIncentives", args: buildArgs },
        warning: "p33 claimIncentives is an operator/protocol automation action. The unsigned calldata is executable only by an authorized p33 operator."
      }
      : null
  };
}

async function autoVaultIncentiveClaimability(
  publicClient: PublicClient,
  input: {
    userAccount: Address;
    caller?: Address;
    currentPeriod: bigint;
    periodsBack?: number;
    includeNextPeriod?: boolean;
    feeDistributors?: Array<{ address: string; period?: string | number }>;
    blockTag?: BlockTag;
  }
) {
  const autoVault = contractRegistry.autoVault.address;
  const [operator, voteModule] = await Promise.all([
    tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "OPERATOR", blockTag: input.blockTag }),
    tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "VOTE_MODULE", blockTag: input.blockTag })
  ]);
  const operatorAddress = readResultAddress(operator);
  const callerIsOperator = input.caller && operatorAddress ? input.caller.toLowerCase() === operatorAddress.toLowerCase() : undefined;
  const periodsBack = Math.max(0, Math.min(input.periodsBack ?? 4, 16));
  const votePeriods = Array.from(new Set([
    ...(input.includeNextPeriod === false ? [] : [input.currentPeriod + 1n]),
    ...Array.from({ length: periodsBack + 1 }, (_value, index) => input.currentPeriod - BigInt(index)).filter((period) => period >= 0n)
  ].map((period) => period.toString()))).map((period) => BigInt(period));

  const voteReads = await Promise.all(votePeriods.map(async (period) => ({
    period,
    getVotes: await tryRunContractFunction(publicClient, {
      contract: "voter",
      functionName: "getVotes",
      args: [autoVault, period],
      blockTag: input.blockTag
    })
  })));

  const votePools = uniqueAddresses(voteReads.flatMap((vote) => readVotePools(vote.getVotes)));
  const derivedDistributors = await Promise.all(votePools.map(async (pool) => {
    const gauge = await tryRunContractFunction(publicClient, {
      contract: "voter",
      functionName: "gaugeForPool",
      args: [pool],
      blockTag: input.blockTag
    });
    const gaugeAddress = readResultAddress(gauge);
    const feeDistributor = gaugeAddress
      ? await tryRunContractFunction(publicClient, {
        contract: "voter",
        functionName: "feeDistributorForGauge",
        args: [gaugeAddress],
        blockTag: input.blockTag
      })
      : { ok: false, error: "No gauge for AutoVault-voted pool." };

    return {
      source: "voter.getVotes(autoVault,period)",
      pool,
      gauge,
      feeDistributor
    };
  }));

  const explicitDistributors = input.feeDistributors?.map((fd, index) => ({
    source: "input.autoVaultFeeDistributors",
    address: asAddress(fd.address, `autoVaultFeeDistributors[${index}].address`),
    period: fd.period === undefined ? input.currentPeriod : parseBigIntLike(fd.period, `autoVaultFeeDistributors[${index}].period`)
  })) ?? [];
  const distributorAddresses = uniqueAddresses([
    ...explicitDistributors.map((fd) => fd.address),
    ...derivedDistributors.map((item) => readResultAddress(item.feeDistributor))
  ]);

  const feeDistributors = await Promise.all(distributorAddresses.map(async (feeDistributor) => {
    const explicit = explicitDistributors.find((fd) => fd.address.toLowerCase() === feeDistributor.toLowerCase());
    const period = explicit?.period ?? input.currentPeriod;
    const [rewardTokensRead, balanceOfAutoVault] = await Promise.all([
      tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "getRewardTokens", addressOverride: feeDistributor, blockTag: input.blockTag }),
      tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "balanceOf", args: [autoVault], addressOverride: feeDistributor, blockTag: input.blockTag })
    ]);
    const rewardTokens = readResultAddresses(rewardTokensRead);
    const earned = await Promise.all(rewardTokens.map(async (token) => ({
      token,
      amount: await tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "earned", args: [token, autoVault], addressOverride: feeDistributor, blockTag: input.blockTag }),
      userVotes: await tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "userVotes", args: [period, autoVault], addressOverride: feeDistributor, blockTag: input.blockTag }),
      rewardSupply: await tryRunContractFunction(publicClient, { contract: "feeDistributor", functionName: "rewardSupply", args: [period, token], addressOverride: feeDistributor, blockTag: input.blockTag })
    })));
    const claimableTokens = earned.filter((item) => hasPositiveRead(item.amount)).map((item) => item.token);

    return {
      address: feeDistributor,
      period,
      source: explicit?.source ?? "derived from AutoVault voted pools",
      balanceOfAutoVault,
      rewardTokens,
      earned,
      claimableTokens,
      claimable: claimableTokens.length > 0
    };
  }));

  const claimableFeeDistributors = feeDistributors.filter((feeDistributor) => feeDistributor.claimable);
  const operatorClaimable = claimableFeeDistributors.length > 0;
  const buildArgs = operatorClaimable
    ? [
      claimableFeeDistributors.map((feeDistributor) => feeDistributor.address),
      claimableFeeDistributors.map((feeDistributor) => feeDistributor.claimableTokens)
    ]
    : null;
  const simulation = buildArgs && operatorAddress
    ? await tryRunContractFunction(publicClient, {
      contract: "autoVault",
      functionName: "claimIncentives",
      args: buildArgs,
      allowNonView: true,
      staticAccount: operatorAddress,
      blockTag: input.blockTag
    })
    : undefined;
  const blockers = [
    ...(operatorClaimable ? [] : ["no current AutoVault FeeDistributor earned rewards for checked voted pools"]),
    ...(callerIsOperator === true ? [] : ["AutoVault incentive claims are operator-only; caller is not AutoVault OPERATOR or no caller was supplied"]),
    ...(simulation && !simulation.ok ? [`operator static call failed: ${compactError(String(simulation.error))}`] : [])
  ];
  const claimable = operatorClaimable && callerIsOperator === true && simulation?.ok !== false;

  return {
    account: autoVault,
    userAccount: input.userAccount,
    operator,
    voteModule,
    caller: input.caller,
    callerIsOperator,
    votePeriodsChecked: votePeriods,
    voteReads,
    votedPools: votePools,
    derivedDistributors,
    feeDistributors,
    operatorClaimable,
    operatorSimulationMode: simulation ? "claimableRewards" : null,
    operatorSimulation: simulation,
    caveat: "AutoVault claimIncentives is an operator/protocol automation path. The planner only simulates positive earned FeeDistributor rows; no-payout all-token static calls are intentionally skipped because current source-backed evidence shows they can revert.",
    ...claimDomainStatus(claimable, blockers),
    buildCall: claimable
      ? {
        tool: "pharaoh_autovault_build_tx",
        arguments: { action: "claimIncentives", args: buildArgs },
        warning: "AutoVault claimIncentives is executable only by the configured AutoVault OPERATOR."
      }
      : null
  };
}

async function clGaugeClaimability(
  publicClient: PublicClient,
  account: Address,
  input: { pool?: string; gauge?: string; tokenIds?: Array<string | number>; maxTokenIds?: number },
  blockTag?: BlockTag
) {
  const pool = input.pool ? asAddress(input.pool, "clPools[].pool") : DEFAULT_CL_WAVAX_USDC_10_POOL;
  const gaugeRead = input.gauge ? undefined : await tryRunContractFunction(publicClient, {
    contract: "voter",
    functionName: "gaugeForPool",
    args: [pool],
    blockTag
  });
  const gauge = input.gauge ? asAddress(input.gauge, "clPools[].gauge") : readResultAddress(gaugeRead ?? { ok: false });
  if (!gauge) {
    const blockers = [`CL gauge could not be resolved for pool: ${compactError(String(gaugeRead && "error" in gaugeRead ? gaugeRead.error : "missing gauge address"))}`];
    return {
      pool,
      gauge: null,
      gaugeRead,
      feeDistributor: null,
      rewardTokens: [],
      discoveredTokenIds: null,
      tokenIds: [],
      tokenRewards: [],
      claimableTokens: [],
      claimableTokenIds: [],
      ...claimDomainStatus(false, blockers),
      buildCall: null
    };
  }
  const feeDistributor = await tryRunContractFunction(publicClient, {
    contract: "voter",
    functionName: "feeDistributorForGauge",
    args: [gauge],
    blockTag
  });
  const rewardTokensRead = await tryRunContractFunction(publicClient, {
    contract: "clGaugeV3",
    functionName: "getRewardTokens",
    addressOverride: gauge,
    blockTag
  });
  const rewardTokens = readResultAddresses(rewardTokensRead);
  const discovered = input.tokenIds
    ? undefined
    : await discoverClTokenIds(publicClient, account, input.maxTokenIds ?? 50, blockTag);
  const tokenIds = (input.tokenIds ?? discovered?.tokenIds ?? []).map((tokenId, index) => parseBigIntLike(tokenId, `clPools[].tokenIds[${index}]`));
  const tokenRewards = await Promise.all(tokenIds.map(async (tokenId) => {
    const earned = await Promise.all(rewardTokens.map(async (token) => ({
      token,
      amount: await tryRunContractFunction(publicClient, { contract: "clGaugeV3", functionName: "earned(address,uint256)", args: [token, tokenId], addressOverride: gauge, blockTag })
    })));
    return {
      tokenId,
      earned,
      claimableTokens: earned.filter((item) => hasPositiveRead(item.amount)).map((item) => item.token)
    };
  }));
  const claimableTokenIds = tokenRewards.filter((item) => item.claimableTokens.length > 0).map((item) => item.tokenId);
  const claimableTokens = Array.from(new Set(tokenRewards.flatMap((item) => item.claimableTokens)));
  const warnings = [
    ...(discovered?.truncated ? ["owned CL NFT discovery was truncated; pass tokenIds explicitly for full coverage"] : [])
  ];
  const blockers = [
    ...(tokenIds.length > 0 ? [] : ["no CL position tokenIds supplied or owned by account"]),
    ...(claimableTokenIds.length > 0 ? [] : ["no positive CL gauge earned token amounts for checked tokenIds"])
  ];
  const claimable = claimableTokenIds.length > 0 && blockers.length === 0;

  return {
    pool,
    gauge,
    feeDistributor,
    rewardTokens,
    discoveredTokenIds: discovered,
    tokenIds,
    tokenRewards,
    claimableTokens,
    claimableTokenIds,
    warnings,
    ...claimDomainStatus(claimable, blockers),
    buildCall: claimable
      ? { tool: "pharaoh_vote_build_tx", arguments: { action: "claimClGaugeRewards", args: [[gauge], [claimableTokens], [claimableTokenIds]] } }
      : null
  };
}

async function dlmmRewarderClaimability(
  publicClient: PublicClient,
  account: Address,
  input: { pair?: string; rewarder?: string; ids?: Array<string | number>; scanRewardedRange?: boolean; maxIds?: number },
  blockTag?: BlockTag
) {
  const pair = input.pair ? asAddress(input.pair, "dlmmPairs[].pair") : DEFAULT_DLMM_REWARDED_POOL;
  const rewarder = input.rewarder
    ? asAddress(input.rewarder, "dlmmPairs[].rewarder")
    : readResultAddress(await tryRunContractFunction(publicClient, {
      contract: "dlmmRewarderFactory",
      functionName: "getRewarder",
      args: [pair],
      blockTag
    })) ?? ZERO_ADDRESS;
  const rewardToken = rewarder !== ZERO_ADDRESS
    ? await tryRunContractFunction(publicClient, { contract: "dlmmRewarderImplementation", functionName: "getRewardToken", addressOverride: rewarder, blockTag })
    : { ok: false, error: "No DLMM rewarder registered for pair." };
  const rewardedRange = rewarder !== ZERO_ADDRESS
    ? await tryRunContractFunction(publicClient, { contract: "dlmmRewarderImplementation", functionName: "getRewardedRange", addressOverride: rewarder, blockTag })
    : undefined;

  let ids = (input.ids ?? []).map((id, index) => parseBigIntLike(id, `dlmmPairs[].ids[${index}]`));
  let rangeScanTruncated = false;
  if (ids.length === 0 && input.scanRewardedRange && rewardedRange?.ok && Array.isArray(rewardedRange.result)) {
    const [start, end] = rewardedRange.result.map((value) => BigInt(String(value)));
    const maxIds = BigInt(input.maxIds ?? 200);
    const upper = end - start + 1n > maxIds ? start + maxIds - 1n : end;
    rangeScanTruncated = upper < end;
    const scanned = [];
    for (let id = start; id <= upper; id += 1n) scanned.push(id);
    const balances = await Promise.all(scanned.map(async (id) => ({
      id,
      balance: await tryRead(publicClient, pair, contractAbis.erc1155Read as Abi, "balanceOf", [account, id], blockTag)
    })));
    ids = balances.filter((item) => hasPositiveRead(item.balance)).map((item) => item.id);
  }

  const pendingRewards = rewarder !== ZERO_ADDRESS
    ? await tryRunContractFunction(publicClient, { contract: "dlmmRewarderImplementation", functionName: "getPendingRewards", args: [account, ids], addressOverride: rewarder, blockTag })
    : { ok: false, error: "No DLMM rewarder registered for pair." };
  const warnings = [
    ...(rangeScanTruncated ? ["rewarded range scan was truncated; pass ids explicitly for full coverage"] : [])
  ];
  const blockers = [
    ...(rewarder !== ZERO_ADDRESS ? [] : ["no DLMM rewarder registered for pair"]),
    ...(ids.length > 0 ? [] : ["no DLMM bin ids supplied or held by account in bounded scan"]),
    ...(hasPositiveRead(pendingRewards) ? [] : ["no pending DLMM rewards for checked ids"])
  ];
  const claimable = hasPositiveRead(pendingRewards) && blockers.length === 0;

  return {
    pair,
    rewarder,
    rewardToken,
    rewardedRange,
    idsChecked: ids,
    rangeScanTruncated,
    pendingRewards,
    warnings,
    ...claimDomainStatus(claimable, blockers),
    buildCall: claimable
      ? { tool: "pharaoh_dlmm_build_tx", arguments: { action: "rewarderClaim", addressOverride: rewarder, args: [account, ids] } }
      : null
  };
}

// === REWARD CLAIMABILITY ===

/** @summary Check which rewards are claimable for an account (gauge status, vesting, lockups) */

export async function rewardClaimabilityRead(
  publicClient: PublicClient,
  input: {
    account: string;
    domains?: Array<"autoVault" | "legacyGauge" | "clGauge" | "feeDistributor" | "dlmmRewarder" | "p33">;
    legacyGauges?: string[];
    clPools?: Array<{ pool?: string; gauge?: string; tokenIds?: Array<string | number>; maxTokenIds?: number }>;
    feeDistributors?: Array<{ address?: string; period?: string | number }>;
    dlmmPairs?: Array<{ pair?: string; rewarder?: string; ids?: Array<string | number>; scanRewardedRange?: boolean; maxIds?: number }>;
    autoVaultFeeDistributors?: Array<{ address: string; period?: string | number }>;
    autoVaultVotePeriodsBack?: number;
    autoVaultIncludeNextPeriod?: boolean;
    p33FeeDistributors?: Array<{ address: string; period?: string | number }>;
    p33VotePeriodsBack?: number;
    p33IncludeNextPeriod?: boolean;
    caller?: string;
    includeZero?: boolean;
    blockTag?: BlockTag;
  }
) {
  const account = asAddress(input.account, "account");
  const caller = input.caller ? asAddress(input.caller, "caller") : undefined;
  const domains = new Set(input.domains ?? ["autoVault", "legacyGauge", "clGauge", "feeDistributor", "dlmmRewarder", "p33"]);
  const currentPeriodRead = await tryRunContractFunction(publicClient, {
    contract: "voter",
    functionName: "getPeriod",
    blockTag: input.blockTag
  });
  const currentPeriod = readResultBigInt(currentPeriodRead);
  if (currentPeriod === undefined) {
    return {
      chainId: CHAIN_ID,
      account,
      caller,
      blockTag: input.blockTag ?? "latest",
      currentPeriod: null,
      currentPeriodRead,
      claimable: false,
      blockers: [`voter.getPeriod failed: ${compactError(String("error" in currentPeriodRead ? currentPeriodRead.error : "missing result"))}`],
      domains: {},
      warning: "Readonly claimability plan only. Current period could not be read, so no reward builder hints were emitted."
    };
  }
  const out: Record<string, unknown> = {};
  const blockers = [];

  if (domains.has("autoVault")) {
    const [balanceOf, earned, storedRewards, outputPreference] = await Promise.all([
      tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "balanceOf", args: [account], blockTag: input.blockTag }),
      tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "earned", args: [account], blockTag: input.blockTag }),
      tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "getStoredRewards", args: [account], blockTag: input.blockTag }),
      tryRunContractFunction(publicClient, { contract: "autoVault", functionName: "outputPreference", args: [account], blockTag: input.blockTag })
    ]);
    const nativeClaimable = hasPositiveRead(earned) || hasPositiveRead(storedRewards);
    const nativeWarnings = [
      ...(hasPositiveRead(balanceOf) ? [] : ["no AutoVault shares for account; stored rewards may still be claimable after withdrawal"])
    ];
    const nativeBlockers = nativeClaimable ? [] : ["no AutoVault earned or stored rewards"];
    const incentives = await autoVaultIncentiveClaimability(publicClient, {
      userAccount: account,
      caller,
      currentPeriod,
      periodsBack: input.autoVaultVotePeriodsBack,
      includeNextPeriod: input.autoVaultIncludeNextPeriod,
      feeDistributors: input.autoVaultFeeDistributors,
      blockTag: input.blockTag
    });
    const claimable = nativeClaimable || incentives.claimable;
    const domainBlockers = [
      ...(nativeClaimable ? [] : nativeBlockers.map((blocker) => `native claim: ${blocker}`)),
      ...(incentives.claimable ? [] : incentives.blockers.map((blocker) => `incentive claim: ${blocker}`))
    ];
    if (!claimable) blockers.push("autoVault");
    out.autoVault = {
      balanceOf,
      earned,
      storedRewards,
      outputPreference,
      native: {
        balanceOf,
        earned,
        storedRewards,
        outputPreference,
        warnings: nativeWarnings,
        ...claimDomainStatus(nativeClaimable, nativeBlockers),
        buildCall: nativeClaimable ? { tool: "pharaoh_autovault_build_tx", arguments: { action: "claim", args: [] } } : null
      },
      incentives,
      caveat: "AutoVault ABI is source_backed_abi_candidate; proxy and EIP-1967 implementation ABIs are not verified on public explorer endpoints, but the integrated user-facing selectors are present in implementation bytecode.",
      ...claimDomainStatus(claimable, domainBlockers),
      buildCall: nativeClaimable ? { tool: "pharaoh_autovault_build_tx", arguments: { action: "claim", args: [] } } : null
    };
  }

  if (domains.has("legacyGauge")) {
    const gauges = (input.legacyGauges?.length ? input.legacyGauges : [contractRegistry.legacyGauge.address]).map((gauge, index) => asAddress(gauge, `legacyGauges[${index}]`));
    const entries = await Promise.all(gauges.map((gauge) => legacyGaugeClaimability(publicClient, account, gauge, input.blockTag)));
    if (!entries.some((entry) => entry.claimable)) blockers.push("legacyGauge");
    out.legacyGauge = input.includeZero === false ? entries.filter((entry) => entry.claimable) : entries;
  }

  let derivedFeeDistributors: Address[] = [];
  if (domains.has("clGauge")) {
    const clInputs = input.clPools?.length ? input.clPools : [{ pool: DEFAULT_CL_WAVAX_USDC_10_POOL }];
    const entries = await Promise.all(clInputs.map((clInput) => clGaugeClaimability(publicClient, account, clInput, input.blockTag)));
    derivedFeeDistributors = entries.map((entry) => readResultAddress(entry.feeDistributor ?? { ok: false }) ?? undefined).filter((value): value is Address => Boolean(value));
    if (!entries.some((entry) => entry.claimable)) blockers.push("clGauge");
    out.clGauge = input.includeZero === false ? entries.filter((entry) => entry.claimable) : entries;
  }

  if (domains.has("feeDistributor")) {
    const distributors = input.feeDistributors?.length
      ? input.feeDistributors.map((fd, index) => ({ address: asAddress(fd.address, `feeDistributors[${index}].address`), period: fd.period === undefined ? currentPeriod : parseBigIntLike(fd.period, `feeDistributors[${index}].period`) }))
      : derivedFeeDistributors.length
        ? derivedFeeDistributors.map((address) => ({ address, period: currentPeriod }))
        : [{ address: contractRegistry.feeDistributor.address, period: currentPeriod }];
    const entries = await Promise.all(distributors.map((fd) => feeDistributorClaimability(publicClient, account, fd.address, fd.period, input.blockTag)));
    if (!entries.some((entry) => entry.claimable)) blockers.push("feeDistributor");
    out.feeDistributor = input.includeZero === false ? entries.filter((entry) => entry.claimable) : entries;
  }

  if (domains.has("dlmmRewarder")) {
    const dlmmInputs = input.dlmmPairs?.length ? input.dlmmPairs : [{ pair: DEFAULT_DLMM_REWARDED_POOL, scanRewardedRange: false }];
    const entries = await Promise.all(dlmmInputs.map((dlmmInput) => dlmmRewarderClaimability(publicClient, account, dlmmInput, input.blockTag)));
    if (!entries.some((entry) => entry.claimable)) blockers.push("dlmmRewarder");
    out.dlmmRewarder = input.includeZero === false ? entries.filter((entry) => entry.claimable) : entries;
  }

  if (domains.has("p33")) {
    const p33 = await p33IncentiveClaimability(publicClient, {
      userAccount: account,
      caller,
      currentPeriod,
      periodsBack: input.p33VotePeriodsBack,
      includeNextPeriod: input.p33IncludeNextPeriod,
      feeDistributors: input.p33FeeDistributors,
      blockTag: input.blockTag
    });
    if (!p33.claimable) blockers.push("p33");
    out.p33 = p33;
  }

  const claimable = Object.values(out).some((value) => Array.isArray(value)
    ? value.some((entry) => Boolean((entry as { claimable?: boolean }).claimable))
    : Boolean((value as { claimable?: boolean }).claimable));

  return {
    chainId: CHAIN_ID,
    account,
    caller,
    blockTag: input.blockTag ?? "latest",
    currentPeriod,
    claimable,
    blockers: claimable ? [] : blockers,
    domains: out,
    warning: "Readonly claimability plan only. It does not sign or broadcast. Bounded scans can miss positions or DLMM bin ids; pass explicit tokenIds/ids for full coverage."
  };
}

// === VOTING ===

/** @summary Read voting state: proposals, user votes, delegation, voting power */

export async function voteRead(
  publicClient: PublicClient,
  input: {
    action: "summary" | "poolStatus" | "getVotes";
    account?: string;
    pool?: string;
    gauge?: string;
    tokenA?: string;
    tokenB?: string;
    tickSpacing?: string | number;
    period?: string | number;
    blockTag?: BlockTag;
  }
) {
  const account = input.account ? asAddress(input.account, "account") : undefined;
  const currentPeriod = await publicClient.readContract({
    address: contractRegistry.voter.address,
    abi: contractAbis.voter as Abi,
    functionName: "getPeriod",
    blockTag: input.blockTag
  } as never) as bigint;
  const period = input.period !== undefined
    ? parseBigIntLike(input.period, "period")
    : currentPeriod + 1n;

  if (input.action === "summary") {
    if (!account) throw new Error("account is required for vote summary.");

    const [voteModuleBalance, delegate, cooldown, unlockTime, stakingToken, lastVoted, votes, votingPower] = await Promise.all([
      runContractFunction(publicClient, { contract: "voteModule", functionName: "balanceOf", args: [account], blockTag: input.blockTag }),
      runContractFunction(publicClient, { contract: "voteModule", functionName: "delegates", args: [account], blockTag: input.blockTag }),
      runContractFunction(publicClient, { contract: "voteModule", functionName: "cooldown", blockTag: input.blockTag }),
      runContractFunction(publicClient, { contract: "voteModule", functionName: "unlockTime", blockTag: input.blockTag }),
      runContractFunction(publicClient, { contract: "voteModule", functionName: "stakingToken", blockTag: input.blockTag }),
      runContractFunction(publicClient, { contract: "voter", functionName: "lastVoted", args: [account], blockTag: input.blockTag }),
      runContractFunction(publicClient, { contract: "voter", functionName: "getVotes", args: [account, period], blockTag: input.blockTag }),
      runContractFunction(publicClient, { contract: "voter", functionName: "userVotingPowerPerPeriod", args: [account, period], blockTag: input.blockTag })
    ]);

    return {
      chainId: CHAIN_ID,
      account,
      currentPeriod,
      period,
      voteModule: { balance: voteModuleBalance, delegate, cooldown, unlockTime, stakingToken },
      voter: { lastVoted, votes, votingPower }
    };
  }

  if (input.action === "getVotes") {
    if (!account) throw new Error("account is required for getVotes.");
    return runContractFunction(publicClient, {
      contract: "voter",
      functionName: "getVotes",
      args: [account, period],
      blockTag: input.blockTag
    });
  }

  const pool = input.pool
    ? asAddress(input.pool, "pool")
    : input.tokenA && input.tokenB && input.tickSpacing !== undefined
      ? await publicClient.readContract({
        address: contractRegistry.ramsesV3Factory.address,
        abi: contractAbis.ramsesV3Factory as Abi,
        functionName: "getPool",
        args: [asAddress(input.tokenA, "tokenA"), asAddress(input.tokenB, "tokenB"), parseBigIntLike(input.tickSpacing, "tickSpacing")],
        blockTag: input.blockTag
      } as never) as Address
      : undefined;

  const gauge = input.gauge
    ? asAddress(input.gauge, "gauge")
    : pool
      ? await publicClient.readContract({
        address: contractRegistry.voter.address,
        abi: contractAbis.voter as Abi,
        functionName: "gaugeForPool",
        args: [pool],
        blockTag: input.blockTag
      } as never) as Address
      : undefined;

  if (!pool && !gauge) {
    throw new Error("pool, gauge, or tokenA/tokenB/tickSpacing is required for poolStatus.");
  }

  const [isGauge, isAlive, feeDistributor, poolTotalVotes, gaugeRewards] = await Promise.all([
    gauge ? runContractFunction(publicClient, { contract: "voter", functionName: "isGauge", args: [gauge], blockTag: input.blockTag }) : undefined,
    gauge ? runContractFunction(publicClient, { contract: "voter", functionName: "isAlive", args: [gauge], blockTag: input.blockTag }) : undefined,
    gauge ? runContractFunction(publicClient, { contract: "voter", functionName: "feeDistributorForGauge", args: [gauge], blockTag: input.blockTag }) : undefined,
    pool ? runContractFunction(publicClient, { contract: "voter", functionName: "poolTotalVotesPerPeriod", args: [pool, period], blockTag: input.blockTag }) : undefined,
    gauge ? runContractFunction(publicClient, { contract: "voter", functionName: "gaugeRewardsPerPeriod", args: [gauge, period], blockTag: input.blockTag }) : undefined
  ]);

  return {
    chainId: CHAIN_ID,
    period,
    pool,
    gauge,
    isGauge,
    isAlive,
    feeDistributor,
    poolTotalVotes,
    gaugeRewards
  };
}

function defaultSpender(domain: string, action?: string, addressOverride?: string): Address {
  if (addressOverride && (domain === "legacyGauge" || domain === "clGauge")) return asAddress(addressOverride, "addressOverride");
  if (domain === "legacy") return contractRegistry.router.address;
  if (domain === "cl") return contractRegistry.ramsesV3PositionManager.address;
  if (domain === "dlmm") return contractRegistry.dlmmRouter.address;
  if (domain === "vote") return contractRegistry.voteModule.address;
  if (domain === "xphar" && action === "convert") return contractRegistry.xPharToken.address;
  if (domain === "p33") return contractRegistry.p33.address;
  if (domain === "autovault") return contractRegistry.autoVault.address;
  return contractRegistry.router.address;
}

// === REQUIRED APPROVALS ===

/** @summary Check token approvals needed for a given action and account */

export async function requiredApprovals(
  publicClient: PublicClient,
  input: {
    domain: string;
    action?: string;
    account: string;
    tokens?: TokenApprovalInput[];
    nfts?: NftApprovalInput[];
    dlmmPool?: string;
    dlmmOperator?: string;
    addressOverride?: string;
    blockTag?: BlockTag;
  }
) {
  const account = asAddress(input.account, "account");
  const fallbackSpender = defaultSpender(input.domain, input.action, input.addressOverride);
  const tokenChecks = [];

  for (const [index, tokenInput] of (input.tokens ?? []).entries()) {
    const token = asAddress(tokenInput.token, `tokens[${index}].token`);
    if (isNativeToken(token)) {
      tokenChecks.push({ token, native: true, requiredAmount: tokenInput.amount ?? "0", approvalRequired: false });
      continue;
    }
    const spender = tokenInput.spender ? asAddress(tokenInput.spender, `tokens[${index}].spender`) : fallbackSpender;
    const allowance = await tryRead(publicClient, token, contractAbis.erc20Read as Abi, "allowance", [account, spender], input.blockTag);
    const requiredAmount = tokenInput.amount === undefined ? undefined : parseBigIntLike(tokenInput.amount, `tokens[${index}].amount`);
    const allowanceValue = allowance.ok ? BigInt(String(allowance.result)) : undefined;
    tokenChecks.push({
      token,
      spender,
      requiredAmount,
      allowance,
      approvalRequired: requiredAmount === undefined ? allowance.ok && allowanceValue === 0n : allowance.ok && allowanceValue !== undefined && allowanceValue < requiredAmount
    });
  }

  const nftChecks = [];
  for (const [index, nftInput] of (input.nfts ?? []).entries()) {
    const token = asAddress(nftInput.token, `nfts[${index}].token`);
    const operator = nftInput.operator ? asAddress(nftInput.operator, `nfts[${index}].operator`) : fallbackSpender;
    const abi = nftInput.standard === "erc1155" ? contractAbis.erc1155Read as Abi : contractAbis.erc721Read as Abi;
    const isApprovedForAll = await tryRead(publicClient, token, abi, "isApprovedForAll", [account, operator], input.blockTag);
    const tokenId = nftInput.tokenId === undefined ? undefined : parseBigIntLike(nftInput.tokenId, `nfts[${index}].tokenId`);
    const ownerOf = nftInput.standard !== "erc1155" && tokenId !== undefined
      ? await tryRead(publicClient, token, abi, "ownerOf", [tokenId], input.blockTag)
      : undefined;
    const getApproved = nftInput.standard !== "erc1155" && tokenId !== undefined
      ? await tryRead(publicClient, token, abi, "getApproved", [tokenId], input.blockTag)
      : undefined;
    const isOwner = Boolean(ownerOf?.ok && String(ownerOf.result).toLowerCase() === account.toLowerCase());
    nftChecks.push({
      token,
      standard: nftInput.standard ?? "erc721",
      tokenId,
      operator,
      ownerOf,
      isApprovedForAll,
      getApproved,
      approvalRequired: !isOwner
        && !Boolean(isApprovedForAll.ok && isApprovedForAll.result === true)
        && !Boolean(getApproved?.ok && String(getApproved.result).toLowerCase() === operator.toLowerCase())
    });
  }

  const dlmmPool = input.dlmmPool ? asAddress(input.dlmmPool, "dlmmPool") : undefined;
  const dlmmOperator = input.dlmmOperator ? asAddress(input.dlmmOperator, "dlmmOperator") : fallbackSpender;
  const dlmmApprovalForAll = dlmmPool
    ? await tryRead(publicClient, dlmmPool, contractAbis.dlmmPool as Abi, "isApprovedForAll", [account, dlmmOperator], input.blockTag)
    : undefined;

  return {
    chainId: CHAIN_ID,
    domain: input.domain,
    action: input.action,
    account,
    defaultSpender: fallbackSpender,
    tokenChecks,
    nftChecks,
    dlmmApprovalForAll: dlmmPool ? { pool: dlmmPool, operator: dlmmOperator, ...dlmmApprovalForAll } : undefined,
    warning: "Approval discovery is advisory. Verify token, spender/operator, amounts, and final calldata before signing elsewhere."
  };
}

// === UTILITIES ===

/** @summary Get ABI input parameter names for a contract function */

export function functionInputNames(contract: ContractKey | string, functionName: string) {
  const entry = lookupContract(contract);
  const fn = lookupFunction(getContractAbi(entry), functionName) as AbiFunction;
  return {
    contract: entry.key,
    functionName: fn.name,
    signature: functionSignature(fn as never),
    inputs: fn.inputs
  };
}
