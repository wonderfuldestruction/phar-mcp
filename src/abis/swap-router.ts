import type { Abi } from "viem";

const exactInputParams = [
  { internalType: "bytes", name: "path", type: "bytes" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
  { internalType: "uint256", name: "amountIn", type: "uint256" },
  { internalType: "uint256", name: "amountOutMinimum", type: "uint256" }
] as const;

const exactInputSingleParams = [
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "address", name: "tokenOut", type: "address" },
  { internalType: "int24", name: "tickSpacing", type: "int24" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
  { internalType: "uint256", name: "amountIn", type: "uint256" },
  { internalType: "uint256", name: "amountOutMinimum", type: "uint256" },
  { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" }
] as const;

const exactOutputParams = [
  { internalType: "bytes", name: "path", type: "bytes" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
  { internalType: "uint256", name: "amountOut", type: "uint256" },
  { internalType: "uint256", name: "amountInMaximum", type: "uint256" }
] as const;

const exactOutputSingleParams = [
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "address", name: "tokenOut", type: "address" },
  { internalType: "int24", name: "tickSpacing", type: "int24" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
  { internalType: "uint256", name: "amountOut", type: "uint256" },
  { internalType: "uint256", name: "amountInMaximum", type: "uint256" },
  { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" }
] as const;

export const swapRouterAbi = [
  {
    inputs: [],
    name: "WETH9",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
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
    inputs: [{ components: exactInputParams, internalType: "struct ISwapRouter.ExactInputParams", name: "params", type: "tuple" }],
    name: "exactInput",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [{ components: exactInputSingleParams, internalType: "struct ISwapRouter.ExactInputSingleParams", name: "params", type: "tuple" }],
    name: "exactInputSingle",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [{ components: exactOutputParams, internalType: "struct ISwapRouter.ExactOutputParams", name: "params", type: "tuple" }],
    name: "exactOutput",
    outputs: [{ internalType: "uint256", name: "amountIn", type: "uint256" }],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [{ components: exactOutputSingleParams, internalType: "struct ISwapRouter.ExactOutputSingleParams", name: "params", type: "tuple" }],
    name: "exactOutputSingle",
    outputs: [{ internalType: "uint256", name: "amountIn", type: "uint256" }],
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
    name: "refundETH",
    outputs: [],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "value", type: "uint256" },
      { internalType: "uint256", name: "deadline", type: "uint256" },
      { internalType: "uint8", name: "v", type: "uint8" },
      { internalType: "bytes32", name: "r", type: "bytes32" },
      { internalType: "bytes32", name: "s", type: "bytes32" }
    ],
    name: "selfPermit",
    outputs: [],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "nonce", type: "uint256" },
      { internalType: "uint256", name: "expiry", type: "uint256" },
      { internalType: "uint8", name: "v", type: "uint8" },
      { internalType: "bytes32", name: "r", type: "bytes32" },
      { internalType: "bytes32", name: "s", type: "bytes32" }
    ],
    name: "selfPermitAllowed",
    outputs: [],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "nonce", type: "uint256" },
      { internalType: "uint256", name: "expiry", type: "uint256" },
      { internalType: "uint8", name: "v", type: "uint8" },
      { internalType: "bytes32", name: "r", type: "bytes32" },
      { internalType: "bytes32", name: "s", type: "bytes32" }
    ],
    name: "selfPermitAllowedIfNecessary",
    outputs: [],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "value", type: "uint256" },
      { internalType: "uint256", name: "deadline", type: "uint256" },
      { internalType: "uint8", name: "v", type: "uint8" },
      { internalType: "bytes32", name: "r", type: "bytes32" },
      { internalType: "bytes32", name: "s", type: "bytes32" }
    ],
    name: "selfPermitIfNecessary",
    outputs: [],
    stateMutability: "payable",
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
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "amountMinimum", type: "uint256" },
      { internalType: "address", name: "recipient", type: "address" },
      { internalType: "uint256", name: "feeBips", type: "uint256" },
      { internalType: "address", name: "feeRecipient", type: "address" }
    ],
    name: "sweepTokenWithFee",
    outputs: [],
    stateMutability: "payable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "int256", name: "amount0Delta", type: "int256" },
      { internalType: "int256", name: "amount1Delta", type: "int256" },
      { internalType: "bytes", name: "_data", type: "bytes" }
    ],
    name: "uniswapV3SwapCallback",
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
  },
  {
    inputs: [
      { internalType: "uint256", name: "amountMinimum", type: "uint256" },
      { internalType: "address", name: "recipient", type: "address" },
      { internalType: "uint256", name: "feeBips", type: "uint256" },
      { internalType: "address", name: "feeRecipient", type: "address" }
    ],
    name: "unwrapWETH9WithFee",
    outputs: [],
    stateMutability: "payable",
    type: "function"
  }
] as const satisfies Abi;
