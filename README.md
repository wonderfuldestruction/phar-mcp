# phar-mcp

**Unofficial** TypeScript stdio MCP server for phar.gg / Pharaoh DEX on Avalanche C-Chain.

This server reads directly from on-chain contracts and searches `docs.phar.gg`. It does not expose external APIs. For LLM website interaction, [camofox](https://github.com/jo-inc/camofox-browser) is optional but recommended.

The server uses the MCP TypeScript SDK, `viem`, and `zod`. It never signs or broadcasts transactions. Transaction-oriented tools only return unsigned calldata that a wallet or another signing workflow must inspect and submit.

## Disclaimer

LLMs can execute on-chain transactions when given access to private keys or signing tools. This is **not recommended** due to the risk of LLM errors and credential exposure.

This project is provided as-is and has not been extensively audited. It may contain bugs and could result in unintended gas costs, token losses and high LLM-token consumption costs. Always simulate transactions before signing.

## Install

```bash
npm install
npm run build
```

## Start

```bash
npm start
```

By default the server connects to Avalanche C-Chain RPC at:

```text
https://api.avax.network/ext/bc/C/rpc
```

Override with:

```bash
AVALANCHE_RPC_URL="https://your.rpc.example" npm start
```

## MCP Host Setup

This server uses the **stdio** transport. Register it in your MCP host config pointing to `dist/index.js`.

### Agentic Installation

For LLM agents to self-install, inject the prompt:

```
1. Clone the repository from `https://github.com/YOUR_REPO/phar-mcp`
2. Run `npm install && npm run build`
3. Register the server in your MCP host config (see sections below)
4. Verify with `npm run smoke:mcp`
```

### Claude Desktop

Add to `~/.config/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "pharaoh": {
      "command": "node",
      "args": ["/absolute/path/to/phar-mcp/dist/index.js"],
      "env": {
        "AVALANCHE_RPC_URL": "https://api.avax.network/ext/bc/C/rpc"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` (project-local) or user settings:

```json
{
  "mcpServers": {
    "pharaoh": {
      "command": "node",
      "args": ["/absolute/path/to/phar-mcp/dist/index.js"],
      "env": {
        "AVALANCHE_RPC_URL": "https://api.avax.network/ext/bc/C/rpc"
      }
    }
  }
}
```

### Generic (any stdio-compatible host)

```json
{
  "mcpServers": {
    "pharaoh": {
      "command": "node",
      "args": ["/absolute/path/to/phar-mcp/dist/index.js"],
      "env": {
        "AVALANCHE_RPC_URL": "https://api.avax.network/ext/bc/C/rpc"
      }
    }
  }
}
```

> **Note:** Replace `/absolute/path/to/phar-mcp/` with the actual path. Requires Node >= 20.

## Key Features

- **Readonly by default** — all chain reads are `view`/`pure` calls via `viem`. No private keys required.
- **Unsigned calldata** — transaction tools return `{ to, data, value }` for your wallet to sign and submit.
- **Source-backed ABIs** — contract functions verified against Pharaoh source artifacts and live on-chain selectors.
- **Live docs integration** — search and fetch pages from `docs.phar.gg` for source-backed answers.
- **Multi-protocol coverage** — legacy AMM, concentrated liquidity (CL), and DLMM pools with swap planning, liquidity management, and route discovery.
- **Staking and rewards** — xPHAR conversion, p33 liquid staking, AutoVault, voting, and reward claimability across legacy gauges, CL gauges, FeeDistributors, and DLMM rewarders.
- **Approval helpers** — encode ERC20/ERC721/ERC1155 approvals and check required allowances before transactions.
- **Simulation** — readonly `eth-call` simulation for unsigned calldata before signing.

## Tools

- `pharaoh_contracts_get`: returns chain id, configured RPC URL, the official docs.phar.gg address registry, and source URLs.
- `pharaoh_functions_list`: lists known ABI function names, signatures, state mutability, input schemas, and extraction status. Accepts an optional `contract` filter.
- `pharaoh_docs_index_get`: fetches and lists live `docs.phar.gg` pages available to the MCP docs tools.
- `pharaoh_docs_search`: searches live `docs.phar.gg` pages and returns source URLs plus snippets for source-backed user answers.
- `pharaoh_docs_page_get`: fetches a live `docs.phar.gg` page as sanitized text for full-page context.
- `pharaoh_function_inputs_get`: returns ABI input names, types, and component schemas for a registered function before using raw `args` builders.
- `pharaoh_read`: calls verified `view`/`pure` functions through `viem` `readContract`. Bigints are returned as strings.
- `pharaoh_read_batch`: calls multiple registered `view`/`pure` functions, including deployed instance ABIs via `addressOverride`.
- `pharaoh_token_read`: reads ERC20 metadata, balance, allowance, and optional native AVAX balance.
- `pharaoh_wallet_positions_read`: reads a bounded wallet inventory across tracked Pharaoh token balances, ERC20-compatible allowances, xPHAR, p33, AutoVault share/readiness state, voting, CL NFTs, DLMM bins, and optional reward claimability.
- `pharaoh_simulate_tx`: performs readonly eth-call simulation for unsigned calldata from either `contract`/`functionName`/`args` or raw `to`/`data`. It never signs or broadcasts.
- `pharaoh_build_tx`: encodes unsigned calldata for registered contract functions and returns `{ chainId, to, data, value, functionName, args, warning }`.
- `pharaoh_encode_approval`: encodes ERC20 `approve`, ERC721 `approve`, ERC721/ERC1155 `setApprovalForAll`, or DLMM pool `approveForAll` calldata.
- `pharaoh_required_approvals`: checks advisory ERC20, ERC721/ERC1155, and DLMM pool approvals for a workflow.
- `pharaoh_vote_build_tx`: encodes unsigned calldata for voteModule and voter workflow actions.
- `pharaoh_vote_read`: reads VoteModule stake/delegate state, Voter period votes, and pool/gauge voting status. It defaults period-sensitive reads to the next voting period.
- `pharaoh_xphar_build_tx`: encodes unsigned calldata for xPHAR conversion, exit, rebase, approval, and transfer actions.
- `pharaoh_xphar_read`: reads xPHAR conversion state, PHAR -> xPHAR conversion preflight quotes, and quote/static-simulates `exit(uint256)` slashing output.
- `pharaoh_p33_build_tx`: encodes unsigned calldata for p33 ERC4626 deposit/mint/withdraw/redeem and automation actions.
- `pharaoh_p33_read`: reads p33 lock/account state and quotes whether ERC4626 deposit, mint, withdraw, or redeem actions are currently actionable.
- `pharaoh_protocol_gates_read`: reads combined p33 live-unlock and DLMM normal-user pool-creation gates, separating protocol state from wallet balance/approval readiness.
- `pharaoh_validation_readiness_read`: composes protocol gates, optional wallet positions, reward claimability, blockers, and next safe validation actions into one readonly MCP response.
- `pharaoh_acceptance_status_read`: reads coverage-aware acceptance and continuation status for long-horizon planning.
- `pharaoh_autovault_build_tx`: encodes unsigned calldata for the source-backed AutoVault deposit/withdraw/claim surface.
- `pharaoh_autovault_read`: reads AutoVault global/account state and preflights deposit, withdraw, or native claim actions with optional static simulation.
- `pharaoh_legacy_liquidity_build_tx`: encodes unsigned calldata for pairFactory `createPair` and router legacy liquidity actions.
- `pharaoh_legacy_swap_build_tx`: encodes unsigned calldata for router legacy swap functions.
- `pharaoh_legacy_quote`: reads legacy router quotes, reserves, and pair addresses.
- `pharaoh_swap_plan`: plans single-hop or same-protocol multi-hop legacy, CL, or DLMM swaps with current quote data, slippage bounds, approval hints, build-call hints, and simulation-call hints.
- `pharaoh_swap_routes_find`: discovers and ranks direct or two-hop same-protocol legacy, CL, and DLMM swap routes, and optional exact-in mixed legacy/CL routes when `includeMixed=true`, returning executable planner outputs.
- `pharaoh_mixed_route_swap_plan`: plans exact-in mixed legacy/CL routes with `MixedRouteQuoterV1`, source-backed UniversalRouter command encoding, native AVAX endpoint wrap/unwrap support, approval hints, and unsigned calldata.
- `pharaoh_liquidity_plan`: plans a single-pool legacy, CL, or DLMM liquidity action with current reads, approval hints, slippage bounds, unsigned builder calls, blockers, and simulation hints. Blocked swap, mixed-route, and liquidity plans suppress nested approval calldata while `canBuild === false`.
- `pharaoh_pool_discover`: discovers legacy, CL, and DLMM pools for a token pair, including state, gauge/FeeDistributor links, DLMM rewarder links, and builder hints.
- `pharaoh_cl_liquidity_build_tx`: encodes unsigned calldata for Ramses V3 pool, position, and position reward actions.
- `pharaoh_cl_swap_build_tx`: encodes unsigned calldata for swapRouter swap and periphery helper functions.
- `pharaoh_universal_router_build_tx`: encodes unsigned calldata for UniversalRouter `execute` and `collectRewards` using pre-encoded command/input payloads.
- `pharaoh_cl_quote`: static-calls CL quoter contracts for exact input/output quote functions.
- `pharaoh_gauge_build_tx`: encodes unsigned calldata for legacy gauge factory creation, CL gauge factory creation, deployed legacy gauge calls, and deployed GaugeV3 calls.
- `pharaoh_rewards_read`: reads reward state for legacy gauges, CL gauges, FeeDistributor instances, DLMM rewarders, AutoVault, and p33 reward/lock state.
- `pharaoh_reward_claimability_read`: composes reward-state reads into an actionable claimability plan with blockers and unsigned-builder hints.
- `pharaoh_dlmm_build_tx`: encodes unsigned calldata for DLMM router/factory liquidity and swaps, DLMM pool bin-token actions, and DLMM rewarder claims.
- `pharaoh_dlmm_quote`: discovers DLMM pools and reads swap quotes, active/bin state, prices, decoded hook address hints, and rewarder factory mappings.

`pharaoh_build_tx` remains the generic escape hatch for any registered ABI function not covered by the workflow tools.

## Example MCP Calls

Discovery preflight:

```json
{
  "name": "pharaoh_contracts_get",
  "arguments": {}
}
```

Function surface check:

```json
{
  "name": "pharaoh_functions_list",
  "arguments": {
    "contract": "xPharToken"
  }
}
```

Docs-backed user question preflight:

```json
{
  "name": "pharaoh_docs_search",
  "arguments": {
    "query": "xPHAR redemption p33 liquid staking",
    "limit": 3
  }
}
```

Fetch a returned docs page:

```json
{
  "name": "pharaoh_docs_page_get",
  "arguments": {
    "pathOrUrl": "/pages/xphar",
    "maxChars": 8000
  }
}
```

Readonly call:

```json
{
  "name": "pharaoh_read",
  "arguments": {
    "contract": "p33",
    "functionName": "isUnlocked"
  }
}
```

Approval check:

```json
{
  "name": "pharaoh_required_approvals",
  "arguments": {
    "domain": "dlmm",
    "action": "addLiquidity",
    "account": "${PHAR_MCP_WALLET}",
    "tokens": [
      {
        "token": "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
        "amount": "999999999989712"
      },
      {
        "token": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        "amount": "1000000"
      }
    ],
    "dlmmPool": "0x8aC5707f8D4BDe1d771d34c7AfD81c3922b73379"
  }
}
```

Approval calldata:

```json
{
  "name": "pharaoh_encode_approval",
  "arguments": {
    "standard": "erc20",
    "tokenAddress": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    "spender": "0xff2BEFC4ff86CB0f3e8D3d9D6200B7A05BF5D93d",
    "amount": "1000000"
  }
}
```

Unsigned legacy swap calldata:

```json
{
  "name": "pharaoh_legacy_swap_build_tx",
  "arguments": {
    "functionName": "swapExactTokensForTokens",
    "args": [
      "500000",
      "1",
      [
        {
          "from": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
          "to": "0x13A466998Ce03Db73aBc2d4DF3bBD845Ed1f28E7",
          "stable": false
        }
      ],
      "${PHAR_MCP_WALLET}",
      "1779989999"
    ]
  }
}
```

Instance ABI call with `addressOverride`:

```json
{
  "name": "pharaoh_read",
  "arguments": {
    "contract": "dlmmPoolImplementation",
    "addressOverride": "0x8aC5707f8D4BDe1d771d34c7AfD81c3922b73379",
    "functionName": "getActiveId"
  }
}
```

Voting state read:

```json
{
  "name": "pharaoh_vote_read",
  "arguments": {
    "action": "summary",
    "account": "${PHAR_MCP_WALLET}"
  }
}
```

xPHAR exit quote:

```json
{
  "name": "pharaoh_xphar_read",
  "arguments": {
    "action": "exitQuote",
    "account": "${PHAR_MCP_WALLET}",
    "amount": "10000000000000000"
  }
}
```

p33 ERC4626 deposit quote:

```json
{
  "name": "pharaoh_p33_read",
  "arguments": {
    "action": "depositQuote",
    "account": "${PHAR_MCP_WALLET}",
    "assets": "30000000000000000",
    "simulate": true
  }
}
```

Reward claimability plan:

```json
{
  "name": "pharaoh_reward_claimability_read",
  "arguments": {
    "account": "${PHAR_MCP_WALLET}",
    "domains": ["autoVault", "legacyGauge", "clGauge", "feeDistributor", "dlmmRewarder", "p33"],
    "includeZero": true
  }
}
```

## Workflow Build Tools

All workflow build tools return unsigned calldata only. They never sign, send, or simulate. Pass `args` in ABI order as a JSON array; large integers should be decimal strings. Tools that can require native AVAX accept `value` in wei as a decimal string, hex string, or safe integer.

Direct operator/admin builders can encode calldata even when the caller is not authorized or current claimability is zero; use `pharaoh_protocol_gates_read`, `pharaoh_reward_claimability_read`, and the returned action warning before signing elsewhere.

Use `pharaoh_validation_readiness_read` as a readonly gate before spending gas — it reports whether p33 deposit, DLMM pool creation, wallet reward claims, or operator incentive claims are currently actionable, with exact blockers when blocked. Use `pharaoh_acceptance_status_read` for coverage-aware planning and continuation status.

Each workflow result includes the underlying contract/function mapping:

```json
{
  "underlying": {
    "contract": "router",
    "address": "0x...",
    "functionName": "addLiquidity",
    "signature": "addLiquidity(address,address,bool,uint256,uint256,uint256,uint256,address,uint256)"
  }
}
```

Supported workflow actions and constrained function names:

- `pharaoh_vote_build_tx` `action`: `deposit`, `depositAll`, `withdraw`, `withdrawAll`, `delegate`, `vote`, `reset`, `poke`, `claimRewards`, `claimIncentives`, `claimLegacyIncentives`, `claimClGaugeRewards`, `claimClGaugeRewardsWithNfpManagers`, `claimClGaugeRewardsWithReceivers`, `distribute`, `distributeAll`, `distributeForPeriod`.
- `pharaoh_xphar_build_tx` `action`: `convert`, `exit`, `rebase`, `approve`, `transfer`, `transferFrom`.
- `pharaoh_p33_build_tx` `action`: `deposit`, `mint`, `withdraw`, `redeem`, `claimIncentives`, `compound`, `submitVotes`, `swapIncentiveViaAggregator`, `unlock`, `approve`, `transfer`, `transferFrom`.
- `pharaoh_autovault_build_tx` `action`: `deposit`, `withdraw`, `claim`, `setOutputPreference`, `claimIncentives`, `submitVotes`, `swap`, `lock`, `unlock`, `addAggregator`, `removeAggregator`, `addOutputToken`, `removeOutputToken`, `setOperator`, `rescue`.
- `pharaoh_legacy_liquidity_build_tx` `action`: `createPair`, `addLiquidity`, `addLiquidityETH`, `addLiquidityAndStake`, `addLiquidityETHAndStake`, `removeLiquidity`, `removeLiquidityETH`, `removeLiquidityETHSupportingFeeOnTransferTokens`.
- `pharaoh_legacy_swap_build_tx` `functionName`: `swapETHForExactTokens`, `swapExactETHForTokens`, `swapExactETHForTokensSupportingFeeOnTransferTokens`, `swapExactTokensForETH`, `swapExactTokensForETHSupportingFeeOnTransferTokens`, `swapExactTokensForTokens`, `swapExactTokensForTokensSupportingFeeOnTransferTokens`, `swapTokensForExactETH`, `swapTokensForExactTokens`.
- `pharaoh_cl_liquidity_build_tx` `action`: `createPool`, `createAndInitializePoolIfNecessary`, `mint`, `increaseLiquidity`, `decreaseLiquidity`, `collect`, `burn`, `getReward`, `getPeriodReward`.
- `pharaoh_cl_swap_build_tx` `functionName`: `exactInput((bytes,address,uint256,uint256,uint256))`, `exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))`, `exactOutput((bytes,address,uint256,uint256,uint256))`, `exactOutputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))`, `multicall`, `refundETH`, `sweepToken`, `sweepTokenWithFee`, `unwrapWETH9`, `unwrapWETH9WithFee`.
- `pharaoh_cl_quote` `action`: `quoteExactInput`, `quoteExactOutput`, `quoteExactInputSingle`, `quoteExactOutputSingle`, `quoteExactInputSingleV2`, `quoteExactInputSingleV3`.
- `pharaoh_universal_router_build_tx` `functionName`: `execute(bytes,bytes[])`, `execute(bytes,bytes[],uint256)`, `collectRewards`.
- `pharaoh_gauge_build_tx` `action`: `createGauge`, `createClGauge`, `legacyDeposit`, `legacyDepositAll`, `legacyDepositFor`, `legacyWithdraw`, `legacyWithdrawAll`, `legacyUnstakeAndClaimAll`, `legacyGetReward`, `legacyNotifyRewardAmount`, `addRewards`, `cachePeriodEarned`, `getPeriodReward`, `getReward`, `getRewardForTokenIds`, `getRewardForPosition`, `getRewardForOwner`, `getRewardForOwnerFromVoter`, `initialize`, `notifyRewardAmount`, `notifyRewardAmountForPeriod`, `notifyRewardAmountNextPeriod`, `removeRewards`, `syncCache`.
- `pharaoh_dlmm_build_tx` `action`: `addLiquidity`, `addLiquidityNATIVE`, `removeLiquidity`, `removeLiquidityNATIVE`, `routerCreateLBPair`, `factoryCreateLBPair`, `swapExactNATIVEForTokens`, `swapExactNATIVEForTokensSupportingFeeOnTransferTokens`, `swapExactTokensForNATIVE`, `swapExactTokensForNATIVESupportingFeeOnTransferTokens`, `swapExactTokensForTokens`, `swapExactTokensForTokensSupportingFeeOnTransferTokens`, `swapNATIVEForExactTokens`, `swapTokensForExactNATIVE`, `swapTokensForExactTokens`, `approveForAll`, `batchTransferFrom`, `poolMint`, `poolBurn`, `rewarderClaim`.

`pharaoh_gauge_build_tx` uses `legacyGaugeFactory` for `createGauge` and `clGaugeFactory` for `createClGauge`. `legacy*` actions require `addressOverride` set to a deployed legacy gauge address. CL GaugeV3 instance actions use the `clGaugeV3` implementation ABI and require `addressOverride` set to the deployed GaugeV3 address.

`pharaoh_dlmm_build_tx` uses registered router/factory addresses for router and factory actions. Pool bin-token actions use the `dlmmPoolImplementation` ABI and require `addressOverride` set to a deployed DLMM pool address. Rewarder actions use the `dlmmRewarderImplementation` ABI and require `addressOverride` set to a deployed rewarder address. DLMM positions are ERC1155-like bin IDs and use `approveForAll`, not ERC721 approval.

`pharaoh_vote_read` defaults `summary`, `getVotes`, and `poolStatus` period-sensitive reads to `voter.getPeriod() + 1`, matching the period targeted by normal `Voter.vote(...)` calls. Pass `period` explicitly when inspecting historical or current-period state.

`pharaoh_xphar_read` reports `BASIS`, `SLASHING_PENALTY`, account balances/exemption flags, PHAR -> xPHAR conversion preflight fields, and exit quote fields. `convertQuote` checks PHAR balance and allowance to xPHAR and emits approval/build-call hints only when `quote.canSubmit === true`; blocked quotes return `buildCalls: null` plus blockers and shortfall fields. `exitQuote` statically simulates by default when `account` is supplied, reports `approvalRequired: false` because `exit(uint256)` spends caller xPHAR directly, and only emits the exit builder hint when `quote.canSubmit === true`.

`pharaoh_p33_read` treats `isUnlocked()` and `periodUnlockStatus(getPeriod())` as authoritative for `depositQuote`, `mintQuote`, `withdrawQuote`, and `redeemQuote`. This matters because `maxDeposit` and `maxMint` can report max uint while deposit/mint still revert with `LOCKED()`. p33 quote `buildCalls` are emitted only when `quote.canSubmit === true`; blocked quotes return `buildCalls: null` plus `blockers`, `approvalRequired`, and shortfall fields. `pharaoh_protocol_gates_read` also suppresses p33 approval/deposit `buildHints` while the protocol gate is locked.

`pharaoh_pool_discover` accepts `tokenA` and `tokenB` and composes existing source-backed reads across legacy, CL, and DLMM. Legacy discovery checks volatile and stable pairFactory/router addresses by default. CL discovery uses `Voter.tickSpacingsForPair(tokenA, tokenB)` unless explicit `tickSpacings` are supplied, then preflights pool `slot0()` and `liquidity()`. DLMM discovery reads `DLMMFactory.getAllLBPairs` in both token orders, optional explicit `binSteps`, pool state, and rewarder links. Pass `includeState=false` or `includeGauges=false` for lighter scans.

`pharaoh_swap_routes_find` composes `pharaoh_pool_discover` with `pharaoh_swap_plan` and, when `includeMixed=true`, `pharaoh_mixed_route_swap_plan`. It searches direct routes and one-intermediate routes over same-protocol legacy, CL, and DLMM candidates, ranks executable plans by quoted output for exact-in or quoted input for exact-out, and returns sampled blockers when requested. CL same-protocol plans support native AVAX endpoints through the verified SwapRouter WETH9 payment surface: native input can use payable swaps, native output uses `multicall` with `unwrapWETH9`, and exact-output native input adds `refundETH`. Mixed legacy/CL discovery is exact-in only because `MixedRouteQuoterV1` has no exact-output quote function; discovered mixed routes return UniversalRouter command/input plans.

`pharaoh_mixed_route_swap_plan` covers exact-in mixed legacy/CL routes. It encodes the `MixedRouteQuoterV1` path using the verified Pharaoh high-bit legacy markers (`0x800000` stable, `0x800001` volatile), preflights each legacy pair or CL pool, quotes the full route, and emits source-backed UniversalRouter `V2_SWAP_EXACT_IN` / `V3_SWAP_EXACT_IN` command payloads. Native AVAX route endpoints are supported by composing UniversalRouter `WRAP_ETH` and `UNWRAP_WETH`; internal route hops use WAVAX. Exact-output mixed routes remain blocked because `MixedRouteQuoterV1` only exposes exact-input quoting.

`pharaoh_liquidity_plan` is a readonly planner for one pool/position at a time. It supports legacy `add`/`remove`, CL `mint`/`increase`/`decrease`/`collect`/`burn`, and DLMM `add`/`remove`. It derives slippage mins where safe, checks advisory approvals, returns the matching workflow-builder call, and includes a `pharaoh_simulate_tx` hint when an account is supplied. It does not sign, broadcast, or estimate CL liquidity math.

`pharaoh_reward_claimability_read` is a readonly planner. It checks known/default reward domains, accepts explicit deployed gauges, FeeDistributor addresses, CL token ids, DLMM bin ids, optional AutoVault/p33 FeeDistributor targets, and an optional `caller` for operator-only incentive paths. It returns unsigned-builder hints only when a claimable balance is detected and no submission blocker remains. Bounded discovery gaps are reported as warnings. DLMM bin scanning is bounded and non-enumerable positions should pass explicit `ids` for full coverage. AutoVault and p33 incentive checks derive FeeDistributor targets from recent Voter votes by default and label `claimIncentives` as operator-only automation.

For CL gauge rewards, `claimClGaugeRewards` is the normal 3-arg Voter path. `claimClGaugeRewardsWithNfpManagers` is the 4-arg overload, and the fourth array is NFP position-manager addresses per gauge, not reward receivers. `claimClGaugeRewardsWithReceivers` remains only as a deprecated compatibility alias with a warning.

## ABI Coverage

The server includes verified ABIs for core Pharaoh DEX contracts (PHAR, Router, RamsesV3Factory, SwapRouter, Quoter, UniversalRouter, VoteModule, xPHAR, p33, DLMMRewarderFactory, GaugeV3, and others) plus minimal ERC20/ERC721/ERC1155 read and approval ABIs. Some contracts are source-backed where public explorer endpoints do not expose verified ABIs for EIP-1967 proxy implementations.

`pharaoh_contracts_get` returns the full address registry with provenance status. `pharaoh_functions_list` lists known ABI function names, signatures, and input schemas.

Official address source: <https://docs.phar.gg/pages/contract-addresses>
