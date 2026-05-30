#!/usr/bin/env node
// === IMPORTS ===

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPublicClient, encodeFunctionData, http, type Abi, type BlockTag } from "viem";
import { avalanche } from "viem/chains";
import { z } from "zod";
import { contractAbis } from "./abis.js";
import { CHAIN_ID, DEFAULT_AVALANCHE_RPC_URL, contractRegistry, registryEntries, sourceUrls } from "./contracts.js";
import { pharaohDocsIndex, pharaohDocsPageGet, pharaohDocsSearch } from "./docs.js";
import { stringifyJson } from "./json.js";
import {
  abiFunctions,
  functionSignature,
  getContractAbi,
  lookupContract,
  lookupFunction,
  normalizeAddress,
  normalizeArgs,
  parseBigIntLike
} from "./lookup.js";
import {
  acceptanceStatusRead,
  autoVaultRead,
  clQuote,
  dlmmQuote,
  legacyQuote,
  liquidityPlan,
  p33Read,
  poolDiscover,
  protocolGatesRead,
  readBatch,
  rewardClaimabilityRead,
  requiredApprovals,
  rewardsRead,
  simulateTx,
  mixedRouteSwapPlan,
  swapPlan,
  swapRoutesFind,
  tokenRead,
  validationReadinessRead,
  voteRead,
  walletPositionsRead,
  xpharRead,
  functionInputNames
} from "./queryTools.js";
import {
  buildMappedWorkflowTx,
  buildUnsignedTx,
  autoVaultActionMap,
  autoVaultActions,
  clLiquidityActionMap,
  clLiquidityActions,
  clSwapFunctionNames,
  dlmmActionMap,
  dlmmActions,
  gaugeActionMap,
  gaugeActions,
  legacyLiquidityActionMap,
  legacyLiquidityActions,
  legacySwapFunctionNames,
  p33ActionMap,
  p33Actions,
  voteActionMap,
  voteBuildActions,
  workflowTxResult,
  xPharActionMap,
  xPharActions
} from "./workflowTools.js";

const rpcUrl = process.env.AVALANCHE_RPC_URL || DEFAULT_AVALANCHE_RPC_URL;

const publicClient = createPublicClient({
  chain: avalanche,
  transport: http(rpcUrl)
});

const server = new McpServer({
  name: "phar-mcp",
  version: "0.1.0"
});

// === INPUT SCHEMAS ===

const bigIntLikeSchema = z.union([z.string(), z.number()]);
const workflowArgsSchema = z.array(z.unknown()).optional().describe("ABI arguments as a JSON array. Large integers should be decimal strings.");
const workflowValueSchema = bigIntLikeSchema.optional().describe("Native AVAX value in wei as a decimal string, hex string, or safe integer.");
const blockTagSchema = z.enum(["latest", "earliest", "pending", "safe", "finalized"]);

function workflowEnum<T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values as unknown as [T[number], ...T[number][]]);
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: stringifyJson(value)
      }
    ]
  };
}

