import { parseAbi } from "viem";

export const dlmmRouterAbi = parseAbi([
  "function addLiquidity((address tokenX, address tokenY, uint256 binStep, uint256 amountX, uint256 amountY, uint256 amountXMin, uint256 amountYMin, uint256 activeIdDesired, uint256 idSlippage, int256[] deltaIds, uint256[] distributionX, uint256[] distributionY, address to, address refundTo, uint256 deadline) liquidityParameters) returns (uint256, uint256, uint256, uint256, uint256[], uint256[])",
  "function addLiquidityNATIVE((address tokenX, address tokenY, uint256 binStep, uint256 amountX, uint256 amountY, uint256 amountXMin, uint256 amountYMin, uint256 activeIdDesired, uint256 idSlippage, int256[] deltaIds, uint256[] distributionX, uint256[] distributionY, address to, address refundTo, uint256 deadline) liquidityParameters) payable returns (uint256, uint256, uint256, uint256, uint256[], uint256[])",
  "function createLBPair(address tokenX, address tokenY, uint24 activeId, uint16 binStep) returns (address)",
  "function getFactory() view returns (address)",
  "function getIdFromPrice(address pair, uint256 price) view returns (uint24)",
  "function getPriceFromId(address pair, uint24 id) view returns (uint256)",
  "function getSwapIn(address pair, uint128 amountOut, bool swapForY) view returns (uint128, uint128, uint128)",
  "function getSwapOut(address pair, uint128 amountIn, bool swapForY) view returns (uint128, uint128, uint128)",
  "function getWNATIVE() view returns (address)",
  "function removeLiquidity(address tokenX, address tokenY, uint16 binStep, uint256 amountXMin, uint256 amountYMin, uint256[] ids, uint256[] amounts, address to, uint256 deadline) returns (uint256, uint256)",
  "function removeLiquidityNATIVE(address token, uint16 binStep, uint256 amountTokenMin, uint256 amountNATIVEMin, uint256[] ids, uint256[] amounts, address to, uint256 deadline) returns (uint256, uint256)",
  "function swapExactNATIVEForTokens(uint256 amountOutMin, (uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline) payable returns (uint256)",
  "function swapExactNATIVEForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, (uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline) payable returns (uint256)",
  "function swapExactTokensForNATIVE(uint256 amountIn, uint256 amountOutMinNATIVE, (uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline) returns (uint256)",
  "function swapExactTokensForNATIVESupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMinNATIVE, (uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline) returns (uint256)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline) returns (uint256)",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, (uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline) returns (uint256)",
  "function swapNATIVEForExactTokens(uint256 amountOut, (uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline) payable returns (uint256[])",
  "function swapTokensForExactNATIVE(uint256 amountNATIVEOut, uint256 amountInMax, (uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline) returns (uint256[])",
  "function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, (uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline) returns (uint256[])",
  "function sweep(address token, address to, uint256 amount)",
  "function sweepLBToken(address lbToken, address to, uint256[] ids, uint256[] amounts)"
]);
