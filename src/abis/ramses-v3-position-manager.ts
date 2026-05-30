import { ramsesInvalidTokenIdError } from "./_shared.js";
import type { Abi } from "viem";

const collectParams = [
  { internalType: "uint256", name: "tokenId", type: "uint256" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint128", name: "amount0Max", type: "uint128" },
  { internalType: "uint128", name: "amount1Max", type: "uint128" }
] as const;

const decreaseLiquidityParams = [
  { internalType: "uint256", name: "tokenId", type: "uint256" },
  { internalType: "uint128", name: "liquidity", type: "uint128" },
  { internalType: "uint256", name: "amount0Min", type: "uint256" },
  { internalType: "uint256", name: "amount1Min", type: "uint256" },
  { internalType: "uint256", name: "deadline", type: "uint256" }
] as const;

const erc721NonexistentTokenError = {
  inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
  name: "ERC721NonexistentToken",
  type: "error"
} as const;

const increaseLiquidityParams = [
  { internalType: "uint256", name: "tokenId", type: "uint256" },
  { internalType: "uint256", name: "amount0Desired", type: "uint256" },
  { internalType: "uint256", name: "amount1Desired", type: "uint256" },
  { internalType: "uint256", name: "amount0Min", type: "uint256" },
  { internalType: "uint256", name: "amount1Min", type: "uint256" },
  { internalType: "uint256", name: "deadline", type: "uint256" }
] as const;

const mintParams = [
  { internalType: "address", name: "token0", type: "address" },
  { internalType: "address", name: "token1", type: "address" },
  { internalType: "int24", name: "tickSpacing", type: "int24" },
  { internalType: "int24", name: "tickLower", type: "int24" },
  { internalType: "int24", name: "tickUpper", type: "int24" },
  { internalType: "uint256", name: "amount0Desired", type: "uint256" },
  { internalType: "uint256", name: "amount1Desired", type: "uint256" },
  { internalType: "uint256", name: "amount0Min", type: "uint256" },
  { internalType: "uint256", name: "amount1Min", type: "uint256" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint256", name: "deadline", type: "uint256" }
] as const;

export const ramsesV3PositionManagerAbi = [
  erc721NonexistentTokenError,
  ramsesInvalidTokenIdError,
  {
    inputs: [],
    name: "WETH9",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "tokenId", type: "uint256" }
    ],
    name: "approve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "burn",
    outputs: [],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [{ components: collectParams, internalType: "struct INonfungiblePositionManager.CollectParams", name: "params", type: "tuple" }],
    name: "collect",
    outputs: [
      { internalType: "uint256", name: "amount0", type: "uint256" },
      { internalType: "uint256", name: "amount1", type: "uint256" }
    ],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "token0", type: "address" },
      { internalType: "address", name: "token1", type: "address" },
      { internalType: "int24", name: "tickSpacing", type: "int24" },
      { internalType: "uint160", name: "sqrtPriceX96", type: "uint160" }
    ],
    name: "createAndInitializePoolIfNecessary",
    outputs: [{ internalType: "address", name: "pool", type: "address" }],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [{ components: decreaseLiquidityParams, internalType: "struct INonfungiblePositionManager.DecreaseLiquidityParams", name: "params", type: "tuple" }],
    name: "decreaseLiquidity",
    outputs: [
      { internalType: "uint256", name: "amount0", type: "uint256" },
      { internalType: "uint256", name: "amount1", type: "uint256" }
    ],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [],
    name: "deployer",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "getApproved",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "period", type: "uint256" },
      { internalType: "uint256", name: "tokenId", type: "uint256" },
      { internalType: "address[]", name: "tokens", type: "address[]" },
      { internalType: "address", name: "receiver", type: "address" }
    ],
    name: "getPeriodReward",
    outputs: [],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "tokenId", type: "uint256" },
      { internalType: "address[]", name: "tokens", type: "address[]" }
    ],
    name: "getReward",
    outputs: [],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [{ components: increaseLiquidityParams, internalType: "struct INonfungiblePositionManager.IncreaseLiquidityParams", name: "params", type: "tuple" }],
    name: "increaseLiquidity",
    outputs: [
      { internalType: "uint128", name: "liquidity", type: "uint128" },
      { internalType: "uint256", name: "amount0", type: "uint256" },
      { internalType: "uint256", name: "amount1", type: "uint256" }
    ],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "address", name: "operator", type: "address" }
    ],
    name: "isApprovedForAll",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ components: mintParams, internalType: "struct INonfungiblePositionManager.MintParams", name: "params", type: "tuple" }],
    name: "mint",
    outputs: [
      { internalType: "uint256", name: "tokenId", type: "uint256" },
      { internalType: "uint128", name: "liquidity", type: "uint128" },
      { internalType: "uint256", name: "amount0", type: "uint256" },
      { internalType: "uint256", name: "amount1", type: "uint256" }
    ],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [{ internalType: "bytes[]", name: "data", type: "bytes[]" }],
    name: "multicall",
    outputs: [{ internalType: "bytes[]", name: "results", type: "bytes[]" }],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "ownerOf",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "positionLastModified",
    outputs: [{ internalType: "uint32", name: "", type: "uint32" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "positions",
    outputs: [
      { internalType: "address", name: "token0", type: "address" },
      { internalType: "address", name: "token1", type: "address" },
      { internalType: "int24", name: "tickSpacing", type: "int24" },
      { internalType: "int24", name: "tickLower", type: "int24" },
      { internalType: "int24", name: "tickUpper", type: "int24" },
      { internalType: "uint128", name: "liquidity", type: "uint128" },
      { internalType: "uint256", name: "feeGrowthInside0LastX128", type: "uint256" },
      { internalType: "uint256", name: "feeGrowthInside1LastX128", type: "uint256" },
      { internalType: "uint128", name: "tokensOwed0", type: "uint128" },
      { internalType: "uint128", name: "tokensOwed1", type: "uint128" }
    ],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "refundETH",
    outputs: [],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "from", type: "address" },
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "tokenId", type: "uint256" }
    ],
    name: "safeTransferFrom",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "from", type: "address" },
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "tokenId", type: "uint256" },
      { internalType: "bytes", name: "data", type: "bytes" }
    ],
    name: "safeTransferFrom",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "operator", type: "address" },
      { internalType: "bool", name: "approved", type: "bool" }
    ],
    name: "setApprovalForAll",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "contract IVoter", name: "_voter", type: "address" }],
    name: "setVoter",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "bytes4", name: "interfaceId", type: "bytes4" }],
    name: "supportsInterface",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "amountMinimum", type: "uint256" },
      { internalType: "address", name: "recipient", type: "address" }
    ],
    name: "sweepToken",
    outputs: [],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "index", type: "uint256" }],
    name: "tokenByIndex",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "uint256", name: "index", type: "uint256" }
    ],
    name: "tokenOfOwnerByIndex",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "tokenURI",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "from", type: "address" },
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "tokenId", type: "uint256" }
    ],
    name: "transferFrom",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "amount0Owed", type: "uint256" },
      { internalType: "uint256", name: "amount1Owed", type: "uint256" },
      { internalType: "bytes", name: "data", type: "bytes" }
    ],
    name: "uniswapV3MintCallback",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "amountMinimum", type: "uint256" },
      { internalType: "address", name: "recipient", type: "address" }
    ],
    name: "unwrapWETH9",
    outputs: [],
    stateMutability: "payable",
    type: "function"
  }
] as const satisfies Abi;