function hexByteLength(value: string, label: string) {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} must be 0x-prefixed even-length hex bytes.`);
  }
  return (value.length - 2) / 2;
}

function functionSummaries(contractFilter?: string) {
  const entries = contractFilter ? [lookupContract(contractFilter)] : registryEntries();

  return entries.map((entry) => {
    const abi = entry.abiKey ? getContractAbi(entry) : undefined;
    const functions = abi
      ? abiFunctions(abi).map((fn) => ({
        name: fn.name,
        signature: functionSignature(fn),
        stateMutability: fn.stateMutability,
        inputs: fn.inputs
      }))
      : [];

    return {
      contract: entry.key,
      name: entry.name,
      address: entry.address,
      status: entry.status,
      extractionStatus: entry.status,
      abiKey: entry.abiKey,
      functionListStatus: entry.functionListStatus,
      provenanceNote: entry.provenanceNote,
      functionCount: functions.length,
      functions
    };
  });
}

// === TOOL REGISTRATION ===

server.tool(
  "pharaoh_contracts_get",
  "Return Avalanche chain id, configured RPC URL, official Pharaoh address registry, and source URLs.",
  {},
  async () => jsonResult({
    chainId: CHAIN_ID,
    rpcUrl,
    sourceUrls,
    registry: registryEntries()
  })
);

server.tool(
  "pharaoh_functions_list",
  "List known verified ABI function names, signatures, state mutability, and extraction status. Optionally filter by contract key/name.",
  {
    contract: z.string().optional().describe("Optional contract key or display name, for example router or RamsesV3Factory.")
  },
  async ({ contract }) => jsonResult({
    chainId: CHAIN_ID,
    contracts: functionSummaries(contract)
  })
);

server.tool(
// --- docs tools ---

  "pharaoh_docs_index_get",
  "Fetch and list the live docs.phar.gg pages available to MCP docs search/page tools.",
  {
    refresh: z.boolean().optional().describe("When true, bypass the in-memory docs cache and fetch docs.phar.gg again."),
    maxPages: z.number().int().positive().max(64).optional().describe("Maximum docs pages to discover from the docs navigation. Defaults to 64.")
  },
  async (input) => jsonResult(await pharaohDocsIndex(input))
);

server.tool(
  "pharaoh_docs_search",
  "Search live docs.phar.gg pages and return source URLs plus snippets for answering user documentation questions.",
  {
    query: z.string().min(1).describe("Search query, for example xPHAR redemption, voting rewards, concentrated liquidity, or contract addresses."),
    limit: z.number().int().positive().max(20).optional().describe("Maximum matching pages to return. Defaults to 5."),
    refresh: z.boolean().optional().describe("When true, bypass the in-memory docs cache and fetch docs.phar.gg again."),
    maxPages: z.number().int().positive().max(64).optional().describe("Maximum docs pages to discover from the docs navigation. Defaults to 64."),
    snippetChars: z.number().int().positive().max(2000).optional().describe("Maximum characters per result snippet. Defaults to 600.")
  },
  async (input) => jsonResult(await pharaohDocsSearch(input))
);

server.tool(
  "pharaoh_docs_page_get",
  "Fetch a live docs.phar.gg page as sanitized text for source-backed user answers.",
  {
    pathOrUrl: z.string().optional().describe("Docs path, slug, or full docs.phar.gg URL. Examples: /pages/xphar, xphar, https://docs.phar.gg/pages/voting. Defaults to docs home."),
    refresh: z.boolean().optional().describe("When true, bypass the in-memory docs cache and fetch the page from docs.phar.gg again."),
    maxChars: z.number().int().positive().max(50000).optional().describe("Maximum returned page-text characters. Defaults to 12000.")
  },
  async (input) => jsonResult(await pharaohDocsPageGet(input))
);

server.tool(
  "pharaoh_function_inputs_get",
  "Return ABI input names, types, and component schemas for a registered Pharaoh function. Use this before raw args-array builders.",
  {
    contract: z.string().describe("Contract key or display name from pharaoh_contracts_get."),
    functionName: z.string().describe("Function name or full signature. Use full signature for overloaded functions.")
  },
  async ({ contract, functionName }) => jsonResult(functionInputNames(contract, functionName))
);

server.tool(
  "pharaoh_read",
  "Call a verified view/pure Pharaoh contract function through viem readContract. Bigints are returned as strings.",
  {
    contract: z.string().describe("Contract key or display name from pharaoh_contracts_get."),
    functionName: z.string().describe("Function name or full signature. Use full signature for overloaded functions."),
    args: z.array(z.unknown()).optional().describe("ABI arguments as a JSON array. Large integers should be decimal strings."),
    addressOverride: z.string().optional().describe("Optional contract address override for the selected ABI."),
    blockTag: blockTagSchema.optional()
  },
  async ({ contract, functionName, args, addressOverride, blockTag }) => {
    const entry = lookupContract(contract);
    const abi = getContractAbi(entry);
    const fn = lookupFunction(abi, functionName);

    if (fn.stateMutability !== "view" && fn.stateMutability !== "pure") {
      throw new Error(`pharaoh_read only allows view/pure functions. ${functionSignature(fn)} is ${fn.stateMutability}.`);
    }

    const address = addressOverride ? normalizeAddress(addressOverride, "addressOverride") : entry.address;
    const normalizedArgs = normalizeArgs(fn, args);
    const result = await publicClient.readContract({
      address,
      abi: [fn] as Abi,
      functionName: fn.name,
      args: normalizedArgs,
      blockTag: blockTag as BlockTag | undefined
    } as never);

    return jsonResult({
      chainId: CHAIN_ID,
      contract: entry.key,
      address,
      functionName: fn.name,
      signature: functionSignature(fn),
      args: normalizedArgs,
      blockTag: blockTag ?? "latest",
      result
    });
  }
);

server.tool(
// --- read tools ---

  "pharaoh_read_batch",
  "Call multiple view/pure Pharaoh contract functions and return per-call results. Use addressOverride for deployed pool/gauge/vault instances.",
  {
    calls: z.array(z.object({
      contract: z.string(),
      functionName: z.string(),
      args: z.array(z.unknown()).optional(),
      addressOverride: z.string().optional(),
      blockTag: blockTagSchema.optional(),
      allowFailure: z.boolean().optional()
    })).min(1),
    blockTag: blockTagSchema.optional()
  },
  async ({ calls, blockTag }) => jsonResult(await readBatch(publicClient, calls, blockTag as BlockTag | undefined))
);

server.tool(
  "pharaoh_token_read",
  "Read ERC20 metadata, balance, allowance, and optional native AVAX balance for any token/account.",
  {
    tokenAddress: z.string().optional(),
    account: z.string().optional(),
    spender: z.string().optional(),
    includeMetadata: z.boolean().optional(),
    includeNativeBalance: z.boolean().optional(),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await tokenRead(publicClient, input as Parameters<typeof tokenRead>[1]))
);

server.tool(
  "pharaoh_wallet_positions_read",
  "Read a bounded wallet inventory across tracked Pharaoh tokens, allowances, xPHAR, p33, AutoVault, voting, CL NFTs, DLMM bins, and optional reward claimability.",
  {
    account: z.string(),
    includeAllowances: z.boolean().optional(),
    includeProtocol: z.boolean().optional(),
    includeRewards: z.boolean().optional().describe("When true, also runs the heavier reward claimability planner."),
    extraTokens: z.array(z.object({
      symbol: z.string().optional(),
      address: z.string(),
      decimals: bigIntLikeSchema.optional()
    })).optional(),
    spenders: z.array(z.object({
      name: z.string().optional(),
      address: z.string()
    })).optional(),
    maxClTokenIds: z.number().int().positive().max(200).optional(),
    dlmmPools: z.array(z.object({
      pair: z.string().optional(),
      ids: z.array(bigIntLikeSchema).optional(),
      scanRewardedRange: z.boolean().optional(),
      maxIds: z.number().int().positive().max(500).optional(),
      operator: z.string().optional()
    })).optional(),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await walletPositionsRead(publicClient, input as Parameters<typeof walletPositionsRead>[1]))
);

server.tool(
  "pharaoh_simulate_tx",
  "Readonly eth-call simulation for unsigned Pharaoh calldata. Accepts either contract/functionName/args or raw to/data; never signs or broadcasts.",
  {
    account: z.string().describe("Account used as msg.sender for eth_call/simulateContract."),
    contract: z.string().optional().describe("Registered contract key/name for ABI-aware simulation."),
    functionName: z.string().optional().describe("Function name or full signature for ABI-aware simulation."),
    args: z.array(z.unknown()).optional().describe("ABI args for ABI-aware simulation."),
    addressOverride: z.string().optional().describe("Optional target address for implementation/instance ABIs."),
    to: z.string().optional().describe("Raw transaction target for to/data simulation."),
    data: z.string().optional().describe("Raw calldata for to/data simulation."),
    value: workflowValueSchema,
    includeGasEstimate: z.boolean().optional(),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await simulateTx(publicClient, input as Parameters<typeof simulateTx>[1]))
);

server.tool(
// --- builder tools ---

  "pharaoh_build_tx",
  "Encode unsigned transaction calldata for a verified Pharaoh contract function. This never signs or broadcasts.",
  {
    contract: z.string().describe("Contract key or display name from pharaoh_contracts_get."),
    functionName: z.string().describe("Function name or full signature. Use full signature for overloaded functions."),
    args: z.array(z.unknown()).optional().describe("ABI arguments as a JSON array. Large integers should be decimal strings."),
    value: z.union([z.string(), z.number()]).optional().describe("Native AVAX value in wei as a decimal string, hex string, or safe integer."),
    addressOverride: z.string().optional().describe("Optional contract address override for the selected ABI.")
  },
  async ({ contract, functionName, args, value, addressOverride }) => {
    const tx = buildUnsignedTx({ contract, functionName, args, value, addressOverride });

    return jsonResult({
      chainId: tx.chainId,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      functionName: tx.functionName,
      signature: tx.signature,
      args: tx.args,
      warning: tx.warning
    });
  }
);

server.tool(
  "pharaoh_vote_build_tx",
  "Encode unsigned calldata for voteModule staking/delegation actions and voter voting, claiming, and distribution actions.",
  {
    action: workflowEnum(voteBuildActions).describe("Workflow action. claimClGaugeRewards uses the 3-arg overload; claimClGaugeRewardsWithNfpManagers uses the 4-arg overload whose fourth argument is NFP manager addresses per gauge. claimClGaugeRewardsWithReceivers is a deprecated compatibility alias."),
    args: workflowArgsSchema
  },
  async ({ action, args }) => jsonResult(buildMappedWorkflowTx(action, voteActionMap, { args }))
);

server.tool(
// --- read tools ---

  "pharaoh_vote_read",
  "Read vote-module stake/delegate state, voter period votes, and pool/gauge voting status.",
  {
    action: z.enum(["summary", "poolStatus", "getVotes"]),
    account: z.string().optional(),
    pool: z.string().optional(),
    gauge: z.string().optional(),
    tokenA: z.string().optional(),
    tokenB: z.string().optional(),
    tickSpacing: bigIntLikeSchema.optional(),
    period: bigIntLikeSchema.optional(),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await voteRead(publicClient, input as Parameters<typeof voteRead>[1]))
);

server.tool(
// --- builder tools ---

  "pharaoh_xphar_build_tx",
  "Encode unsigned calldata for xPHAR conversion, exit, rebase, approval, and transfer actions.",
  {
    action: workflowEnum(xPharActions).describe("xPHAR action. convert maps to convertEmissionsToken(uint256)."),
    args: workflowArgsSchema
  },
  async ({ action, args }) => jsonResult(buildMappedWorkflowTx(action, xPharActionMap, { args }))
);

server.tool(
// --- read tools ---

  "pharaoh_xphar_read",
  "Read xPHAR conversion state and quote/static-simulate PHAR->xPHAR conversion or xPHAR exit penalties.",
  {
    action: z.enum(["summary", "convertQuote", "exitQuote"]),
    account: z.string().optional(),
    amount: bigIntLikeSchema.optional(),
    simulate: z.boolean().optional(),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await xpharRead(publicClient, input as Parameters<typeof xpharRead>[1]))
);

server.tool(
  "pharaoh_p33_build_tx",
  "Encode unsigned calldata for p33 ERC4626 deposit/mint/withdraw/redeem and automation actions.",
  {
    action: workflowEnum(p33Actions).describe("p33 action. deposit/mint/withdraw/redeem are ERC4626-compatible; claim/compound/vote actions are operator or protocol flows where contract permissions apply."),
    args: workflowArgsSchema
  },
  async ({ action, args }) => jsonResult(buildMappedWorkflowTx(action, p33ActionMap, { args }))
);

server.tool(
  "pharaoh_p33_read",
  "Read p33 lock/account state and quote whether xPHAR deposit/mint or p33 withdraw/redeem actions are currently actionable.",
  {
    action: z.enum(["summary", "depositQuote", "mintQuote", "withdrawQuote", "redeemQuote"]),
    account: z.string().optional(),
    assets: bigIntLikeSchema.optional(),
    shares: bigIntLikeSchema.optional(),
    receiver: z.string().optional(),
    owner: z.string().optional(),
    simulate: z.boolean().optional(),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await p33Read(publicClient, input as Parameters<typeof p33Read>[1]))
);

server.tool(
// --- read tools ---

  "pharaoh_protocol_gates_read",
  "Read combined live protocol gates for p33 normal-user deposit and DLMM normal-user pool creation, separating protocol state from wallet readiness.",
  {
    account: z.string().optional().describe("Wallet/account used for p33 xPHAR balance and allowance readiness."),
    p33ProbeAssets: bigIntLikeSchema.optional().describe("xPHAR asset amount used for p33 readiness probes. Defaults to 0.03 xPHAR."),
    tokenA: z.string().optional().describe("DLMM pool-creation token A. Defaults to PHAR."),
    tokenB: z.string().optional().describe("DLMM pool-creation token B. Defaults to xPHAR."),
    activeId: bigIntLikeSchema.optional().describe("DLMM activeId for createLBPair builder hints. Defaults to 8388608."),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await protocolGatesRead(publicClient, input as Parameters<typeof protocolGatesRead>[1]))
);

server.tool(
// --- read tools ---

  "pharaoh_validation_readiness_read",
  "Readonly MCP-facing readiness report that composes protocol gates, wallet positions, reward claimability, blockers, and next safe validation actions.",
  {
    account: z.string().optional().describe("Wallet/account used for wallet readiness and reward claimability. If omitted, only protocol-level gates are checked."),
    caller: z.string().optional().describe("Optional caller used for operator-only p33/AutoVault incentive claimability checks."),
    includeWalletPositions: z.boolean().optional().describe("Defaults true when account is supplied."),
    includeRewardClaimability: z.boolean().optional().describe("Defaults true when account is supplied."),
    p33ProbeAssets: bigIntLikeSchema.optional().describe("xPHAR amount used for p33 readiness probes. Defaults to 0.03 xPHAR."),
    tokenA: z.string().optional().describe("DLMM pool-creation token A. Defaults to PHAR."),
    tokenB: z.string().optional().describe("DLMM pool-creation token B. Defaults to xPHAR."),
    activeId: bigIntLikeSchema.optional().describe("DLMM activeId for createLBPair builder hints. Defaults to 8388608."),
    rewardDomains: z.array(z.enum(["autoVault", "legacyGauge", "clGauge", "feeDistributor", "dlmmRewarder", "p33"])).optional(),
    legacyGauges: z.array(z.string()).optional(),
    clPools: z.array(z.object({
      pool: z.string().optional(),
      gauge: z.string().optional(),
      tokenIds: z.array(bigIntLikeSchema).optional(),
      maxTokenIds: z.number().int().positive().max(200).optional()
    })).optional(),
    feeDistributors: z.array(z.object({
      address: z.string().optional(),
      period: bigIntLikeSchema.optional()
    })).optional(),
    dlmmPairs: z.array(z.object({
      pair: z.string().optional(),
      rewarder: z.string().optional(),
      ids: z.array(bigIntLikeSchema).optional(),
      scanRewardedRange: z.boolean().optional(),
      maxIds: z.number().int().positive().max(500).optional()
    })).optional(),
    autoVaultFeeDistributors: z.array(z.object({
      address: z.string(),
      period: bigIntLikeSchema.optional()
    })).optional(),
    autoVaultVotePeriodsBack: z.number().int().min(0).max(16).optional(),
    autoVaultIncludeNextPeriod: z.boolean().optional(),
    p33FeeDistributors: z.array(z.object({
      address: z.string(),
      period: bigIntLikeSchema.optional()
    })).optional(),
    p33VotePeriodsBack: z.number().int().min(0).max(16).optional(),
    p33IncludeNextPeriod: z.boolean().optional(),
    includeZero: z.boolean().optional(),
    maxClTokenIds: z.number().int().positive().max(200).optional(),
    walletDlmmPools: z.array(z.object({
      pair: z.string().optional(),
      ids: z.array(bigIntLikeSchema).optional(),
      scanRewardedRange: z.boolean().optional(),
      maxIds: z.number().int().positive().max(500).optional(),
      operator: z.string().optional()
    })).optional(),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await validationReadinessRead(publicClient, input as Parameters<typeof validationReadinessRead>[1]))
);

server.tool(
// --- read tools ---

  "pharaoh_acceptance_status_read",
  "Read the latest local coverage-aware acceptance and continuation status report. Use this for long-horizon planning; use pharaoh_validation_readiness_read for fresh live actionability.",
  {
    includeContinuationPrompt: z.boolean().optional().describe("Include the full continuation JSON prompt from reports/acceptance-audit.latest.json."),
    includeCompletionBlockers: z.boolean().optional().describe("Include completionBlockingItems. Defaults true."),
    includeFinalOutputSummary: z.boolean().optional().describe("Include compact final-output material: coverage, live/fork tx hashes, verification results, files changed, wallet balances, and warnings.")
  },
  async (input) => jsonResult(acceptanceStatusRead(input))
);

server.tool(
// --- builder tools ---

  "pharaoh_autovault_build_tx",
  "Encode unsigned calldata for the source-backed and selector-backed Pharaoh AutoVault deposit/withdraw/claim and operator actions.",
  {
    action: workflowEnum(autoVaultActions).describe("AutoVault action. This surface is source-backed from app/live-read evidence and selector-backed against the EIP-1967 implementation, not a verified public explorer ABI."),
    args: workflowArgsSchema
  },
  async ({ action, args }) => jsonResult(buildMappedWorkflowTx(action, autoVaultActionMap, { args }))
);

server.tool(
// --- read tools ---

  "pharaoh_autovault_read",
  "Read AutoVault global/account state and preflight deposit, withdraw, or native claim actions with optional static simulation.",
  {
    action: z.enum(["summary", "depositQuote", "withdrawQuote", "claimQuote"]),
    account: z.string().optional(),
    amount: bigIntLikeSchema.optional(),
    outputToken: z.string().optional(),
    simulate: z.boolean().optional(),
    pendingSwapsStart: bigIntLikeSchema.optional(),
    pendingSwapsMax: bigIntLikeSchema.optional(),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await autoVaultRead(publicClient, input as Parameters<typeof autoVaultRead>[1]))
);

server.tool(
// --- builder tools ---

  "pharaoh_legacy_liquidity_build_tx",
  "Encode unsigned calldata for legacy pairFactory createPair and router add/remove liquidity actions.",
  {
    action: workflowEnum(legacyLiquidityActions).describe("Legacy liquidity action."),
    args: workflowArgsSchema,
    value: workflowValueSchema
  },
  async ({ action, args, value }) => jsonResult(buildMappedWorkflowTx(action, legacyLiquidityActionMap, { args, value }))
);

server.tool(
// --- builder tools ---

  "pharaoh_legacy_swap_build_tx",
  "Encode unsigned calldata for legacy router swap functions. This never signs or broadcasts.",
  {
    functionName: workflowEnum(legacySwapFunctionNames).describe("Legacy router swap function."),
    args: workflowArgsSchema,
    value: workflowValueSchema
  },
  async ({ functionName, args, value }) => {
    const tx = buildUnsignedTx({ contract: "router", functionName, args, value });
    return jsonResult(workflowTxResult(tx));
  }
);

server.tool(
// --- planner tools ---

  "pharaoh_swap_plan",
  "Plan a single-hop Pharaoh swap across legacy, CL, or DLMM: quote current state and return approval, builder, and simulation hints without signing or broadcasting.",
  {
    protocol: z.enum(["legacy", "cl", "dlmm"]).optional(),
    side: z.enum(["exactIn", "exactOut"]),
    account: z.string().optional().describe("Optional account for allowance checks and simulation hints."),
    recipient: z.string().optional().describe("Swap recipient. Defaults to account when account is supplied."),
    tokenIn: z.string().describe("Input token address. Use 0x0000000000000000000000000000000000000000 for native AVAX."),
    tokenOut: z.string().describe("Output token address. Use 0x0000000000000000000000000000000000000000 for native AVAX where supported."),
    amountIn: bigIntLikeSchema.optional().describe("Required for exactIn."),
    amountOut: bigIntLikeSchema.optional().describe("Required for exactOut."),
    amountOutMin: bigIntLikeSchema.optional().describe("Optional exactIn slippage bound. If omitted, derived from quote and slippageBps."),
    amountInMax: bigIntLikeSchema.optional().describe("Optional exactOut slippage bound. If omitted, derived from quote and slippageBps."),
    slippageBps: bigIntLikeSchema.optional().describe("Slippage tolerance in basis points for deriving amountOutMin/amountInMax. Defaults to 50."),
    deadline: bigIntLikeSchema.optional().describe("Unix timestamp deadline. Defaults to now + 1800 seconds."),
    stable: z.boolean().optional().describe("Legacy pool stable flag. Defaults false."),
    tickSpacing: bigIntLikeSchema.optional().describe("Required for CL single-hop planning."),
    sqrtPriceLimitX96: bigIntLikeSchema.optional().describe("CL sqrt price limit. Defaults 0."),
    binStep: bigIntLikeSchema.optional().describe("Required for DLMM planning."),
    pair: z.string().optional().describe("Optional DLMM pair address override."),
    dlmmVersion: bigIntLikeSchema.optional().describe("DLMM path version. Defaults 2."),
    hops: z.array(z.object({
      tokenIn: z.string().describe("Hop input token. Use native AVAX only for route endpoints; planner wraps it to WAVAX for pool/path discovery."),
      tokenOut: z.string().describe("Hop output token. Each hop output must match the next hop input after native AVAX wrapping."),
      stable: z.boolean().optional().describe("Legacy route stable flag for this hop. Defaults to top-level stable or false."),
      tickSpacing: bigIntLikeSchema.optional().describe("CL route tick spacing for this hop. Defaults to top-level tickSpacing when supplied."),
      binStep: bigIntLikeSchema.optional().describe("DLMM bin step for this hop. Defaults to top-level binStep when supplied."),
      pair: z.string().optional().describe("Optional deployed DLMM pair override for this hop."),
      dlmmVersion: bigIntLikeSchema.optional().describe("DLMM path version for this hop. Defaults to top-level dlmmVersion or 2.")
    })).optional().describe("Optional same-protocol route hops for multi-hop swap planning. If omitted, the planner uses tokenIn/tokenOut as a single hop."),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await swapPlan(publicClient, input as Parameters<typeof swapPlan>[1]))
);

server.tool(
// --- planner tools ---

  "pharaoh_swap_routes_find",
  "Discover and rank direct or two-hop Pharaoh swap routes, including optional exact-in mixed legacy/CL routes, returning executable plan outputs without signing or broadcasting.",
  {
    side: z.enum(["exactIn", "exactOut"]),
    account: z.string().optional().describe("Optional account for allowance checks and simulation hints."),
    recipient: z.string().optional().describe("Swap recipient. Defaults to account when account is supplied."),
    tokenIn: z.string().describe("Input token address. Use 0x0000000000000000000000000000000000000000 for native AVAX."),
    tokenOut: z.string().describe("Output token address. Use 0x0000000000000000000000000000000000000000 for native AVAX where supported."),
    amountIn: bigIntLikeSchema.optional().describe("Required for exactIn."),
    amountOut: bigIntLikeSchema.optional().describe("Required for exactOut."),
    protocols: z.array(z.enum(["legacy", "cl", "dlmm"])).optional().describe("Protocol families to search. Defaults to legacy, CL, and DLMM."),
    intermediateTokens: z.array(z.string()).optional().describe("Optional bridge tokens for two-hop searches. Defaults to WAVAX, USDC, PHAR, and xPHAR."),
    maxHops: bigIntLikeSchema.optional().describe("1 for direct routes only, or 2 for direct plus one-intermediate routes. Defaults 2."),
    stableTypes: z.array(z.boolean()).optional().describe("Legacy stable flags to inspect. Defaults to both volatile=false and stable=true."),
    tickSpacings: z.array(bigIntLikeSchema).optional().describe("Optional CL tick spacings to inspect. If omitted, Voter.tickSpacingsForPair is used per hop."),
    binSteps: z.array(bigIntLikeSchema).optional().describe("Optional DLMM bin steps to inspect in addition to factory-discovered pairs."),
    slippageBps: bigIntLikeSchema.optional().describe("Slippage tolerance in basis points for each generated plan. Defaults to 50."),
    deadline: bigIntLikeSchema.optional().describe("Unix timestamp deadline. Defaults to now + 1800 seconds."),
    includeBlocked: z.boolean().optional().describe("When true, include sampled blocked/error route candidates."),
    includeMixed: z.boolean().optional().describe("When true and side=exactIn, also discover mixed legacy/CL two-hop candidates using MixedRouteQuoterV1 and UniversalRouter hints."),
    maxRoutes: bigIntLikeSchema.optional().describe("Maximum ranked buildable routes to return. Defaults 5, max 25."),
    maxPlanAttempts: bigIntLikeSchema.optional().describe("Maximum candidate route plans to quote/build. Defaults 48, max 200."),
    maxVariantsPerHop: bigIntLikeSchema.optional().describe("Maximum discovered variants per hop before planning. Defaults 8, max 32."),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await swapRoutesFind(publicClient, input as Parameters<typeof swapRoutesFind>[1]))
);

server.tool(
// --- planner tools ---

  "pharaoh_mixed_route_swap_plan",
  "Plan an exact-in mixed legacy/CL Pharaoh swap route using MixedRouteQuoterV1 and UniversalRouter unsigned calldata, including native AVAX endpoint wrap/unwrap support.",
  {
    side: z.enum(["exactIn"]).optional().describe("Only exactIn is supported because MixedRouteQuoterV1 does not support exactOutput."),
    account: z.string().optional().describe("Optional account for allowance checks and simulation hints."),
    recipient: z.string().optional().describe("Swap recipient. Defaults to account when account is supplied."),
    tokenIn: z.string().describe("Input token address. Use 0x0000000000000000000000000000000000000000 for native AVAX at the route endpoint."),
    tokenOut: z.string().describe("Output token address. Use 0x0000000000000000000000000000000000000000 for native AVAX at the route endpoint."),
    amountIn: bigIntLikeSchema.describe("Exact input amount."),
    amountOutMin: bigIntLikeSchema.optional().describe("Optional final output slippage bound. If omitted, derived from the mixed quote and slippageBps."),
    slippageBps: bigIntLikeSchema.optional().describe("Slippage tolerance in basis points for deriving amountOutMin. Defaults to 50."),
    deadline: bigIntLikeSchema.optional().describe("UniversalRouter execute deadline. Defaults to now + 1800 seconds."),
    hops: z.array(z.object({
      protocol: z.enum(["legacy", "cl"]),
      tokenIn: z.string().describe("Hop input token. Native AVAX is only valid for the first hop endpoint; internal hops should use WAVAX."),
      tokenOut: z.string().describe("Hop output token. Native AVAX is only valid for the last hop endpoint; internal hops should use WAVAX."),
      stable: z.boolean().optional().describe("Required for legacy hops. false=volatile, true=stable."),
      tickSpacing: bigIntLikeSchema.optional().describe("Required for CL hops.")
    })).min(2).max(6).describe("Continuous route hops. Must include at least one legacy hop and one CL hop."),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await mixedRouteSwapPlan(publicClient, input as Parameters<typeof mixedRouteSwapPlan>[1]))
);

server.tool(
// --- planner tools ---

  "pharaoh_liquidity_plan",
  "Plan a single-pool Pharaoh liquidity action across legacy, CL, or DLMM with current reads, approval hints, unsigned builder calls, blockers, and simulation hints.",
  {
    protocol: z.enum(["legacy", "cl", "dlmm"]),
    action: z.enum(["add", "remove", "mint", "increase", "decrease", "collect", "burn"]),
    account: z.string().optional().describe("Optional account used for advisory approval checks and simulation hints."),
    recipient: z.string().optional().describe("Recipient/to address. Defaults to account when account is supplied."),
    refundTo: z.string().optional().describe("DLMM refundTo address. Defaults to recipient."),
    tokenA: z.string().optional().describe("Legacy/CL token A, or DLMM tokenX fallback."),
    tokenB: z.string().optional().describe("Legacy/CL token B, or DLMM tokenY fallback."),
    tokenX: z.string().optional().describe("DLMM tokenX. Use 0x0000000000000000000000000000000000000000 for native AVAX."),
    tokenY: z.string().optional().describe("DLMM tokenY. Use 0x0000000000000000000000000000000000000000 for native AVAX."),
    pair: z.string().optional().describe("Optional deployed DLMM pair override."),
    stable: z.boolean().optional().describe("Legacy stable flag. Defaults false."),
    tickSpacing: bigIntLikeSchema.optional(),
    tickLower: bigIntLikeSchema.optional(),
    tickUpper: bigIntLikeSchema.optional(),
    tokenId: bigIntLikeSchema.optional().describe("CL NFT token id for increase/decrease/collect/burn."),
    binStep: bigIntLikeSchema.optional().describe("DLMM bin step."),
    amountA: bigIntLikeSchema.optional().describe("Legacy/CL amount A/0 desired."),
    amountB: bigIntLikeSchema.optional().describe("Legacy/CL amount B/1 desired."),
    amountAMin: bigIntLikeSchema.optional(),
    amountBMin: bigIntLikeSchema.optional(),
    amountX: bigIntLikeSchema.optional().describe("DLMM tokenX desired amount."),
    amountY: bigIntLikeSchema.optional().describe("DLMM tokenY desired amount."),
    amountXMin: bigIntLikeSchema.optional(),
    amountYMin: bigIntLikeSchema.optional(),
    amount0Max: bigIntLikeSchema.optional().describe("CL collect amount0 max. Defaults uint128 max."),
    amount1Max: bigIntLikeSchema.optional().describe("CL collect amount1 max. Defaults uint128 max."),
    liquidity: bigIntLikeSchema.optional().describe("Legacy LP amount or CL liquidity amount, depending on action."),
    sqrtPriceX96: bigIntLikeSchema.optional().describe("Optional CL pool initialization price for createAndInitializePoolIfNecessary hint."),
    activeIdDesired: bigIntLikeSchema.optional().describe("DLMM active id desired. Defaults to current pool active id for add."),
    idSlippage: bigIntLikeSchema.optional().describe("DLMM id slippage. Defaults 20."),
    deltaIds: z.array(bigIntLikeSchema).optional(),
    distributionX: z.array(bigIntLikeSchema).optional(),
    distributionY: z.array(bigIntLikeSchema).optional(),
    ids: z.array(bigIntLikeSchema).optional().describe("DLMM bin ids for remove."),
    amounts: z.array(bigIntLikeSchema).optional().describe("DLMM bin token amounts for remove."),
    slippageBps: bigIntLikeSchema.optional().describe("Slippage tolerance in basis points for derived minimum amounts. Defaults 50."),
    deadline: bigIntLikeSchema.optional().describe("Unix timestamp deadline. Defaults to now + 1800 seconds."),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await liquidityPlan(publicClient, input as Parameters<typeof liquidityPlan>[1]))
);

server.tool(
// --- read tools ---

  "pharaoh_legacy_quote",
  "Read legacy router quote and pool discovery helpers: amounts in/out, add/remove liquidity quotes, reserves, and pair address.",
  {
    action: z.enum(["getAmountsOut", "getAmountsIn", "getAmountOut", "quoteAddLiquidity", "quoteRemoveLiquidity", "getReserves", "pairFor"]),
    amountIn: bigIntLikeSchema.optional(),
    amountOut: bigIntLikeSchema.optional(),
    routes: z.array(z.object({ from: z.string(), to: z.string(), stable: z.boolean() })).optional(),
    tokenIn: z.string().optional(),
    tokenOut: z.string().optional(),
    tokenA: z.string().optional(),
    tokenB: z.string().optional(),
    stable: z.boolean().optional(),
    amountADesired: bigIntLikeSchema.optional(),
    amountBDesired: bigIntLikeSchema.optional(),
    liquidity: bigIntLikeSchema.optional(),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await legacyQuote(publicClient, input as Parameters<typeof legacyQuote>[1]))
);

server.tool(
// --- read tools ---

  "pharaoh_pool_discover",
  "Discover Pharaoh legacy, CL, and DLMM pools for a token pair, including state, gauges, fee distributors, rewarders, and builder hints.",
  {
    tokenA: z.string(),
    tokenB: z.string(),
    protocols: z.array(z.enum(["legacy", "cl", "dlmm"])).optional().describe("Pool families to inspect. Defaults to all."),
    stableTypes: z.array(z.boolean()).optional().describe("Legacy stable flags to inspect. Defaults to both volatile=false and stable=true."),
    tickSpacings: z.array(bigIntLikeSchema).optional().describe("Optional CL tick spacings to inspect. If omitted, Voter.tickSpacingsForPair(tokenA,tokenB) is used."),
    binSteps: z.array(bigIntLikeSchema).optional().describe("Optional DLMM bin steps to inspect in addition to getAllLBPairs(tokenA,tokenB)."),
    includeState: z.boolean().optional().describe("Read pool state such as reserves, slot0/liquidity, activeId, and DLMM reserves. Defaults true."),
    includeGauges: z.boolean().optional().describe("Read Voter/CL factory gauge, FeeDistributor, and DLMM rewarder links. Defaults true."),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await poolDiscover(publicClient, input as Parameters<typeof poolDiscover>[1]))
);

server.tool(
// --- builder tools ---

  "pharaoh_cl_liquidity_build_tx",
  "Encode unsigned calldata for Ramses V3 factory pool creation and position manager liquidity/reward actions.",
  {
    action: workflowEnum(clLiquidityActions).describe("Concentrated liquidity action."),
    args: workflowArgsSchema,
    value: workflowValueSchema
  },
  async ({ action, args, value }) => jsonResult(buildMappedWorkflowTx(action, clLiquidityActionMap, { args, value }))
);

server.tool(
// --- builder tools ---

  "pharaoh_cl_swap_build_tx",
  "Encode unsigned calldata for swapRouter exact input/output swaps and periphery multicall/refund/unwrap/sweep helpers.",
  {
    functionName: workflowEnum(clSwapFunctionNames).describe("Concentrated liquidity swapRouter function."),
    args: workflowArgsSchema,
    value: workflowValueSchema
  },
  async ({ functionName, args, value }) => {
    const tx = buildUnsignedTx({ contract: "swapRouter", functionName, args, value });
    return jsonResult(workflowTxResult(tx));
  }
);

server.tool(
// --- builder tools ---

  "pharaoh_universal_router_build_tx",
  "Encode unsigned calldata for UniversalRouter execute or collectRewards. This never signs or broadcasts.",
  {
    functionName: z.enum(["execute(bytes,bytes[])", "execute(bytes,bytes[],uint256)", "collectRewards"]),
    commands: z.string().describe("UniversalRouter command bytes as 0x-prefixed hex."),
    inputs: z.array(z.string()).optional().describe("UniversalRouter encoded input payloads as 0x-prefixed hex. Required for execute."),
    deadline: bigIntLikeSchema.optional().describe("Required for execute(bytes,bytes[],uint256)."),
    value: workflowValueSchema
  },
  async ({ functionName, commands, inputs, deadline, value }) => {
    const commandCount = hexByteLength(commands, "commands");
    if (functionName !== "collectRewards") {
      if (!inputs) throw new Error("inputs is required for UniversalRouter execute.");
      for (const [index, input] of inputs.entries()) hexByteLength(input, `inputs[${index}]`);
      if (inputs.length !== commandCount) {
        throw new Error(`UniversalRouter execute requires inputs.length (${inputs.length}) to match command byte count (${commandCount}).`);
      }
    }
    const executeInputs = inputs ?? [];
    const args = functionName === "collectRewards"
      ? [commands]
      : functionName === "execute(bytes,bytes[])"
        ? [commands, executeInputs]
        : [commands, executeInputs, deadline];
    if (functionName === "execute(bytes,bytes[],uint256)" && deadline === undefined) {
      throw new Error("deadline is required for execute(bytes,bytes[],uint256).");
    }
    const tx = buildUnsignedTx({ contract: "universalRouter", functionName, args, value });
    return jsonResult(workflowTxResult(tx));
  }
);

server.tool(
// --- read tools ---

  "pharaoh_cl_quote",
  "Static-call CL quoter contracts for exact input/output quotes. Supports named single-hop params or raw ABI args.",
  {
    quoter: z.enum(["quoterV2", "quoter", "mixedRouteQuoterV1"]).optional(),
    action: z.enum([
      "quoteExactInput",
      "quoteExactOutput",
      "quoteExactInputSingle",
      "quoteExactOutputSingle",
      "quoteExactInputSingleV2",
      "quoteExactInputSingleV3"
    ]).describe("Quote function. MixedRouteQuoterV1 supports quoteExactInput, quoteExactInputSingleV2, and quoteExactInputSingleV3."),
    args: z.array(z.unknown()).optional().describe("Optional raw ABI args. If omitted, named fields are used for common quoter actions."),
    path: z.string().optional(),
    tokenIn: z.string().optional(),
    tokenOut: z.string().optional(),
    amountIn: bigIntLikeSchema.optional(),
    amountOut: bigIntLikeSchema.optional(),
    tickSpacing: bigIntLikeSchema.optional(),
    sqrtPriceLimitX96: bigIntLikeSchema.optional(),
    stable: z.boolean().optional().describe("Required for mixedRouteQuoterV1 quoteExactInputSingleV2 legacy-pair quotes."),
    preflight: z.boolean().optional().describe("When true/default for V3 single-hop quotes, reads factory/pool state before calling the quoter and returns structured blockers."),
    staticAccount: z.string().optional().describe("Optional account used for viem simulateContract; defaults to a nonzero placeholder."),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await clQuote(publicClient, input as Parameters<typeof clQuote>[1]))
);

server.tool(
// --- builder tools ---

  "pharaoh_gauge_build_tx",
  "Encode unsigned calldata for legacy gauge factory creation, CL gauge factory creation, deployed legacy gauge calls, and deployed GaugeV3 calls.",
  {
    action: workflowEnum(gaugeActions).describe("Gauge action. createGauge targets legacyGaugeFactory; createClGauge targets clGaugeFactory; legacy* and CL GaugeV3 instance actions require addressOverride."),
    args: workflowArgsSchema,
    addressOverride: z.string().optional().describe("Required for deployed legacyGauge or clGaugeV3 instance calls. Must be the deployed gauge address, not the implementation/template address.")
  },
  async ({ action, args, addressOverride }) => {
    if ((action === "createGauge" || action === "createClGauge") && addressOverride !== undefined) {
      throw new Error(`${action} targets a registered factory address; do not pass addressOverride for that action.`);
    }

    return jsonResult(buildMappedWorkflowTx(action, gaugeActionMap, { args, addressOverride }));
  }
);

server.tool(
// --- read tools ---

  "pharaoh_rewards_read",
  "Read reward state for deployed legacy gauges, CL gauges, FeeDistributor instances, DLMM rewarders, AutoVault, and p33 reward/lock state.",
  {
    domain: z.enum(["legacyGauge", "clGauge", "feeDistributor", "dlmmRewarder", "autoVault", "p33"]),
    action: z.string().describe("Read action or function name, for example earned, getRewardTokens, rewardData, getPendingRewards, getOutputTokens."),
    addressOverride: z.string().optional().describe("Required for deployed gauge, FeeDistributor, or DLMM rewarder instances."),
    args: z.array(z.unknown()).optional().describe("Optional raw ABI args; when omitted, common actions use named fields."),
    account: z.string().optional(),
    token: z.string().optional(),
    outputToken: z.string().optional().describe("AutoVault output token for getInputBudget/totalSupplyPerOutput helpers."),
    tokenId: bigIntLikeSchema.optional(),
    period: bigIntLikeSchema.optional(),
    ids: z.array(bigIntLikeSchema).optional(),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await rewardsRead(publicClient, input as Parameters<typeof rewardsRead>[1]))
);

server.tool(
// --- read tools ---

  "pharaoh_reward_claimability_read",
  "Compose reward-state reads into an actionable claimability plan with blockers and unsigned-builder hints.",
  {
    account: z.string(),
    domains: z.array(z.enum(["autoVault", "legacyGauge", "clGauge", "feeDistributor", "dlmmRewarder", "p33"])).optional(),
    legacyGauges: z.array(z.string()).optional(),
    clPools: z.array(z.object({
      pool: z.string().optional(),
      gauge: z.string().optional(),
      tokenIds: z.array(bigIntLikeSchema).optional(),
      maxTokenIds: z.number().int().positive().max(200).optional()
    })).optional(),
    feeDistributors: z.array(z.object({
      address: z.string().optional(),
      period: bigIntLikeSchema.optional()
    })).optional(),
    dlmmPairs: z.array(z.object({
      pair: z.string().optional(),
      rewarder: z.string().optional(),
      ids: z.array(bigIntLikeSchema).optional(),
      scanRewardedRange: z.boolean().optional(),
      maxIds: z.number().int().positive().max(500).optional()
    })).optional(),
    autoVaultFeeDistributors: z.array(z.object({
      address: z.string(),
      period: bigIntLikeSchema.optional()
    })).optional().describe("Optional explicit FeeDistributor targets for AutoVault operator incentive claim checks. If omitted, the planner derives targets from AutoVault's recent Voter votes."),
    autoVaultVotePeriodsBack: z.number().int().min(0).max(16).optional().describe("Number of current/prior Voter periods to inspect for AutoVault voted pools. Defaults to 4."),
    autoVaultIncludeNextPeriod: z.boolean().optional().describe("Whether to include currentPeriod + 1 when deriving AutoVault voted pools. Defaults to true."),
    p33FeeDistributors: z.array(z.object({
      address: z.string(),
      period: bigIntLikeSchema.optional()
    })).optional().describe("Optional explicit FeeDistributor targets for p33 operator incentive claim checks. If omitted, the planner derives targets from p33's recent Voter votes."),
    p33VotePeriodsBack: z.number().int().min(0).max(16).optional().describe("Number of current/prior Voter periods to inspect for p33 voted pools. Defaults to 4."),
    p33IncludeNextPeriod: z.boolean().optional().describe("Whether to include currentPeriod + 1 when deriving p33 voted pools. Defaults to true."),
    caller: z.string().optional(),
    includeZero: z.boolean().optional(),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await rewardClaimabilityRead(publicClient, input as Parameters<typeof rewardClaimabilityRead>[1]))
);

server.tool(
// --- builder tools ---

  "pharaoh_dlmm_build_tx",
  "Encode unsigned calldata for DLMM router/factory liquidity and swap actions, DLMM pool bin-token actions, and DLMM rewarder claims.",
  {
    action: workflowEnum(dlmmActions).describe("DLMM action. Pool and rewarder instance actions require addressOverride; router/factory actions use registered addresses."),
    args: workflowArgsSchema,
    value: workflowValueSchema,
    addressOverride: z.string().optional().describe("Required for deployed DLMM pool or rewarder instance actions.")
  },
  async ({ action, args, value, addressOverride }) => jsonResult(buildMappedWorkflowTx(action, dlmmActionMap, { args, value, addressOverride }))
);

server.tool(
// --- read tools ---

  "pharaoh_dlmm_quote",
  "Discover DLMM pools and read swap quotes, active/bin state, prices, decoded hook address hints, and rewarder factory mapping.",
  {
    action: z.enum(["findPair", "getSwapOut", "getSwapIn", "getPriceFromId", "getIdFromPrice", "poolState", "binState", "rewarderForPair"]),
    source: z.enum(["router", "pool"]).optional(),
    pair: z.string().optional(),
    tokenX: z.string().optional(),
    tokenY: z.string().optional(),
    binStep: bigIntLikeSchema.optional(),
    amountIn: bigIntLikeSchema.optional(),
    amountOut: bigIntLikeSchema.optional(),
    swapForY: z.boolean().optional(),
    id: bigIntLikeSchema.optional(),
    price: bigIntLikeSchema.optional(),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await dlmmQuote(publicClient, input as Parameters<typeof dlmmQuote>[1]))
);

server.tool(
// --- read tools ---

  "pharaoh_required_approvals",
  "Check advisory ERC20, ERC721/ERC1155, and DLMM pool approvals for a Pharaoh workflow before building unsigned calldata.",
  {
    domain: z.string().describe("Workflow domain, for example legacy, cl, dlmm, vote, xphar, p33, autovault, legacyGauge, or clGauge."),
    action: z.string().optional(),
    account: z.string(),
    tokens: z.array(z.object({
      token: z.string(),
      amount: bigIntLikeSchema.optional(),
      spender: z.string().optional()
    })).optional(),
    nfts: z.array(z.object({
      token: z.string(),
      tokenId: bigIntLikeSchema.optional(),
      operator: z.string().optional(),
      standard: z.enum(["erc721", "erc1155"]).optional()
    })).optional(),
    dlmmPool: z.string().optional(),
    dlmmOperator: z.string().optional(),
    addressOverride: z.string().optional(),
    blockTag: blockTagSchema.optional()
  },
  async (input) => jsonResult(await requiredApprovals(publicClient, input as Parameters<typeof requiredApprovals>[1]))
);

server.tool(
// --- builder tools ---

  "pharaoh_encode_approval",
  "Encode unsigned ERC20 approve, ERC721/ERC1155 setApprovalForAll, ERC721 approve, or DLMM pool approveForAll calldata.",
  {
    standard: z.enum(["erc20", "erc721", "erc1155", "dlmmPool"]).describe("Token standard to encode. dlmmPool uses Pharaoh DLMM pool approveForAll(address,bool)."),
    tokenAddress: z.string().describe("ERC20/ERC721/ERC1155 token contract address, or DLMM pool address for standard=dlmmPool."),
    approvalType: z.enum(["approve", "setApprovalForAll"]).optional().describe("Defaults to approve for ERC20/ERC721 and setApprovalForAll for ERC1155/DLMM."),
    spender: z.string().optional().describe("Spender/to address for approve."),
    operator: z.string().optional().describe("Operator address for ERC721 setApprovalForAll."),
    amount: z.union([z.string(), z.number()]).optional().describe("ERC20 allowance amount in token base units."),
    tokenId: z.union([z.string(), z.number()]).optional().describe("ERC721 token id for approve."),
    approved: z.boolean().optional().describe("ERC721 setApprovalForAll boolean, defaults to true.")
  },
  async ({ standard, tokenAddress, approvalType, spender, operator, amount, tokenId, approved }) => {
    const to = normalizeAddress(tokenAddress, "tokenAddress");
    const type = approvalType ?? (standard === "erc1155" || standard === "dlmmPool" ? "setApprovalForAll" : "approve");

    if (standard === "erc20") {
      if (type !== "approve") {
        throw new Error("ERC20 approval supports only approvalType=approve.");
      }
      if (spender === undefined || amount === undefined) {
        throw new Error("ERC20 approve requires spender and amount.");
      }

      const args = [normalizeAddress(spender, "spender"), parseBigIntLike(amount, "amount")] as const;
      const data = encodeFunctionData({
        abi: contractAbis.erc20Approval,
        functionName: "approve",
        args
      });

      return jsonResult({
        chainId: CHAIN_ID,
        to,
        data,
        value: "0",
        standard,
        functionName: "approve",
        args,
        warning: "Unsigned ERC20 approval calldata only. Verify token, spender, and amount before signing elsewhere."
      });
    }

    if (standard === "erc1155" || standard === "dlmmPool") {
      if (type !== "setApprovalForAll") {
        throw new Error(`${standard} approvals support only approvalType=setApprovalForAll.`);
      }
      if (operator === undefined) {
        throw new Error(`${standard} setApprovalForAll requires operator.`);
      }

      const args = [normalizeAddress(operator, "operator"), approved ?? true] as const;
      const data = encodeFunctionData({
        abi: standard === "dlmmPool" ? contractAbis.dlmmPool : contractAbis.erc721Approval,
        functionName: standard === "dlmmPool" ? "approveForAll" : "setApprovalForAll",
        args
      } as never);

      return jsonResult({
        chainId: CHAIN_ID,
        to,
        data,
        value: "0",
        standard,
        functionName: standard === "dlmmPool" ? "approveForAll" : "setApprovalForAll",
        args,
        warning: `Unsigned ${standard} approval calldata only. Verify token/pool, operator, and approval boolean before signing elsewhere.`
      });
    }

    if (type === "approve") {
      if (spender === undefined || tokenId === undefined) {
        throw new Error("ERC721 approve requires spender and tokenId.");
      }

      const args = [normalizeAddress(spender, "spender"), parseBigIntLike(tokenId, "tokenId")] as const;
      const data = encodeFunctionData({
        abi: contractAbis.erc721Approval,
        functionName: "approve",
        args
      });

      return jsonResult({
        chainId: CHAIN_ID,
        to,
        data,
        value: "0",
        standard,
        functionName: "approve",
        args,
        warning: "Unsigned ERC721 approval calldata only. Verify token, spender, and tokenId before signing elsewhere."
      });
    }

    if (operator === undefined) {
      throw new Error("ERC721 setApprovalForAll requires operator.");
    }

    const args = [normalizeAddress(operator, "operator"), approved ?? true] as const;
    const data = encodeFunctionData({
      abi: contractAbis.erc721Approval,
      functionName: "setApprovalForAll",
      args
    });

    return jsonResult({
      chainId: CHAIN_ID,
      to,
      data,
      value: "0",
      standard,
      functionName: "setApprovalForAll",
      args,
      warning: "Unsigned ERC721 setApprovalForAll calldata only. Verify token, operator, and approval boolean before signing elsewhere."
    });
  }
);

// === SERVER BOOTSTRAP ===

const transport = new StdioServerTransport();
await server.connect(transport);
