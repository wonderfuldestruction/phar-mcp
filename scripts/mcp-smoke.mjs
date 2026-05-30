#!/usr/bin/env node
import { spawn } from "node:child_process";

const wallet = process.env.PHAR_MCP_WALLET ?? "0x0000000000000000000000000000000000000000";
const phar = "0x13A466998Ce03Db73aBc2d4DF3bBD845Ed1f28E7";
const xphar = "0xE8164Ea89665DAb7a553e667F81F30CfDA736B9A";
const wavax = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
const usdc = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
const usdt = "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7";
const universalRouter = "0x5AcC35397D2ce81Ac54A4B1c6D9e1FB29F8EC6C6";
const nativeAvax = "0x0000000000000000000000000000000000000000";
const dlmmWavaxUsdcPool = "0x8aC5707f8D4BDe1d771d34c7AfD81c3922b73379";
const dlmmRewardedPool = "0x87206a5a6eDDd4e22423425BA66C2591551BFc6f";
const dlmmRewarder = "0x08399f8Fd61EA48DD3BCBe9ccf86D98E64e836d7";
const dlmmRouter = "0xff2BEFC4ff86CB0f3e8D3d9D6200B7A05BF5D93d";
const legacyGauge = "0x16c6657D260D3C49632A040F9FF58A958EFB4f71";
const legacyGaugeFeeDistributor = "0x8dD18390f4F872F27D11a6851Dc3104091102D3f";
const clGauge = "0x4543922018006B46fE7dab001669f38d4e22c728";
const positionManager = "0x0B4478e810D48B5882D4019D435A2f864Bab4F39";
const dlmmBinStep = "5";
const dlmmActiveId = "8337708";
const dlmmPath = [[dlmmBinStep], ["2"], [wavax, usdc]];
const clPathWavaxUsdc10 = `0x${wavax.slice(2)}00000a${usdc.slice(2)}`;
const clPathUsdcWavax10 = `0x${usdc.slice(2)}00000a${wavax.slice(2)}`;
const farFutureDeadline = "4102444800";
const maxUint128 = "340282366920938463463374607431768211455";
const requiredGoalUserFlowKeys = [
  "phar_xphar",
  "xphar_p33",
  "voting",
  "manual_reward_claims",
  "autovault",
  "legacy_pools",
  "cl_pools",
  "dlmm_pools",
  "swaps",
  "quotes",
  "approvals",
  "pool_discovery",
  "liquidity_management",
  "reward_discovery"
];
const dlmmLiquidityParams = [
  wavax,
  usdc,
  dlmmBinStep,
  "1",
  "1",
  "0",
  "0",
  dlmmActiveId,
  "1",
  ["0"],
  ["1000000000000000000"],
  ["0"],
  wallet,
  wallet,
  farFutureDeadline
];
const dlmmMultibinLiquidityParams = [
  wavax,
  usdc,
  dlmmBinStep,
  "999999999989712",
  "1000000",
  "994999999989763",
  "995000",
  "8337719",
  "0",
  ["-4", "-3", "-2", "-1", "0", "1"],
  ["0", "0", "0", "0", "333333333333333333", "666666666666666666"],
  ["222222222222222222", "222222222222222222", "222222222222222222", "222222222222222222", "111111111111111111", "0"],
  wallet,
  wallet,
  farFutureDeadline
];

