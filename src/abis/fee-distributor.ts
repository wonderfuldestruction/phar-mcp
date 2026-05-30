import { parseAbi } from "viem";

export const feeDistributorAbi = parseAbi([
  "function voter() view returns (address)",
  "function voteModule() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function firstPeriod() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256 amount)",
  "function votes(uint256 period) view returns (uint256 weight)",
  "function userVotes(uint256 period, address owner) view returns (uint256 weight)",
  "function rewardSupply(uint256 period, address token) view returns (uint256 amount)",
  "function userClaimed(uint256 period, address owner, address token) view returns (uint256 amount)",
  "function lastClaimByToken(address token, address owner) view returns (uint256 period)",
  "function _deposit(uint256 amount, address owner)",
  "function _withdraw(uint256 amount, address owner)",
  "function getRewardForOwner(address owner, address[] tokens)",
  "function getRewardForOwnerTo(address owner, address[] tokens, address destination)",
  "function notifyRewardAmount(address token, uint256 amount)",
  "function getRewardTokens() view returns (address[] _rewards)",
  "function earned(address token, address owner) view returns (uint256 reward)",
  "function incentivize(address token, uint256 amount)",
  "function getPeriodReward(uint256 period, address owner, address token)",
  "function getReward(address owner, address[] tokens)",
  "function removeReward(address _token)",
  "function clawbackRewards(address token, address destination)",
  "function getPeriod() view returns (uint256)"
]);
