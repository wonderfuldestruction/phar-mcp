import { parseAbi } from "viem";

export const feeRecipientAbi = parseAbi([
  "function feeDistributor() view returns (address)",
  "function feeRecipientFactory() view returns (address)",
  "function initialize(address _feeDistributor)",
  "function notifyFees()",
  "function pair() view returns (address)",
  "function voter() view returns (address)"
]);