const smokeCalls = [
  ["pharaoh_contracts_get", {}],
  ["pharaoh_functions_list", { contract: "pharToken" }],
  ["pharaoh_docs_search", {
    query: "xPHAR redemption p33 liquid staking",
    limit: 3,
    snippetChars: 400
  }],
  ["pharaoh_docs_page_get", {
    pathOrUrl: "/pages/xphar",
    maxChars: 7000
  }],
  ["pharaoh_function_inputs_get", { contract: "ramsesV3PositionManager", functionName: "mint" }],
  ["pharaoh_read", { contract: "accessHub", functionName: "voter" }],
  ["pharaoh_read_batch", {
    calls: [
      { contract: "minter", functionName: "weeklyEmissions" },
      { contract: "clGaugeFactory", functionName: "implementation" }
    ]
  }],
  ["pharaoh_token_read", {
    tokenAddress: "0x13A466998Ce03Db73aBc2d4DF3bBD845Ed1f28E7",
    account: wallet,
    includeMetadata: true
  }],
  ["pharaoh_wallet_positions_read", {
    account: wallet,
    includeRewards: false,
    dlmmPools: [
      {
        pair: "0x8aC5707f8D4BDe1d771d34c7AfD81c3922b73379",
        ids: []
      }
    ]
  }],
  ["pharaoh_wallet_positions_read", {
    account: wallet,
    includeAllowances: true,
    includeProtocol: true,
    includeRewards: true,
    maxClTokenIds: 5,
    dlmmPools: [
      {
        pair: dlmmWavaxUsdcPool,
        ids: [dlmmActiveId],
        operator: dlmmRouter
      },
      {
        pair: dlmmRewardedPool,
        scanRewardedRange: true,
        maxIds: 2,
        operator: dlmmRouter
      }
    ]
  }],
  ["pharaoh_simulate_tx", {
    account: wallet,
    contract: "xPharToken",
    functionName: "exit",
    args: ["10000000000000000"]
  }],
  ["pharaoh_vote_read", {
    action: "summary",
    account: wallet
  }],
  ["pharaoh_vote_read", {
    action: "poolStatus",
    pool: "0xf01449C0bA930B6e2CaCA3DEF3CCBd7a3E589534"
  }],
  ["pharaoh_xphar_read", {
    action: "convertQuote",
    account: wallet,
    amount: "10000000000000000"
  }],
  ["pharaoh_xphar_read", {
    action: "exitQuote",
    account: wallet,
    amount: "10000000000000000"
  }],
  ["pharaoh_p33_read", {
    action: "depositQuote",
    account: wallet,
    assets: "30000000000000000",
    simulate: true
  }],
  ["pharaoh_p33_read", {
    action: "mintQuote",
    account: wallet,
    shares: "10000000000000000"
  }],
  ["pharaoh_p33_read", {
    action: "withdrawQuote",
    account: wallet,
    assets: "10000000000000000"
  }],
  ["pharaoh_p33_read", {
    action: "redeemQuote",
    account: wallet,
    shares: "10000000000000000"
  }],
  ["pharaoh_protocol_gates_read", {
    account: wallet,
    p33ProbeAssets: "30000000000000000"
  }],
  ["pharaoh_validation_readiness_read", {
    account: wallet,
    includeWalletPositions: false,
    includeRewardClaimability: true,
    rewardDomains: ["autoVault", "p33"],
    autoVaultVotePeriodsBack: 0,
    p33VotePeriodsBack: 0,
    includeZero: true,
    p33ProbeAssets: "30000000000000000"
  }],
  ["pharaoh_acceptance_status_read", {
    includeContinuationPrompt: false,
    includeCompletionBlockers: true,
    includeFinalOutputSummary: true
  }],
  ["pharaoh_legacy_quote", {
    action: "pairFor",
    tokenA: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    tokenB: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    stable: false
  }],
  ["pharaoh_swap_plan", {
    protocol: "legacy",
    side: "exactIn",
    account: wallet,
    tokenIn: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    tokenOut: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    amountIn: "1000000000000000",
    stable: false
  }],
  ["pharaoh_swap_plan", {
    protocol: "cl",
    side: "exactIn",
    account: wallet,
    tokenIn: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    tokenOut: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    amountIn: "1000000000000000",
    tickSpacing: "10"
  }],
  ["pharaoh_swap_plan", {
    protocol: "cl",
    side: "exactIn",
    account: wallet,
    tokenIn: nativeAvax,
    tokenOut: usdc,
    amountIn: "1000000000000000",
    tickSpacing: "10"
  }],
  ["pharaoh_swap_plan", {
    protocol: "cl",
    side: "exactIn",
    account: wallet,
    tokenIn: usdc,
    tokenOut: nativeAvax,
    amountIn: "10000",
    tickSpacing: "10"
  }],
  ["pharaoh_swap_plan", {
    protocol: "cl",
    side: "exactOut",
    account: wallet,
    tokenIn: nativeAvax,
    tokenOut: usdc,
    amountOut: "10000",
    tickSpacing: "10"
  }],
  ["pharaoh_swap_plan", {
    protocol: "dlmm",
    side: "exactIn",
    account: wallet,
    tokenIn: "0x0000000000000000000000000000000000000000",
    tokenOut: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    amountIn: "100000000000000",
    binStep: "5"
  }],
  ["pharaoh_swap_plan", {
    protocol: "legacy",
    side: "exactIn",
    account: wallet,
    tokenIn: usdc,
    tokenOut: phar,
    amountIn: "10000",
    hops: [
      { tokenIn: usdc, tokenOut: wavax, stable: false },
      { tokenIn: wavax, tokenOut: phar, stable: false }
    ]
  }],
  ["pharaoh_swap_plan", {
    protocol: "cl",
    side: "exactIn",
    account: wallet,
    tokenIn: usdc,
    tokenOut: phar,
    amountIn: "10000",
    hops: [
      { tokenIn: usdc, tokenOut: wavax, tickSpacing: "10" },
      { tokenIn: wavax, tokenOut: phar, tickSpacing: "5" }
    ]
  }],
  ["pharaoh_swap_plan", {
    protocol: "cl",
    side: "exactOut",
    account: wallet,
    tokenIn: usdc,
    tokenOut: phar,
    amountOut: "100000000000000000",
    hops: [
      { tokenIn: usdc, tokenOut: wavax, tickSpacing: "10" },
      { tokenIn: wavax, tokenOut: phar, tickSpacing: "5" }
    ]
  }],
  ["pharaoh_swap_plan", {
    protocol: "cl",
    side: "exactIn",
    account: wallet,
    tokenIn: usdc,
    tokenOut: phar,
    amountIn: "1000000000000000000000000000000",
    tickSpacing: "999"
  }],
  ["pharaoh_swap_plan", {
    protocol: "dlmm",
    side: "exactIn",
    recipient: wallet,
    tokenIn: usdt,
    tokenOut: wavax,
    amountIn: "1000000",
    hops: [
      { tokenIn: usdt, tokenOut: usdc, binStep: "1" },
      { tokenIn: usdc, tokenOut: wavax, binStep: "5" }
    ]
  }],
  ["pharaoh_swap_routes_find", {
    side: "exactIn",
    account: wallet,
    tokenIn: wavax,
    tokenOut: usdc,
    amountIn: "1000000000000000",
    maxHops: "1",
    maxRoutes: "3",
    maxPlanAttempts: "12"
  }],
  ["pharaoh_swap_routes_find", {
    side: "exactIn",
    account: wallet,
    tokenIn: usdc,
    tokenOut: phar,
    amountIn: "10000",
    protocols: ["legacy", "cl"],
    intermediateTokens: [wavax],
    includeMixed: true,
    maxHops: "2",
    maxRoutes: "4",
    maxPlanAttempts: "24"
  }],
  ["pharaoh_swap_routes_find", {
    side: "exactOut",
    account: wallet,
    tokenIn: usdc,
    tokenOut: phar,
    amountOut: "100000000000000000",
    protocols: ["legacy", "cl"],
    intermediateTokens: [wavax],
    maxHops: "2",
    maxRoutes: "3",
    maxPlanAttempts: "12"
  }],
  ["pharaoh_swap_routes_find", {
    side: "exactIn",
    recipient: wallet,
    tokenIn: "0x0000000000000000000000000000000000000000",
    tokenOut: usdc,
    amountIn: "100000000000000",
    protocols: ["legacy", "dlmm"],
    maxHops: "1",
    includeBlocked: true,
    maxRoutes: "3",
    maxPlanAttempts: "12"
  }],
  ["pharaoh_mixed_route_swap_plan", {
    account: wallet,
    tokenIn: usdc,
    tokenOut: phar,
    amountIn: "10000",
    hops: [
      { protocol: "legacy", tokenIn: usdc, tokenOut: wavax, stable: false },
      { protocol: "cl", tokenIn: wavax, tokenOut: phar, tickSpacing: "5" }
    ]
  }],
  ["pharaoh_mixed_route_swap_plan", {
    account: wallet,
    tokenIn: nativeAvax,
    tokenOut: usdc,
    amountIn: "1000000000000000",
    hops: [
      { protocol: "cl", tokenIn: nativeAvax, tokenOut: phar, tickSpacing: "5" },
      { protocol: "legacy", tokenIn: phar, tokenOut: usdc, stable: false }
    ]
  }],
  ["pharaoh_mixed_route_swap_plan", {
    account: wallet,
    tokenIn: usdc,
    tokenOut: nativeAvax,
    amountIn: "10000",
    hops: [
      { protocol: "legacy", tokenIn: usdc, tokenOut: phar, stable: false },
      { protocol: "cl", tokenIn: phar, tokenOut: nativeAvax, tickSpacing: "5" }
    ]
  }],
  ["pharaoh_liquidity_plan", {
    protocol: "legacy",
    action: "add",
    account: wallet,
    tokenA: wavax,
    tokenB: usdc,
    stable: false,
    amountA: "1000000000000000",
    amountB: "100000",
    slippageBps: "50",
    deadline: farFutureDeadline
  }],
  ["pharaoh_liquidity_plan", {
    protocol: "cl",
    action: "mint",
    account: wallet,
    tokenA: wavax,
    tokenB: usdc,
    tickSpacing: "10",
    tickLower: "-887220",
    tickUpper: "887220",
    amountA: "1000000000000000",
    amountB: "100000",
    slippageBps: "50",
    deadline: farFutureDeadline
  }],
  ["pharaoh_liquidity_plan", {
    protocol: "dlmm",
    action: "add",
    account: wallet,
    tokenX: wavax,
    tokenY: usdc,
    binStep: "5",
    amountX: "100000000000000",
    amountY: "10000",
    deltaIds: ["0"],
    distributionX: ["1000000000000000000"],
    distributionY: ["1000000000000000000"],
    slippageBps: "50",
    deadline: farFutureDeadline
  }],
  ["pharaoh_liquidity_plan", {
    protocol: "dlmm",
    action: "add",
    account: wallet,
    tokenX: usdc,
    tokenY: wavax,
    binStep: "5",
    amountX: "1000000000000000000000000000000",
    amountY: "1000000000000000000000000000000",
    deltaIds: ["0"],
    distributionX: ["1000000000000000000"],
    distributionY: ["1000000000000000000"],
    slippageBps: "50",
    deadline: farFutureDeadline
  }],
  ["pharaoh_liquidity_plan", {
    protocol: "dlmm",
    action: "remove",
    account: wallet,
    recipient: wallet,
    tokenX: nativeAvax,
    tokenY: usdc,
    pair: "0x8aC5707f8D4BDe1d771d34c7AfD81c3922b73379",
    binStep: "5",
    amountXMin: "111",
    amountYMin: "222",
    ids: ["0"],
    amounts: ["1"],
    slippageBps: "50",
    deadline: farFutureDeadline
  }],
  ["pharaoh_pool_discover", {
    tokenA: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    tokenB: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"
  }],
  ["pharaoh_cl_quote", {
    quoter: "quoterV2",
    action: "quoteExactInputSingle",
    tokenIn: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    tokenOut: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    tickSpacing: "10",
    amountIn: "1000000000000000"
  }],
  ["pharaoh_cl_quote", {
    quoter: "mixedRouteQuoterV1",
    action: "quoteExactInputSingleV3",
    tokenIn: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    tokenOut: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    tickSpacing: "10",
    amountIn: "1000000000000000"
  }],
  ["pharaoh_rewards_read", {
    domain: "legacyGauge",
    action: "rewardsList",
    addressOverride: "0x44cf080397ceF7D9344A1f0f84052AC474a5B43e"
  }],
  ["pharaoh_rewards_read", {
    domain: "autoVault",
    action: "getStoredRewards",
    account: wallet
  }],
  ["pharaoh_autovault_read", {
    action: "depositQuote",
    account: wallet,
    amount: "1000000000000000000",
    outputToken: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"
  }],
  ["pharaoh_autovault_read", {
    action: "withdrawQuote",
    account: wallet,
    amount: "1000000000000000000"
  }],
  ["pharaoh_autovault_read", {
    action: "claimQuote",
    account: wallet
  }],
  ["pharaoh_rewards_read", {
    domain: "p33",
    action: "isUnlocked",
    account: wallet
  }],
  ["pharaoh_reward_claimability_read", {
    account: wallet,
    domains: ["autoVault", "legacyGauge", "clGauge", "feeDistributor", "dlmmRewarder", "p33"],
    includeZero: true
  }],
  ["pharaoh_dlmm_quote", {
    action: "poolState",
    tokenX: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    tokenY: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    binStep: "5"
  }],
  ["pharaoh_dlmm_quote", {
    action: "rewarderForPair",
    pair: "0x87206a5a6eDDd4e22423425BA66C2591551BFc6f"
  }],
  ["pharaoh_required_approvals", {
    domain: "dlmm",
    account: wallet,
    tokens: [
      {
        token: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        amount: "100000"
      }
    ],
    dlmmPool: "0x8aC5707f8D4BDe1d771d34c7AfD81c3922b73379"
  }],
  ["pharaoh_encode_approval", {
    standard: "erc20",
    tokenAddress: usdc,
    spender: dlmmRouter,
    amount: "1"
  }],
  ["pharaoh_encode_approval", {
    standard: "erc721",
    tokenAddress: positionManager,
    approvalType: "approve",
    spender: universalRouter,
    tokenId: "1"
  }],
  ["pharaoh_encode_approval", {
    standard: "erc721",
    tokenAddress: positionManager,
    approvalType: "setApprovalForAll",
    operator: universalRouter,
    approved: true
  }],
  ["pharaoh_encode_approval", {
    standard: "erc1155",
    tokenAddress: dlmmWavaxUsdcPool,
    operator: dlmmRouter,
    approved: true
  }],
  ["pharaoh_encode_approval", {
    standard: "dlmmPool",
    tokenAddress: "0x8aC5707f8D4BDe1d771d34c7AfD81c3922b73379",
    operator: "0xff2BEFC4ff86CB0f3e8D3d9D6200B7A05BF5D93d"
  }],
  ["pharaoh_build_tx", {
    contract: "xPharToken",
    functionName: "exit",
    args: ["10000000000000000"]
  }],
  ["pharaoh_vote_build_tx", {
    action: "deposit",
    args: ["1"]
  }],
  ["pharaoh_vote_build_tx", {
    action: "depositAll",
    args: []
  }],
  ["pharaoh_vote_build_tx", {
    action: "withdraw",
    args: ["1"]
  }],
  ["pharaoh_vote_build_tx", {
    action: "withdrawAll",
    args: []
  }],
  ["pharaoh_vote_build_tx", {
    action: "delegate",
    args: [wallet]
  }],
  ["pharaoh_vote_build_tx", {
    action: "vote",
    args: [wallet, [clGauge], ["1"]]
  }],
  ["pharaoh_vote_build_tx", {
    action: "reset",
    args: [wallet]
  }],
  ["pharaoh_vote_build_tx", {
    action: "poke",
    args: [wallet]
  }],
  ["pharaoh_vote_build_tx", {
    action: "claimRewards",
    args: [[legacyGauge], [[phar]]]
  }],
  ["pharaoh_vote_build_tx", {
    action: "claimIncentives",
    args: [wallet, [legacyGaugeFeeDistributor], [[phar]]]
  }],
  ["pharaoh_vote_build_tx", {
    action: "claimLegacyIncentives",
    args: [wallet, [legacyGaugeFeeDistributor], [[phar]]]
  }],
  ["pharaoh_vote_build_tx", {
    action: "claimClGaugeRewards",
    args: [[clGauge], [[phar]], [["1"]]]
  }],
  ["pharaoh_vote_build_tx", {
    action: "claimClGaugeRewardsWithNfpManagers",
    args: [[clGauge], [[phar]], [["1"]], [positionManager]]
  }],
  ["pharaoh_vote_build_tx", {
    action: "distribute",
    args: [legacyGauge]
  }],
  ["pharaoh_vote_build_tx", {
    action: "distributeAll",
    args: []
  }],
  ["pharaoh_vote_build_tx", {
    action: "distributeForPeriod",
    args: [clGauge, "2943"]
  }],
  ["pharaoh_xphar_build_tx", {
    action: "convert",
    args: ["10000000000000000"]
  }],
  ["pharaoh_xphar_build_tx", {
    action: "exit",
    args: ["10000000000000000"]
  }],
  ["pharaoh_xphar_build_tx", {
    action: "rebase",
    args: []
  }],
  ["pharaoh_xphar_build_tx", {
    action: "approve",
    args: [wallet, "1"]
  }],
  ["pharaoh_p33_build_tx", {
    action: "deposit",
    args: ["30000000000000000", wallet]
  }],
  ["pharaoh_p33_build_tx", {
    action: "mint",
    args: ["10000000000000000", wallet]
  }],
  ["pharaoh_p33_build_tx", {
    action: "withdraw",
    args: ["10000000000000000", wallet, wallet]
  }],
  ["pharaoh_p33_build_tx", {
    action: "redeem",
    args: ["10000000000000000", wallet, wallet]
  }],
  ["pharaoh_p33_build_tx", {
    action: "approve",
    args: [wallet, "1"]
  }],
  ["pharaoh_p33_build_tx", {
    action: "claimIncentives",
    args: [[], []]
  }],
  ["pharaoh_autovault_build_tx", {
    action: "deposit",
    args: ["1000000000000000000", usdc]
  }],
  ["pharaoh_autovault_build_tx", {
    action: "withdraw",
    args: ["1000000000000000000"]
  }],
  ["pharaoh_autovault_build_tx", {
    action: "claim",
    args: []
  }],
  ["pharaoh_autovault_build_tx", {
    action: "setOutputPreference",
    args: [usdc]
  }],
  ["pharaoh_autovault_build_tx", {
    action: "claimIncentives",
    args: [[], []]
  }],
  ["pharaoh_autovault_build_tx", {
    action: "lock",
    args: []
  }],
  ["pharaoh_legacy_liquidity_build_tx", {
    action: "createPair",
    args: [phar, xphar, false]
  }],
  ["pharaoh_legacy_liquidity_build_tx", {
    action: "addLiquidity",
    args: [wavax, usdc, false, "1", "1", "0", "0", wallet, farFutureDeadline]
  }],
  ["pharaoh_legacy_liquidity_build_tx", {
    action: "addLiquidityETH",
    args: [usdc, false, "1", "0", "0", wallet, farFutureDeadline],
    value: "1"
  }],
  ["pharaoh_legacy_liquidity_build_tx", {
    action: "addLiquidityAndStake",
    args: [wavax, usdc, false, "1", "1", "0", "0", wallet, farFutureDeadline]
  }],
  ["pharaoh_legacy_liquidity_build_tx", {
    action: "addLiquidityETHAndStake",
    args: [usdc, false, "1", "0", "0", wallet, farFutureDeadline],
    value: "1"
  }],
  ["pharaoh_legacy_liquidity_build_tx", {
    action: "removeLiquidity",
    args: [wavax, usdc, false, "1", "0", "0", wallet, farFutureDeadline]
  }],
  ["pharaoh_legacy_liquidity_build_tx", {
    action: "removeLiquidityETH",
    args: [usdc, false, "1", "0", "0", wallet, farFutureDeadline]
  }],
  ["pharaoh_legacy_liquidity_build_tx", {
    action: "removeLiquidityETHSupportingFeeOnTransferTokens",
    args: [usdc, false, "1", "0", "0", wallet, farFutureDeadline]
  }],
  ["pharaoh_legacy_swap_build_tx", {
    functionName: "swapETHForExactTokens",
    args: [
      "1",
      [{ from: wavax, to: usdc, stable: false }],
      wallet,
      farFutureDeadline
    ],
    value: "1"
  }],
  ["pharaoh_legacy_swap_build_tx", {
    functionName: "swapExactETHForTokens",
    args: [
      "1",
      [{ from: wavax, to: usdc, stable: false }],
      wallet,
      farFutureDeadline
    ],
    value: "1"
  }],
  ["pharaoh_legacy_swap_build_tx", {
    functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
    args: [
      "1",
      [{ from: wavax, to: usdc, stable: false }],
      wallet,
      farFutureDeadline
    ],
    value: "1"
  }],
  ["pharaoh_legacy_swap_build_tx", {
    functionName: "swapExactTokensForETH",
    args: [
      "1",
      "1",
      [{ from: usdc, to: wavax, stable: false }],
      wallet,
      farFutureDeadline
    ]
  }],
  ["pharaoh_legacy_swap_build_tx", {
    functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
    args: [
      "1",
      "1",
      [{ from: usdc, to: wavax, stable: false }],
      wallet,
      farFutureDeadline
    ]
  }],
  ["pharaoh_legacy_swap_build_tx", {
    functionName: "swapExactTokensForTokens",
    args: [
      "100000",
      "1",
      [{ from: usdc, to: phar, stable: false }],
      wallet,
      farFutureDeadline
    ]
  }],
  ["pharaoh_legacy_swap_build_tx", {
    functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    args: [
      "1",
      "1",
      [{ from: usdc, to: phar, stable: false }],
      wallet,
      farFutureDeadline
    ]
  }],
  ["pharaoh_legacy_swap_build_tx", {
    functionName: "swapTokensForExactETH",
    args: [
      "1",
      "1",
      [{ from: usdc, to: wavax, stable: false }],
      wallet,
      farFutureDeadline
    ]
  }],
  ["pharaoh_legacy_swap_build_tx", {
    functionName: "swapTokensForExactTokens",
    args: [
      "1",
      "1",
      [{ from: usdc, to: phar, stable: false }],
      wallet,
      farFutureDeadline
    ]
  }],
  ["pharaoh_cl_liquidity_build_tx", {
    action: "createPool",
    args: [phar, xphar, "10", "79228162514264337593543950336"]
  }],
  ["pharaoh_cl_liquidity_build_tx", {
    action: "createAndInitializePoolIfNecessary",
    args: [phar, xphar, "10", "79228162514264337593543950336"]
  }],
  ["pharaoh_cl_liquidity_build_tx", {
    action: "mint",
    args: [[wavax, usdc, "10", "-887220", "887220", "1", "1", "0", "0", wallet, farFutureDeadline]]
  }],
  ["pharaoh_cl_liquidity_build_tx", {
    action: "increaseLiquidity",
    args: [["1", "1", "1", "0", "0", farFutureDeadline]]
  }],
  ["pharaoh_cl_liquidity_build_tx", {
    action: "decreaseLiquidity",
    args: [["1", "0", "0", "0", farFutureDeadline]]
  }],
  ["pharaoh_cl_liquidity_build_tx", {
    action: "collect",
    args: [["1", wallet, maxUint128, maxUint128]]
  }],
  ["pharaoh_cl_liquidity_build_tx", {
    action: "burn",
    args: ["1"]
  }],
  ["pharaoh_cl_liquidity_build_tx", {
    action: "getReward",
    args: ["1", [phar]]
  }],
  ["pharaoh_cl_liquidity_build_tx", {
    action: "getPeriodReward",
    args: ["1", "2943", [phar], wallet]
  }],
  ["pharaoh_cl_swap_build_tx", {
    functionName: "exactInput((bytes,address,uint256,uint256,uint256))",
    args: [[clPathWavaxUsdc10, wallet, farFutureDeadline, "1", "0"]]
  }],
  ["pharaoh_cl_swap_build_tx", {
    functionName: "exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))",
    args: [[wavax, usdc, "10", wallet, farFutureDeadline, "1000000000000000", "1", "0"]]
  }],
  ["pharaoh_cl_swap_build_tx", {
    functionName: "exactOutput((bytes,address,uint256,uint256,uint256))",
    args: [[clPathUsdcWavax10, wallet, farFutureDeadline, "1", "1"]]
  }],
  ["pharaoh_cl_swap_build_tx", {
    functionName: "exactOutputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))",
    args: [[wavax, usdc, "10", wallet, farFutureDeadline, "1", "1", "0"]]
  }],
  ["pharaoh_cl_swap_build_tx", {
    functionName: "multicall",
    args: [["0x"]]
  }],
  ["pharaoh_cl_swap_build_tx", {
    functionName: "refundETH",
    args: []
  }],
  ["pharaoh_cl_swap_build_tx", {
    functionName: "sweepToken",
    args: [usdc, "0", wallet]
  }],
  ["pharaoh_cl_swap_build_tx", {
    functionName: "sweepTokenWithFee",
    args: [usdc, "0", wallet, "0", wallet]
  }],
  ["pharaoh_cl_swap_build_tx", {
    functionName: "unwrapWETH9",
    args: ["0", wallet]
  }],
  ["pharaoh_cl_swap_build_tx", {
    functionName: "unwrapWETH9WithFee",
    args: ["0", wallet, "0", wallet]
  }],
  ["pharaoh_universal_router_build_tx", {
    functionName: "execute(bytes,bytes[],uint256)",
    commands: "0x",
    inputs: [],
    deadline: farFutureDeadline
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "routerCreateLBPair",
    args: [phar, xphar, "8388608", "5"]
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "factoryCreateLBPair",
    args: [phar, xphar, "8388608", "5"]
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "addLiquidity",
    args: [dlmmLiquidityParams]
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "addLiquidity",
    args: [dlmmMultibinLiquidityParams]
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "addLiquidityNATIVE",
    args: [dlmmLiquidityParams],
    value: "1"
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "removeLiquidity",
    args: [wavax, usdc, dlmmBinStep, "0", "0", [dlmmActiveId], ["0"], wallet, farFutureDeadline]
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "removeLiquidityNATIVE",
    args: [usdc, dlmmBinStep, "0", "0", [dlmmActiveId], ["0"], wallet, farFutureDeadline]
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "swapExactNATIVEForTokens",
    args: ["1", dlmmPath, wallet, farFutureDeadline],
    value: "1"
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "swapExactNATIVEForTokensSupportingFeeOnTransferTokens",
    args: ["1", dlmmPath, wallet, farFutureDeadline],
    value: "1"
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "swapExactTokensForNATIVE",
    args: ["1", "1", dlmmPath, wallet, farFutureDeadline]
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "swapExactTokensForNATIVESupportingFeeOnTransferTokens",
    args: ["1", "1", dlmmPath, wallet, farFutureDeadline]
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "swapExactTokensForTokens",
    args: ["1", "1", dlmmPath, wallet, farFutureDeadline]
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    args: ["1", "1", dlmmPath, wallet, farFutureDeadline]
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "swapNATIVEForExactTokens",
    args: ["1", dlmmPath, wallet, farFutureDeadline],
    value: "1"
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "swapTokensForExactNATIVE",
    args: ["1", "1", dlmmPath, wallet, farFutureDeadline]
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "swapTokensForExactTokens",
    args: ["1", "1", dlmmPath, wallet, farFutureDeadline]
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "approveForAll",
    args: [dlmmRouter, true],
    addressOverride: dlmmWavaxUsdcPool
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "batchTransferFrom",
    args: [wallet, wallet, [dlmmActiveId], ["0"]],
    addressOverride: dlmmWavaxUsdcPool
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "poolMint",
    args: [wallet, [], wallet],
    addressOverride: dlmmWavaxUsdcPool
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "poolBurn",
    args: [wallet, wallet, [dlmmActiveId], ["0"]],
    addressOverride: dlmmWavaxUsdcPool
  }],
  ["pharaoh_dlmm_build_tx", {
    action: "rewarderClaim",
    args: [wallet, [dlmmActiveId]],
    addressOverride: dlmmRewarder
  }],
  ["pharaoh_gauge_build_tx", {
    action: "createGauge",
    args: [legacyGauge]
  }],
  ["pharaoh_gauge_build_tx", {
    action: "createClGauge",
    args: [clGauge]
  }],
  ["pharaoh_gauge_build_tx", {
    action: "legacyDeposit",
    args: ["1000"],
    addressOverride: legacyGauge
  }],
  ["pharaoh_gauge_build_tx", {
    action: "legacyDepositAll",
    args: [],
    addressOverride: legacyGauge
  }],
  ["pharaoh_gauge_build_tx", {
    action: "legacyDepositFor",
    args: [wallet, "1000"],
    addressOverride: legacyGauge
  }],
  ["pharaoh_gauge_build_tx", {
    action: "legacyWithdraw",
    args: ["1000"],
    addressOverride: legacyGauge
  }],
  ["pharaoh_gauge_build_tx", {
    action: "legacyWithdrawAll",
    args: [],
    addressOverride: legacyGauge
  }],
  ["pharaoh_gauge_build_tx", {
    action: "legacyUnstakeAndClaimAll",
    args: [[phar]],
    addressOverride: legacyGauge
  }],
  ["pharaoh_gauge_build_tx", {
    action: "legacyGetReward",
    args: [wallet, [phar]],
    addressOverride: legacyGauge
  }],
  ["pharaoh_gauge_build_tx", {
    action: "cachePeriodEarned",
    args: ["2943", wallet, phar, "1", "-887220", "887220", false],
    addressOverride: clGauge
  }],
  ["pharaoh_gauge_build_tx", {
    action: "getPeriodReward",
    args: ["1", [phar], wallet, "2943", "-887220", "887220", wallet],
    addressOverride: clGauge
  }],
  ["pharaoh_gauge_build_tx", {
    action: "getReward",
    args: ["1", [phar]],
    addressOverride: clGauge
  }],
  ["pharaoh_gauge_build_tx", {
    action: "getRewardForTokenIds",
    args: [["1"], [phar]],
    addressOverride: clGauge
  }],
  ["pharaoh_gauge_build_tx", {
    action: "getRewardForOwner",
    args: ["1", [phar]],
    addressOverride: clGauge
  }],
  ["pharaoh_gauge_build_tx", {
    action: "getRewardForPosition",
    args: [wallet, "1", "-887220", "887220", [phar], wallet],
    addressOverride: clGauge
  }],
  ["pharaoh_gauge_build_tx", {
    action: "getRewardForOwnerFromVoter",
    args: [wallet, "1", [phar]],
    addressOverride: clGauge
  }]
];

