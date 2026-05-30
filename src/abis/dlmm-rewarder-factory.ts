import { parseAbi } from "viem";

export const dlmmRewarderFactoryAbi = parseAbi([
  "function createRewarder(address pair) returns (address rewarder)",
  "function getRewarder(address pair) view returns (address rewarder)",
  "function implementation() view returns (address)",
  "function setImplementation(address implementation)",
  "function setVoter(address voter)",
  "function voter() view returns (address)"
]);
