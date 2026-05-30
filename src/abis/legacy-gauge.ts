import { parseAbi } from "viem";

export const legacyGaugeAbi = parseAbi([
  "function stake() view returns (address)",
  "function voter() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address user) view returns (uint256)",
  "function userRewardPerTokenStored(address user, address token) view returns (uint256)",
  "function storedRewardsPerUser(address user, address token) view returns (uint256)",
  "function isReward(address token) view returns (bool)",
  "function rewardsList() view returns (address[] _rewards)",
  "function rewardsListLength() view returns (uint256 _length)",
  "function lastTimeRewardApplicable(address token) view returns (uint256 ltra)",
  "function rewardData(address token) view returns ((uint256 rewardRate, uint256 periodFinish, uint256 lastUpdateTime, uint256 rewardPerTokenStored) data)",
  "function earned(address token, address account) view returns (uint256 _reward)",
  "function getReward(address account, address[] tokens)",
  "function rewardPerToken(address token) view returns (uint256 rpt)",
  "function depositAll()",
  "function depositFor(address recipient, uint256 amount)",
  "function deposit(uint256 amount)",
  "function withdrawAll()",
  "function withdraw(uint256 amount)",
  "function unstakeAndClaimAll(address[] tokens)",
  "function left(address token) view returns (uint256)",
  "function notifyRewardAmount(address token, uint256 amount)",
  "function isWhitelisted(address reward) view returns (bool)"
]);