function createClient() {
  const child = spawn("node", ["dist/index.js"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });

  const pending = new Map();
  let nextId = 1;
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  function send(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}. stderr=${stderr}`));
      }, 30_000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });
  }

  return { child, send };
}

function extractText(response) {
  return response?.result?.content?.[0]?.text ?? JSON.stringify(response?.error ?? response?.result ?? response);
}

function parsePayload(text) {
  try {
    return { ok: true, payload: JSON.parse(text) };
  } catch (error) {
    return { ok: false, reason: `expected JSON payload: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function responseSummary(name, payload) {
  if (name !== "pharaoh_acceptance_status_read") return undefined;
  const summary = payload.finalOutputSummary ?? {};
  const userFlows = summary.userFlowCoverageMatrix ?? summary.coverageSummaryByDomain?.userFlows ?? {};
  return {
    timestamp: payload.timestamp ?? null,
    goalComplete: payload.goalComplete === true,
    overallStatus: payload.overallStatus ?? null,
    recommendedNextAction: payload.recommendedNextAction ?? null,
    currentStateRecommendedNextAction: payload.currentStateRecommendedNextAction ?? null,
    p33Complete: payload.coverageContext?.p33Complete === true,
    remainingBlockerKeys: (payload.remainingBlockers ?? []).map((item) => item.key),
    completionBlockingKeys: (payload.completionBlockingItems ?? []).map((item) => item.key),
    finalOutputSummary: {
      liveTransactionCount: summary.liveTransactionHashes?.length ?? 0,
      forkTransactionCount: summary.forkSimulationSummary?.transactions?.length ?? 0,
	      verificationCommandCount: summary.verificationCommandsAndResults?.length ?? 0,
	      verificationCommandsCount: summary.verificationCommands?.length ?? 0,
	      filesChangedCount: summary.filesChanged?.paths?.length ?? 0,
	      approvalsCleared: summary.currentWalletBalancesAndApprovals?.approvalsCleared ?? null,
	      fundingTopUpRequired: summary.fundingTopUpRequest?.required ?? null,
	      fundingTopUpStatus: summary.fundingTopUpRequest?.status ?? null,
	      coverageDomains: Object.keys(summary.coverageSummaryByDomain ?? {}),
	      userFlowKeys: (userFlows.flows ?? []).map((flow) => flow.flowKey),
	      requiredUserFlowKeys: userFlows.requiredFlowKeys ?? [],
	      userFlowStatusCounts: userFlows.summary?.statusCounts ?? null
	    }
	  };
}

function expectsUnsignedCalldata(name) {
  return name === "pharaoh_build_tx"
    || name === "pharaoh_encode_approval"
    || name.endsWith("_build_tx");
}

function expectsOperatorWarning(name, payload) {
  const action = payload?.action;
  return (name === "pharaoh_p33_build_tx" && [
    "claimIncentives",
    "compound",
    "submitVotes",
    "swapIncentiveViaAggregator",
    "unlock"
  ].includes(action))
    || (name === "pharaoh_autovault_build_tx" && [
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
	    ].includes(action));
}

function validateSuppressedQuoteBuildHints(payload, label) {
  if (payload.quote?.canSubmit === false) {
    const buildCallsSuppressed = !Object.hasOwn(payload.quote, "buildCalls")
      || payload.quote.buildCalls === null;
    const buildCallSuppressed = !Object.hasOwn(payload.quote, "buildCall")
      || payload.quote.buildCall === null;
    const statusOk = (payload.quote.buildCallsStatus ?? payload.quote.buildCallStatus) === "blocked_canSubmit_false";
    const reasonOk = typeof (payload.quote.buildCallsSuppressedReason ?? payload.quote.buildCallSuppressedReason) === "string";
    const blockersOk = Array.isArray(payload.quote.blockers) && payload.quote.blockers.length > 0;

    return {
      ok: buildCallsSuppressed && buildCallSuppressed && statusOk && reasonOk && blockersOk,
      reason: `blocked ${label} quote suppressed=${buildCallsSuppressed && buildCallSuppressed} status=${statusOk} reason=${reasonOk} blockers=${blockersOk}`
    };
  }

  if (payload.quote?.canSubmit === true) {
    const buildCallsPresent = !Object.hasOwn(payload.quote, "buildCalls")
      || payload.quote.buildCalls !== null;
    const buildCallPresent = !Object.hasOwn(payload.quote, "buildCall")
      || payload.quote.buildCall !== null;
    const statusOk = !Object.hasOwn(payload.quote, "buildCallsStatus")
      || payload.quote.buildCallsStatus === "actionable";
    const singularStatusOk = !Object.hasOwn(payload.quote, "buildCallStatus")
      || payload.quote.buildCallStatus === "actionable";

    return {
      ok: buildCallsPresent && buildCallPresent && statusOk && singularStatusOk,
      reason: `actionable ${label} quote buildCalls=${buildCallsPresent} buildCall=${buildCallPresent} status=${statusOk && singularStatusOk}`
    };
  }

  return { ok: true };
}

function validateSuppressedBlockedPlanBuildHints(payload, label) {
  if (payload?.canBuild !== false) return { ok: true };

  const topBuildCallOk = !Object.hasOwn(payload, "buildCall") || payload.buildCall === null;
  const approvalOk = !payload.approval || !Object.hasOwn(payload.approval, "buildCall") || payload.approval.buildCall === null;
  const approvalsOk = !Array.isArray(payload.approvals)
    || payload.approvals.every((approval) => !approval || !Object.hasOwn(approval, "buildCall") || approval.buildCall === null);

  return {
    ok: topBuildCallOk && approvalOk && approvalsOk,
    reason: `blocked ${label} plan top=${topBuildCallOk} approval=${approvalOk} approvals=${approvalsOk}`
  };
}

function validateBlockedClaimabilityBuildHints(payload) {
  const leaks = [];

  function visit(value, path) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }

    const blocked = value.claimable === false
      || value.status === "blocked"
      || (Array.isArray(value.blockers) && value.blockers.length > 0);
    if (blocked && Object.hasOwn(value, "buildCall") && value.buildCall !== null) {
      leaks.push(path);
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "buildCall") continue;
      visit(child, path ? `${path}.${key}` : key);
    }
  }

  visit(payload.domains, "domains");

  return {
    ok: leaks.length === 0,
    reason: leaks.length === 0 ? "blocked claimability build hints suppressed" : `blocked claimability buildCall leaks at ${leaks.join(", ")}`
  };
}

