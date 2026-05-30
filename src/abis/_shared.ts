export const aggregatorSwapTuple = [
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "address", name: "tokenOut", type: "address" },
  { internalType: "uint256", name: "amountIn", type: "uint256" },
  { internalType: "uint256", name: "minAmountOut", type: "uint256" },
  { internalType: "bytes", name: "data", type: "bytes" }
] as const;

export const autoVaultSwapTuple = [
  { internalType: "address", name: "aggregator", type: "address" },
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "bytes", name: "callData", type: "bytes" }
] as const;

export const collectParams = [
  { internalType: "uint256", name: "tokenId", type: "uint256" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint128", name: "amount0Max", type: "uint128" },
  { internalType: "uint128", name: "amount1Max", type: "uint128" }
] as const;

export const decreaseLiquidityParams = [
  { internalType: "uint256", name: "tokenId", type: "uint256" },
  { internalType: "uint128", name: "liquidity", type: "uint128" },
  { internalType: "uint256", name: "amount0Min", type: "uint256" },
  { internalType: "uint256", name: "amount1Min", type: "uint256" },
  { internalType: "uint256", name: "deadline", type: "uint256" }
] as const;

export const exactInputParams = [
  { internalType: "bytes", name: "path", type: "bytes" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
  { internalType: "uint256", name: "amountIn", type: "uint256" },
  { internalType: "uint256", name: "amountOutMinimum", type: "uint256" }
] as const;

export const exactInputSingleParams = [
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "address", name: "tokenOut", type: "address" },
  { internalType: "int24", name: "tickSpacing", type: "int24" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
  { internalType: "uint256", name: "amountIn", type: "uint256" },
  { internalType: "uint256", name: "amountOutMinimum", type: "uint256" },
  { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" }
] as const;

export const exactOutputParams = [
  { internalType: "bytes", name: "path", type: "bytes" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
  { internalType: "uint256", name: "amountOut", type: "uint256" },
  { internalType: "uint256", name: "amountInMaximum", type: "uint256" }
] as const;

export const exactOutputSingleParams = [
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "address", name: "tokenOut", type: "address" },
  { internalType: "int24", name: "tickSpacing", type: "int24" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
  { internalType: "uint256", name: "amountOut", type: "uint256" },
  { internalType: "uint256", name: "amountInMaximum", type: "uint256" },
  { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" }
] as const;

export const increaseLiquidityParams = [
  { internalType: "uint256", name: "tokenId", type: "uint256" },
  { internalType: "uint256", name: "amount0Desired", type: "uint256" },
  { internalType: "uint256", name: "amount1Desired", type: "uint256" },
  { internalType: "uint256", name: "amount0Min", type: "uint256" },
  { internalType: "uint256", name: "amount1Min", type: "uint256" },
  { internalType: "uint256", name: "deadline", type: "uint256" }
] as const;

export const mintParams = [
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

export const mixedRouteQuoteV2Params = [
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "address", name: "tokenOut", type: "address" },
  { internalType: "uint256", name: "amountIn", type: "uint256" },
  { internalType: "bool", name: "stable", type: "bool" }
] as const;

export const mixedRouteQuoteV3Params = [
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "address", name: "tokenOut", type: "address" },
  { internalType: "uint256", name: "amountIn", type: "uint256" },
  { internalType: "int24", name: "tickSpacing", type: "int24" },
  { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" }
] as const;

export const multicallCallTuple = [
  { internalType: "address", name: "target", type: "address" },
  { internalType: "uint256", name: "gasLimit", type: "uint256" },
  { internalType: "bytes", name: "callData", type: "bytes" }
] as const;

export const quoteExactInputSingleV2Params = [
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "address", name: "tokenOut", type: "address" },
  { internalType: "uint256", name: "amountIn", type: "uint256" },
  { internalType: "int24", name: "tickSpacing", type: "int24" },
  { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" }
] as const;

export const quoteExactOutputSingleV2Params = [
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "address", name: "tokenOut", type: "address" },
  { internalType: "uint256", name: "amount", type: "uint256" },
  { internalType: "int24", name: "tickSpacing", type: "int24" },
  { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" }
] as const;

export const ramsesInvalidTokenIdError = {
  inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
  name: "InvalidTokenId",
  type: "error"
} as const;