function validateToolResponse(name, args, response) {
  const text = extractText(response);

  if (name === "pharaoh_contracts_get") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    const payload = parsed.payload;
    const registry = Array.isArray(payload.registry) ? payload.registry : [];
    const chainOk = payload.chainId === 43114;
    const registryOk = registry.length > 0;
    const provenanceOk = registry.some((entry) =>
      typeof entry?.status === "string" &&
      typeof entry?.functionListStatus === "string" &&
      typeof entry?.provenanceNote === "string"
    );
    const sourcesOk = payload.sourceUrls && typeof payload.sourceUrls === "object" && Object.keys(payload.sourceUrls).length > 0;
    return {
      ok: chainOk && registryOk && provenanceOk && sourcesOk,
      reason: `chain=${chainOk} registry=${registry.length} provenance=${provenanceOk} sourceUrls=${sourcesOk}`
    };
  }

  if (name === "pharaoh_docs_search") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    const payload = parsed.payload;
    const results = Array.isArray(payload.results) ? payload.results : [];
    const sourceOk = payload.source === "https://docs.phar.gg/";
    const resultOk = results.length > 0 && results.some((result) =>
      typeof result?.url === "string" &&
      result.url.startsWith("https://docs.phar.gg/") &&
      /xphar/i.test(`${result.title ?? ""} ${result.snippet ?? ""}`)
    );
    return {
      ok: sourceOk && resultOk,
      reason: `source=${sourceOk} result=${resultOk} resultCount=${results.length}`
    };
  }

  if (name === "pharaoh_docs_page_get") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    const payload = parsed.payload;
    const sourceOk = payload.source === "https://docs.phar.gg/";
    const urlOk = typeof payload.url === "string" && payload.url === "https://docs.phar.gg/pages/xphar";
    const textOk = typeof payload.text === "string" && /xPHAR/.test(payload.text) && /p33/.test(payload.text);
    return {
      ok: sourceOk && urlOk && textOk,
      reason: `source=${sourceOk} url=${urlOk} text=${textOk}`
    };
  }

  if (name === "pharaoh_swap_plan") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    const blockedPlanCheck = validateSuppressedBlockedPlanBuildHints(parsed.payload, "swap");
    if (!blockedPlanCheck.ok) return blockedPlanCheck;
    const payload = parsed.payload;
    if (payload.protocol === "cl" && (payload.normalized?.nativeIn === true || payload.normalized?.nativeOut === true)) {
      const nativeUnsupportedGone = !(payload.blockers ?? []).some((blocker) => /native AVAX swap planning is not built/i.test(String(blocker)));
      const nativeHandlingOk = payload.nativeHandling && typeof payload.nativeHandling.mode === "string";
      const nativeOutOrRefund = payload.normalized?.nativeOut === true || (payload.normalized?.nativeIn === true && payload.side === "exactOut");
      const multicallOk = !nativeOutOrRefund
        || (payload.buildCall?.arguments?.functionName === "multicall" && payload.tx?.data?.startsWith?.("0xac9650d8"));
      const directNativeInOk = !(payload.normalized?.nativeIn === true && payload.side === "exactIn" && payload.normalized?.nativeOut !== true)
        || (payload.buildCall?.arguments?.value !== "0" && payload.nativeHandling?.mode === "direct_payable_swap");

      return {
        ok: payload.canBuild === true && nativeUnsupportedGone && nativeHandlingOk && multicallOk && directNativeInOk,
        reason: `CL native canBuild=${payload.canBuild === true} unsupportedGone=${nativeUnsupportedGone} nativeHandling=${nativeHandlingOk} multicall=${multicallOk} direct=${directNativeInOk}`
      };
    }
    return { ok: true };
  }

  if (name === "pharaoh_wallet_positions_read") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    const payload = parsed.payload;
    if (payload.protocol?.rewards) {
      const rewards = payload.protocol.rewards;
      const rewardContext = payload.protocol.rewardContext;
      const rewardsOk = rewards.ok === true;
      const contextOk = rewardContext &&
        Array.isArray(rewardContext.clPools) &&
        Array.isArray(rewardContext.dlmmPairs) &&
        Array.isArray(rewardContext.warnings);
      const clOk = payload.protocol.clNfts?.ok === true &&
        Array.isArray(payload.protocol.clNfts?.result?.positions);
      const dlmmOk = Array.isArray(payload.protocol.dlmmPools) && payload.protocol.dlmmPools.length > 0;
      const suppressedOk = rewards.result?.claimable === false
        ? validateBlockedClaimabilityBuildHints(rewards.result).ok
        : true;
      return {
        ok: rewardsOk && contextOk && clOk && dlmmOk && suppressedOk,
        reason: `wallet rewards rewardsOk=${rewardsOk} context=${contextOk} cl=${clOk} dlmm=${dlmmOk} suppressed=${suppressedOk}`
      };
    }
    return { ok: true };
  }

  if (name === "pharaoh_swap_routes_find") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    const blockedRoutes = Array.isArray(parsed.payload.blockedRoutes) ? parsed.payload.blockedRoutes : [];
    const checks = blockedRoutes
      .filter((route) => route?.plan?.canBuild === false)
      .map((route) => validateSuppressedBlockedPlanBuildHints(route.plan, `route ${route.index}`));
    const failed = checks.find((check) => !check.ok);
    if (failed) return failed;
    if (parsed.payload.search?.includeMixed === true) {
      const mixedRoutes = (parsed.payload.routes ?? []).filter((route) => route?.protocol === "mixed");
      const mixedOk = mixedRoutes.length > 0 && mixedRoutes.every((route) =>
        route.plan?.protocol === "mixed" &&
        route.plan?.canBuild === true &&
        typeof route.plan?.universalRouterPlan?.commands === "string" &&
        route.plan.universalRouterPlan.commands.startsWith("0x") &&
        route.plan?.buildCall?.tool === "pharaoh_universal_router_build_tx"
      );
      return {
        ok: mixedOk,
        reason: `mixed route discovery routes=${mixedRoutes.length} ok=${mixedOk}`
      };
    }
    return { ok: true };
  }

  if (name === "pharaoh_mixed_route_swap_plan") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    const { payload } = parsed;
    const blockedPlanCheck = validateSuppressedBlockedPlanBuildHints(payload, "mixed-route swap");
    if (!blockedPlanCheck.ok) return blockedPlanCheck;
    const commands = payload.universalRouterPlan?.commands;
    const expectedCommands = new Set(["0x0800", "0x0b0008", "0x08000c"]);
    const expectedInputCount = typeof commands === "string" && commands.startsWith("0x") ? (commands.length - 2) / 2 : 0;
    const commandsOk = expectedCommands.has(commands);
    const inputsOk = Array.isArray(payload.universalRouterPlan?.inputs) && payload.universalRouterPlan.inputs.length === expectedInputCount;
    const buildCallOk = payload.buildCall?.arguments?.commands === commands
      && Array.isArray(payload.buildCall?.arguments?.inputs)
      && payload.buildCall.arguments.inputs.length === expectedInputCount;
    const txOk = typeof payload.tx?.data === "string"
      && payload.tx.data.startsWith("0x3593564c")
      && payload.tx.to?.toLowerCase?.() === universalRouter.toLowerCase();
    const blockersOk = Array.isArray(payload.blockers) && payload.blockers.length === 0;
    return {
      ok: payload.canBuild === true && blockersOk && commandsOk && inputsOk && buildCallOk && txOk,
      reason: `canBuild=${payload.canBuild === true} blockers=${blockersOk} commands=${commandsOk} inputs=${inputsOk} buildCall=${buildCallOk} tx=${txOk}`
    };
  }

  if (name === "pharaoh_liquidity_plan") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    const { payload } = parsed;
    const blockedPlanCheck = validateSuppressedBlockedPlanBuildHints(payload, "liquidity");
    if (!blockedPlanCheck.ok) return blockedPlanCheck;
    if (payload.protocol === "dlmm" && payload.action === "remove" && payload.tokenX?.isNative === true) {
      const args = payload.buildCall?.arguments?.args;
      const tokenOk = args?.[0]?.toLowerCase?.() === usdc.toLowerCase();
      const amountTokenMinOk = String(args?.[2]) === "222";
      const amountNativeMinOk = String(args?.[3]) === "111";
      return {
        ok: payload.canBuild === true && tokenOk && amountTokenMinOk && amountNativeMinOk,
        reason: `canBuild=${payload.canBuild === true} token=${tokenOk} amountTokenMin=${amountTokenMinOk} amountNativeMin=${amountNativeMinOk}`
      };
    }
  }

  if (name === "pharaoh_p33_read") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    return validateSuppressedQuoteBuildHints(parsed.payload, "p33");
  }

  if (name === "pharaoh_protocol_gates_read") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    const gate = parsed.payload?.gates?.p33LiveUnlock;
    if (gate?.protocolOpen === false || gate?.status === "blocked_protocol_locked") {
      const hintsSuppressed = !Object.hasOwn(gate, "buildHints") || gate.buildHints === null;
      const statusOk = gate.buildHintsStatus === "blocked_protocol_locked";
      const reasonOk = typeof gate.buildHintsSuppressedReason === "string" && gate.buildHintsSuppressedReason.length > 0;
      const blockersOk = Array.isArray(gate.blockers) && gate.blockers.length > 0;
      return {
        ok: hintsSuppressed && statusOk && reasonOk && blockersOk,
        reason: `locked p33 gate suppressed=${hintsSuppressed} status=${statusOk} reason=${reasonOk} blockers=${blockersOk}`
      };
    }
    return { ok: true };
  }

  if (name === "pharaoh_validation_readiness_read") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    const payload = parsed.payload;
    const safetyOk = payload.safety?.readOnly === true &&
      payload.safety?.privateKeyRead === false &&
      payload.safety?.liveBroadcastAllowed === false;
    const gatesOk = payload.protocolGates?.gates?.p33LiveUnlock &&
      payload.protocolGates?.gates?.dlmmNormalUserPoolCreation;
    const readinessOk = payload.readiness?.p33LiveDeposit &&
      payload.readiness?.dlmmPoolCreation &&
      payload.readiness?.rewardClaims?.walletRewards &&
      payload.readiness?.rewardClaims?.operatorIncentives;
    const recommendationOk = typeof payload.recommendedNextAction === "string" &&
      payload.recommendedNextAction.length > 0;
    const rewardOk = payload.rewardClaimability?.ok === true &&
      payload.rewardClaimability?.result?.domains?.autoVault &&
      payload.rewardClaimability?.result?.domains?.p33;
    const walletSkippedOk = payload.walletPositions === null;

    return {
      ok: safetyOk && gatesOk && readinessOk && recommendationOk && rewardOk && walletSkippedOk,
      reason: `safety=${safetyOk} gates=${Boolean(gatesOk)} readiness=${Boolean(readinessOk)} recommendation=${recommendationOk} reward=${rewardOk} walletSkipped=${walletSkippedOk}`
    };
  }

  if (name === "pharaoh_acceptance_status_read") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    const payload = parsed.payload;
    const safetyOk = payload.safety?.readOnly === true &&
      payload.safety?.privateKeyRead === false &&
      payload.safety?.liveBroadcastAllowed === false;
    const sourceOk = payload.source === "reports/acceptance-audit.latest.json" &&
      payload.available === true;
    const recommendationOk = payload.recommendedNextAction === "wait_refresh_gates" &&
      typeof payload.currentStateRecommendedNextAction === "string" &&
      payload.currentStateRecommendedNextAction.length > 0;
	    const p33Ok = payload.coverageContext?.p33Complete === true;
	    const blockersOk = Array.isArray(payload.remainingBlockers) &&
	      payload.remainingBlockers.some((item) => item.key === "dlmm_pool_creation") &&
	      Array.isArray(payload.completionBlockingItems);
	    const userFlows = payload.finalOutputSummary?.userFlowCoverageMatrix ?? payload.finalOutputSummary?.coverageSummaryByDomain?.userFlows ?? {};
	    const userFlowKeys = new Set((userFlows.flows ?? []).map((flow) => flow.flowKey));
	    const userFlowsOk = Array.isArray(userFlows.flows) &&
	      requiredGoalUserFlowKeys.every((key) => userFlowKeys.has(key)) &&
	      requiredGoalUserFlowKeys.every((key) => (userFlows.requiredFlowKeys ?? []).includes(key)) &&
	      userFlows.flows.every((flow) =>
	        typeof flow?.flowKey === "string" &&
	        typeof flow?.goalName === "string" &&
	        typeof flow?.status === "string" &&
	        Array.isArray(flow?.evidenceReports) &&
	        Array.isArray(flow?.blockers)
	      );
	    const finalOutputOk = payload.finalOutputSummary &&
	      typeof payload.finalOutputSummary.coverageSummaryByDomain === "object" &&
	      userFlowsOk &&
	      typeof payload.finalOutputSummary.resolvedVsRemainingIncompleteComponents === "object" &&
	      Array.isArray(payload.finalOutputSummary.liveTransactionHashes) &&
	      payload.finalOutputSummary.liveTransactionHashes.every((tx) => typeof tx?.hash === "string" && typeof tx?.proved === "string") &&
	      typeof payload.finalOutputSummary.forkSimulationSummary === "object" &&
      Array.isArray(payload.finalOutputSummary.verificationCommandsAndResults) &&
      Array.isArray(payload.finalOutputSummary.verificationCommands) &&
      payload.finalOutputSummary.verificationCommands.length > 0 &&
      Array.isArray(payload.finalOutputSummary.filesChanged?.paths) &&
      typeof payload.finalOutputSummary.currentWalletBalancesAndApprovals === "object";
	    const fundingOk = payload.finalOutputSummary?.fundingTopUpRequest &&
	      payload.finalOutputSummary.fundingTopUpRequest.required === false &&
	      payload.finalOutputSummary.fundingTopUpRequest.status === "no_top_up_required";

	    return {
	      ok: safetyOk && sourceOk && recommendationOk && p33Ok && blockersOk && finalOutputOk && fundingOk,
	      reason: `safety=${safetyOk} source=${sourceOk} recommendation=${recommendationOk} p33=${p33Ok} blockers=${blockersOk} userFlows=${userFlowsOk} finalOutput=${finalOutputOk} funding=${fundingOk}`
	    };
  }

  if (name === "pharaoh_xphar_read") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    return validateSuppressedQuoteBuildHints(parsed.payload, "xPHAR");
  }

  if (name === "pharaoh_autovault_read") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    return validateSuppressedQuoteBuildHints(parsed.payload, "AutoVault");
  }

  if (name === "pharaoh_reward_claimability_read") {
    const parsed = parsePayload(text);
    if (!parsed.ok) return parsed;
    return validateBlockedClaimabilityBuildHints(parsed.payload);
  }

  if (!expectsUnsignedCalldata(name)) return { ok: true };

  const parsed = parsePayload(text);
  if (!parsed.ok) return parsed;
  const { payload } = parsed;

  if (name === "pharaoh_universal_router_build_tx") {
    const selectorOk = typeof payload.data === "string" && payload.data.startsWith("0x3593564c");
    const targetOk = payload.to?.toLowerCase?.() === universalRouter.toLowerCase();
    if (!selectorOk || !targetOk) return { ok: false, reason: `universalRouter selector=${selectorOk} target=${targetOk}` };
  }

  const hasData = typeof payload.data === "string" && /^0x[0-9a-fA-F]+$/.test(payload.data) && payload.data.length >= 10;
  const hasTo = typeof payload.to === "string" && /^0x[0-9a-fA-F]{40}$/.test(payload.to);
  const hasValue = payload.value !== undefined;
  const hasWarning = typeof payload.warning === "string" && payload.warning.toLowerCase().includes("unsigned");
  const hasOperatorWarning = !expectsOperatorWarning(name, payload)
    || /operator|automation|authorized|permission/i.test(payload.warning ?? "");
  const approvalType = args?.approvalType ?? (args?.standard === "erc1155" || args?.standard === "dlmmPool" ? "setApprovalForAll" : "approve");
  const expectedApprovalFunction = name !== "pharaoh_encode_approval"
    ? null
    : args?.standard === "dlmmPool"
      ? "approveForAll"
      : approvalType;
  const approvalOk = name !== "pharaoh_encode_approval"
    || (
      payload.standard === args?.standard &&
      payload.functionName === expectedApprovalFunction &&
      payload.to?.toLowerCase?.() === args.tokenAddress.toLowerCase() &&
      payload.value === "0"
    );
  const targetOk = !args?.addressOverride
    || payload.to?.toLowerCase?.() === args.addressOverride.toLowerCase();
  const valueOk = args?.value === undefined
    || String(payload.value) === String(args.value);
  const hasMapping = name === "pharaoh_encode_approval"
    ? true
    : name === "pharaoh_build_tx"
      ? Boolean(payload.signature)
      : Boolean(payload.signature && payload.underlying);

  return {
    ok: hasData && hasTo && hasValue && hasWarning && hasOperatorWarning && hasMapping && approvalOk && targetOk && valueOk,
    reason: `data=${hasData} to=${hasTo} value=${hasValue} warning=${hasWarning} operatorWarning=${hasOperatorWarning} mapping=${hasMapping} approval=${approvalOk} target=${targetOk} valueMatch=${valueOk}`
  };
}

function smokeVariant(name, args) {
  if (name === "pharaoh_wallet_positions_read" && args?.includeRewards === true) return "includeRewards";
  return null;
}

const client = createClient();
const results = [];
let toolCount = 0;
try {
  const initialized = await client.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "phar-mcp-smoke", version: "0.0.0" }
  });
  if (initialized.error) throw new Error(JSON.stringify(initialized.error));
  client.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const listed = await client.send("tools/list", {});
  if (listed.error) throw new Error(JSON.stringify(listed.error));
  toolCount = listed.result.tools.length;
  results.push({ name: "tools/list", ok: true, detail: `${toolCount} tools` });

  for (const [name, args] of smokeCalls) {
    const response = await client.send("tools/call", { name, arguments: args });
    const validation = validateToolResponse(name, args, response);
    const parsedResult = parsePayload(extractText(response));
    const payload = parsedResult.ok ? parsedResult.payload : {};
    const ok = !response.error && !response.result?.isError && validation.ok;
    results.push({
      name,
      action: args?.action ?? null,
      functionName: args?.functionName ?? payload?.functionName ?? null,
      contract: args?.contract ?? null,
      standard: args?.standard ?? payload?.standard ?? null,
      approvalType: args?.approvalType ?? null,
      variant: smokeVariant(name, args),
      ok,
      detail: validation.ok
        ? (name === "pharaoh_acceptance_status_read"
          ? validation.reason
          : extractText(response).slice(0, 240).replace(/\s+/g, " "))
        : `${validation.reason}. ${extractText(response).slice(0, 240).replace(/\s+/g, " ")}`,
      responseSummary: responseSummary(name, payload)
    });
  }
} finally {
  client.child.kill();
}

const acceptanceSmokeResult = results.find((result) => result.name === "pharaoh_acceptance_status_read");
const smokedAcceptanceTimestamp = acceptanceSmokeResult?.responseSummary?.timestamp ?? null;

console.log(JSON.stringify({
  schemaVersion: 1,
  timestamp: new Date().toISOString(),
  smokedAcceptanceTimestamp,
  ok: results.every((result) => result.ok),
  wallet,
  toolCount,
  checkCount: results.length,
  results
}, null, 2));

if (!results.every((result) => result.ok)) {
  process.exit(1);
}
