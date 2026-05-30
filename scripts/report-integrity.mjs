#!/usr/bin/env node
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toFunctionSelector } from "viem";
import { contractAbis } from "../dist/abis.js";

const reportsDir = "reports";
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
const additionalTrackedUserFlowKeys = [
  "pool_creation",
  "operator_incentive_claims"
];

function loadJson(file) {
  const path = join(reportsDir, file);
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadOptionalJson(file) {
  const path = join(reportsDir, file);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(failures, file, message) {
  failures.push({ file, message });
}

function requireTruthy(failures, file, value, message) {
  if (!value) fail(failures, file, message);
}

function requireZero(failures, file, value, message) {
  if (Number(value ?? 0) !== 0) fail(failures, file, message);
}

function requireSetIncludes(failures, file, values, expected, message) {
  const set = new Set(values ?? []);
  const missing = expected.filter((value) => !set.has(value));
  if (missing.length > 0) fail(failures, file, `${message}: missing ${missing.join(", ")}`);
}

function requireEmpty(failures, file, values, message) {
  if ((values ?? []).length > 0) fail(failures, file, `${message}: ${values.join(", ")}`);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireDeepEqual(failures, file, actual, expected, message) {
  if (stableStringify(actual) !== stableStringify(expected)) fail(failures, file, message);
}

function requireArraySetEqual(failures, file, actual, expected, message) {
  const actualSet = new Set((actual ?? []).map((item) => stableStringify(item)));
  const expectedSet = new Set((expected ?? []).map((item) => stableStringify(item)));
  const missing = [...expectedSet].filter((item) => !actualSet.has(item));
  const extra = [...actualSet].filter((item) => !expectedSet.has(item));
  if (missing.length > 0 || extra.length > 0) {
    fail(failures, file, `${message}: missing=${missing.length} extra=${extra.length}`);
  }
}

function requireStringSetEqual(failures, file, actual, expected, message) {
  requireArraySetEqual(failures, file, actual ?? [], expected ?? [], message);
}

function byKey(items, key) {
  return (items ?? []).find((item) => item?.key === key);
}

function acceptanceCurrentState(report) {
  return report?.finalOutput?.continuationJsonPrompt?.current_state ?? report?.finalOutput?.currentState ?? {};
}

function acceptanceNextSteps(report) {
  return report?.finalOutput?.continuationJsonPrompt?.next_steps ?? report?.finalOutput?.nextSteps ?? [];
}

function acceptanceStatusSatisfied(item) {
  return ["complete", "caveated"].includes(item?.completionLevel);
}

function isCompletionBlocking(item) {
  if (!item || item.completionBlocking === false) return false;
  if (item.completionBlocking === true) return true;
  return (item.blockers ?? []).length > 0;
}

function deriveOverallStatus({ goalComplete, completionBlockingItems, acceptanceCriteriaSatisfied }) {
  if (goalComplete) return "complete";
  if (completionBlockingItems.some((item) => item.category === "live_state_gate")) return "partial_state_gated";
  if (completionBlockingItems.some((item) => item.category === "provenance_caveat")) return "partial_provenance_gated";
  return acceptanceCriteriaSatisfied ? "partial_documented_caveats" : "partial_verification_gated";
}

function sourceBackedAcceptanceEvidence(parsed, key) {
  if (key === "autoVault") return parsed["autovault-provenance.latest.json"] ?? null;
  return byKey(parsed["source-backed-provenance.latest.json"]?.targets, key) ??
    byKey(parsed["dlmm-provenance.latest.json"]?.targets, key) ??
    null;
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === "string"))].sort();
}

function parseRawAmount(value) {
  if (typeof value !== "string") return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function gitStatusEntries(statusLinesOrOutput = []) {
  const lines = Array.isArray(statusLinesOrOutput)
    ? statusLinesOrOutput
    : String(statusLinesOrOutput).split("\n");
  return lines
    .map((line) => String(line).trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      const renameParts = rawPath.split(" -> ");
      return {
        status,
        path: renameParts.at(-1) ?? rawPath,
        originalPath: renameParts.length > 1 ? renameParts[0] : null
      };
    });
}

function workflowConstStrings(source, constName) {
  const match = source.match(new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const;`));
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function flattenExclusions(excludedByCategory) {
  return Object.entries(excludedByCategory ?? {}).flatMap(([category, values]) =>
    (values ?? []).map((value) => ({ category, value }))
  );
}

function requireSmokedOrExcludedCoverage(failures, {
  source,
  constName,
  report,
  resultName,
  field,
  excludedByCategory,
  label
}) {
  const expected = workflowConstStrings(source, constName);
  if (!expected) {
    fail(failures, "src/workflowTools.ts", `expected to parse ${constName}`);
    return;
  }

  const expectedSet = new Set(expected);
  const smoked = uniqueStrings((report.results ?? [])
    .filter((item) => item.name === resultName)
    .map((item) => item[field]));
  const exclusions = flattenExclusions(excludedByCategory);
  const excluded = uniqueStrings(exclusions.map((item) => item.value));
  const coveredSet = new Set([...smoked, ...excluded]);
  const missing = expected.filter((value) => !coveredSet.has(value));
  const unknownSmoked = smoked.filter((value) => !expectedSet.has(value));
  const unknownExcluded = excluded.filter((value) => !expectedSet.has(value));
  const duplicateExcluded = exclusions
    .map((item) => item.value)
    .filter((value, index, values) => values.indexOf(value) !== index);
  const emptyCategories = Object.entries(excludedByCategory ?? {})
    .filter(([, values]) => !Array.isArray(values) || values.length === 0)
    .map(([category]) => category);

  requireEmpty(failures, "mcp-smoke.latest.json", missing, `expected ${label} actions smoked or explicitly excluded`);
  requireEmpty(failures, "mcp-smoke.latest.json", unknownSmoked, `expected ${label} smoked actions to exist in ${constName}`);
  requireEmpty(failures, "mcp-smoke.latest.json", unknownExcluded, `expected ${label} excluded actions to exist in ${constName}`);
  requireEmpty(failures, "mcp-smoke.latest.json", duplicateExcluded, `expected ${label} exclusions to be unique`);
  requireEmpty(failures, "mcp-smoke.latest.json", emptyCategories, `expected ${label} exclusion categories to be non-empty`);
}

function statusCounts(values = []) {
  const counts = {};
  for (const value of values) counts[value ?? "unknown"] = (counts[value ?? "unknown"] ?? 0) + 1;
  return counts;
}

function approvalCleanupSummaryFromRows(allowances, dlmmPoolApprovals) {
  const allowanceEntries = Object.entries(allowances ?? {});
  const allowanceSpenders = new Set();
  const nonzeroAllowanceRows = [];
  const allowanceReadErrors = [];
  let allowanceRowCount = 0;

  for (const [token, spendersByName] of Object.entries(allowances ?? {})) {
    for (const [spenderName, allowance] of Object.entries(spendersByName ?? {})) {
      allowanceRowCount += 1;
      allowanceSpenders.add(spenderName);
      const row = {
        token,
        spenderName,
        spender: allowance?.spender ?? null,
        raw: allowance?.raw ?? null,
        formatted: allowance?.formatted ?? null
      };

      if (typeof allowance?.raw !== "string") {
        allowanceReadErrors.push({
          standard: "ERC20",
          ...row,
          error: allowance?.error ?? "allowance raw value missing"
        });
        continue;
      }

      try {
        if (BigInt(allowance.raw) !== 0n) nonzeroAllowanceRows.push(row);
      } catch (error) {
        allowanceReadErrors.push({
          standard: "ERC20",
          ...row,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  const nonzeroDlmmApprovalRows = [];
  const dlmmApprovalReadErrors = [];
  let dlmmApprovalRowCount = 0;
  for (const [key, approved] of Object.entries(dlmmPoolApprovals ?? {})) {
    dlmmApprovalRowCount += 1;
    if (typeof approved !== "boolean") {
      dlmmApprovalReadErrors.push({
        standard: "DLMM_POOL",
        key,
        error: approved?.error ?? "approval value is not boolean"
      });
      continue;
    }
    if (approved) nonzeroDlmmApprovalRows.push({ key, approved });
  }

  const allTrackedAllowancesZero = nonzeroAllowanceRows.length === 0 && allowanceReadErrors.length === 0;
  const approvalsCleared = allTrackedAllowancesZero &&
    nonzeroDlmmApprovalRows.length === 0 &&
    dlmmApprovalReadErrors.length === 0;

  return {
    approvalsCleared,
    allTrackedAllowancesZero,
    allowanceTokenCount: allowanceEntries.length,
    allowanceSpenderCount: allowanceSpenders.size,
    allowanceRowCount,
    nonzeroAllowanceRowCount: nonzeroAllowanceRows.length,
    nonzeroAllowanceRows,
    allowanceReadErrorCount: allowanceReadErrors.length,
    allowanceReadErrors,
    dlmmApprovalRowCount,
    dlmmApprovedRowCount: nonzeroDlmmApprovalRows.length,
    nonzeroDlmmApprovalRows,
    dlmmApprovalReadErrorCount: dlmmApprovalReadErrors.length,
    dlmmApprovalReadErrors,
    approvalReadFailureCount: allowanceReadErrors.length + dlmmApprovalReadErrors.length,
    note: "Derived from tracked ERC20 allowances plus DLMM pool approval flags. approvalsCleared is false if any tracked approval is nonzero or any approval read fails."
  };
}

function summarizeRewardDomain(value) {
  if (Array.isArray(value)) {
    return {
      kind: "list",
      entries: value.length,
      claimableEntries: value.filter((entry) => entry?.claimable === true).length,
      buildCallEntries: value.filter((entry) => entry?.buildCall).length,
      statuses: statusCounts(value.map((entry) => entry?.status)),
      blockers: uniqueStrings(value.flatMap((entry) => entry?.blockers ?? []))
    };
  }

  if (value && typeof value === "object") {
    const nestedClaimability = Object.fromEntries(Object.entries(value)
      .filter(([, child]) => child && typeof child === "object" && !Array.isArray(child) && Object.hasOwn(child, "claimable"))
      .map(([key, child]) => [key, summarizeRewardDomain(child)]));
    return {
      kind: "single",
      claimable: value.claimable === true,
      status: value.status ?? (value.claimable === true ? "claimable" : "blocked"),
      hasBuildCall: Boolean(value.buildCall),
      blockers: uniqueStrings(value.blockers ?? []),
      nestedClaimability
    };
  }

  return { kind: "missing", claimable: false, status: "missing", hasBuildCall: false, blockers: ["domain missing"] };
}

function summarizeRewardClaimability(claimabilityRead) {
  const domains = claimabilityRead?.domains ?? {};
  return {
    currentPeriod: claimabilityRead?.currentPeriod ?? null,
    claimable: claimabilityRead?.claimable ?? null,
    blockers: claimabilityRead?.blockers ?? [],
    domains: Object.fromEntries(Object.entries(domains).map(([key, value]) => [key, summarizeRewardDomain(value)]))
  };
}

function flattenedOperatorRows(operatorIncentives) {
  return [
    ...(operatorIncentives?.positiveRows?.p33 ?? []).map((row) => ({ domain: "p33", ...row })),
    ...(operatorIncentives?.positiveRows?.autoVault ?? []).map((row) => ({ domain: "autoVault", ...row }))
  ];
}

function timestampMs(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function requireTimestamp(failures, file, value, message) {
  requireTruthy(failures, file, timestampMs(value) !== null, message);
}

function requireTimestampMatch(failures, file, actual, expected, message) {
  requireTimestamp(failures, file, expected, `${message}: expected source timestamp is missing or invalid`);
  if (actual !== expected) fail(failures, file, message);
}

function requireFreshEvidence(failures, file, acceptanceTimestamp, evidenceTimestamp, maxAgeMs, message) {
  const acceptanceMs = timestampMs(acceptanceTimestamp);
  const evidenceMs = timestampMs(evidenceTimestamp);
  if (acceptanceMs === null || evidenceMs === null) {
    fail(failures, file, `${message}: invalid timestamp`);
    return;
  }
  if (evidenceMs > acceptanceMs) {
    fail(failures, file, `${message}: evidence timestamp is after acceptance timestamp`);
    return;
  }
  if (acceptanceMs - evidenceMs > maxAgeMs) {
    fail(failures, file, `${message}: evidence is older than ${Math.round(maxAgeMs / 60000)} minutes`);
  }
}

function requireNotOlderThan(failures, file, actualTimestamp, floorTimestamp, message) {
  const actualMs = timestampMs(actualTimestamp);
  const floorMs = timestampMs(floorTimestamp);
  if (actualMs === null || floorMs === null) {
    fail(failures, file, `${message}: invalid timestamp`);
    return;
  }
  if (actualMs < floorMs) fail(failures, file, message);
}

function byCommand(items, command) {
  return (items ?? []).find((item) => item?.command === command);
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireHashMatchesSortedStrings(failures, file, values, hash, message) {
  const sortedValues = [...(values ?? [])].sort();
  requireTruthy(failures, file, isSha256(hash), `${message}: expected SHA-256 hash`);
  requireTruthy(failures, file, hash === sha256(sortedValues.join("\n")), `${message}: hash mismatch`);
}

function explorerStatuses(target) {
  return Object.values(target?.explorer ?? {})
    .filter((value) => value && typeof value === "object" && !Object.hasOwn(value, "classification"));
}

function exactAbiReports(target) {
  return [target?.explorer?.exactAbi, target?.explorer?.implementationExactAbi, target?.explorer?.selectorExactAbi].filter(Boolean);
}

function requireSourceArtifactEvidence(failures, file, target, key) {
  const evidence = target?.sourceArtifactEvidence;
  requireTruthy(failures, file, evidence && typeof evidence === "object", `expected ${key} source artifact evidence`);
  if (!evidence || typeof evidence !== "object") return;
  requireTruthy(failures, file, ["source_artifacts_fetched", "source_artifacts_partial"].includes(evidence.status), `expected ${key} fetched source artifact status`);
  requireTruthy(failures, file, Number(evidence.artifactCount ?? 0) > 0, `expected ${key} one or more source artifacts`);
  requireTruthy(failures, file, Number(evidence.fetchedArtifactCount ?? 0) === Number(evidence.artifactCount ?? -1), `expected ${key} all source artifacts fetched`);
  requireTruthy(failures, file, (evidence.artifacts ?? []).every((artifact) => artifact?.ok === true), `expected ${key} source artifact fetch ok`);
  requireTruthy(failures, file, (evidence.artifacts ?? []).every((artifact) => typeof artifact?.sourceUrl === "string" && artifact.sourceUrl.startsWith("https://")), `expected ${key} source artifact URLs`);
  requireTruthy(failures, file, (evidence.artifacts ?? []).every((artifact) => isSha256(artifact?.contentSha256)), `expected ${key} source artifact content hashes`);
  requireTruthy(failures, file, (evidence.artifacts ?? []).every((artifact) => timestampMs(artifact?.retrievedAt) !== null), `expected ${key} source artifact retrieval timestamps`);
  requireTruthy(failures, file, isSha256(evidence.sourceFunctionNamesSha256), `expected ${key} source function-name hash`);
  requireTruthy(failures, file, isSha256(evidence.sourceExplicitFunctionNamesSha256), `expected ${key} source explicit function-name hash`);
  requireTruthy(failures, file, isSha256(evidence.sourcePublicGetterNamesSha256), `expected ${key} source public getter-name hash`);
  requireTruthy(failures, file, ["complete", "partial", "name_only"].includes(evidence.signatureExtractionStatus), `expected ${key} signature extraction status`);
  requireTruthy(failures, file, Array.isArray(evidence.signatureExtractionWarnings), `expected ${key} signature extraction warnings array`);
  requireTruthy(
    failures,
    file,
    Array.isArray(evidence.skippedSignatureCandidates) || Number.isInteger(evidence.skippedSignatureCandidateCount),
    `expected ${key} skipped signature candidates array or count`
  );
  if (Array.isArray(evidence.comparison?.sourceFunctionSignatures)) {
    requireTruthy(failures, file, Number(evidence.sourceFunctionSignatureCount ?? 0) === evidence.comparison.sourceFunctionSignatures.length, `expected ${key} source function signature count parity`);
  }
  if (Array.isArray(evidence.comparison?.sourceExplicitFunctionSignatures)) {
    requireTruthy(failures, file, Number(evidence.sourceExplicitFunctionSignatureCount ?? 0) === evidence.comparison.sourceExplicitFunctionSignatures.length, `expected ${key} source explicit function signature count parity`);
  }
  if (Array.isArray(evidence.comparison?.sourcePublicGetterSignatures)) {
    requireTruthy(failures, file, Number(evidence.sourcePublicGetterSignatureCount ?? 0) === evidence.comparison.sourcePublicGetterSignatures.length, `expected ${key} source public getter signature count parity`);
  }
  if (Number(evidence.sourceFunctionSignatureCount ?? 0) > 0) {
    requireTruthy(
      failures,
      file,
      ["source_text_hash_and_signature_level_abi_comparison", "pharaoh_app_bundle_hash_and_signature_list_comparison"].includes(evidence.evidenceLevel),
      `expected ${key} signature-level evidence level`
    );
    if (Array.isArray(evidence.comparison?.sourceFunctionSignatures)) {
      requireHashMatchesSortedStrings(failures, file, evidence.comparison?.sourceFunctionSignatures, evidence.sourceFunctionSignaturesSha256, `expected ${key} source function signatures hash`);
    } else {
      requireTruthy(failures, file, isSha256(evidence.sourceFunctionSignaturesSha256), `expected ${key} source function signatures hash`);
    }
    if (Array.isArray(evidence.comparison?.sourceExplicitFunctionSignatures)) {
      requireHashMatchesSortedStrings(failures, file, evidence.comparison?.sourceExplicitFunctionSignatures, evidence.sourceExplicitFunctionSignaturesSha256, `expected ${key} source explicit function signatures hash`);
    } else {
      requireTruthy(failures, file, isSha256(evidence.sourceExplicitFunctionSignaturesSha256), `expected ${key} source explicit function signatures hash`);
    }
    if (Array.isArray(evidence.comparison?.sourcePublicGetterSignatures)) {
      requireHashMatchesSortedStrings(failures, file, evidence.comparison?.sourcePublicGetterSignatures, evidence.sourcePublicGetterSignaturesSha256, `expected ${key} source public getter signatures hash`);
    } else {
      requireTruthy(failures, file, isSha256(evidence.sourcePublicGetterSignaturesSha256), `expected ${key} source public getter signatures hash`);
    }
    requireTruthy(failures, file, Number(evidence.comparison?.localFunctionSignatureCoverage ?? 0) > 0, `expected ${key} positive local/source function-signature coverage`);
  } else {
    requireTruthy(failures, file, evidence.signatureExtractionStatus === "name_only", `expected ${key} name_only status when no source signatures are extracted`);
  }
  requireTruthy(failures, file, isSha256(evidence.localFunctionSignaturesSha256), `expected ${key} local function signature hash in source artifact evidence`);
  requireTruthy(
    failures,
    file,
    evidence.localFunctionSignaturesSha256 === target?.localAbi?.functionSignaturesSha256 ||
      evidence.localFunctionSignaturesSha256 === target?.bytecodeEvidence?.localAbiFunctionSignaturesSha256,
    `expected ${key} source artifact local ABI hash parity`
  );
  requireTruthy(failures, file, Number(evidence.sourceFunctionNameCount ?? 0) > 0, `expected ${key} source function names`);
  const commonFunctionNameCount = Array.isArray(evidence.comparison?.commonFunctionNames)
    ? evidence.comparison.commonFunctionNames.length
    : Number(evidence.comparison?.commonFunctionNameCount ?? 0);
  requireTruthy(failures, file, commonFunctionNameCount > 0, `expected ${key} local/source common function names`);
  requireTruthy(failures, file, Number(evidence.comparison?.localFunctionNameCoverage ?? 0) > 0, `expected ${key} positive local/source function-name coverage`);
  requireZero(
    failures,
    file,
    evidence.comparison?.unexpectedLocalFunctionNamesMissingFromSource?.length,
    `expected ${key} no unexpected local ABI names missing from source artifacts`
  );
}

function requireRuntimeSelectorOnlyEvidence(failures, file, target, key) {
  const evidence = target?.sourceArtifactEvidence;
  requireTruthy(failures, file, evidence && typeof evidence === "object", `expected ${key} runtime selector evidence`);
  if (!evidence || typeof evidence !== "object") return;
  requireTruthy(failures, file, evidence.status === "no_source_artifact_configured", `expected ${key} no source artifact configured status`);
  requireTruthy(failures, file, evidence.evidenceLevel === "runtime_selector_and_live_read_only", `expected ${key} runtime selector evidence level`);
  requireTruthy(failures, file, evidence.signatureExtractionStatus === "not_configured", `expected ${key} source signature extraction not configured`);
  requireZero(failures, file, evidence.artifactCount, `expected ${key} zero non-Pharaoh source artifacts`);
  requireZero(failures, file, evidence.fetchedArtifactCount, `expected ${key} zero fetched non-Pharaoh source artifacts`);
  requireTruthy(failures, file, Array.isArray(evidence.artifacts) && evidence.artifacts.length === 0, `expected ${key} empty source artifact list`);
  requireTruthy(failures, file, isSha256(evidence.localFunctionSignaturesSha256), `expected ${key} local function signature hash`);
  requireTruthy(
    failures,
    file,
    evidence.localFunctionSignaturesSha256 === target?.localAbi?.functionSignaturesSha256 ||
      evidence.localFunctionSignaturesSha256 === target?.bytecodeEvidence?.localAbiFunctionSignaturesSha256,
    `expected ${key} runtime selector evidence local ABI hash parity`
  );
  requireTruthy(failures, file, target?.provenanceGate?.selectorEvidence?.selectorComplete === true, `expected ${key} selector-complete provenance gate`);
  requireZero(failures, file, target?.provenanceGate?.selectorEvidence?.selectorsMissing, `expected ${key} zero selector gaps`);
  requireZero(failures, file, target?.provenanceGate?.liveReadEvidence?.failedCount, `expected ${key} zero live-read failures`);
  requireTruthy(failures, file, target?.provenanceGate?.keepSourceBacked === true, `expected ${key} to remain caveated until exact Pharaoh ABI evidence is available`);
}

function summarizedSourceArtifactEvidence(evidence) {
  if (!evidence) return null;
  return {
    status: evidence.status ?? null,
    evidenceLevel: evidence.evidenceLevel ?? null,
    artifactCount: evidence.artifactCount ?? 0,
    fetchedArtifactCount: evidence.fetchedArtifactCount ?? 0,
    artifacts: (evidence.artifacts ?? []).map((artifact) => ({
      kind: artifact.kind ?? null,
      repository: artifact.repository ?? null,
      commit: artifact.commit ?? null,
      path: artifact.path ?? null,
      sourceUrl: artifact.sourceUrl ?? null,
      fetchHost: artifact.fetchHost ?? null,
      retrievedAt: artifact.retrievedAt ?? null,
      ok: artifact.ok === true,
      httpStatus: artifact.httpStatus ?? null,
      httpStatusText: artifact.httpStatusText ?? null,
      contentLength: artifact.contentLength ?? null,
      contentSha256: artifact.contentSha256 ?? null,
      error: artifact.error ?? null
	    })),
	    signatureExtractionStatus: evidence.signatureExtractionStatus ?? null,
	    signatureExtractionWarnings: evidence.signatureExtractionWarnings ?? [],
	    skippedSignatureCandidateCount: evidence.skippedSignatureCandidates?.length ?? 0,
	    sourceFunctionSignatureCount: evidence.sourceFunctionSignatureCount ?? 0,
	    sourceFunctionSignaturesSha256: evidence.sourceFunctionSignaturesSha256 ?? null,
	    sourceExplicitFunctionSignatureCount: evidence.sourceExplicitFunctionSignatureCount ?? 0,
	    sourceExplicitFunctionSignaturesSha256: evidence.sourceExplicitFunctionSignaturesSha256 ?? null,
	    sourcePublicGetterSignatureCount: evidence.sourcePublicGetterSignatureCount ?? 0,
	    sourcePublicGetterSignaturesSha256: evidence.sourcePublicGetterSignaturesSha256 ?? null,
	    sourceFunctionNameCount: evidence.sourceFunctionNameCount ?? 0,
    sourceFunctionNamesSha256: evidence.sourceFunctionNamesSha256 ?? null,
    sourceExplicitFunctionNameCount: evidence.sourceExplicitFunctionNameCount ?? 0,
    sourceExplicitFunctionNamesSha256: evidence.sourceExplicitFunctionNamesSha256 ?? null,
    sourcePublicGetterNameCount: evidence.sourcePublicGetterNameCount ?? 0,
    sourcePublicGetterNamesSha256: evidence.sourcePublicGetterNamesSha256 ?? null,
    sourceErrorNameCount: evidence.sourceErrorNameCount ?? 0,
    sourceErrorNamesSha256: evidence.sourceErrorNamesSha256 ?? null,
	    localFunctionSignatureCount: evidence.localFunctionSignatureCount ?? 0,
    localFunctionSignaturesSha256: evidence.localFunctionSignaturesSha256 ?? null,
    localErrorSignatureCount: evidence.localErrorSignatureCount ?? 0,
    localErrorSignaturesSha256: evidence.localErrorSignaturesSha256 ?? null,
    comparison: {
	      commonFunctionNameCount: evidence.comparison?.commonFunctionNames?.length ?? 0,
	      commonFunctionSignatureCount: evidence.comparison?.commonFunctionSignatures?.length ?? 0,
	      commonErrorNameCount: evidence.comparison?.commonErrorNames?.length ?? 0,
	      localFunctionNamesMissingFromSource: evidence.comparison?.localFunctionNamesMissingFromSource ?? [],
	      localFunctionSignaturesMissingFromSource: evidence.comparison?.localFunctionSignaturesMissingFromSource ?? [],
	      expectedLocalFunctionNamesMissingFromSource: evidence.comparison?.expectedLocalFunctionNamesMissingFromSource ?? [],
	      expectedLocalFunctionSignaturesMissingFromSource: evidence.comparison?.expectedLocalFunctionSignaturesMissingFromSource ?? [],
	      unexpectedLocalFunctionNamesMissingFromSource: evidence.comparison?.unexpectedLocalFunctionNamesMissingFromSource ?? [],
	      unexpectedLocalFunctionSignaturesMissingFromSource: evidence.comparison?.unexpectedLocalFunctionSignaturesMissingFromSource ?? [],
	      expectedMissingReason: evidence.comparison?.expectedMissingReason ?? null,
      localErrorNamesMissingFromSource: evidence.comparison?.localErrorNamesMissingFromSource ?? [],
      appBundleSignaturesMissingFromLocal: evidence.comparison?.appBundleSignaturesMissingFromLocal ?? null,
	      localSignaturesExtraVsAppBundle: evidence.comparison?.localSignaturesExtraVsAppBundle ?? null,
	      localFunctionNameCoverage: evidence.comparison?.localFunctionNameCoverage ?? null,
	      localFunctionSignatureCoverage: evidence.comparison?.localFunctionSignatureCoverage ?? null,
	      localErrorNameCoverage: evidence.comparison?.localErrorNameCoverage ?? null,
      comparisonScope: evidence.comparison?.comparisonScope ?? null
    }
  };
}

function sourceArtifactRef(artifact) {
  if (!artifact) return "unknown";
  if (artifact.repository && artifact.commit && artifact.path) {
    return `${artifact.repository}@${String(artifact.commit).slice(0, 12)}:${artifact.path}`;
  }
  const host = artifact.fetchHost ?? (artifact.sourceUrl ? new URL(artifact.sourceUrl).host : "source");
  return `${host}:${artifact.path ?? artifact.sourceUrl ?? "unknown"}`;
}

function sourceArtifactCoverageSummary(unresolvedTargets) {
  return {
    sourceBackedTargets: unresolvedTargets.length,
    targets: unresolvedTargets.map((target) => ({
      key: target.key,
      evidenceLevel: target.sourceArtifactEvidence?.evidenceLevel ?? null,
      artifactCount: target.sourceArtifactEvidence?.artifactCount ?? 0,
      fetchedArtifactCount: target.sourceArtifactEvidence?.fetchedArtifactCount ?? 0,
	      artifactRefs: (target.sourceArtifactEvidence?.artifacts ?? []).map(sourceArtifactRef),
	      signatureExtractionStatus: target.sourceArtifactEvidence?.signatureExtractionStatus ?? null,
	      sourceFunctionSignatureCount: target.sourceArtifactEvidence?.sourceFunctionSignatureCount ?? 0,
	      localFunctionSignatureCoverage: target.sourceArtifactEvidence?.comparison?.localFunctionSignatureCoverage ?? null,
	      unexpectedMissingSignatureCount: target.sourceArtifactEvidence?.comparison?.unexpectedLocalFunctionSignaturesMissingFromSource?.length ?? 0,
	      expectedMissingSignatureCount: target.sourceArtifactEvidence?.comparison?.expectedLocalFunctionSignaturesMissingFromSource?.length ?? 0,
	      localFunctionNameCoverage: target.sourceArtifactEvidence?.comparison?.localFunctionNameCoverage ?? null,
      unexpectedMissingCount: target.sourceArtifactEvidence?.comparison?.unexpectedLocalFunctionNamesMissingFromSource?.length ?? 0,
      expectedMissingCount: target.sourceArtifactEvidence?.comparison?.expectedLocalFunctionNamesMissingFromSource?.length ?? 0,
      expectedMissingReason: target.sourceArtifactEvidence?.comparison?.expectedMissingReason ?? null,
      promotionBlockers: target.provenanceGate?.promotionBlockers ?? []
    })),
    sourceArtifactsFetchedTargets: unresolvedTargets
      .filter((target) => target.sourceArtifactEvidence?.status === "source_artifacts_fetched")
      .map((target) => target.key),
    runtimeSelectorOnlyTargets: unresolvedTargets
      .filter((target) => target.sourceArtifactEvidence?.status === "no_source_artifact_configured")
      .map((target) => target.key),
    totalArtifactCount: unresolvedTargets
      .reduce((sum, target) => sum + Number(target.sourceArtifactEvidence?.artifactCount ?? 0), 0),
    fetchedArtifactCount: unresolvedTargets
      .reduce((sum, target) => sum + Number(target.sourceArtifactEvidence?.fetchedArtifactCount ?? 0), 0),
    unexpectedMissingLocalFunctionNames: unresolvedTargets.flatMap((target) =>
      (target.sourceArtifactEvidence?.comparison?.unexpectedLocalFunctionNamesMissingFromSource ?? [])
        .map((name) => ({ key: target.key, name }))
    ),
	    expectedMissingLocalFunctionNames: unresolvedTargets.flatMap((target) =>
	      (target.sourceArtifactEvidence?.comparison?.expectedLocalFunctionNamesMissingFromSource ?? [])
        .map((name) => ({
          key: target.key,
          name,
	          reason: target.sourceArtifactEvidence?.comparison?.expectedMissingReason ?? null
	        }))
	    ),
	    unexpectedMissingLocalFunctionSignatures: unresolvedTargets.flatMap((target) =>
	      (target.sourceArtifactEvidence?.comparison?.unexpectedLocalFunctionSignaturesMissingFromSource ?? [])
	        .map((signature) => ({ key: target.key, signature }))
	    ),
	    expectedMissingLocalFunctionSignatures: unresolvedTargets.flatMap((target) =>
	      (target.sourceArtifactEvidence?.comparison?.expectedLocalFunctionSignaturesMissingFromSource ?? [])
	        .map((signature) => ({
	          key: target.key,
	          signature,
	          reason: target.sourceArtifactEvidence?.comparison?.expectedMissingReason ?? null
	        }))
	    )
	  };
	}

function summarizedAbiAttempt(attempt) {
  return {
    source: attempt?.source ?? null,
    address: attempt?.address ?? null,
    endpointKind: attempt?.endpointKind ?? null,
    urlHost: attempt?.urlHost ?? null,
    attempt: attempt?.attempt ?? null,
    maxAttempts: attempt?.maxAttempts ?? null,
    ok: attempt?.ok === true,
    retryable: attempt?.retryable ?? null,
    outcome: attempt?.outcome ?? null,
    retrievedAt: attempt?.retrievedAt ?? null,
    httpStatus: attempt?.httpStatus ?? null,
    httpStatusText: attempt?.httpStatusText ?? null,
    httpOk: attempt?.httpOk ?? null,
    apiStatus: attempt?.apiStatus ?? attempt?.status ?? null,
    apiMessage: attempt?.apiMessage ?? attempt?.message ?? null,
    resultSummary: attempt?.resultSummary ?? attempt?.bodySummary ?? null,
    error: attempt?.error ?? null
  };
}

function requireAbiFetchAttemptEvidence(failures, file, report, label, options = {}) {
  const attempts = report?.attempts ?? [];
  requireTruthy(failures, file, attempts.length > 0, `expected ${label} exact-ABI attempts`);

  if (options.requireSnowtraceAndRoutescan) {
    requireSetIncludes(failures, file, attempts.map((attempt) => attempt?.source), ["snowtrace", "routescan"], `expected ${label} snowtrace and routescan attempts`);
  }

  for (const attempt of attempts) {
    const prefix = `${label} ${attempt?.source ?? "unknown"} attempt ${attempt?.attempt ?? "?"}`;
    requireTruthy(failures, file, typeof attempt?.source === "string", `expected ${prefix} source`);
    requireTruthy(failures, file, typeof attempt?.address === "string", `expected ${prefix} address`);
    requireTruthy(failures, file, attempt?.endpointKind === "etherscan_getabi", `expected ${prefix} endpointKind etherscan_getabi`);
    requireTruthy(failures, file, typeof attempt?.retrievedAt === "string", `expected ${prefix} retrievedAt`);
    requireTruthy(failures, file, typeof attempt?.ok === "boolean", `expected ${prefix} boolean ok`);
    requireTruthy(failures, file, typeof attempt?.retryable === "boolean", `expected ${prefix} boolean retryable`);
    requireTruthy(failures, file, typeof attempt?.outcome === "string", `expected ${prefix} outcome`);
    if (attempt?.ok !== true) {
      requireTruthy(failures, file, typeof attempt?.error === "string" || typeof attempt?.resultSummary === "string", `expected ${prefix} failed attempt error or resultSummary`);
    }
    if (attempt?.outcome === "explorer_unverified") {
      requireTruthy(failures, file, attempt.retryable === false, `expected ${prefix} explorer_unverified not retryable`);
    }
    if (attempt?.outcome === "transport_error") {
      requireTruthy(failures, file, attempt.retryable === true, `expected ${prefix} transport_error retryable`);
    }
  }

  if (report?.classification === "remote_abi_unavailable") {
    const inconclusiveSources = uniqueStrings(
      attempts
        .filter((attempt) => attempt?.retryable === true)
        .map((attempt) => attempt?.source)
    );
    requireTruthy(failures, file, report.ok === false, `expected ${label} unavailable ABI ok=false`);
    requireTruthy(failures, file, report.source === null, `expected ${label} unavailable ABI source=null`);
    requireTruthy(failures, file, report.comparison === null, `expected ${label} unavailable ABI comparison=null`);
    requireTruthy(
      failures,
      file,
      ["confirmed_unavailable", "inconclusive_fetch"].includes(report.fetchEvidenceStatus),
      `expected ${label} unavailable ABI fetchEvidenceStatus confirmed_unavailable or inconclusive_fetch`
    );
    requireTruthy(
      failures,
      file,
      attempts.every((attempt) => attempt?.outcome !== "exact_abi_fetched"),
      `expected ${label} unavailable ABI attempts not to include exact_abi_fetched`
    );
    if (report.fetchEvidenceStatus === "confirmed_unavailable") {
      requireZero(failures, file, inconclusiveSources.length, `expected ${label} confirmed_unavailable to have zero retryable sources`);
      requireStringSetEqual(failures, file, report.inconclusiveSources ?? [], [], `expected ${label} confirmed_unavailable inconclusiveSources`);
    }
    if (report.fetchEvidenceStatus === "inconclusive_fetch") {
      requireTruthy(failures, file, inconclusiveSources.length > 0, `expected ${label} inconclusive_fetch retryable source evidence`);
      requireStringSetEqual(
        failures,
        file,
        report.inconclusiveSources ?? [],
        inconclusiveSources,
        `expected ${label} inconclusiveSources to match retryable attempts`
      );
    }
  }
}

function summarizedExactAbiReport(report) {
  if (!report) return null;
  return {
    source: report.source ?? null,
    ok: report.ok === true,
    classification: report.classification ?? null,
    unavailableReason: report.unavailableReason ?? null,
    fetchEvidenceStatus: report.fetchEvidenceStatus ?? null,
    inconclusiveSources: report.inconclusiveSources ?? [],
    comparison: report.comparison ?? null,
    attempts: (report.attempts ?? []).map(summarizedAbiAttempt)
  };
}

function requireSourceBackedGate(failures, file, target, expectedEvidenceClass, expectedCheckAddressKind, blockNumber, label) {
  const gate = target?.provenanceGate ?? {};
  requireTruthy(failures, file, gate.evidenceClass === expectedEvidenceClass, `expected ${label} provenanceGate evidenceClass ${expectedEvidenceClass}`);
  requireTruthy(failures, file, gate.selectorBackedOnly === true, `expected ${label} provenanceGate selectorBackedOnly=true`);
  requireTruthy(failures, file, gate.exactPublicAbiVerified === false, `expected ${label} provenanceGate exactPublicAbiVerified=false`);
  requireTruthy(failures, file, gate.promotionEligible === false, `expected ${label} provenanceGate promotionEligible=false`);
  requireTruthy(failures, file, gate.keepSourceBacked === true, `expected ${label} provenanceGate keepSourceBacked=true`);
  requireTruthy(failures, file, (gate.promotionBlockers ?? []).length > 0, `expected ${label} provenanceGate promotion blockers`);
  requireTruthy(failures, file, gate.selectorEvidence?.checkAddress === target?.selectorCheckAddress, `expected ${label} provenanceGate selector check address parity`);
  requireTruthy(failures, file, gate.selectorEvidence?.checkAddressKind === expectedCheckAddressKind, `expected ${label} provenanceGate checkAddressKind ${expectedCheckAddressKind}`);
  requireTruthy(failures, file, Number(gate.selectorEvidence?.functionCount ?? -1) === Number(target?.selectorSummary?.functionCount ?? -2), `expected ${label} provenanceGate function count parity`);
  requireZero(failures, file, gate.selectorEvidence?.selectorsMissing, `expected ${label} provenanceGate zero missing selectors`);
  requireTruthy(failures, file, gate.selectorEvidence?.selectorComplete === true, `expected ${label} provenanceGate selectorComplete=true`);
  requireTruthy(failures, file, Number(gate.liveReadEvidence?.readCount ?? -1) === Object.keys(target?.liveReads ?? {}).length, `expected ${label} provenanceGate live read count parity`);
  requireZero(failures, file, gate.liveReadEvidence?.failedCount, `expected ${label} provenanceGate zero failed live reads`);
  requireTruthy(failures, file, gate.liveReadEvidence?.blockNumber === blockNumber, `expected ${label} provenanceGate live-read blockNumber`);
}

function requireExactVerifiedGate(failures, file, target, blockNumber, label) {
  const gate = target?.provenanceGate ?? {};
  requireTruthy(failures, file, gate.evidenceClass === "exact_public_abi_verified", `expected ${label} provenanceGate exact_public_abi_verified`);
  requireTruthy(failures, file, gate.selectorBackedOnly === false, `expected ${label} provenanceGate selectorBackedOnly=false`);
  requireTruthy(failures, file, gate.exactPublicAbiVerified === true, `expected ${label} provenanceGate exactPublicAbiVerified=true`);
  requireTruthy(failures, file, gate.promotionEligible === false, `expected ${label} provenanceGate promotionEligible=false`);
  requireTruthy(failures, file, gate.keepSourceBacked === false, `expected ${label} provenanceGate keepSourceBacked=false`);
  requireTruthy(failures, file, target?.explorer?.exactAbi?.ok === true, `expected ${label} exact public ABI ok`);
  requireZero(failures, file, target?.explorer?.exactAbi?.comparison?.missing?.length, `expected ${label} exact ABI comparison missing=0`);
  requireZero(failures, file, target?.explorer?.exactAbi?.comparison?.extra?.length, `expected ${label} exact ABI comparison extra=0`);
  requireTruthy(failures, file, gate.selectorEvidence?.checkAddress === target?.selectorCheckAddress, `expected ${label} provenanceGate selector check address parity`);
  requireTruthy(failures, file, Number(gate.selectorEvidence?.functionCount ?? -1) === Number(target?.selectorSummary?.functionCount ?? -2), `expected ${label} provenanceGate function count parity`);
  requireZero(failures, file, gate.selectorEvidence?.selectorsMissing, `expected ${label} provenanceGate zero missing selectors`);
  requireTruthy(failures, file, gate.selectorEvidence?.selectorComplete === true, `expected ${label} provenanceGate selectorComplete=true`);
  requireZero(failures, file, gate.liveReadEvidence?.failedCount, `expected ${label} provenanceGate zero failed live reads`);
  requireTruthy(failures, file, gate.liveReadEvidence?.blockNumber === blockNumber, `expected ${label} provenanceGate live-read blockNumber`);
}

const baseLiveReceiptSources = [
  "reports/live-broadcast.latest.json",
  "reports/mixed-route-live.latest.json",
  "reports/vote-live.latest.json",
  "reports/xphar-exit.latest.json",
  "reports/dlmm-multibin-live.latest.json",
  "reports/dlmm-close-live.latest.json"
];
const optionalLiveReceiptSources = [
  "reports/p33-live.latest.json",
  "reports/p33-mint-withdraw-live.latest.json"
];
const liveReportStepPhases = {
  "p33-live.latest.json": "p33_live",
  "p33-mint-withdraw-live.latest.json": "p33_mint_withdraw_live",
  "vote-live.latest.json": "vote_module_roundtrip",
  "xphar-exit.latest.json": "xphar_exit",
  "dlmm-multibin-live.latest.json": "dlmm_multibin_manual_live",
  "dlmm-close-live.latest.json": "dlmm_close_manual_live"
};

function sourceFile(source) {
  return source.startsWith("reports/") ? source.slice("reports/".length) : source;
}

function liveReceiptSourcesForParsed(parsed) {
  const sourceSummaries = parsed["live-receipt-provenance.latest.json"]?.summary?.sourceSummaries ?? {};
  return [
    ...baseLiveReceiptSources,
    ...optionalLiveReceiptSources.filter((source) =>
      Object.hasOwn(parsed, sourceFile(source)) || Object.hasOwn(sourceSummaries, source)
    )
  ];
}

function liveHashesFromReport(file, report) {
  const out = [];
  for (const [phaseIndex, phase] of (report?.phases ?? []).entries()) {
    for (const [stepIndex, step] of (phase.steps ?? []).entries()) {
      if (step?.hash) {
        out.push({
          source: `reports/${file}`,
          sourcePath: `phases.${phaseIndex}.steps.${stepIndex}.hash`,
          phase: phase.name,
          label: step.label,
          hash: step.hash,
          reportedGasUsed: step.gasUsed ?? null
        });
      }
    }
  }
  for (const [stepIndex, step] of (report?.steps ?? []).entries()) {
    if (step?.hash) {
      out.push({
        source: `reports/${file}`,
        sourcePath: `steps.${stepIndex}.hash`,
        phase: liveReportStepPhases[file] ?? "live_steps",
        label: step.label,
        hash: step.hash,
        reportedGasUsed: step.gasUsed ?? null
      });
    }
  }
  return out;
}

function allLiveReportHashes(parsed) {
  return liveReceiptSourcesForParsed(parsed).flatMap((source) => {
    const file = sourceFile(source);
    return liveHashesFromReport(file, parsed[file] ?? {});
  });
}

function hasLiveReceiptProvenance(parsed, source) {
  const report = parsed["live-receipt-provenance.latest.json"];
  const summary = report?.summary?.sourceSummaries?.[source];
  return report?.ok === true && summary?.txCount > 0 && summary?.failedCount === 0;
}

function git(args) {
  try {
    return execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const files = readdirSync(reportsDir).filter((file) => file.endsWith(".latest.json")).sort();
const parsed = {};
const failures = [];
const warnings = [];
const workflowSource = readFileSync("src/workflowTools.ts", "utf8");
const pinnedDlmm = loadOptionalJson("dlmm-rewarder-pinned-evidence.json");
const pinnedClGauge = loadOptionalJson("cl-gauge-reward-pinned-evidence.json");

const p33LockedError = (contractAbis.p33 ?? []).find((item) =>
  item?.type === "error" &&
  item?.name === "LOCKED" &&
  Array.isArray(item?.inputs) &&
  item.inputs.length === 0
);
requireTruthy(failures, "dist/abis.js", p33LockedError, "expected p33 ABI to include custom error LOCKED()");
requireTruthy(failures, "dist/abis.js", toFunctionSelector("LOCKED()") === "0xa1422f69", "expected LOCKED() selector to equal p33 revert selector 0xa1422f69");
const autoVaultDepositTooSmallError = (contractAbis.autoVault ?? []).find((item) =>
  item?.type === "error" &&
  item?.name === "DepositTooSmall" &&
  Array.isArray(item?.inputs) &&
  item.inputs.length === 0
);
requireTruthy(failures, "dist/abis.js", autoVaultDepositTooSmallError, "expected AutoVault ABI to include custom error DepositTooSmall()");
requireTruthy(failures, "dist/abis.js", toFunctionSelector("DepositTooSmall()") === "0x6ba4a1c7", "expected DepositTooSmall() selector to equal AutoVault revert selector 0x6ba4a1c7");
const dlmmFactoryPresetLockedError = (contractAbis.dlmmFactory ?? []).find((item) =>
  item?.type === "error" &&
  item?.name === "LBFactory__PresetIsLockedForUsers" &&
  Array.isArray(item?.inputs) &&
  item.inputs.map((input) => input.type).join(",") === "address,uint256"
);
requireTruthy(failures, "dist/abis.js", dlmmFactoryPresetLockedError, "expected DLMMFactory ABI to include custom error LBFactory__PresetIsLockedForUsers(address,uint256)");
requireTruthy(failures, "dist/abis.js", toFunctionSelector("LBFactory__PresetIsLockedForUsers(address,uint256)") === "0x09f85fce", "expected LBFactory__PresetIsLockedForUsers selector to equal DLMM closed-preset revert selector 0x09f85fce");
const ramsesErc721NonexistentTokenError = (contractAbis.ramsesV3PositionManager ?? []).find((item) =>
  item?.type === "error" &&
  item?.name === "ERC721NonexistentToken" &&
  Array.isArray(item?.inputs) &&
  item.inputs.map((input) => input.type).join(",") === "uint256"
);
const ramsesInvalidTokenIdError = (contractAbis.ramsesV3PositionManager ?? []).find((item) =>
  item?.type === "error" &&
  item?.name === "InvalidTokenId" &&
  Array.isArray(item?.inputs) &&
  item.inputs.map((input) => input.type).join(",") === "uint256"
);
const clGaugeInvalidTokenIdError = (contractAbis.clGaugeV3 ?? []).find((item) =>
  item?.type === "error" &&
  item?.name === "InvalidTokenId" &&
  Array.isArray(item?.inputs) &&
  item.inputs.map((input) => input.type).join(",") === "uint256"
);
requireTruthy(failures, "dist/abis.js", ramsesErc721NonexistentTokenError, "expected RamsesV3PositionManager ABI to include ERC721NonexistentToken(uint256)");
requireTruthy(failures, "dist/abis.js", ramsesInvalidTokenIdError, "expected RamsesV3PositionManager ABI to include InvalidTokenId(uint256)");
requireTruthy(failures, "dist/abis.js", clGaugeInvalidTokenIdError, "expected CL GaugeV3 ABI to include bubbled InvalidTokenId(uint256)");
requireTruthy(failures, "dist/abis.js", toFunctionSelector("ERC721NonexistentToken(uint256)") === "0x7e273289", "expected ERC721NonexistentToken selector to equal CL stale-NFT ownerOf revert selector 0x7e273289");
requireTruthy(failures, "dist/abis.js", toFunctionSelector("InvalidTokenId(uint256)") === "0xed15e6cf", "expected InvalidTokenId selector to equal CL stale-NFT earned revert selector 0xed15e6cf");

for (const file of files) {
  try {
    parsed[file] = loadJson(file);
  } catch (error) {
    fail(failures, file, error instanceof Error ? error.message : String(error));
  }
}

if (parsed["fork-rehearsal.latest.json"]) {
  const report = parsed["fork-rehearsal.latest.json"];
  const p33Phase = (report.phases ?? []).find((phase) => phase.name === "phar_xphar_p33_roundtrip");
  const p33MintWithdrawPhase = (report.phases ?? []).find((phase) => phase.name === "p33_mint_withdraw_roundtrip");
  const p33Steps = p33Phase?.steps ?? [];
  const p33MintWithdrawSteps = p33MintWithdrawPhase?.steps ?? [];
  const p33Preflight = p33Steps.find((step) => step.label === "p33 preflight");
  const p33PostUnlock = p33Steps.find((step) => step.label === "p33 post-unlock preflight");
  const p33Deposit = p33Steps.find((step) => step.label === "p33 deposit xPHAR");
  const p33Redeem = p33Steps.find((step) => step.label === "p33 redeem to xPHAR");
  const p33Mint = p33MintWithdrawSteps.find((step) => step.label === "p33 mint shares");
  const p33Withdraw = p33MintWithdrawSteps.find((step) => step.label === "p33 withdraw assets");
  const p33MintWithdrawRevoke = p33MintWithdrawSteps.find((step) => step.label === "revoke xPHAR -> p33 after mint/withdraw");
  const p33MintWithdrawRemainingShares = p33MintWithdrawSteps.find((step) => step.label === "p33 shares after withdraw");
  requireTruthy(failures, "fork-rehearsal.latest.json", report.ok === true, "expected top-level ok=true");
  requireZero(failures, "fork-rehearsal.latest.json", report.summary?.failed, "expected zero failed phases");
  requireTruthy(failures, "fork-rehearsal.latest.json", report.final?.approvals?.dlmmPoolApprovals?.wavaxUsdc5ToRouter === false, "expected final DLMM router approval to be false");
  requireTruthy(failures, "fork-rehearsal.latest.json", p33Phase?.ok === true && p33Phase?.status === "passed", "expected p33 fork roundtrip phase to pass");
  requireTruthy(failures, "fork-rehearsal.latest.json", p33Preflight?.ok === true, "expected p33 fork preflight to pass");
  if (p33Preflight?.result?.isUnlocked === false || p33Preflight?.result?.periodUnlockStatus === false) {
    requireTruthy(failures, "fork-rehearsal.latest.json", p33Steps.some((step) => step.label === "fork impersonate p33 operator unlock" && step.ok === true), "expected locked p33 fork to impersonate operator unlock");
    requireTruthy(failures, "fork-rehearsal.latest.json", p33PostUnlock?.ok === true && p33PostUnlock?.result?.isUnlocked === true && p33PostUnlock?.result?.periodUnlockStatus === true, "expected p33 fork post-unlock preflight to be open");
  }
  requireTruthy(failures, "fork-rehearsal.latest.json", p33Deposit?.ok === true && typeof p33Deposit?.hash === "string", "expected p33 fork deposit transaction proof");
  requireTruthy(failures, "fork-rehearsal.latest.json", p33Redeem?.ok === true && typeof p33Redeem?.hash === "string", "expected p33 fork redeem transaction proof");
  requireTruthy(failures, "fork-rehearsal.latest.json", p33MintWithdrawPhase?.ok === true && p33MintWithdrawPhase?.status === "passed", "expected p33 fork mint/withdraw phase to pass");
  requireTruthy(failures, "fork-rehearsal.latest.json", p33Mint?.ok === true && typeof p33Mint?.hash === "string", "expected p33 fork mint transaction proof");
  requireTruthy(failures, "fork-rehearsal.latest.json", p33Withdraw?.ok === true && typeof p33Withdraw?.hash === "string", "expected p33 fork withdraw transaction proof");
  requireTruthy(failures, "fork-rehearsal.latest.json", p33MintWithdrawRevoke?.ok === true, "expected p33 fork mint/withdraw approval cleanup step");
  requireZero(failures, "fork-rehearsal.latest.json", p33MintWithdrawRemainingShares?.result, "expected p33 fork mint/withdraw to leave zero p33 shares");
}

if (parsed["mixed-route-rehearsal.latest.json"]) {
  const report = parsed["mixed-route-rehearsal.latest.json"];
  const mixedPhase = report.phases?.find((phase) => phase.name === "mixed_route_exact_in");
  const mixedSteps = mixedPhase?.steps ?? [];
  const nativeInputPlan = mixedSteps.find((step) => step.label === "mixed native-input UniversalRouter command plan");
  const nativeOutputPlan = mixedSteps.find((step) => step.label === "mixed native-output UniversalRouter command plan");
  const nativeInputTx = mixedSteps.find((step) => step.label === "UniversalRouter mixed native-input exact-in AVAX->USDC");
  const nativeOutputTx = mixedSteps.find((step) => step.label === "UniversalRouter mixed native-output exact-in USDC->AVAX");
  const routerDustAfterNativeOutput = mixedSteps.find((step) => step.label === "UniversalRouter dust after native-output mixed route");
  requireTruthy(failures, "mixed-route-rehearsal.latest.json", report.ok === true, "expected top-level ok=true");
  requireTruthy(failures, "mixed-route-rehearsal.latest.json", Number(report.summary?.passed ?? 0) >= 1, "expected at least one passed phase");
  requireZero(failures, "mixed-route-rehearsal.latest.json", report.summary?.failed, "expected zero failed phases");
  requireTruthy(failures, "mixed-route-rehearsal.latest.json", nativeInputPlan?.result?.commands === "0x0b0008", "expected native-input mixed route command plan 0x0b0008");
  requireTruthy(failures, "mixed-route-rehearsal.latest.json", nativeOutputPlan?.result?.commands === "0x08000c", "expected native-output mixed route command plan 0x08000c");
  requireTruthy(failures, "mixed-route-rehearsal.latest.json", nativeInputTx?.ok === true && typeof nativeInputTx.hash === "string", "expected native-input mixed route fork transaction hash");
  requireTruthy(failures, "mixed-route-rehearsal.latest.json", nativeOutputTx?.ok === true && typeof nativeOutputTx.hash === "string", "expected native-output mixed route fork transaction hash");
  for (const token of ["WAVAX", "PHAR", "USDC"]) {
    requireZero(failures, "mixed-route-rehearsal.latest.json", routerDustAfterNativeOutput?.result?.[token]?.raw, `expected zero UniversalRouter ${token} dust after native mixed routes`);
  }
}

if (parsed["reward-claim-rehearsal.latest.json"]) {
  const report = parsed["reward-claim-rehearsal.latest.json"];
  requireTruthy(failures, "reward-claim-rehearsal.latest.json", report.ok === true, "expected top-level ok=true");
  requireTruthy(failures, "reward-claim-rehearsal.latest.json", report.forkBlockMatchesFixture === true, "expected forkStartBlock to match fixtureLatestBlock");
  requireTruthy(failures, "reward-claim-rehearsal.latest.json", Number(report.summary?.executed ?? 0) > 0, "expected at least one executed claim case");
  requireZero(failures, "reward-claim-rehearsal.latest.json", report.summary?.failed, "expected zero failed claim cases");
  if (parsed["reward-fixtures.latest.json"]?.latestBlock !== undefined) {
    requireTruthy(
      failures,
      "reward-claim-rehearsal.latest.json",
      String(report.fixtureLatestBlock) === String(parsed["reward-fixtures.latest.json"].latestBlock),
      "expected reward-claim fixtureLatestBlock to match current reward-fixtures latestBlock"
    );
  }
}

if (parsed["reward-fixtures.latest.json"]) {
  const fixtures = parsed["reward-fixtures.latest.json"];
  const clGaugeSummary = fixtures.summary?.clGauge ?? {};
  const clGaugeDomain = fixtures.domains?.clGauge ?? {};
  const clGaugeStaleEvidence = fixtures.clGaugeStaleNftErrorEvidence ?? [];
  const clGaugeStaleEvidenceBySignature = new Map(clGaugeStaleEvidence.map((item) => [item.signature, item]));
  const staleClGaugeAssessments = (clGaugeDomain.assessments ?? []).filter((item) => item.staleCandidate === true);
  const dlmmSummary = fixtures.summary?.dlmmRewarder ?? {};
  const dlmmDomain = fixtures.domains?.dlmmRewarder ?? {};
  const dlmmScanStatus = dlmmSummary.scanStatus ?? dlmmDomain.scanStatus?.status;
  const dlmmScanHadErrors = dlmmSummary.scanHadErrors === true || dlmmDomain.scanStatus?.scanHadErrors === true || dlmmScanStatus === "incomplete_scan_error";
  const dlmmClaimableCandidates = Number(dlmmSummary.claimableCandidates ?? 0);
  const dlmmRehearsal = parsed["reward-claim-rehearsal.latest.json"]?.results?.find((item) => item.domain === "dlmmRewarder");

  requireTruthy(
    failures,
    "reward-fixtures.latest.json",
    !dlmmScanHadErrors,
    "expected DLMM rewarder fixture scan to be clean; scan-error zero-candidate reports are not absence evidence"
  );
  requireTruthy(
    failures,
    "reward-fixtures.latest.json",
    clGaugeStaleEvidenceBySignature.get("ERC721NonexistentToken(uint256)")?.selector === "0x7e273289",
    "expected CL stale-NFT ownerOf selector evidence for ERC721NonexistentToken(uint256)"
  );
  requireTruthy(
    failures,
    "reward-fixtures.latest.json",
    clGaugeStaleEvidenceBySignature.get("InvalidTokenId(uint256)")?.selector === "0xed15e6cf",
    "expected CL stale-NFT earned selector evidence for InvalidTokenId(uint256)"
  );
  requireTruthy(
    failures,
    "reward-fixtures.latest.json",
    !JSON.stringify(clGaugeDomain).includes("reverted with the following signature"),
    "expected CL gauge fixture errors to decode or skip instead of preserving raw selector-only messages"
  );
  for (const item of staleClGaugeAssessments) {
    requireTruthy(failures, "reward-fixtures.latest.json", item.ownerStatus === "stale_nonexistent_token", "expected stale CL gauge NFT owner status");
    requireTruthy(failures, "reward-fixtures.latest.json", item.currentOwner === null, "expected stale CL gauge NFT not to reuse historical recipient as currentOwner");
    requireTruthy(failures, "reward-fixtures.latest.json", item.ownerOf?.decodedError?.name === "ERC721NonexistentToken", "expected stale CL gauge ownerOf decoded ERC721NonexistentToken");
    requireTruthy(
      failures,
      "reward-fixtures.latest.json",
      (item.earned ?? []).every((entry) => entry.amount?.skipped === true && entry.amount?.decodedErrorEvidence?.selector === "0xed15e6cf"),
      "expected stale CL gauge earned probes to be skipped with InvalidTokenId evidence"
    );
  }

  if (dlmmClaimableCandidates > 0) {
    requireTruthy(
      failures,
      "reward-claim-rehearsal.latest.json",
      dlmmRehearsal?.ok === true,
      "expected current claimable DLMM rewarder fixture to execute successfully in reward-claim rehearsal"
    );
  } else if (dlmmScanStatus === "complete_no_candidates") {
    requireTruthy(
      failures,
      "dlmm-rewarder-pinned-evidence.json",
      pinnedDlmm?.ok === true &&
        pinnedDlmm?.rehearsal?.forkBlockMatchesFixture === true &&
        pinnedDlmm?.rehearsal?.dlmmResult?.ok === true &&
        Number(pinnedDlmm?.fixture?.summary?.claimableCandidates ?? 0) > 0,
      "expected pinned DLMM rewarder execution evidence when latest rolling fixture has no clean current candidates"
    );
  }

  if (Number(clGaugeSummary.claimableCandidates ?? 0) === 0) {
    requireTruthy(
      failures,
      "cl-gauge-reward-pinned-evidence.json",
      pinnedClGauge?.ok === true &&
        pinnedClGauge?.rehearsal?.forkBlockMatchesFixture === true &&
        Number(pinnedClGauge?.fixture?.summary?.claimableCandidates ?? 0) > 0 &&
        Array.isArray(pinnedClGauge?.rehearsal?.clResults) &&
        pinnedClGauge.rehearsal.clResults.every((item) => item.ok === true),
      "expected pinned CL gauge reward execution evidence when latest rolling fixture has no current claimable CL gauge candidate"
    );
  }
}

if (parsed["pool-creation-rehearsal.latest.json"]) {
  const report = parsed["pool-creation-rehearsal.latest.json"];
  const dlmmBlockedCases = (report.results ?? []).filter((item) => item?.domain === "dlmm" && item?.status === "blocked");
  requireTruthy(failures, "pool-creation-rehearsal.latest.json", report.ok === true, "expected top-level ok=true");
  requireTimestamp(failures, "pool-creation-rehearsal.latest.json", report.timestamp, "expected timestamp");
  requireTruthy(failures, "pool-creation-rehearsal.latest.json", Number(report.chainId) === 43114, "expected chainId 43114");
  requireTruthy(failures, "pool-creation-rehearsal.latest.json", typeof report.forkStartBlock === "string", "expected forkStartBlock");
  requireTruthy(failures, "pool-creation-rehearsal.latest.json", typeof report.blockNumber === "string", "expected blockNumber");
  requireTruthy(failures, "pool-creation-rehearsal.latest.json", BigInt(report.blockNumber) >= BigInt(report.forkStartBlock), "expected blockNumber >= forkStartBlock");
  requireZero(failures, "pool-creation-rehearsal.latest.json", report.summary?.failed, "expected zero failed pool-creation cases");
  if (dlmmBlockedCases.length > 0) {
    requireTruthy(failures, "pool-creation-rehearsal.latest.json", report.dlmmPoolCreationErrorEvidence?.signature === "LBFactory__PresetIsLockedForUsers(address,uint256)", "expected DLMM pool-creation custom-error signature evidence");
    requireTruthy(failures, "pool-creation-rehearsal.latest.json", report.dlmmPoolCreationErrorEvidence?.selector === "0x09f85fce", "expected DLMM pool-creation custom-error selector evidence");
    for (const item of dlmmBlockedCases) {
      requireTruthy(failures, "pool-creation-rehearsal.latest.json", item.selector === "0x09f85fce", `expected ${item.label} selector to preserve closed-preset error`);
      requireTruthy(failures, "pool-creation-rehearsal.latest.json", item.decodedError?.name === "LBFactory__PresetIsLockedForUsers", `expected ${item.label} decoded LBFactory closed-preset error`);
      requireTruthy(failures, "pool-creation-rehearsal.latest.json", item.decodedError?.signature === "LBFactory__PresetIsLockedForUsers(address,uint256)", `expected ${item.label} decoded closed-preset signature`);
      requireTruthy(failures, "pool-creation-rehearsal.latest.json", item.decodedError?.selector === "0x09f85fce", `expected ${item.label} decoded selector parity`);
      requireTruthy(failures, "pool-creation-rehearsal.latest.json", Array.isArray(item.decodedError?.args) && item.decodedError.args.at(-1) === "5", `expected ${item.label} decoded binStep 5`);
    }
  }
}

if (parsed["mcp-smoke.latest.json"]) {
  const report = parsed["mcp-smoke.latest.json"];
  requireTruthy(failures, "mcp-smoke.latest.json", report.ok === true, "expected top-level ok=true");
  requireTruthy(failures, "mcp-smoke.latest.json", report.schemaVersion === 1, "expected schemaVersion=1");
  requireTruthy(failures, "mcp-smoke.latest.json", typeof report.timestamp === "string", "expected timestamp");
  requireTruthy(failures, "mcp-smoke.latest.json", Number(report.toolCount ?? 0) >= 37, "expected at least 37 MCP tools");
  requireTruthy(failures, "mcp-smoke.latest.json", Number(report.checkCount ?? 0) === (report.results?.length ?? -1), "expected checkCount to match results length");
  requireTruthy(failures, "mcp-smoke.latest.json", Number(report.checkCount ?? 0) >= 167, "expected expanded high-level builder and approval smoke coverage");
  requireTruthy(failures, "mcp-smoke.latest.json", Array.isArray(report.results) && report.results.length > 1, "expected non-empty smoke results");
  requireTruthy(failures, "mcp-smoke.latest.json", report.results?.every((item) => item.ok === true), "expected all smoke results ok=true");
  requireSetIncludes(
    failures,
    "mcp-smoke.latest.json",
    report.results?.map((item) => item.name),
    ["pharaoh_contracts_get", "pharaoh_acceptance_status_read"],
    "expected smoke coverage for registry/provenance and acceptance status entrypoints"
  );
  const acceptanceSmoke = report.results?.find((item) => item.name === "pharaoh_acceptance_status_read");
	  requireTruthy(failures, "mcp-smoke.latest.json", acceptanceSmoke?.ok === true, "expected smoke coverage for coverage-aware acceptance status MCP tool");
	  requireTruthy(failures, "mcp-smoke.latest.json", acceptanceSmoke?.responseSummary?.p33Complete === true, "expected acceptance status smoke summary to preserve p33Complete");
	  requireTruthy(failures, "mcp-smoke.latest.json", acceptanceSmoke?.responseSummary?.recommendedNextAction === "wait_refresh_gates", "expected acceptance status smoke summary to preserve coverage-aware recommendation");
	  requireTruthy(failures, "mcp-smoke.latest.json", typeof acceptanceSmoke?.responseSummary?.currentStateRecommendedNextAction === "string" && acceptanceSmoke.responseSummary.currentStateRecommendedNextAction.length > 0, "expected acceptance status smoke summary to preserve raw current-state recommendation");
	  requireSetIncludes(
	    failures,
	    "mcp-smoke.latest.json",
	    acceptanceSmoke?.responseSummary?.finalOutputSummary?.coverageDomains,
	    ["userFlows", "contractsAndProvenance", "forkSimulation", "liveWalletValidation", "rewards"],
	    "expected acceptance status smoke summary to expose final-output coverage domains"
	  );
	  requireStringSetEqual(
	    failures,
	    "mcp-smoke.latest.json",
	    acceptanceSmoke?.responseSummary?.finalOutputSummary?.requiredUserFlowKeys,
	    requiredGoalUserFlowKeys,
	    "expected MCP acceptance status summary to expose every required goal user flow key"
	  );
	  requireSetIncludes(
	    failures,
	    "mcp-smoke.latest.json",
	    acceptanceSmoke?.responseSummary?.finalOutputSummary?.userFlowKeys,
	    requiredGoalUserFlowKeys,
	    "expected MCP acceptance status summary to expose user-flow coverage rows"
	  );
  requireTruthy(
    failures,
    "mcp-smoke.latest.json",
    /recommendation=true/.test(acceptanceSmoke?.detail ?? "") && /finalOutput=true/.test(acceptanceSmoke?.detail ?? ""),
    "expected acceptance status smoke to verify coverage-aware recommendation and final-output summary"
  );
  if (parsed["acceptance-audit.latest.json"]) {
    const acceptance = parsed["acceptance-audit.latest.json"];
    const acceptanceState = acceptanceCurrentState(acceptance);
    const smokeSummary = acceptanceSmoke?.responseSummary ?? {};
    const smokeTimestampMs = timestampMs(report.timestamp);
    const acceptanceTimestampMs = timestampMs(acceptance.timestamp);
    requireTruthy(failures, "mcp-smoke.latest.json", smokeTimestampMs !== null && acceptanceTimestampMs !== null && smokeTimestampMs >= acceptanceTimestampMs, "expected MCP smoke report to be generated after the current acceptance report");
    requireTruthy(failures, "mcp-smoke.latest.json", report.smokedAcceptanceTimestamp === smokeSummary.timestamp, "expected top-level smokedAcceptanceTimestamp to match acceptance status smoke summary");
    requireTruthy(failures, "mcp-smoke.latest.json", smokeSummary.timestamp === acceptance.timestamp, "expected MCP acceptance status smoke summary timestamp to match the current acceptance report");
    requireTruthy(failures, "mcp-smoke.latest.json", smokeSummary.goalComplete === acceptance.goalComplete, "expected MCP acceptance status goalComplete to match acceptance report");
    requireTruthy(failures, "mcp-smoke.latest.json", smokeSummary.overallStatus === acceptance.overallStatus, "expected MCP acceptance status overallStatus to match acceptance report");
    requireTruthy(failures, "mcp-smoke.latest.json", smokeSummary.p33Complete === acceptance.coverageContext?.p33Complete, "expected MCP acceptance status p33Complete to match acceptance report");
    requireTruthy(failures, "mcp-smoke.latest.json", smokeSummary.recommendedNextAction === acceptanceState.recommendedNextAction, "expected MCP acceptance status recommendation to match acceptance report");
    requireTruthy(failures, "mcp-smoke.latest.json", smokeSummary.currentStateRecommendedNextAction === acceptanceState.currentStateRecommendedNextAction, "expected MCP acceptance status raw recommendation to match acceptance report");
    requireStringSetEqual(failures, "mcp-smoke.latest.json", smokeSummary.remainingBlockerKeys, (acceptance.remainingBlockers ?? []).map((item) => item.key), "expected MCP acceptance status blocker keys to match acceptance report");
    requireStringSetEqual(failures, "mcp-smoke.latest.json", smokeSummary.completionBlockingKeys, (acceptance.completionBlockingItems ?? []).map((item) => item.key), "expected MCP acceptance status completion blocker keys to match acceptance report");
    requireTruthy(failures, "mcp-smoke.latest.json", Number(smokeSummary.finalOutputSummary?.liveTransactionCount ?? -1) === Number(acceptance.finalOutput?.liveTransactionHashes?.length ?? -2), "expected MCP acceptance status live tx count to match acceptance report");
    requireTruthy(failures, "mcp-smoke.latest.json", Number(smokeSummary.finalOutputSummary?.forkTransactionCount ?? -1) === Number(acceptance.finalOutput?.forkSimulationSummary?.transactions?.length ?? -2), "expected MCP acceptance status fork tx count to match acceptance report");
    requireTruthy(failures, "mcp-smoke.latest.json", Number(smokeSummary.finalOutputSummary?.verificationCommandCount ?? -1) === Number(acceptance.finalOutput?.verificationCommandsAndResults?.length ?? -2), "expected MCP acceptance status verification command count to match acceptance report");
    requireTruthy(failures, "mcp-smoke.latest.json", Number(smokeSummary.finalOutputSummary?.verificationCommandsCount ?? -1) === Number(acceptance.finalOutput?.verificationCommands?.length ?? -2), "expected MCP acceptance status verification command list count to match acceptance report");
	    requireTruthy(failures, "mcp-smoke.latest.json", Number(smokeSummary.finalOutputSummary?.filesChangedCount ?? -1) === Number(acceptance.finalOutput?.filesChanged?.paths?.length ?? -2), "expected MCP acceptance status files changed count to match acceptance report");
	    requireTruthy(failures, "mcp-smoke.latest.json", smokeSummary.finalOutputSummary?.approvalsCleared === acceptance.finalOutput?.currentWalletBalancesAndApprovals?.approvalsCleared, "expected MCP acceptance status approval cleanup to match acceptance report");
	    requireTruthy(failures, "mcp-smoke.latest.json", smokeSummary.finalOutputSummary?.fundingTopUpRequired === acceptance.finalOutput?.fundingTopUpRequest?.required, "expected MCP acceptance status funding top-up requirement to match acceptance report");
	    requireTruthy(failures, "mcp-smoke.latest.json", smokeSummary.finalOutputSummary?.fundingTopUpStatus === acceptance.finalOutput?.fundingTopUpRequest?.status, "expected MCP acceptance status funding top-up status to match acceptance report");
	    requireStringSetEqual(failures, "mcp-smoke.latest.json", smokeSummary.finalOutputSummary?.userFlowKeys, (acceptance.finalOutput?.userFlowCoverageMatrix?.flows ?? []).map((flow) => flow.flowKey), "expected MCP user-flow keys to match acceptance report");
	  }
  requireTruthy(
    failures,
    "mcp-smoke.latest.json",
    report.results?.some((item) => item.name === "pharaoh_wallet_positions_read" && item.variant === "includeRewards" && item.ok === true) === true,
    "expected smoke coverage for wallet positions with includeRewards=true"
  );
  requireSetIncludes(
    failures,
    "mcp-smoke.latest.json",
    report.results?.filter((item) => item.name === "pharaoh_encode_approval").map((item) => `${item.standard}:${item.functionName}`),
    [
      "erc20:approve",
      "erc721:approve",
      "erc721:setApprovalForAll",
      "erc1155:setApprovalForAll",
      "dlmmPool:approveForAll"
    ],
    "expected smoke coverage for ERC20, ERC721, ERC1155, and DLMM approval encoders"
  );
  requireSetIncludes(
    failures,
    "mcp-smoke.latest.json",
    report.results?.filter((item) => item.name === "pharaoh_vote_build_tx").map((item) => item.action),
    [
      "deposit",
      "depositAll",
      "withdraw",
      "withdrawAll",
      "delegate",
      "vote",
      "reset",
      "poke",
      "claimRewards",
      "claimIncentives",
      "claimLegacyIncentives",
      "claimClGaugeRewards",
      "claimClGaugeRewardsWithNfpManagers",
      "distribute",
      "distributeAll",
      "distributeForPeriod"
    ],
    "expected smoke coverage for vote staking, voting, manual claims, and distribution builders"
  );
  requireSetIncludes(
    failures,
    "mcp-smoke.latest.json",
    report.results?.filter((item) => item.name === "pharaoh_xphar_build_tx").map((item) => item.action),
    ["convert", "exit", "rebase", "approve"],
    "expected smoke coverage for PHAR/xPHAR conversion and approval builders"
  );
  requireSetIncludes(
    failures,
    "mcp-smoke.latest.json",
    report.results?.filter((item) => item.name === "pharaoh_p33_build_tx").map((item) => item.action),
    ["deposit", "mint", "withdraw", "redeem", "approve"],
    "expected smoke coverage for p33 ERC4626 lifecycle builders"
  );
  requireSetIncludes(
    failures,
    "mcp-smoke.latest.json",
    report.results?.filter((item) => item.name === "pharaoh_autovault_build_tx").map((item) => item.action),
    ["deposit", "withdraw", "claim", "setOutputPreference"],
    "expected smoke coverage for AutoVault user lifecycle builders"
  );
  requireSetIncludes(
    failures,
    "mcp-smoke.latest.json",
    report.results?.filter((item) => item.name === "pharaoh_legacy_liquidity_build_tx").map((item) => item.action),
    [
      "createPair",
      "addLiquidity",
      "addLiquidityETH",
      "addLiquidityAndStake",
      "addLiquidityETHAndStake",
      "removeLiquidity",
      "removeLiquidityETH",
      "removeLiquidityETHSupportingFeeOnTransferTokens"
    ],
    "expected smoke coverage for legacy pool lifecycle builders"
  );
  requireSetIncludes(
    failures,
    "mcp-smoke.latest.json",
    report.results?.filter((item) => item.name === "pharaoh_legacy_swap_build_tx").map((item) => item.functionName),
    [
      "swapETHForExactTokens",
      "swapExactETHForTokens",
      "swapExactETHForTokensSupportingFeeOnTransferTokens",
      "swapExactTokensForETH",
      "swapExactTokensForETHSupportingFeeOnTransferTokens",
      "swapExactTokensForTokens",
      "swapExactTokensForTokensSupportingFeeOnTransferTokens",
      "swapTokensForExactETH",
      "swapTokensForExactTokens"
    ],
    "expected smoke coverage for every legacy router swap builder"
  );
  requireSetIncludes(
    failures,
    "mcp-smoke.latest.json",
    report.results?.filter((item) => item.name === "pharaoh_cl_liquidity_build_tx").map((item) => item.action),
    [
      "createPool",
      "createAndInitializePoolIfNecessary",
      "mint",
      "increaseLiquidity",
      "decreaseLiquidity",
      "collect",
      "burn",
      "getReward",
      "getPeriodReward"
    ],
    "expected smoke coverage for CL position lifecycle and reward builders"
  );
  requireSetIncludes(
    failures,
    "mcp-smoke.latest.json",
    report.results?.filter((item) => item.name === "pharaoh_cl_swap_build_tx").map((item) => item.functionName),
    [
      "exactInput((bytes,address,uint256,uint256,uint256))",
      "exactInputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))",
      "exactOutput((bytes,address,uint256,uint256,uint256))",
      "exactOutputSingle((address,address,int24,address,uint256,uint256,uint256,uint160))",
      "multicall",
      "refundETH",
      "sweepToken",
      "sweepTokenWithFee",
      "unwrapWETH9",
      "unwrapWETH9WithFee"
    ],
    "expected smoke coverage for every CL swapRouter swap and periphery builder"
  );
  requireSetIncludes(
    failures,
    "mcp-smoke.latest.json",
    report.results?.filter((item) => item.name === "pharaoh_gauge_build_tx").map((item) => item.action),
    [
      "createGauge",
      "createClGauge",
      "legacyDeposit",
      "legacyDepositAll",
      "legacyDepositFor",
      "legacyWithdraw",
      "legacyWithdrawAll",
      "legacyUnstakeAndClaimAll",
      "legacyGetReward",
      "cachePeriodEarned",
      "getPeriodReward",
      "getReward",
      "getRewardForTokenIds",
      "getRewardForOwner",
      "getRewardForPosition",
      "getRewardForOwnerFromVoter"
    ],
    "expected smoke coverage for direct legacy and CL gauge user builders"
  );
  requireSetIncludes(
    failures,
    "mcp-smoke.latest.json",
    report.results?.filter((item) => item.name === "pharaoh_dlmm_build_tx").map((item) => item.action),
    [
      "addLiquidity",
      "addLiquidityNATIVE",
      "removeLiquidity",
      "removeLiquidityNATIVE",
      "routerCreateLBPair",
      "factoryCreateLBPair",
      "swapExactNATIVEForTokens",
      "swapExactNATIVEForTokensSupportingFeeOnTransferTokens",
      "swapExactTokensForNATIVE",
      "swapExactTokensForNATIVESupportingFeeOnTransferTokens",
      "swapExactTokensForTokens",
      "swapExactTokensForTokensSupportingFeeOnTransferTokens",
      "swapNATIVEForExactTokens",
      "swapTokensForExactNATIVE",
      "swapTokensForExactTokens",
      "approveForAll",
      "batchTransferFrom",
      "poolMint",
      "poolBurn",
      "rewarderClaim"
    ],
    "expected smoke coverage for every DLMM builder action"
  );
  requireSmokedOrExcludedCoverage(failures, {
    source: workflowSource,
    constName: "voteBuildActions",
    report,
    resultName: "pharaoh_vote_build_tx",
    field: "action",
    label: "vote builder",
    excludedByCategory: {
      deprecatedAlias: ["claimClGaugeRewardsWithReceivers"]
    }
  });
  requireSmokedOrExcludedCoverage(failures, {
    source: workflowSource,
    constName: "xPharActions",
    report,
    resultName: "pharaoh_xphar_build_tx",
    field: "action",
    label: "xPHAR builder",
    excludedByCategory: {
      genericTokenTransfer: ["transfer", "transferFrom"]
    }
  });
  requireSmokedOrExcludedCoverage(failures, {
    source: workflowSource,
    constName: "p33Actions",
    report,
    resultName: "pharaoh_p33_build_tx",
    field: "action",
    label: "p33 builder",
    excludedByCategory: {
      operatorAutomation: ["compound", "submitVotes", "swapIncentiveViaAggregator", "unlock"],
      genericTokenTransfer: ["transfer", "transferFrom"]
    }
  });
  requireSmokedOrExcludedCoverage(failures, {
    source: workflowSource,
    constName: "autoVaultActions",
    report,
    resultName: "pharaoh_autovault_build_tx",
    field: "action",
    label: "AutoVault builder",
    excludedByCategory: {
      operatorAutomation: ["submitVotes", "swap", "unlock"],
      adminConfig: ["addAggregator", "removeAggregator", "addOutputToken", "removeOutputToken", "setOperator"],
      rescue: ["rescue"]
    }
  });
  requireSmokedOrExcludedCoverage(failures, {
    source: workflowSource,
    constName: "legacyLiquidityActions",
    report,
    resultName: "pharaoh_legacy_liquidity_build_tx",
    field: "action",
    label: "legacy liquidity builder",
    excludedByCategory: {}
  });
  requireSmokedOrExcludedCoverage(failures, {
    source: workflowSource,
    constName: "legacySwapFunctionNames",
    report,
    resultName: "pharaoh_legacy_swap_build_tx",
    field: "functionName",
    label: "legacy swap builder",
    excludedByCategory: {}
  });
  requireSmokedOrExcludedCoverage(failures, {
    source: workflowSource,
    constName: "clLiquidityActions",
    report,
    resultName: "pharaoh_cl_liquidity_build_tx",
    field: "action",
    label: "CL liquidity builder",
    excludedByCategory: {}
  });
  requireSmokedOrExcludedCoverage(failures, {
    source: workflowSource,
    constName: "clSwapFunctionNames",
    report,
    resultName: "pharaoh_cl_swap_build_tx",
    field: "functionName",
    label: "CL swap builder",
    excludedByCategory: {}
  });
  requireSmokedOrExcludedCoverage(failures, {
    source: workflowSource,
    constName: "gaugeActions",
    report,
    resultName: "pharaoh_gauge_build_tx",
    field: "action",
    label: "gauge builder",
    excludedByCategory: {
      adminReward: ["legacyNotifyRewardAmount", "addRewards"],
      implementationAdmin: ["initialize", "notifyRewardAmount", "notifyRewardAmountForPeriod", "notifyRewardAmountNextPeriod", "removeRewards", "syncCache"]
    }
  });
  requireSmokedOrExcludedCoverage(failures, {
    source: workflowSource,
    constName: "dlmmActions",
    report,
    resultName: "pharaoh_dlmm_build_tx",
    field: "action",
    label: "DLMM builder",
    excludedByCategory: {}
  });
}

if (parsed["abi-diff.latest.json"]) {
  const report = parsed["abi-diff.latest.json"];
  requireTruthy(failures, "abi-diff.latest.json", report.ok === true, "expected top-level ok=true");
  requireZero(failures, "abi-diff.latest.json", report.mismatches?.length, "expected zero ABI mismatches");
  requireTruthy(failures, "abi-diff.latest.json", typeof report.timestamp === "string", "expected timestamp");
  requireTruthy(failures, "abi-diff.latest.json", Number(report.exactMatches ?? 0) >= 22, "expected at least 22 exact ABI matches including WAVAX");
  const wavaxResult = report.results?.find((result) => result.key === "wavax");
  requireTruthy(failures, "abi-diff.latest.json", wavaxResult?.ok === true, "expected WAVAX exact ABI diff to pass");
  requireTruthy(failures, "abi-diff.latest.json", Number(wavaxResult?.localCount ?? 0) === 11, "expected local WAVAX function count 11");
  requireTruthy(failures, "abi-diff.latest.json", Number(wavaxResult?.remoteCount ?? 0) === 11, "expected remote WAVAX function count 11");
}

if (parsed["live-receipt-provenance.latest.json"]) {
  const report = parsed["live-receipt-provenance.latest.json"];
  const expectedWallet = "0xe60cea39210ab9807cd01fc2a226a840846e08fa";
  const expectedLiveReceiptSources = liveReceiptSourcesForParsed(parsed);
  const expectedTxs = allLiveReportHashes(parsed);
  const expectedTxSet = expectedTxs.map((tx) => ({
    source: tx.source,
    sourcePath: tx.sourcePath,
    phase: tx.phase,
    label: tx.label,
    hash: tx.hash,
    reportedGasUsed: tx.reportedGasUsed
  }));
  const actualTxSet = (report.transactions ?? []).map((tx) => ({
    source: tx.source,
    sourcePath: tx.sourcePath,
    phase: tx.phase,
    label: tx.label,
    hash: tx.hash,
    reportedGasUsed: tx.reportedGasUsed
  }));
  requireTruthy(failures, "live-receipt-provenance.latest.json", report.ok === true, "expected top-level ok=true");
  requireTimestamp(failures, "live-receipt-provenance.latest.json", report.timestamp, "expected timestamp");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.chainId) === 43114, "expected chainId 43114");
  requireTruthy(failures, "live-receipt-provenance.latest.json", typeof report.rpcUrl === "string" && report.rpcUrl.length > 0, "expected rpcUrl");
  requireTruthy(failures, "live-receipt-provenance.latest.json", report.wallet?.toLowerCase?.() === expectedWallet, "expected expendable wallet address");
  requireStringSetEqual(failures, "live-receipt-provenance.latest.json", Object.keys(report.summary?.sourceSummaries ?? {}), expectedLiveReceiptSources, "expected exact live receipt source set");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.summary?.txCount ?? 0) === expectedTxs.length, "expected live receipt tx count to match live reports");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.summary?.txCount ?? 0) >= 35, "expected at least 35 current historical live tx hashes");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.summary?.uniqueHashCount ?? 0) === Number(report.summary?.txCount ?? -1), "expected all historical live tx hashes unique");
  requireZero(failures, "live-receipt-provenance.latest.json", report.summary?.failureCount, "expected zero live receipt failures");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.summary?.logsCount ?? 0) > 0, "expected live receipt event-log evidence");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.summary?.eventLogCountMatchCount ?? 0) === Number(report.summary?.txCount ?? -1), "expected event log-count parity for every live tx");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.summary?.calldataCount ?? 0) === Number(report.summary?.txCount ?? -1), "expected calldata evidence for every live tx");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.summary?.knownSelectorCount ?? 0) === Number(report.summary?.txCount ?? -1), "expected known function selector evidence for every live tx");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.summary?.knownTargetCount ?? 0) === Number(report.summary?.txCount ?? -1), "expected known target contract evidence for every live tx");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.summary?.contractMatchedFunctionCount ?? 0) === Number(report.summary?.txCount ?? -1), "expected contract-matched function evidence for every live tx");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.summary?.decodedFunctionCount ?? 0) === Number(report.summary?.txCount ?? -1), "expected decoded function calldata for every live tx");
  requireZero(failures, "live-receipt-provenance.latest.json", report.summary?.unknownSelectorCount, "expected zero unknown live calldata selectors");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.summary?.knownLogCount ?? 0) >= 213, "expected high-confidence live event decoding coverage");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.summary?.unknownLogCount ?? 0) <= 1, "expected at most the VoteModule delegate candidate to remain undecoded");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.summary?.knownEventCounts?.Transfer ?? 0) > 0, "expected live Transfer event evidence");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(report.summary?.knownEventCounts?.Approval ?? 0) > 0, "expected live Approval event evidence");
  requireSetIncludes(
    failures,
    "live-receipt-provenance.latest.json",
    Object.keys(report.summary?.knownEventCounts ?? {}),
    [
      "VoterVoted",
      "LegacyPairSync",
      "RamsesV3PoolSwap",
      "DLMMPoolSwap",
      "XPharInstantExit",
      ...(Number(report.summary?.sourceSummaries?.["reports/p33-live.latest.json"]?.txCount ?? 0) > 0 ||
        Number(report.summary?.sourceSummaries?.["reports/p33-mint-withdraw-live.latest.json"]?.txCount ?? 0) > 0 ? ["P33Deposit", "P33Withdraw"] : [])
    ],
    "expected decoded live protocol event evidence beyond ERC20 basics"
  );
  requireSetIncludes(
    failures,
    "live-receipt-provenance.latest.json",
    Object.keys(report.summary?.knownFunctionCounts ?? {}),
    [
      "erc20.approve",
      "router.swapExactTokensForTokens",
      "xPharToken.convertEmissionsToken",
      "autoVault.deposit",
      "autoVault.withdraw",
      "router.addLiquidityETH",
      "router.removeLiquidityETH",
      "ramsesV3PositionManager.mint",
      "ramsesV3PositionManager.decreaseLiquidity",
      "ramsesV3PositionManager.collect",
      "ramsesV3PositionManager.burn",
      "dlmmRouter.swapExactNATIVEForTokens",
      "dlmmRouter.addLiquidity",
      "dlmmRouter.addLiquidityNATIVE",
      "dlmmPool.approveForAll",
      "dlmmRouter.removeLiquidity",
      "dlmmRouter.removeLiquidityNATIVE",
      "universalRouter.executeDeadline",
      "voteModule.deposit",
      "voteModule.delegate",
      "voter.vote",
      "voter.reset",
      "voteModule.withdraw",
      "xPharToken.exit",
      ...(Number(report.summary?.sourceSummaries?.["reports/p33-live.latest.json"]?.txCount ?? 0) > 0 ? ["p33.deposit", "p33.redeem"] : []),
      ...(Number(report.summary?.sourceSummaries?.["reports/p33-mint-withdraw-live.latest.json"]?.txCount ?? 0) > 0 ? ["p33.mint", "p33.withdraw"] : [])
    ],
    "expected live calldata function coverage across current historical wallet flows"
  );
  const dlmmMultibinSummary = report.summary?.sourceSummaries?.["reports/dlmm-multibin-live.latest.json"] ?? {};
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(dlmmMultibinSummary.txCount ?? 0) === 3, "expected DLMM multibin manual live source to contain three txs");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(dlmmMultibinSummary.knownFunctionCounts?.["erc20.approve"] ?? 0) === 2, "expected DLMM multibin manual source to prove both ERC20 approvals");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(dlmmMultibinSummary.knownFunctionCounts?.["dlmmRouter.addLiquidity"] ?? 0) === 1, "expected DLMM multibin manual source to prove non-native addLiquidity");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(dlmmMultibinSummary.knownEventCounts?.DLMMDepositedToBins ?? 0) > 0, "expected DLMM multibin manual source to prove DepositedToBins event");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(dlmmMultibinSummary.knownEventCounts?.TransferBatch ?? 0) > 0, "expected DLMM multibin manual source to prove ERC1155 TransferBatch event");
  const dlmmCloseSummary = report.summary?.sourceSummaries?.["reports/dlmm-close-live.latest.json"] ?? {};
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(dlmmCloseSummary.txCount ?? 0) === 5, "expected DLMM close manual live source to contain five txs");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(dlmmCloseSummary.knownFunctionCounts?.["dlmmPool.approveForAll"] ?? 0) === 2, "expected DLMM close manual source to prove pool approval grant and revoke");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(dlmmCloseSummary.knownFunctionCounts?.["dlmmRouter.removeLiquidity"] ?? 0) === 1, "expected DLMM close manual source to prove non-native removeLiquidity");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(dlmmCloseSummary.knownFunctionCounts?.["erc20.approve"] ?? 0) === 2, "expected DLMM close manual source to prove both ERC20 allowance revokes");
  requireTruthy(failures, "live-receipt-provenance.latest.json", Number(dlmmCloseSummary.knownEventCounts?.DLMMWithdrawnFromBins ?? 0) > 0, "expected DLMM close manual source to prove WithdrawnFromBins event");
  requireArraySetEqual(failures, "live-receipt-provenance.latest.json", actualTxSet, expectedTxSet, "expected receipt transactions to match live report hashes");
  for (const source of expectedLiveReceiptSources) {
    const sourceReport = parsed[sourceFile(source)] ?? {};
    const sourceSummary = report.summary?.sourceSummaries?.[source] ?? {};
    const sourceTransactions = (report.transactions ?? []).filter((tx) => tx.source === source);
    const optionalMissing = optionalLiveReceiptSources.includes(source) &&
      !Object.hasOwn(parsed, sourceFile(source)) &&
      Number(sourceSummary.txCount ?? 0) === 0;
    if (optionalMissing) {
      requireZero(failures, "live-receipt-provenance.latest.json", sourceSummary.failedCount, `expected absent optional ${source} zero receipt failures`);
      requireZero(failures, "live-receipt-provenance.latest.json", sourceTransactions.length, `expected absent optional ${source} zero transactions`);
      continue;
    }
    requireTruthy(failures, "live-receipt-provenance.latest.json", sourceReport.mode === "live", `expected ${source} mode=live`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", sourceReport.wallet?.toLowerCase?.() === expectedWallet, `expected ${source} wallet to match expendable wallet`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", Number(sourceSummary.txCount ?? 0) === liveHashesFromReport(sourceFile(source), sourceReport).length, `expected ${source} receipt count parity`);
    requireTruthy(
      failures,
      "live-receipt-provenance.latest.json",
      Number(sourceSummary.logsCount ?? -1) === sourceTransactions.reduce((sum, tx) => sum + Number(tx.events?.logsCount ?? 0), 0),
      `expected ${source} event log count parity`
    );
    requireTruthy(failures, "live-receipt-provenance.latest.json", Number(sourceSummary.calldataCount ?? 0) === sourceTransactions.length, `expected ${source} calldata count parity`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", Number(sourceSummary.knownSelectorCount ?? 0) === sourceTransactions.length, `expected ${source} known selector count parity`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", Number(sourceSummary.knownTargetCount ?? 0) === sourceTransactions.length, `expected ${source} known target count parity`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", Number(sourceSummary.contractMatchedFunctionCount ?? 0) === sourceTransactions.length, `expected ${source} contract-matched function count parity`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", Number(sourceSummary.decodedFunctionCount ?? 0) === sourceTransactions.length, `expected ${source} decoded function count parity`);
    requireZero(failures, "live-receipt-provenance.latest.json", sourceSummary.failedCount, `expected ${source} zero receipt failures`);
  }
  for (const tx of report.transactions ?? []) {
    requireTruthy(failures, "live-receipt-provenance.latest.json", /^0x[0-9a-fA-F]{64}$/.test(tx.hash), `expected valid tx hash for ${tx.sourcePath}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.ok === true, `expected receipt tx ok for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.receipt?.status === "success", `expected receipt success for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.transaction?.from?.toLowerCase?.() === expectedWallet, `expected transaction sender wallet for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.receipt?.from?.toLowerCase?.() === expectedWallet, `expected receipt sender wallet for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.receipt?.transactionHash?.toLowerCase?.() === tx.hash.toLowerCase(), `expected receipt hash match for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.transaction?.blockHash === tx.receipt?.blockHash, `expected block hash match for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", String(tx.transaction?.blockNumber) === String(tx.receipt?.blockNumber), `expected block number match for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", BigInt(tx.receipt?.gasUsed ?? 0) > 0n, `expected positive receipt gasUsed for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.checks?.gasUsedMatches === true, `expected gas-used parity for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.checks?.eventLogCountMatches === true, `expected event log-count parity for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.checks?.calldataPresent === true, `expected calldata presence for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.checks?.calldataSelectorKnown === true, `expected known calldata selector for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.checks?.calldataTargetKnown === true, `expected known calldata target for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.checks?.calldataContractMatched === true, `expected contract-matched calldata selector for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.checks?.calldataFunctionDecoded === true, `expected decoded calldata function for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", typeof tx.call?.input === "string" && /^0x[0-9a-fA-F]+$/.test(tx.call.input), `expected raw calldata for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", isSha256(tx.call?.inputSha256), `expected calldata SHA-256 for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", /^0x[0-9a-fA-F]{8}$/.test(tx.call?.selector ?? ""), `expected calldata selector for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.call?.selector === tx.transaction?.selector, `expected transaction/call selector parity for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", Number(tx.call?.inputBytes ?? -1) === Number(tx.transaction?.inputBytes ?? -2), `expected transaction/call input byte parity for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.call?.inputSha256 === tx.transaction?.inputSha256, `expected transaction/call calldata hash parity for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", typeof tx.call?.selectedFunctionKey === "string", `expected selected function key for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.call?.decodedFunction?.ok === true, `expected decoded function ok for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", tx.call?.decodedFunction?.selector === tx.call?.selector, `expected decoded selector parity for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", Number(tx.events?.logsCount ?? -1) === Number(tx.receipt?.logsCount ?? -2), `expected receipt event count parity for ${tx.hash}`);
    requireTruthy(failures, "live-receipt-provenance.latest.json", Array.isArray(tx.events?.logs) && tx.events.logs.length === Number(tx.receipt?.logsCount ?? -1), `expected event log details for ${tx.hash}`);
    requireTruthy(
      failures,
      "live-receipt-provenance.latest.json",
      (tx.events?.logs ?? []).every((log) => typeof log.address === "string" && (log.topic0 === null || /^0x[0-9a-fA-F]{64}$/.test(log.topic0))),
      `expected event log address/topic evidence for ${tx.hash}`
    );
  }
}

if (parsed["live-trace-provenance.latest.json"]) {
  const report = parsed["live-trace-provenance.latest.json"];
  const liveReceipts = parsed["live-receipt-provenance.latest.json"] ?? {};
  const expectedTraceFunctionKeys = [
    "erc20.approve",
    "router.swapExactTokensForTokens",
    "xPharToken.convertEmissionsToken",
    ...(Number(liveReceipts.summary?.knownFunctionCounts?.["p33.deposit"] ?? 0) > 0 ? ["p33.deposit"] : []),
    ...(Number(liveReceipts.summary?.knownFunctionCounts?.["p33.mint"] ?? 0) > 0 ? ["p33.mint"] : []),
    ...(Number(liveReceipts.summary?.knownFunctionCounts?.["p33.redeem"] ?? 0) > 0 ? ["p33.redeem"] : []),
    ...(Number(liveReceipts.summary?.knownFunctionCounts?.["p33.withdraw"] ?? 0) > 0 ? ["p33.withdraw"] : []),
    "autoVault.deposit",
    "ramsesV3PositionManager.mint",
    "dlmmRouter.addLiquidityNATIVE",
    "universalRouter.executeDeadline",
    "voter.vote",
    "xPharToken.exit"
  ];
  requireTruthy(failures, "live-trace-provenance.latest.json", report.ok === true, "expected top-level ok=true");
  requireTimestamp(failures, "live-trace-provenance.latest.json", report.timestamp, "expected timestamp");
  requireTruthy(failures, "live-trace-provenance.latest.json", Number(report.chainId) === 43114, "expected chainId 43114");
  requireTruthy(failures, "live-trace-provenance.latest.json", typeof report.rpcUrl === "string" && report.rpcUrl.length > 0, "expected rpcUrl");
  requireTruthy(failures, "live-trace-provenance.latest.json", report.wallet?.toLowerCase?.() === "0xe60cea39210ab9807cd01fc2a226a840846e08fa", "expected expendable wallet address");
  requireTimestampMatch(
    failures,
    "live-trace-provenance.latest.json",
    report.liveReceiptTimestamp,
    liveReceipts.timestamp,
    "expected live trace report to point at current live receipt report"
  );
  requireTruthy(failures, "live-trace-provenance.latest.json", Number(report.summary?.sampleCount ?? 0) >= 8, "expected representative historical trace sample set");
  requireSetIncludes(
    failures,
    "live-trace-provenance.latest.json",
    report.summary?.sampledFunctionKeys ?? [],
    expectedTraceFunctionKeys,
    "expected representative historical trace samples across live domains"
  );
  requireTruthy(
    failures,
    "live-trace-provenance.latest.json",
    report.summary?.anyTraceSupported === true ||
      (report.summary?.allTraceMethodsUnavailable === true && report.summary?.fallbackComplete === true),
    "expected supported traces or complete calldata fallback when trace methods are unavailable"
  );
  requireTruthy(failures, "live-trace-provenance.latest.json", Number(report.summary?.fallbackDecodedFunctionCount ?? -1) === Number(liveReceipts.summary?.decodedFunctionCount ?? -2), "expected live trace fallback decoded-function parity");
  requireZero(failures, "live-trace-provenance.latest.json", report.summary?.fallbackUnknownSelectorCount, "expected live trace fallback unknown selectors to be zero");
  requireSetIncludes(
    failures,
    "live-trace-provenance.latest.json",
    (report.methods ?? []).map((item) => item.method),
    ["debug_traceTransaction", "trace_transaction"],
    "expected historical trace method probes"
  );
  for (const method of report.methods ?? []) {
    requireTruthy(failures, "live-trace-provenance.latest.json", Number(method.attemptedCount ?? 0) > 0, `expected ${method.method} attempt evidence`);
    if (method.status === "unavailable_on_rpc") {
      requireTruthy(failures, "live-trace-provenance.latest.json", Number(method.unavailableCount ?? 0) > 0, `expected ${method.method} unavailable evidence`);
      requireTruthy(failures, "live-trace-provenance.latest.json", typeof method.attempts?.[0]?.error === "string", `expected ${method.method} unavailable error text`);
    } else {
      requireTruthy(failures, "live-trace-provenance.latest.json", Number(method.successCount ?? 0) > 0, `expected ${method.method} supported trace summaries`);
    }
  }
}

for (const file of [
  "source-backed-provenance.latest.json",
  "dlmm-provenance.latest.json",
  "autovault-provenance.latest.json",
  "token-anchors-provenance.latest.json",
  "official-anchors-provenance.latest.json"
]) {
  const report = parsed[file];
  if (!report) continue;
  requireTimestamp(failures, file, report.timestamp, "expected timestamp");
  requireTruthy(failures, file, Number(report.chainId) === 43114, "expected chainId 43114");
  requireTruthy(failures, file, typeof report.rpcUrl === "string" && report.rpcUrl.length > 0, "expected rpcUrl");
  requireTruthy(failures, file, typeof report.blockNumber === "string", "expected blockNumber");
}

if (parsed["registry-coverage.latest.json"]) {
  const report = parsed["registry-coverage.latest.json"];
  const wavax = report.entries?.find((entry) => entry.key === "wavax");
  const usdc = report.entries?.find((entry) => entry.key === "usdcNative");
  requireTimestamp(failures, "registry-coverage.latest.json", report.timestamp, "expected timestamp");
  requireTruthy(failures, "registry-coverage.latest.json", wavax?.status === "verified_abi_first_pass", "expected WAVAX registry status verified_abi_first_pass");
  requireTruthy(failures, "registry-coverage.latest.json", wavax?.abiKey === "wavaxToken", "expected WAVAX abiKey wavaxToken");
  requireTruthy(failures, "registry-coverage.latest.json", wavax?.functionListStatus === "abi_functions_available", "expected WAVAX ABI functions available");
  requireTruthy(failures, "registry-coverage.latest.json", Number(wavax?.functionCount ?? 0) === 11, "expected WAVAX registry function count 11");
  requireTruthy(failures, "registry-coverage.latest.json", usdc?.status === "official_address_only", "expected native USDC registry status official_address_only");
  requireTruthy(failures, "registry-coverage.latest.json", usdc?.abiKey === "erc20Read", "expected native USDC abiKey erc20Read");
  requireTruthy(failures, "registry-coverage.latest.json", usdc?.functionListStatus === "generic_erc20_read", "expected native USDC generic ERC20 read status");
  requireTruthy(failures, "registry-coverage.latest.json", Number(usdc?.functionCount ?? 0) === 6, "expected native USDC generic read function count 6");
  requireTruthy(failures, "registry-coverage.latest.json", report.summary?.statusCounts?.verified_abi_first_pass === 25, "expected 25 verified ABI registry entries");
  requireTruthy(failures, "registry-coverage.latest.json", report.summary?.statusCounts?.official_address_only === 7, "expected 7 official address-only registry entries");
  requireTruthy(failures, "registry-coverage.latest.json", report.summary?.functionListStatusCounts?.generic_erc20_read === 1, "expected 1 generic ERC20 read entry");
}

if (parsed["token-anchors-provenance.latest.json"]) {
  const report = parsed["token-anchors-provenance.latest.json"];
  const wavax = report.targets?.wavax;
  const usdc = report.targets?.usdcNative;
  requireTruthy(failures, "token-anchors-provenance.latest.json", report.ok === true, "expected top-level ok=true");
  requireTruthy(failures, "token-anchors-provenance.latest.json", typeof report.timestamp === "string", "expected timestamp");
  requireTruthy(failures, "token-anchors-provenance.latest.json", report.summary?.wavaxExactVerified === true, "expected WAVAX exact verified summary");
  requireTruthy(failures, "token-anchors-provenance.latest.json", Number(report.summary?.wavaxFunctionCount ?? 0) === 11, "expected WAVAX function count 11");
  requireTruthy(failures, "token-anchors-provenance.latest.json", report.summary?.usdcProxyAdminOnly === true, "expected native USDC proxy ABI to be admin-only");
  requireTruthy(failures, "token-anchors-provenance.latest.json", report.summary?.usdcGenericReadOnly === true, "expected native USDC to remain generic read only");
  requireTruthy(failures, "token-anchors-provenance.latest.json", typeof report.summary?.usdcImplementationAddress === "string", "expected native USDC implementation address");
  requireTruthy(failures, "token-anchors-provenance.latest.json", Number(report.summary?.usdcImplementationFunctionCount ?? 0) >= 40, "expected native USDC implementation to expose broad admin/user ABI");
  requireTruthy(failures, "token-anchors-provenance.latest.json", Array.isArray(report.summary?.usdcAdminSurfaceNames) && report.summary.usdcAdminSurfaceNames.length > 0, "expected native USDC implementation admin surface names");
  requireTruthy(failures, "token-anchors-provenance.latest.json", wavax?.registryStatus === "verified_abi_first_pass", "expected WAVAX token anchor registry status verified");
  requireTruthy(failures, "token-anchors-provenance.latest.json", usdc?.registryStatus === "official_address_only", "expected native USDC token anchor registry status official_address_only");
  requireTruthy(
    failures,
    "token-anchors-provenance.latest.json",
    Object.values(wavax?.metadata ?? {}).every((item) => item?.blockNumber === report.blockNumber) &&
      Object.values(usdc?.metadata ?? {}).every((item) => item?.blockNumber === report.blockNumber),
    "expected token metadata reads to be pinned to report blockNumber"
  );
}

if (parsed["official-anchors-provenance.latest.json"]) {
  const report = parsed["official-anchors-provenance.latest.json"];
  const keys = (report.targets ?? []).map((target) => target.key);
  const proxyAdmin = byKey(report.targets, "proxyAdmin");
  const teamMultisig = byKey(report.targets, "pharaohTeamMultisig");
  const poolDeployer = byKey(report.targets, "ramsesV3PoolDeployer");
  const initializedDeployer = byKey(report.targets, "ramsesV3FactoryInitializedDeployer");
  const descriptor = byKey(report.targets, "nonfungibleTokenPositionDescriptor");
  const relationReads = (report.targets ?? [])
    .flatMap((target) => Object.values(target.relations ?? {}))
    .filter((item) => item && typeof item === "object" && Object.hasOwn(item, "ok"));
  requireTruthy(failures, "official-anchors-provenance.latest.json", report.ok === true, "expected top-level ok=true");
  requireTruthy(failures, "official-anchors-provenance.latest.json", typeof report.timestamp === "string", "expected timestamp");
  requireTruthy(failures, "official-anchors-provenance.latest.json", Number(report.summary?.totalOfficialAnchors ?? 0) === 7, "expected 7 official anchors");
  requireTruthy(failures, "official-anchors-provenance.latest.json", Number(report.summary?.nonUserAnchors ?? 0) === 7, "expected all official anchors to be non-user surfaces");
  requireTruthy(failures, "official-anchors-provenance.latest.json", Number(report.summary?.genericTokenAnchors ?? 0) === 1, "expected one generic token anchor");
  requireTruthy(failures, "official-anchors-provenance.latest.json", Number(report.summary?.addressOnlyNoUserAbi ?? 0) === 6, "expected six address-only non-user ABI anchors");
  requireSetIncludes(
    failures,
    "official-anchors-provenance.latest.json",
    keys,
    ["timelockController", "pharaohTeamMultisig", "proxyAdmin", "ramsesV3PoolDeployer", "ramsesV3FactoryInitializedDeployer", "nonfungibleTokenPositionDescriptor", "usdcNative"],
    "expected official anchor report key membership"
  );
  requireTruthy(
    failures,
    "official-anchors-provenance.latest.json",
    (report.targets ?? []).every((target) => target.registryStatus === "official_address_only" && target.userFacingDexSurface === false),
    "expected all official anchor targets to be official_address_only non-user surfaces"
  );
  requireTruthy(failures, "official-anchors-provenance.latest.json", proxyAdmin?.relations?.owner?.result === "0xd1b27ccAF2A4dDcA0Ac32181374C70282492d843", "expected proxyAdmin owner to be team multisig");
  requireTruthy(failures, "official-anchors-provenance.latest.json", teamMultisig?.relations?.version?.result === "1.4.1", "expected team multisig Safe VERSION 1.4.1");
  requireTruthy(failures, "official-anchors-provenance.latest.json", Array.isArray(teamMultisig?.relations?.owners?.result) && teamMultisig.relations.owners.result.length > 0, "expected team multisig owner list");
  requireTruthy(failures, "official-anchors-provenance.latest.json", poolDeployer?.relations?.factoryRamsesV3PoolDeployer?.result === poolDeployer?.address, "expected factory deployer link to ramsesV3PoolDeployer");
  requireTruthy(failures, "official-anchors-provenance.latest.json", poolDeployer?.relations?.positionManagerDeployer?.result === poolDeployer?.address, "expected position-manager deployer link to ramsesV3PoolDeployer");
  requireTruthy(failures, "official-anchors-provenance.latest.json", initializedDeployer?.code?.byteLength === 0, "expected initialized deployer/operator anchor to have no runtime code");
  requireTruthy(failures, "official-anchors-provenance.latest.json", descriptor?.relations?.nativeCurrencyLabel?.result === "AVAX", "expected descriptor nativeCurrencyLabel AVAX");
  requireTruthy(failures, "official-anchors-provenance.latest.json", descriptor?.relations?.WETH9?.result === "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", "expected descriptor WETH9 to match WAVAX");
  requireTruthy(
    failures,
    "official-anchors-provenance.latest.json",
    (report.targets ?? []).every((target) => target.code?.blockNumber === report.blockNumber),
    "expected official anchor code checks to be pinned to report blockNumber"
  );
  requireTruthy(
    failures,
    "official-anchors-provenance.latest.json",
    relationReads.every((read) => read.blockNumber === report.blockNumber),
    "expected official anchor relation reads to be pinned to report blockNumber"
  );
}

if (parsed["autovault-provenance.latest.json"]) {
  const report = parsed["autovault-provenance.latest.json"];
  const registryEntry = byKey(parsed["registry-coverage.latest.json"]?.entries, "autoVault");
  const appBundleDelta = report.promotion?.appBundleDelta ?? {};
  const gatePromotableTargets = report.provenanceGate?.promotionEligible === true ? ["autoVault"] : [];
  requireTruthy(failures, "autovault-provenance.latest.json", typeof report.timestamp === "string", "expected timestamp");
  requireTruthy(failures, "autovault-provenance.latest.json", report.statusRecommendation === "keep source_backed_abi_candidate", "expected AutoVault to remain source-backed");
  requireStringSetEqual(failures, "autovault-provenance.latest.json", report.summary?.promotableSourceBackedTargets, gatePromotableTargets, "expected AutoVault promotable summary to derive from provenanceGate.promotionEligible");
  requireTruthy(failures, "autovault-provenance.latest.json", report.summary?.promotionEligible === report.provenanceGate?.promotionEligible, "expected AutoVault promotionEligible summary/gate parity");
  requireDeepEqual(failures, "autovault-provenance.latest.json", report.summary?.promotionBlockers, report.provenanceGate?.promotionBlockers, "expected AutoVault promotionBlockers summary/gate parity");
  requireZero(failures, "autovault-provenance.latest.json", report.summary?.promotableSourceBackedTargets?.length, "expected zero promotable AutoVault targets");
  requireZero(failures, "autovault-provenance.latest.json", report.summary?.liveReadFailures?.length, "expected zero AutoVault live-read failures in summary");
  requireTruthy(failures, "autovault-provenance.latest.json", report.autoVault === "0xFe99E92df71F53a26005d1bFbe54C941A3131Aa0", "expected AutoVault proxy address");
  requireTruthy(failures, "autovault-provenance.latest.json", report.status === "source_backed_abi_candidate", "expected AutoVault report status source_backed_abi_candidate");
  requireTruthy(failures, "autovault-provenance.latest.json", report.abiKey === "autoVault", "expected AutoVault report abiKey");
  requireTruthy(failures, "autovault-provenance.latest.json", registryEntry?.address === report.autoVault, "expected AutoVault registry/report address parity");
  requireTruthy(failures, "autovault-provenance.latest.json", registryEntry?.abiKey === "autoVault" && registryEntry?.status === "source_backed_abi_candidate", "expected AutoVault registry source-backed ABI parity");
  requireTruthy(failures, "autovault-provenance.latest.json", Number(registryEntry?.functionCount ?? 0) === Number(report.promotion?.selectorCoverage?.functionCount ?? -1), "expected AutoVault registry/report function-count parity");
  requireTruthy(failures, "autovault-provenance.latest.json", Number(report.localAbi?.functionCount ?? 0) === Number(report.promotion?.selectorCoverage?.functionCount ?? -1), "expected AutoVault local ABI fingerprint function-count parity");
  requireTruthy(failures, "autovault-provenance.latest.json", isSha256(report.localAbi?.functionSignaturesSha256), "expected AutoVault local ABI signature SHA-256");
  requireTruthy(failures, "autovault-provenance.latest.json", Number(report.localAbi?.errorCount ?? 0) >= 1, "expected AutoVault local ABI custom-error fingerprint");
  requireTruthy(failures, "autovault-provenance.latest.json", isSha256(report.localAbi?.errorSignaturesSha256), "expected AutoVault local ABI custom-error SHA-256");
  requireTruthy(failures, "autovault-provenance.latest.json", Number(report.localAbi?.errorSelectorsPresent ?? 0) >= 1, "expected AutoVault custom-error selector evidence");
  requireZero(failures, "autovault-provenance.latest.json", report.localAbi?.errorSelectorsMissing?.length, "expected AutoVault zero missing custom-error selectors");
  const depositTooSmallEvidence = (report.localAbi?.customErrors ?? []).find((item) => item?.signature === "DepositTooSmall()");
  requireTruthy(failures, "autovault-provenance.latest.json", depositTooSmallEvidence?.selector === "0x6ba4a1c7", "expected AutoVault DepositTooSmall selector evidence");
  requireTruthy(failures, "autovault-provenance.latest.json", depositTooSmallEvidence?.implementationBytecode?.present === true, "expected AutoVault DepositTooSmall selector present in implementation bytecode");
  requireTruthy(failures, "autovault-provenance.latest.json", depositTooSmallEvidence?.implementationBytecode?.pushPattern === "636ba4a1c7", "expected AutoVault DepositTooSmall PUSH4 pattern");
  requireTruthy(failures, "autovault-provenance.latest.json", report.proxy?.eip1967?.implementation?.address === "0x9b8afab330223dc81ed5e2bf4e6d59643762e7c7", "expected AutoVault EIP-1967 implementation address");
  requireTruthy(failures, "autovault-provenance.latest.json", report.selectorCheckAddress === report.proxy?.eip1967?.implementation?.address, "expected AutoVault selectorCheckAddress to match implementation");
  requireTruthy(failures, "autovault-provenance.latest.json", Number(report.promotion?.selectorCoverage?.functionCount ?? 0) === 36, "expected AutoVault local function count 36");
  requireZero(failures, "autovault-provenance.latest.json", report.promotion?.selectorCoverage?.selectorsMissing, "expected AutoVault zero missing selectors");
  requireTruthy(failures, "autovault-provenance.latest.json", report.promotion?.proxyExactAbi?.classification === "remote_abi_unavailable", "expected AutoVault proxy ABI unavailable");
  requireTruthy(failures, "autovault-provenance.latest.json", report.promotion?.implementationExactAbi?.classification === "remote_abi_unavailable", "expected AutoVault implementation ABI unavailable");
  requireAbiFetchAttemptEvidence(failures, "autovault-provenance.latest.json", report.promotion?.proxyExactAbi, "autoVault proxy remote_abi_unavailable", {
    requireSnowtraceAndRoutescan: true
  });
  requireAbiFetchAttemptEvidence(failures, "autovault-provenance.latest.json", report.promotion?.implementationExactAbi, "autoVault implementation remote_abi_unavailable", {
    requireSnowtraceAndRoutescan: true
  });
  requireSetIncludes(failures, "autovault-provenance.latest.json", report.promotion?.promotionBlockers, ["proxy exact ABI remote_abi_unavailable", "implementation exact ABI remote_abi_unavailable"], "expected AutoVault promotion blockers");
  requireStringSetEqual(failures, "autovault-provenance.latest.json", report.promotion?.appBundleDelta?.missingFromLocal, ["initialize(address,address,address,address,address)"], "expected only AutoVault app-bundle initialize missing locally");
  requireStringSetEqual(failures, "autovault-provenance.latest.json", report.promotion?.appBundleDelta?.localExtra, ["getStoredRewards(address)"], "expected only AutoVault getStoredRewards local extra");
  requireTruthy(failures, "autovault-provenance.latest.json", report.proxy?.codeBlockNumber === report.blockNumber, "expected AutoVault proxy code block to match report blockNumber");
  requireTruthy(failures, "autovault-provenance.latest.json", isSha256(report.proxy?.codeSha256), "expected AutoVault proxy bytecode SHA-256");
  requireTruthy(failures, "autovault-provenance.latest.json", report.implementation?.codeBlockNumber === report.blockNumber, "expected AutoVault implementation code block to match report blockNumber");
  requireTruthy(failures, "autovault-provenance.latest.json", isSha256(report.implementation?.codeSha256), "expected AutoVault implementation bytecode SHA-256");
  requireTruthy(
    failures,
    "autovault-provenance.latest.json",
    Object.values(report.proxy?.eip1967 ?? {}).every((slot) => slot?.blockNumber === report.blockNumber),
    "expected AutoVault EIP-1967 slots to be pinned to report blockNumber"
  );
  requireTruthy(failures, "autovault-provenance.latest.json", appBundleDelta.sourceUrl === "https://www.phar.gg/_next/static/chunks/app/autovault/page-c803499e24028e78.js", "expected AutoVault app-bundle source URL");
  requireTimestamp(failures, "autovault-provenance.latest.json", appBundleDelta.retrievedAt, "expected AutoVault app-bundle retrievedAt");
  requireTruthy(failures, "autovault-provenance.latest.json", typeof appBundleDelta.contentSha256 === "string" && /^[0-9a-f]{64}$/.test(appBundleDelta.contentSha256), "expected AutoVault app-bundle contentSha256");
  requireTruthy(failures, "autovault-provenance.latest.json", appBundleDelta.sourceFetch?.ok === true, "expected AutoVault app-bundle source fetch to pass");
  requireTruthy(failures, "autovault-provenance.latest.json", appBundleDelta.functionCount === report.localAbi?.appBundle?.functionCount, "expected AutoVault app-bundle function-count parity");
  requireSourceArtifactEvidence(failures, "autovault-provenance.latest.json", report, "autoVault");
  requireSourceBackedGate(failures, "autovault-provenance.latest.json", report, "eip1967_implementation_selector_backed", "eip1967_implementation", report.blockNumber, "autoVault");
  requireTruthy(
    failures,
    "autovault-provenance.latest.json",
    Object.values(report.liveReads ?? {}).every((item) => item?.ok === true),
    "expected all AutoVault representative live reads to pass"
  );
  requireTruthy(
    failures,
    "autovault-provenance.latest.json",
    Object.values(report.liveReads ?? {}).every((item) => item?.blockNumber === report.blockNumber),
    "expected all AutoVault representative live reads to be pinned to report blockNumber"
  );
}

if (parsed["source-backed-provenance.latest.json"]) {
  const report = parsed["source-backed-provenance.latest.json"];
  const registryEntries = parsed["registry-coverage.latest.json"]?.entries ?? [];
  const targets = report.targets ?? [];
  const gatePromotableTargets = targets
    .filter((target) => target.status === "source_backed_abi_candidate" && target.provenanceGate?.promotionEligible === true)
    .map((target) => target.key);
  const targetKeys = targets.map((target) => target.key);
  const sourceBackedKeys = ["accessHub", "treasuryHelper", "voter", "legacyGauge", "feeDistributor", "feeRecipient", "pairFactory"];
  const exactVerifiedKeys = ["clGaugeFactory", "feeDistributorFactory", "feeRecipientFactory"];
  requireTimestamp(failures, "source-backed-provenance.latest.json", report.timestamp, "expected timestamp");
  requireTruthy(failures, "source-backed-provenance.latest.json", typeof report.blockNumber === "string", "expected blockNumber");
  requireTruthy(failures, "source-backed-provenance.latest.json", Number(report.summary?.targets ?? 0) === 10, "expected 10 source provenance targets");
  requireTruthy(failures, "source-backed-provenance.latest.json", Number(report.summary?.exactVerifiedMatches ?? 0) === 3, "expected 3 exact verified source-provenance matches");
  requireStringSetEqual(failures, "source-backed-provenance.latest.json", report.summary?.promotableSourceBackedTargets, gatePromotableTargets, "expected source promotable summary to derive from provenanceGate.promotionEligible");
  requireZero(failures, "source-backed-provenance.latest.json", report.summary?.promotableSourceBackedTargets?.length, "expected zero promotable source-backed targets");
  requireZero(failures, "source-backed-provenance.latest.json", report.summary?.selectorFailures?.length, "expected zero source selector failures");
  requireZero(failures, "source-backed-provenance.latest.json", report.summary?.verifiedExactFailures?.length, "expected zero source verified exact failures");
  requireZero(failures, "source-backed-provenance.latest.json", report.summary?.liveReadFailures?.length, "expected zero source live-read failures");
  requireStringSetEqual(failures, "source-backed-provenance.latest.json", report.summary?.proxyAbiOnlyTargets, ["accessHub", "treasuryHelper", "voter"], "expected source proxy ABI-only targets");
  requireStringSetEqual(failures, "source-backed-provenance.latest.json", targetKeys, [...sourceBackedKeys, ...exactVerifiedKeys], "expected exact source provenance target membership");
  for (const key of sourceBackedKeys) {
    const target = byKey(targets, key);
    const registryEntry = byKey(registryEntries, key);
    requireTruthy(failures, "source-backed-provenance.latest.json", target?.status === "source_backed_abi_candidate", `expected ${key} source-backed status`);
    requireTruthy(failures, "source-backed-provenance.latest.json", registryEntry?.address === target?.address, `expected ${key} registry/report address parity`);
    requireTruthy(failures, "source-backed-provenance.latest.json", registryEntry?.abiKey === target?.abiKey, `expected ${key} registry/report abiKey parity`);
    requireTruthy(failures, "source-backed-provenance.latest.json", registryEntry?.status === target?.status, `expected ${key} registry/report status parity`);
    requireTruthy(failures, "source-backed-provenance.latest.json", Number(registryEntry?.functionCount ?? 0) === Number(target?.selectorSummary?.functionCount ?? -1), `expected ${key} registry/report function-count parity`);
    requireTruthy(failures, "source-backed-provenance.latest.json", Number(target?.localAbi?.functionCount ?? 0) === Number(target?.selectorSummary?.functionCount ?? -1), `expected ${key} local ABI fingerprint function-count parity`);
    requireTruthy(failures, "source-backed-provenance.latest.json", isSha256(target?.localAbi?.functionSignaturesSha256), `expected ${key} local ABI signature SHA-256`);
    requireSourceArtifactEvidence(failures, "source-backed-provenance.latest.json", target, key);
    requireTruthy(failures, "source-backed-provenance.latest.json", Number(target?.selectorSummary?.selectorsPresent ?? 0) + Number(target?.selectorSummary?.selectorsMissing ?? 0) === Number(target?.selectorSummary?.functionCount ?? -1), `expected ${key} selector count consistency`);
    requireTruthy(failures, "source-backed-provenance.latest.json", Number(target?.functions?.length ?? 0) === Number(target?.selectorSummary?.functionCount ?? -1), `expected ${key} function list length to match selector summary`);
    requireZero(failures, "source-backed-provenance.latest.json", target?.selectorSummary?.selectorsMissing, `expected ${key} zero missing selectors`);
    requireTruthy(failures, "source-backed-provenance.latest.json", Object.values(target?.liveReads ?? {}).every((item) => item?.ok === true), `expected ${key} representative live reads to pass`);
    requireTruthy(failures, "source-backed-provenance.latest.json", Object.values(target?.liveReads ?? {}).every((item) => item?.blockNumber === report.blockNumber), `expected ${key} live reads pinned to report blockNumber`);
    requireTruthy(failures, "source-backed-provenance.latest.json", Object.values(target?.proxy?.eip1967 ?? {}).every((slot) => slot?.blockNumber === report.blockNumber), `expected ${key} proxy slots pinned to report blockNumber`);
    requireTruthy(failures, "source-backed-provenance.latest.json", target?.proxy?.targetCodeBlockNumber === report.blockNumber, `expected ${key} target code pinned to report blockNumber`);
    requireTruthy(failures, "source-backed-provenance.latest.json", isSha256(target?.proxy?.targetCodeSha256), `expected ${key} target bytecode SHA-256`);
    requireTruthy(failures, "source-backed-provenance.latest.json", explorerStatuses(target).every((status) => Object.values(status).every((attempt) => typeof attempt?.retrievedAt === "string")), `expected ${key} explorer status retrieval timestamps`);
    requireTruthy(failures, "source-backed-provenance.latest.json", exactAbiReports(target).every((item) => (item.attempts ?? []).every((attempt) => typeof attempt?.retrievedAt === "string")), `expected ${key} exact-ABI attempt retrieval timestamps`);
    for (const exactReport of exactAbiReports(target)) {
      requireAbiFetchAttemptEvidence(failures, "source-backed-provenance.latest.json", exactReport, `${key} ${exactReport.classification}`, {
        requireSnowtraceAndRoutescan: exactReport.classification === "remote_abi_unavailable"
      });
    }
    requireTruthy(failures, "source-backed-provenance.latest.json", target?.statusRecommendation?.startsWith("keep source_backed_abi_candidate"), `expected ${key} keep-source-backed recommendation`);
    if (["accessHub", "treasuryHelper", "voter"].includes(key)) {
      requireSourceBackedGate(failures, "source-backed-provenance.latest.json", target, "eip1967_implementation_selector_backed", "eip1967_implementation", report.blockNumber, key);
      requireTruthy(failures, "source-backed-provenance.latest.json", typeof target?.proxy?.eip1967?.implementation?.address === "string", `expected ${key} proxy implementation address`);
      requireTruthy(failures, "source-backed-provenance.latest.json", Number(target?.proxy?.implementationCodeBytes ?? 0) > 0, `expected ${key} implementation code bytes`);
      requireTruthy(failures, "source-backed-provenance.latest.json", target?.proxy?.implementationCodeBlockNumber === report.blockNumber, `expected ${key} implementation code pinned to report blockNumber`);
      requireTruthy(failures, "source-backed-provenance.latest.json", isSha256(target?.proxy?.implementationCodeSha256), `expected ${key} implementation bytecode SHA-256`);
      requireTruthy(failures, "source-backed-provenance.latest.json", target?.selectorCheckAddress === target?.proxy?.eip1967?.implementation?.address, `expected ${key} selectors checked against implementation`);
    } else {
      requireSourceBackedGate(failures, "source-backed-provenance.latest.json", target, "target_runtime_selector_backed", "target_runtime", report.blockNumber, key);
      requireTruthy(failures, "source-backed-provenance.latest.json", target?.proxy?.eip1967?.implementation?.address === null, `expected ${key} no EIP-1967 implementation`);
      requireTruthy(failures, "source-backed-provenance.latest.json", Number(target?.proxy?.targetCodeBytes ?? 0) > 0, `expected ${key} target code bytes`);
      requireTruthy(failures, "source-backed-provenance.latest.json", target?.selectorCheckAddress === target?.address, `expected ${key} selectors checked against target runtime`);
    }
  }
  for (const key of exactVerifiedKeys) {
    const target = byKey(targets, key);
    const registryEntry = byKey(registryEntries, key);
    requireTruthy(failures, "source-backed-provenance.latest.json", target?.status === "verified_abi_first_pass", `expected ${key} verified status`);
    requireTruthy(failures, "source-backed-provenance.latest.json", registryEntry?.address === target?.address && registryEntry?.abiKey === target?.abiKey && registryEntry?.status === target?.status, `expected ${key} registry/report parity`);
    requireTruthy(failures, "source-backed-provenance.latest.json", Number(target?.localAbi?.functionCount ?? 0) === Number(target?.selectorSummary?.functionCount ?? -1), `expected ${key} local ABI fingerprint function-count parity`);
    requireTruthy(failures, "source-backed-provenance.latest.json", isSha256(target?.localAbi?.functionSignaturesSha256), `expected ${key} local ABI signature SHA-256`);
    requireTruthy(failures, "source-backed-provenance.latest.json", target?.explorer?.exactAbi?.ok === true, `expected ${key} exact public ABI match`);
    requireZero(failures, "source-backed-provenance.latest.json", target?.selectorSummary?.selectorsMissing, `expected ${key} zero missing selectors`);
    requireTruthy(failures, "source-backed-provenance.latest.json", Object.values(target?.liveReads ?? {}).every((item) => item?.blockNumber === report.blockNumber), `expected ${key} live reads pinned to report blockNumber`);
    requireTruthy(failures, "source-backed-provenance.latest.json", Object.values(target?.proxy?.eip1967 ?? {}).every((slot) => slot?.blockNumber === report.blockNumber), `expected ${key} proxy slots pinned to report blockNumber`);
    requireTruthy(failures, "source-backed-provenance.latest.json", target?.proxy?.targetCodeBlockNumber === report.blockNumber, `expected ${key} target code pinned to report blockNumber`);
    requireTruthy(failures, "source-backed-provenance.latest.json", isSha256(target?.proxy?.targetCodeSha256), `expected ${key} target bytecode SHA-256`);
    requireTruthy(failures, "source-backed-provenance.latest.json", explorerStatuses(target).every((status) => Object.values(status).every((attempt) => typeof attempt?.retrievedAt === "string")), `expected ${key} explorer status retrieval timestamps`);
    requireTruthy(failures, "source-backed-provenance.latest.json", exactAbiReports(target).every((item) => (item.attempts ?? []).every((attempt) => typeof attempt?.retrievedAt === "string")), `expected ${key} exact-ABI attempt retrieval timestamps`);
    for (const exactReport of exactAbiReports(target)) {
      requireAbiFetchAttemptEvidence(failures, "source-backed-provenance.latest.json", exactReport, `${key} ${exactReport.classification}`, {
        requireSnowtraceAndRoutescan: exactReport.classification === "remote_abi_unavailable"
      });
    }
    requireExactVerifiedGate(failures, "source-backed-provenance.latest.json", target, report.blockNumber, key);
  }
}

if (parsed["dlmm-provenance.latest.json"]) {
  const report = parsed["dlmm-provenance.latest.json"];
  const registryEntries = parsed["registry-coverage.latest.json"]?.entries ?? [];
  const rewarderFactory = report.targets?.find((target) => target.key === "dlmmRewarderFactory");
  const gatePromotableTargets = (report.targets ?? [])
    .filter((target) => target.status === "source_backed_abi_candidate" && target.provenanceGate?.promotionEligible === true)
    .map((target) => target.key);
  const sourceBackedDlmmKeys = ["dlmmRouter", "dlmmFactory", "dlmmPoolImplementation", "dlmmRewarderImplementation", "dlmmWavaxUsdc5Pool"];
  const dlmmKeys = (report.targets ?? []).map((target) => target.key);
  requireTimestamp(failures, "dlmm-provenance.latest.json", report.timestamp, "expected timestamp");
  requireTruthy(failures, "dlmm-provenance.latest.json", typeof report.blockNumber === "string", "expected blockNumber");
  requireTruthy(failures, "dlmm-provenance.latest.json", Number(report.summary?.targets ?? 0) >= 6, "expected dlmmRewarderFactory to be included as an explicit DLMM provenance target");
  requireTruthy(failures, "dlmm-provenance.latest.json", Number(report.summary?.exactVerifiedMatches ?? 0) === 1, "expected exactly one exact verified DLMM target");
  requireStringSetEqual(failures, "dlmm-provenance.latest.json", report.summary?.promotableSourceBackedTargets, gatePromotableTargets, "expected DLMM promotable summary to derive from provenanceGate.promotionEligible");
  requireZero(failures, "dlmm-provenance.latest.json", report.summary?.promotableSourceBackedTargets?.length, "expected zero promotable source-backed DLMM targets");
  requireZero(failures, "dlmm-provenance.latest.json", report.summary?.selectorFailures?.length, "expected zero DLMM selector failures");
  requireZero(failures, "dlmm-provenance.latest.json", report.summary?.verifiedExactFailures?.length, "expected zero verified DLMM exact-ABI failures");
  requireZero(failures, "dlmm-provenance.latest.json", report.summary?.liveReadFailures?.length, "expected zero DLMM live-read failures");
  requireZero(failures, "dlmm-provenance.latest.json", report.summary?.linkFailures?.length, "expected zero DLMM registry-link failures");
  requireTruthy(failures, "dlmm-provenance.latest.json", rewarderFactory?.status === "verified_abi_first_pass", "expected dlmmRewarderFactory status verified_abi_first_pass");
  requireTruthy(failures, "dlmm-provenance.latest.json", rewarderFactory?.abiKey === "dlmmRewarderFactory", "expected dlmmRewarderFactory abiKey");
  requireTruthy(failures, "dlmm-provenance.latest.json", rewarderFactory?.address === "0xd28467eDe84cEde6B05070779E39Eaff4988548C", "expected dlmmRewarderFactory address");
  requireTruthy(failures, "dlmm-provenance.latest.json", rewarderFactory?.explorer?.exactAbi?.ok === true, "expected dlmmRewarderFactory exact public ABI match");
  requireTruthy(failures, "dlmm-provenance.latest.json", rewarderFactory?.explorer?.exactAbi?.source === "snowtrace", "expected dlmmRewarderFactory exact ABI source snowtrace");
  requireTruthy(failures, "dlmm-provenance.latest.json", rewarderFactory?.explorer?.exactAbi?.classification === "exact_match", "expected dlmmRewarderFactory exact ABI classification exact_match");
  requireTruthy(failures, "dlmm-provenance.latest.json", rewarderFactory?.explorer?.exactAbi?.comparison?.ok === true, "expected dlmmRewarderFactory exact ABI comparison ok");
  requireTruthy(failures, "dlmm-provenance.latest.json", Number(rewarderFactory?.explorer?.exactAbi?.comparison?.localCount ?? 0) === 6, "expected dlmmRewarderFactory local ABI function count 6");
  requireTruthy(failures, "dlmm-provenance.latest.json", Number(rewarderFactory?.explorer?.exactAbi?.comparison?.remoteCount ?? 0) === 6, "expected dlmmRewarderFactory remote ABI function count 6");
  requireZero(failures, "dlmm-provenance.latest.json", rewarderFactory?.explorer?.exactAbi?.comparison?.missing?.length, "expected dlmmRewarderFactory exact ABI comparison missing=0");
  requireZero(failures, "dlmm-provenance.latest.json", rewarderFactory?.explorer?.exactAbi?.comparison?.extra?.length, "expected dlmmRewarderFactory exact ABI comparison extra=0");
  requireTruthy(failures, "dlmm-provenance.latest.json", Number(rewarderFactory?.localAbi?.functionCount ?? 0) === Number(rewarderFactory?.selectorSummary?.functionCount ?? -1), "expected dlmmRewarderFactory local ABI fingerprint function-count parity");
  requireTruthy(failures, "dlmm-provenance.latest.json", isSha256(rewarderFactory?.localAbi?.functionSignaturesSha256), "expected dlmmRewarderFactory local ABI signature SHA-256");
  requireTruthy(failures, "dlmm-provenance.latest.json", Number(rewarderFactory?.selectorSummary?.functionCount ?? 0) === 6, "expected dlmmRewarderFactory selector function count 6");
  requireZero(failures, "dlmm-provenance.latest.json", rewarderFactory?.selectorSummary?.selectorsMissing, "expected dlmmRewarderFactory zero missing selectors");
  requireTruthy(failures, "dlmm-provenance.latest.json", report.context?.rewarderFactoryImplementation?.ok === true, "expected rewarderFactoryImplementation context read");
  requireTruthy(failures, "dlmm-provenance.latest.json", report.context?.rewarderFactoryImplementation?.result === "0xC997575204290FF7106aB8b2BCFa7e7dEA43D783", "expected rewarderFactoryImplementation to match registry rewarder implementation");
  requireTruthy(
    failures,
    "dlmm-provenance.latest.json",
    [
      report.context?.wavaxUsdc5PoolImplementation,
      report.context?.rewardedPoolRewarder,
      report.context?.rewarderFactoryImplementation
    ].every((item) => item?.blockNumber === report.blockNumber),
    "expected DLMM context live reads to be pinned to report blockNumber"
  );
  requireTruthy(failures, "dlmm-provenance.latest.json", rewarderFactory?.liveReads?.implementation?.ok === true, "expected dlmmRewarderFactory implementation live read");
  requireTruthy(failures, "dlmm-provenance.latest.json", rewarderFactory?.liveReads?.getRewarder?.ok === true, "expected dlmmRewarderFactory getRewarder live read");
  requireTruthy(failures, "dlmm-provenance.latest.json", Object.values(rewarderFactory?.liveReads ?? {}).every((item) => item?.blockNumber === report.blockNumber), "expected dlmmRewarderFactory live reads pinned to report blockNumber");
  requireTruthy(failures, "dlmm-provenance.latest.json", rewarderFactory?.targetCodeBlockNumber === report.blockNumber, "expected dlmmRewarderFactory target code pinned to report blockNumber");
  requireTruthy(failures, "dlmm-provenance.latest.json", rewarderFactory?.selectorCodeBlockNumber === report.blockNumber, "expected dlmmRewarderFactory selector code pinned to report blockNumber");
  requireTruthy(failures, "dlmm-provenance.latest.json", isSha256(rewarderFactory?.targetCodeSha256), "expected dlmmRewarderFactory target bytecode SHA-256");
  requireTruthy(failures, "dlmm-provenance.latest.json", isSha256(rewarderFactory?.selectorCodeSha256), "expected dlmmRewarderFactory selector bytecode SHA-256");
  requireTruthy(failures, "dlmm-provenance.latest.json", explorerStatuses(rewarderFactory).every((status) => Object.values(status).every((attempt) => typeof attempt?.retrievedAt === "string")), "expected dlmmRewarderFactory explorer status retrieval timestamps");
  requireTruthy(failures, "dlmm-provenance.latest.json", exactAbiReports(rewarderFactory).every((item) => (item.attempts ?? []).every((attempt) => typeof attempt?.retrievedAt === "string")), "expected dlmmRewarderFactory exact-ABI attempt retrieval timestamps");
  requireExactVerifiedGate(failures, "dlmm-provenance.latest.json", rewarderFactory, report.blockNumber, "dlmmRewarderFactory");
  requireStringSetEqual(failures, "dlmm-provenance.latest.json", dlmmKeys, [...sourceBackedDlmmKeys, "dlmmRewarderFactory"], "expected exact DLMM provenance target membership");
  for (const key of sourceBackedDlmmKeys) {
    const target = byKey(report.targets, key);
    const registryEntry = byKey(registryEntries, key);
    requireTruthy(failures, "dlmm-provenance.latest.json", target?.status === "source_backed_abi_candidate", `expected ${key} source-backed DLMM status`);
    requireTruthy(failures, "dlmm-provenance.latest.json", registryEntry?.address === target?.address, `expected ${key} registry/report address parity`);
    requireTruthy(failures, "dlmm-provenance.latest.json", registryEntry?.abiKey === target?.abiKey, `expected ${key} registry/report abiKey parity`);
    requireTruthy(failures, "dlmm-provenance.latest.json", registryEntry?.status === target?.status, `expected ${key} registry/report status parity`);
    requireTruthy(failures, "dlmm-provenance.latest.json", Number(registryEntry?.functionCount ?? 0) === Number(target?.selectorSummary?.functionCount ?? -1), `expected ${key} registry/report function-count parity`);
    requireTruthy(failures, "dlmm-provenance.latest.json", Number(target?.localAbi?.functionCount ?? 0) === Number(target?.selectorSummary?.functionCount ?? -1), `expected ${key} local ABI fingerprint function-count parity`);
    requireTruthy(failures, "dlmm-provenance.latest.json", isSha256(target?.localAbi?.functionSignaturesSha256), `expected ${key} local ABI signature SHA-256`);
    if (target?.sourceArtifactEvidence?.status === "no_source_artifact_configured") {
      requireRuntimeSelectorOnlyEvidence(failures, "dlmm-provenance.latest.json", target, key);
    } else {
      requireSourceArtifactEvidence(failures, "dlmm-provenance.latest.json", target, key);
    }
    requireTruthy(failures, "dlmm-provenance.latest.json", target?.explorer?.exactAbi?.classification === "remote_abi_unavailable", `expected ${key} public exact ABI unavailable`);
    requireTruthy(failures, "dlmm-provenance.latest.json", Number(target?.selectorSummary?.selectorsPresent ?? 0) + Number(target?.selectorSummary?.selectorsMissing ?? 0) === Number(target?.selectorSummary?.functionCount ?? -1), `expected ${key} selector count consistency`);
    requireTruthy(failures, "dlmm-provenance.latest.json", Number(target?.functions?.length ?? 0) === Number(target?.selectorSummary?.functionCount ?? -1), `expected ${key} function list length to match selector summary`);
    requireZero(failures, "dlmm-provenance.latest.json", target?.selectorSummary?.selectorsMissing, `expected ${key} zero missing selectors`);
    requireTruthy(failures, "dlmm-provenance.latest.json", Object.values(target?.liveReads ?? {}).every((item) => item?.ok === true), `expected ${key} representative live reads to pass`);
    requireTruthy(failures, "dlmm-provenance.latest.json", Object.values(target?.liveReads ?? {}).every((item) => item?.blockNumber === report.blockNumber), `expected ${key} live reads pinned to report blockNumber`);
    requireTruthy(failures, "dlmm-provenance.latest.json", Object.values(target?.proxy?.eip1967 ?? {}).every((slot) => slot?.blockNumber === report.blockNumber), `expected ${key} proxy slots pinned to report blockNumber`);
    requireTruthy(failures, "dlmm-provenance.latest.json", target?.targetCodeBlockNumber === report.blockNumber, `expected ${key} target code pinned to report blockNumber`);
    requireTruthy(failures, "dlmm-provenance.latest.json", target?.selectorCodeBlockNumber === report.blockNumber, `expected ${key} selector code pinned to report blockNumber`);
    requireTruthy(failures, "dlmm-provenance.latest.json", isSha256(target?.targetCodeSha256), `expected ${key} target bytecode SHA-256`);
    requireTruthy(failures, "dlmm-provenance.latest.json", isSha256(target?.selectorCodeSha256), `expected ${key} selector bytecode SHA-256`);
    requireTruthy(failures, "dlmm-provenance.latest.json", explorerStatuses(target).every((status) => Object.values(status).every((attempt) => typeof attempt?.retrievedAt === "string")), `expected ${key} explorer status retrieval timestamps`);
    requireTruthy(failures, "dlmm-provenance.latest.json", exactAbiReports(target).every((item) => (item.attempts ?? []).every((attempt) => typeof attempt?.retrievedAt === "string")), `expected ${key} exact-ABI attempt retrieval timestamps`);
    for (const exactReport of exactAbiReports(target)) {
      requireAbiFetchAttemptEvidence(failures, "dlmm-provenance.latest.json", exactReport, `${key} ${exactReport.classification}`, {
        requireSnowtraceAndRoutescan: exactReport.classification === "remote_abi_unavailable"
      });
    }
    requireTruthy(failures, "dlmm-provenance.latest.json", target?.statusRecommendation?.startsWith("keep source_backed_abi_candidate"), `expected ${key} keep-source-backed recommendation`);
    if (key === "dlmmRouter") {
      requireTruthy(failures, "dlmm-provenance.latest.json", target?.explorer?.exactAbi?.classification === "remote_abi_unavailable", "expected dlmmRouter exact ABI to remain unavailable");
      requireTruthy(failures, "dlmm-provenance.latest.json", target?.provenanceGate?.exactPublicAbiVerified === false, "expected dlmmRouter exactPublicAbiVerified=false");
      requireTruthy(failures, "dlmm-provenance.latest.json", target?.provenanceGate?.promotionEligible === false, "expected dlmmRouter promotionEligible=false");
      requireTruthy(failures, "dlmm-provenance.latest.json", target?.provenanceGate?.keepSourceBacked === true, "expected dlmmRouter keepSourceBacked=true");
      requireTruthy(
        failures,
        "dlmm-provenance.latest.json",
        (target?.provenanceGate?.promotionBlockers ?? []).includes("target exact public ABI unavailable or mismatched"),
        "expected dlmmRouter exact-public-ABI promotion blocker"
      );
    }
    if (key === "dlmmWavaxUsdc5Pool") {
      requireSourceBackedGate(failures, "dlmm-provenance.latest.json", target, "clone_implementation_selector_backed", "clone_implementation", report.blockNumber, key);
      requireTruthy(failures, "dlmm-provenance.latest.json", Number(target?.targetCodeBytes ?? 0) > 0 && Number(target?.targetCodeBytes ?? 0) < 200, "expected DLMM WAVAX/USDC pool to be a small clone");
      requireTruthy(failures, "dlmm-provenance.latest.json", target?.selectorCheckAddress === byKey(report.targets, "dlmmPoolImplementation")?.address, "expected DLMM clone selectors checked against pool implementation");
      requireTruthy(failures, "dlmm-provenance.latest.json", target?.liveReads?.implementation?.result === byKey(report.targets, "dlmmPoolImplementation")?.address, "expected DLMM clone implementation link");
    } else {
      requireSourceBackedGate(failures, "dlmm-provenance.latest.json", target, "target_runtime_selector_backed", "target_runtime", report.blockNumber, key);
      requireTruthy(failures, "dlmm-provenance.latest.json", target?.selectorCheckAddress === target?.address, `expected ${key} selectors checked against registered runtime`);
      requireTruthy(failures, "dlmm-provenance.latest.json", Number(target?.selectorCodeBytes ?? 0) > 0, `expected ${key} selector code bytes`);
    }
  }
}

if (parsed["acceptance-audit.latest.json"]) {
  const report = parsed["acceptance-audit.latest.json"];
  const walletState = parsed["wallet-state.latest.json"] ?? {};
  const liveReceipts = parsed["live-receipt-provenance.latest.json"] ?? {};
  const liveTraces = parsed["live-trace-provenance.latest.json"] ?? {};
  const registryCoverage = parsed["registry-coverage.latest.json"] ?? {};
  const mcpSmoke = parsed["mcp-smoke.latest.json"] ?? {};
  const abiDiff = parsed["abi-diff.latest.json"] ?? {};
  const forkRehearsal = parsed["fork-rehearsal.latest.json"] ?? {};
  const mixedRouteRehearsal = parsed["mixed-route-rehearsal.latest.json"] ?? {};
  const rewardClaimRehearsal = parsed["reward-claim-rehearsal.latest.json"] ?? {};
  const poolCreationRehearsal = parsed["pool-creation-rehearsal.latest.json"] ?? {};
  const validationReadiness = parsed["validation-readiness.latest.json"] ?? {};
  const protocolGates = parsed["protocol-gates.latest.json"] ?? {};
  const claimability = parsed["claimability.latest.json"] ?? {};
  const operatorIncentives = parsed["operator-incentives.latest.json"] ?? {};
  const sourceProvenance = parsed["source-backed-provenance.latest.json"] ?? {};
  const tokenAnchors = parsed["token-anchors-provenance.latest.json"] ?? {};
  const officialAnchors = parsed["official-anchors-provenance.latest.json"] ?? {};
  const dlmmProvenance = parsed["dlmm-provenance.latest.json"] ?? {};
  const autoVaultProvenance = parsed["autovault-provenance.latest.json"] ?? {};
  const rewardFixtures = parsed["reward-fixtures.latest.json"] ?? {};
  const currentHead = git("rev-parse --short HEAD");
  const parentHead = git("rev-parse --short HEAD^");
  const finalOutput = report.finalOutput ?? {};
  const coverageContext = report.coverageContext ?? {};
  const provenance = finalOutput.coverageSummaryByDomain?.contractsAndProvenance ?? {};
  const unresolvedTargets = provenance.unresolvedTargets ?? [];
	  const officialAddressOnlyAnchors = provenance.officialAddressOnlyAnchors ?? [];
	  const promotionReadyTargets = provenance.promotionReadyTargets ?? [];
	  const finalOutputCurrentState = acceptanceCurrentState(report);
	  const finalOutputNextSteps = acceptanceNextSteps(report);
	  const completionBlockingItems = report.completionBlockingItems ?? [];
  const documentedCaveats = report.documentedCaveats ?? [];
  const expectedCompletionBlockingItems = (report.remainingBlockers ?? []).filter(isCompletionBlocking);
  const expectedDocumentedCaveats = (report.remainingBlockers ?? [])
    .filter((item) => !isCompletionBlocking(item) && (item.blockers ?? []).length > 0);
  const acceptanceCriteriaSatisfied = (report.acceptanceCriteria ?? []).every(acceptanceStatusSatisfied);
  const expectedGoalComplete = report.reportFreshness?.status === "fresh_for_acceptance" &&
    acceptanceCriteriaSatisfied &&
    expectedCompletionBlockingItems.length === 0;
  const expectedOverallStatus = deriveOverallStatus({
    goalComplete: expectedGoalComplete,
    completionBlockingItems: expectedCompletionBlockingItems,
    acceptanceCriteriaSatisfied
  });
  const expectedPromotionReadyTargets = unresolvedTargets
    .filter((target) => target.provenanceGate?.promotionEligible === true)
    .map((target) => ({
      key: target.key,
      status: target.status,
      abiKey: target.abiKey,
      evidenceClass: target.provenanceGate?.evidenceClass ?? null,
      selectorCheckAddress: target.selectorCheckAddress,
      statusRecommendation: target.statusRecommendation,
      promotionBlockers: target.provenanceGate?.promotionBlockers ?? []
    }));
  const sourceTimestamps = report.evidenceSourceTimestamps ?? {};
  const sourceBlocks = report.evidenceSourceBlocks ?? {};
  const provenanceBlocker = report.remainingBlockers?.find((blocker) => blocker.key === "source_backed_abi_caveats");
  const p33Blocker = byKey(report.remainingBlockers, "p33_live_deposit");
  const dlmmBlocker = byKey(report.remainingBlockers, "dlmm_pool_creation");
  const operatorBlocker = byKey(report.remainingBlockers, "operator_incentive_claims");
  const walletRewardBlocker = byKey(report.remainingBlockers, "current_wallet_reward_claims");
  const p33Readiness = validationReadiness.readiness?.p33LiveDepositReady ?? {};
  const p33Gate = validationReadiness.protocolGates?.gates?.p33LiveUnlock ?? {};
  const p33LiveSourceSummary = liveReceipts.summary?.sourceSummaries?.["reports/p33-live.latest.json"] ?? {};
  const p33MintWithdrawLiveSourceSummary = liveReceipts.summary?.sourceSummaries?.["reports/p33-mint-withdraw-live.latest.json"] ?? {};
  const liveReceiptSourceOk = (summary) => {
    const txCount = Number(summary.txCount ?? 0);
    return liveReceipts.ok === true &&
      txCount > 0 &&
      Number(summary.failedCount ?? -1) === 0 &&
      summary.allFromWallet === true &&
      summary.allReceiptSuccess === true &&
      Number(summary.decodedFunctionCount ?? -1) === txCount &&
      Number(summary.contractMatchedFunctionCount ?? -1) === txCount;
  };
  const p33LiveRoundtripValidated = liveReceiptSourceOk(p33LiveSourceSummary) &&
    Number(p33LiveSourceSummary.knownFunctionCounts?.["p33.deposit"] ?? 0) > 0 &&
    Number(p33LiveSourceSummary.knownFunctionCounts?.["p33.redeem"] ?? 0) > 0 &&
    Number(p33LiveSourceSummary.knownEventCounts?.P33Deposit ?? 0) > 0 &&
    Number(p33LiveSourceSummary.knownEventCounts?.P33Withdraw ?? 0) > 0;
  const p33MintWithdrawLiveValidated = liveReceiptSourceOk(p33MintWithdrawLiveSourceSummary) &&
    Number(p33MintWithdrawLiveSourceSummary.knownFunctionCounts?.["p33.mint"] ?? 0) > 0 &&
    Number(p33MintWithdrawLiveSourceSummary.knownFunctionCounts?.["p33.withdraw"] ?? 0) > 0 &&
    Number(p33MintWithdrawLiveSourceSummary.knownEventCounts?.P33Deposit ?? 0) > 0 &&
    Number(p33MintWithdrawLiveSourceSummary.knownEventCounts?.P33Withdraw ?? 0) > 0;
  const p33Complete = p33LiveRoundtripValidated && p33MintWithdrawLiveValidated;
  const p33ClaimabilityDepositQuote = claimability.p33?.depositQuote ?? {};
  const p33ClaimabilityDepositSimulationError = String(p33ClaimabilityDepositQuote.simulation?.error ?? "");
  const p33ReadinessDepositSimulationError = String(validationReadiness.claimability?.p33?.depositQuote?.simulation?.error ?? "");
  const dlmmReadiness = validationReadiness.readiness?.dlmmPoolCreationReady ?? {};
  const dlmmGate = validationReadiness.protocolGates?.gates?.dlmmNormalUserPoolCreation ?? {};
  const walletRewardReadiness = validationReadiness.readiness?.walletRewardClaimReady ?? {};
  const operatorReadiness = validationReadiness.readiness?.operatorIncentiveClaimReady ?? {};
  const claimable = claimability.rewardClaimability ?? {};
  const claimabilityOperator = claimability.operatorIncentiveClaimability ?? {};
  const unresolvedKeys = unresolvedTargets.map((target) => target.key);
  const officialAnchorKeys = officialAddressOnlyAnchors.map((target) => target.key);
  const expectedUnresolvedKeys = [
    "autoVault",
    "accessHub",
    "treasuryHelper",
    "voter",
    "legacyGauge",
    "feeDistributor",
    "feeRecipient",
    "pairFactory",
    "dlmmRouter",
    "dlmmFactory",
    "dlmmPoolImplementation",
    "dlmmRewarderImplementation",
    "dlmmWavaxUsdc5Pool"
  ];
  const expectedOfficialAnchorKeys = [
    "timelockController",
    "pharaohTeamMultisig",
    "proxyAdmin",
    "ramsesV3PoolDeployer",
    "ramsesV3FactoryInitializedDeployer",
    "nonfungibleTokenPositionDescriptor",
    "usdcNative"
  ];
  requireTruthy(failures, "acceptance-audit.latest.json", report.ok === true, "expected top-level ok=true");
  requireTruthy(failures, "acceptance-audit.latest.json", report.goalComplete === expectedGoalComplete, "expected goalComplete to derive from freshness, acceptance criteria, and completionBlockingItems");
  requireTruthy(failures, "acceptance-audit.latest.json", report.overallStatus === expectedOverallStatus, "expected overallStatus to derive from completionBlockingItems and acceptance criteria");
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    report.git?.head === currentHead || report.git?.head === parentHead,
    `expected acceptance audit git.head (${report.git?.head ?? "missing"}) to match current HEAD (${currentHead}) or parent checkpoint (${parentHead})`
  );
	  requireTruthy(failures, "acceptance-audit.latest.json", typeof finalOutput === "object" && finalOutput !== null, "expected finalOutput object");
	  requireTruthy(failures, "acceptance-audit.latest.json", typeof finalOutput.coverageSummaryByDomain === "object", "expected finalOutput.coverageSummaryByDomain");
	  const userFlowMatrix = finalOutput.userFlowCoverageMatrix;
	  const userFlowRows = userFlowMatrix?.flows ?? [];
	  const userFlowKeys = userFlowRows.map((flow) => flow.flowKey);
	  const userFlowByKey = Object.fromEntries(userFlowRows.map((flow) => [flow.flowKey, flow]));
	  requireTruthy(failures, "acceptance-audit.latest.json", typeof userFlowMatrix === "object" && userFlowMatrix !== null, "expected finalOutput.userFlowCoverageMatrix");
	  requireDeepEqual(failures, "acceptance-audit.latest.json", finalOutput.coverageSummaryByDomain?.userFlows, userFlowMatrix, "expected coverageSummaryByDomain.userFlows to mirror finalOutput.userFlowCoverageMatrix");
	  requireDeepEqual(failures, "acceptance-audit.latest.json", report.coverageByDomain?.userFlows, userFlowMatrix, "expected coverageByDomain.userFlows to mirror finalOutput.userFlowCoverageMatrix");
	  requireStringSetEqual(failures, "acceptance-audit.latest.json", userFlowMatrix?.requiredFlowKeys, requiredGoalUserFlowKeys, "expected exact required goal user-flow key list");
	  requireStringSetEqual(failures, "acceptance-audit.latest.json", userFlowMatrix?.additionalTrackedFlowKeys, additionalTrackedUserFlowKeys, "expected exact additional tracked user-flow key list");
	  requireSetIncludes(failures, "acceptance-audit.latest.json", userFlowKeys, requiredGoalUserFlowKeys, "expected finalOutput user-flow rows for every required goal flow");
	  requireSetIncludes(failures, "acceptance-audit.latest.json", userFlowKeys, additionalTrackedUserFlowKeys, "expected finalOutput user-flow rows for tracked caveated flows");
	  requireTruthy(failures, "acceptance-audit.latest.json", Number(userFlowMatrix?.summary?.total ?? -1) === userFlowRows.length, "expected user-flow total summary to match row count");
	  requireTruthy(failures, "acceptance-audit.latest.json", Number(userFlowMatrix?.summary?.required ?? -1) === requiredGoalUserFlowKeys.length, "expected user-flow required summary to match required key count");
	  requireTruthy(failures, "acceptance-audit.latest.json", Number(userFlowMatrix?.summary?.additionalTracked ?? -1) === additionalTrackedUserFlowKeys.length, "expected user-flow additional summary to match additional key count");
	  for (const row of userFlowRows) {
	    requireTruthy(
	      failures,
	      "acceptance-audit.latest.json",
	      typeof row?.flowKey === "string" &&
	        typeof row?.goalName === "string" &&
	        typeof row?.status === "string" &&
	        typeof row?.readCoverage === "object" &&
	        typeof row?.builderCoverage === "object" &&
	        typeof row?.approvalCoverage === "object" &&
	        typeof row?.quoteCoverage === "object" &&
	        typeof row?.discoveryCoverage === "object" &&
	        typeof row?.liquidityCoverage === "object" &&
	        Array.isArray(row?.evidenceReports) &&
	        row.evidenceReports.length > 0 &&
	        Array.isArray(row?.txHashes) &&
	        Array.isArray(row?.blockers),
	      `expected complete user-flow row shape for ${row?.flowKey ?? "unknown"}`
	    );
	    if ((row?.blockers ?? []).length > 0) {
	      requireTruthy(failures, "acceptance-audit.latest.json", row.status.includes("state_gate") || row.status === "covered_with_current_state_gate", `expected blocked user-flow row ${row.flowKey} to be state-gated`);
	    }
	    if (row?.liveValidation?.ok === true) {
	      requireTruthy(failures, "acceptance-audit.latest.json", Number(row.liveValidation.txCount ?? 0) > 0 && row.txHashes.length > 0, `expected live-covered user-flow ${row.flowKey} to expose tx hashes`);
	    }
	    if (String(row?.status ?? "").includes("live_read")) {
	      requireTruthy(failures, "acceptance-audit.latest.json", row.readOnlyLiveCoverage?.ok === true && (row.readOnlyLiveCoverage.evidenceReports ?? []).length > 0, `expected live-read user-flow ${row.flowKey} to expose readonly evidence`);
	    }
	  }
	  const quoteRow = userFlowByKey.quotes;
	  const poolDiscoveryRow = userFlowByKey.pool_discovery;
	  const rewardDiscoveryRow = userFlowByKey.reward_discovery;
	  requireTruthy(failures, "acceptance-audit.latest.json", quoteRow?.status === "live_read_proven", "expected quotes flow to be live-read proven");
	  requireTruthy(failures, "acceptance-audit.latest.json", quoteRow?.readOnlyLiveCoverage?.summary?.quoteSuccesses === parsed["cl-quote.latest.json"]?.summary?.quoteSuccesses, "expected quote live-read summary parity with cl-quote report");
	  requireZero(failures, "acceptance-audit.latest.json", quoteRow?.txHashes?.length, "expected readonly quotes flow not to expose execution tx hashes");
	  requireTruthy(failures, "acceptance-audit.latest.json", poolDiscoveryRow?.status === "live_read_proven", "expected pool discovery flow to be live-read proven");
	  requireTruthy(failures, "acceptance-audit.latest.json", poolDiscoveryRow?.readOnlyLiveCoverage?.summary?.failures === parsed["pool-discovery.latest.json"]?.summary?.failures, "expected pool discovery live-read summary parity with pool-discovery report");
	  requireZero(failures, "acceptance-audit.latest.json", poolDiscoveryRow?.txHashes?.length, "expected readonly pool discovery flow not to expose execution tx hashes");
	  requireTruthy(failures, "acceptance-audit.latest.json", rewardDiscoveryRow?.status === "live_read_and_fixture_proven", "expected reward discovery flow to be live-read and fixture proven");
	  requireTruthy(failures, "acceptance-audit.latest.json", rewardDiscoveryRow?.readOnlyLiveCoverage?.summary?.claimable === parsed["claimability.latest.json"]?.rewardClaimability?.claimable, "expected reward discovery claimability parity");
	  requireZero(failures, "acceptance-audit.latest.json", rewardDiscoveryRow?.txHashes?.length, "expected readonly reward discovery flow not to expose execution tx hashes");
	  const approvalRow = userFlowByKey.approvals;
	  const approvalStandards = approvalRow?.approvalEncodingCoverageByStandard?.standards ?? {};
	  requireTruthy(
	    failures,
	    "acceptance-audit.latest.json",
	    approvalRow?.approvalEncodingCoverageByStandard?.ok === true &&
	      ["erc20", "erc721Approve", "erc721SetApprovalForAll", "erc1155SetApprovalForAll", "dlmmPoolApproveForAll", "requiredApprovalsPlanner"]
	        .every((key) => approvalStandards[key]?.ok === true),
	    "expected approvals flow to expose encoding coverage by token standard"
	  );
	  requireTruthy(failures, "acceptance-audit.latest.json", Array.isArray(finalOutput.liveTransactionHashes), "expected finalOutput.liveTransactionHashes array");
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.liveTransactionHashes?.every((tx) =>
      typeof tx?.hash === "string" &&
      typeof tx?.proved === "string" &&
      tx.proved.length > 0 &&
      tx.proofEvidence?.receiptReport === "reports/live-receipt-provenance.latest.json" &&
      tx.proofEvidence?.fromExpendableWalletRequired === true
    ) === true,
    "expected every live transaction hash to include what it proved and receipt evidence"
  );
  requireTruthy(failures, "acceptance-audit.latest.json", typeof finalOutput.forkSimulationSummary === "object", "expected finalOutput.forkSimulationSummary");
  requireTruthy(failures, "acceptance-audit.latest.json", Array.isArray(finalOutput.verificationCommandsAndResults), "expected finalOutput.verificationCommandsAndResults array");
  requireTruthy(failures, "acceptance-audit.latest.json", Array.isArray(finalOutput.verificationCommands), "expected finalOutput.verificationCommands array");
  requireDeepEqual(failures, "acceptance-audit.latest.json", finalOutput.verificationCommands, report.verificationCommands, "expected finalOutput.verificationCommands to match top-level verificationCommands");
  const verificationCommands = finalOutput.verificationCommands ?? [];
  const acceptanceCommandIndex = verificationCommands.indexOf("npm run reports:acceptance-audit");
  const postAcceptanceSmokeCommandIndex = verificationCommands.indexOf("npm run smoke:mcp:report");
  const integrityCommandIndex = verificationCommands.indexOf("npm run reports:integrity");
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    acceptanceCommandIndex >= 0 &&
      postAcceptanceSmokeCommandIndex > acceptanceCommandIndex &&
      integrityCommandIndex > postAcceptanceSmokeCommandIndex,
    "expected finalOutput verification checklist to run post-acceptance MCP smoke before integrity"
  );
  requireTruthy(failures, "acceptance-audit.latest.json", Array.isArray(finalOutput.filesChanged?.paths), "expected finalOutput.filesChanged.paths array");
  requireDeepEqual(failures, "acceptance-audit.latest.json", finalOutput.filesChanged, report.filesChanged, "expected finalOutput.filesChanged to match top-level filesChanged");
  requireTruthy(failures, "acceptance-audit.latest.json", finalOutput.filesChanged?.headCommit === report.git?.head, "expected filesChanged.headCommit to match report.git.head");
  requireTruthy(failures, "acceptance-audit.latest.json", Array.isArray(finalOutput.filesChanged?.committedPaths), "expected finalOutput.filesChanged.committedPaths array");
  requireTruthy(failures, "acceptance-audit.latest.json", typeof finalOutput.filesChanged?.dirty === "boolean", "expected finalOutput.filesChanged.dirty boolean");
  requireTruthy(failures, "acceptance-audit.latest.json", Array.isArray(finalOutput.filesChanged?.dirtyStatusShort), "expected finalOutput.filesChanged.dirtyStatusShort array");
  requireTruthy(failures, "acceptance-audit.latest.json", Array.isArray(finalOutput.filesChanged?.dirtyPaths), "expected finalOutput.filesChanged.dirtyPaths array");
  requireTruthy(failures, "acceptance-audit.latest.json", Array.isArray(finalOutput.filesChanged?.worktreeStatus), "expected finalOutput.filesChanged.worktreeStatus array");
  requireTruthy(failures, "acceptance-audit.latest.json", Array.isArray(finalOutput.filesChanged?.worktreePaths), "expected finalOutput.filesChanged.worktreePaths array");
  const expectedWorktreeStatus = gitStatusEntries(report.git?.statusShort ?? []);
  const expectedWorktreePaths = uniqueStrings(expectedWorktreeStatus.map((entry) => entry.path));
  const expectedCommittedPaths = finalOutput.filesChanged?.baselineCommit && finalOutput.filesChanged?.headCommit
    ? uniqueStrings(git(`diff --name-only ${finalOutput.filesChanged.baselineCommit}..${finalOutput.filesChanged.headCommit}`)?.split("\n") ?? [])
    : [];
  requireStringSetEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.filesChanged?.committedPaths,
    expectedCommittedPaths,
    "expected finalOutput.filesChanged.committedPaths to match baselineCommit..headCommit git diff"
  );
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.filesChanged?.dirtyStatusShort,
    report.git?.statusShort ?? [],
    "expected finalOutput.filesChanged.dirtyStatusShort to match report.git.statusShort"
  );
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.filesChanged?.worktreeStatus,
    expectedWorktreeStatus,
    "expected finalOutput.filesChanged.worktreeStatus to derive from report.git.statusShort"
  );
  requireStringSetEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.filesChanged?.worktreePaths,
    expectedWorktreePaths,
    "expected finalOutput.filesChanged.worktreePaths to derive from report.git.statusShort"
  );
  requireStringSetEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.filesChanged?.dirtyPaths,
    expectedWorktreePaths,
    "expected finalOutput.filesChanged.dirtyPaths to derive from report.git.statusShort"
  );
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.filesChanged?.dirty === (expectedWorktreeStatus.length > 0),
    "expected finalOutput.filesChanged.dirty to match report.git.statusShort emptiness"
  );
  if (report.git?.head && currentHead && report.git.head !== currentHead) {
    const currentHeadDeltaPaths = uniqueStrings(git(`diff --name-only ${report.git.head}..${currentHead}`)?.split("\n") ?? []);
    requireSetIncludes(
      failures,
      "acceptance-audit.latest.json",
      finalOutput.filesChanged?.worktreePaths,
      currentHeadDeltaPaths,
      "expected parent-head acceptance report to have captured current checkpoint delta paths as dirty worktree paths"
    );
  }
  requireStringSetEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.filesChanged?.paths,
    uniqueStrings([...(finalOutput.filesChanged?.committedPaths ?? []), ...expectedWorktreePaths]),
    "expected finalOutput.filesChanged.paths to union committedPaths and current worktree paths"
  );
  requireTruthy(failures, "acceptance-audit.latest.json", typeof finalOutput.currentWalletBalancesAndApprovals === "object", "expected finalOutput.currentWalletBalancesAndApprovals");
  requireTruthy(failures, "acceptance-audit.latest.json", typeof finalOutput.fundingTopUpRequest === "object" && finalOutput.fundingTopUpRequest !== null, "expected finalOutput.fundingTopUpRequest");
  requireDeepEqual(failures, "acceptance-audit.latest.json", finalOutput.remainingBlockers, report.remainingBlockers, "expected finalOutput.remainingBlockers to match top-level remainingBlockers");
  requireDeepEqual(failures, "acceptance-audit.latest.json", finalOutput.coverageContext, report.coverageContext, "expected finalOutput.coverageContext to match top-level coverageContext");
  requireDeepEqual(failures, "acceptance-audit.latest.json", completionBlockingItems, expectedCompletionBlockingItems, "expected top-level completionBlockingItems to derive from remainingBlockers");
  requireDeepEqual(failures, "acceptance-audit.latest.json", documentedCaveats, expectedDocumentedCaveats, "expected top-level documentedCaveats to derive from non-blocking remainingBlockers");
  requireDeepEqual(failures, "acceptance-audit.latest.json", finalOutput.completionBlockingItems, report.completionBlockingItems, "expected finalOutput.completionBlockingItems to match top-level completionBlockingItems");
  requireDeepEqual(failures, "acceptance-audit.latest.json", finalOutput.documentedCaveats, report.documentedCaveats, "expected finalOutput.documentedCaveats to match top-level documentedCaveats");
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.resolvedVsRemainingIncompleteComponents?.remainingBlockers,
    report.remainingBlockers,
    "expected finalOutput resolved/remaining component blockers to match top-level remainingBlockers"
  );
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.resolvedVsRemainingIncompleteComponents?.completionBlockingItems,
    report.completionBlockingItems,
    "expected finalOutput resolved/remaining completion blockers to match top-level completionBlockingItems"
  );
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.resolvedVsRemainingIncompleteComponents?.documentedCaveats,
    report.documentedCaveats,
    "expected finalOutput resolved/remaining caveats to match top-level documentedCaveats"
  );
  const walletPositions = walletState.walletPositions ?? {};
  const walletPositionSummary = walletState.walletPositionSummary ?? {};
  const walletProtocol = walletPositions.protocol ?? {};
  const clResult = walletProtocol.clNfts?.result ?? {};
  const clTokenIds = (clResult.tokenIds ?? []).map((id) => String(id));
  const dlmmPools = Array.isArray(walletProtocol.dlmmPools) ? walletProtocol.dlmmPools : [];
  const dlmmIdsCheckedCount = dlmmPools.reduce((sum, pool) => sum + Number(pool?.idsChecked?.length ?? 0), 0);
  const dlmmNonzeroBinBalanceCount = dlmmPools.reduce((sum, pool) => sum + Number(pool?.nonzeroBalances?.length ?? 0), 0);
  const rewardResult = walletProtocol.rewards?.result ?? {};
  const expectedApprovalCleanupSummary = approvalCleanupSummaryFromRows(walletState.allowances, walletState.dlmmPoolApprovals);
  requireDeepEqual(failures, "wallet-state.latest.json", walletState.approvalCleanupSummary, expectedApprovalCleanupSummary, "expected wallet approval cleanup summary to derive from tracked allowance and DLMM approval rows");
  requireTruthy(failures, "wallet-state.latest.json", walletState.approvalsCleared === expectedApprovalCleanupSummary.approvalsCleared, "expected wallet-state approvalsCleared to match approval cleanup summary");
  requireTruthy(failures, "wallet-state.latest.json", walletState.approvalCleanupSummary?.approvalReadFailureCount === 0, "expected wallet-state approval cleanup reads to succeed");
  requireTruthy(failures, "wallet-state.latest.json", typeof walletState.walletPositionSummary === "object" && walletState.walletPositionSummary !== null, "expected wallet-state walletPositionSummary");
  requireTruthy(failures, "wallet-state.latest.json", typeof walletState.walletPositions === "object" && walletState.walletPositions !== null, "expected wallet-state walletPositions evidence");
  requireTruthy(failures, "wallet-state.latest.json", walletState.walletPositions?.account === walletState.wallet, "expected walletPositions account to match wallet");
  requireTruthy(failures, "wallet-state.latest.json", Array.isArray(walletState.walletPositions?.tokens) && walletState.walletPositions.tokens.length >= 6, "expected walletPositions tracked token inventory");
  requireTruthy(failures, "wallet-state.latest.json", Array.isArray(walletState.walletPositions?.spenders) && walletState.walletPositions.spenders.length >= 8, "expected walletPositions spender inventory");
  const autoVaultWalletToken = (walletState.walletPositions?.tokens ?? []).find((token) => token?.symbol === "AutoVault");
  requireTruthy(failures, "wallet-state.latest.json", autoVaultWalletToken?.balance?.ok === true, "expected walletPositions AutoVault share balance read to pass");
  requireTruthy(failures, "wallet-state.latest.json", autoVaultWalletToken?.erc20MetadataSupported === false, "expected walletPositions AutoVault ERC20 metadata probe to be marked unsupported");
  requireTruthy(failures, "wallet-state.latest.json", autoVaultWalletToken?.chainSymbol?.skipped === true, "expected walletPositions AutoVault symbol read to be skipped");
  requireTruthy(failures, "wallet-state.latest.json", autoVaultWalletToken?.erc20AllowancesSupported === false, "expected walletPositions AutoVault ERC20 allowances to be marked unsupported");
  requireTruthy(failures, "wallet-state.latest.json", Array.isArray(autoVaultWalletToken?.allowances) && autoVaultWalletToken.allowances.length === 0, "expected walletPositions AutoVault allowances to be skipped without revert rows");
  requireTruthy(failures, "wallet-state.latest.json", walletState.walletPositions?.protocol?.autoVault?.ok === true, "expected walletPositions AutoVault source-backed protocol read to pass");
  requireTruthy(failures, "wallet-state.latest.json", walletState.walletPositions?.protocol?.autoVault?.result?.accountState?.sharesBalance?.ok === true, "expected walletPositions AutoVault source-backed sharesBalance to pass");
  requireTruthy(failures, "wallet-state.latest.json", walletState.walletPositions?.protocol?.clNfts?.ok === true, "expected walletPositions CL NFT discovery to pass");
  requireTruthy(failures, "wallet-state.latest.json", Array.isArray(walletState.walletPositions?.protocol?.clNfts?.result?.positions), "expected walletPositions CL NFT positions array");
  requireTruthy(failures, "wallet-state.latest.json", Array.isArray(walletState.walletPositions?.protocol?.dlmmPools) && walletState.walletPositions.protocol.dlmmPools.length >= 1, "expected walletPositions DLMM pool evidence");
  requireTruthy(failures, "wallet-state.latest.json", walletState.walletPositions?.protocol?.rewards?.ok === true, "expected walletPositions reward claimability call to pass");
  requireTruthy(failures, "wallet-state.latest.json", walletState.walletPositionSummary?.account === walletState.wallet, "expected walletPositionSummary account to match wallet");
  requireTruthy(failures, "wallet-state.latest.json", Number(walletPositionSummary?.tokenCount ?? -1) === Number(walletPositions?.tokens?.length ?? -2), "expected walletPositionSummary token count parity");
  requireTruthy(failures, "wallet-state.latest.json", Number(walletPositionSummary?.spenderCount ?? -1) === Number(walletPositions?.spenders?.length ?? -2), "expected walletPositionSummary spender count parity");
  requireDeepEqual(failures, "wallet-state.latest.json", walletPositionSummary?.clNfts?.discoveredTokenIds, clTokenIds, "expected walletPositionSummary CL token id parity");
  requireTruthy(
    failures,
    "wallet-state.latest.json",
    walletPositionSummary?.clNfts?.balanceRaw === (clResult?.balance?.ok === true ? String(clResult.balance.result) : null),
    "expected walletPositionSummary CL balance parity"
  );
  requireTruthy(failures, "wallet-state.latest.json", walletPositionSummary?.clNfts?.truncated === Boolean(clResult?.truncated), "expected walletPositionSummary CL truncation parity");
  requireTruthy(failures, "wallet-state.latest.json", walletPositionSummary?.clNfts?.hasActivePositions === (clTokenIds.length > 0), "expected walletPositionSummary CL active-position parity");
  requireTruthy(
    failures,
    "wallet-state.latest.json",
    Number(walletState.walletPositionSummary?.clNfts?.positionCount ?? -1) === Number(walletState.walletPositions?.protocol?.clNfts?.result?.positions?.length ?? -2),
    "expected walletPositionSummary CL position count parity"
  );
  requireTruthy(
    failures,
    "wallet-state.latest.json",
    Number(walletState.walletPositionSummary?.dlmmPools?.poolCount ?? -1) === Number(walletState.walletPositions?.protocol?.dlmmPools?.length ?? -2),
    "expected walletPositionSummary DLMM pool count parity"
  );
  requireTruthy(failures, "wallet-state.latest.json", Number(walletPositionSummary?.dlmmPools?.idsCheckedCount ?? -1) === dlmmIdsCheckedCount, "expected walletPositionSummary DLMM idsChecked count parity");
  requireTruthy(failures, "wallet-state.latest.json", Number(walletPositionSummary?.dlmmPools?.nonzeroBinBalanceCount ?? -1) === dlmmNonzeroBinBalanceCount, "expected walletPositionSummary DLMM nonzero bin count parity");
  requireTruthy(failures, "wallet-state.latest.json", walletPositionSummary?.dlmmPools?.hasNonzeroBinBalances === (dlmmNonzeroBinBalanceCount > 0), "expected walletPositionSummary DLMM nonzero-bin boolean parity");
  for (const [poolIndex, pool] of dlmmPools.entries()) {
    const summaryPool = walletPositionSummary?.dlmmPools?.pools?.[poolIndex] ?? {};
    const idsChecked = (pool?.idsChecked ?? []).map((id) => String(id));
    const nonzeroBalances = (pool?.nonzeroBalances ?? []).map((entry) => ({
      id: entry?.id?.toString?.() ?? String(entry?.id),
      balanceRaw: entry?.balance?.ok === true ? String(entry.balance.result) : null
    }));
    requireTruthy(failures, "wallet-state.latest.json", summaryPool.pair === pool?.pair, `expected walletPositionSummary DLMM pool ${poolIndex} pair parity`);
    requireTruthy(failures, "wallet-state.latest.json", summaryPool.operator === pool?.operator, `expected walletPositionSummary DLMM pool ${poolIndex} operator parity`);
    requireTruthy(failures, "wallet-state.latest.json", summaryPool.rewarder === pool?.rewarder, `expected walletPositionSummary DLMM pool ${poolIndex} rewarder parity`);
    requireTruthy(failures, "wallet-state.latest.json", Number(summaryPool.idsCheckedCount ?? -1) === idsChecked.length, `expected walletPositionSummary DLMM pool ${poolIndex} idsChecked count parity`);
    requireDeepEqual(failures, "wallet-state.latest.json", summaryPool.idsChecked, idsChecked, `expected walletPositionSummary DLMM pool ${poolIndex} idsChecked parity`);
    requireTruthy(failures, "wallet-state.latest.json", Number(summaryPool.nonzeroBinBalanceCount ?? -1) === nonzeroBalances.length, `expected walletPositionSummary DLMM pool ${poolIndex} nonzero count parity`);
    requireDeepEqual(failures, "wallet-state.latest.json", summaryPool.nonzeroBinBalances, nonzeroBalances, `expected walletPositionSummary DLMM pool ${poolIndex} nonzero balance parity`);
    requireTruthy(failures, "wallet-state.latest.json", summaryPool.rangeScanTruncated === Boolean(pool?.rangeScanTruncated), `expected walletPositionSummary DLMM pool ${poolIndex} truncation parity`);
    requireDeepEqual(failures, "wallet-state.latest.json", summaryPool.isApprovedForAll, pool?.isApprovedForAll, `expected walletPositionSummary DLMM pool ${poolIndex} approval parity`);
  }
  requireTruthy(
    failures,
    "wallet-state.latest.json",
    walletState.walletPositionSummary?.rewardClaimability?.claimable === walletState.walletPositions?.protocol?.rewards?.result?.claimable,
    "expected walletPositionSummary reward claimability parity"
  );
  requireDeepEqual(failures, "wallet-state.latest.json", walletPositionSummary?.rewardClaimability?.blockers, rewardResult?.blockers ?? [], "expected walletPositionSummary reward blocker parity");
  requireDeepEqual(failures, "wallet-state.latest.json", walletPositionSummary?.rewardClaimability?.rewardContext, walletProtocol.rewardContext ?? null, "expected walletPositionSummary reward context parity");
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.currentWalletBalancesAndApprovals?.positionSummary,
    walletState.walletPositionSummary,
    "expected acceptance wallet position summary to match wallet-state"
  );
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.currentWalletBalancesAndApprovals?.walletPositionsScan,
    walletState.walletPositionsScan,
    "expected acceptance wallet scan controls to match wallet-state"
  );
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.currentWalletBalancesAndApprovals?.approvalCleanupSummary,
    walletState.approvalCleanupSummary,
    "expected acceptance wallet approval cleanup summary to match wallet-state"
  );
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.currentWalletBalancesAndApprovals?.approvalsCleared === walletState.approvalCleanupSummary?.approvalsCleared,
    "expected acceptance approvalsCleared to match wallet-state approval cleanup summary"
  );
  requireTruthy(failures, "acceptance-audit.latest.json", Array.isArray(finalOutput.verificationWarnings), "expected finalOutput.verificationWarnings array");
  requireTruthy(failures, "acceptance-audit.latest.json", typeof finalOutput.readinessStatement === "string", "expected finalOutput.readinessStatement");
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.evidenceSourceTimestamps,
    sourceTimestamps,
    "expected finalOutput evidenceSourceTimestamps to match top-level evidenceSourceTimestamps"
  );
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.evidenceSourceBlocks,
    sourceBlocks,
    "expected finalOutput evidenceSourceBlocks to match top-level evidenceSourceBlocks"
  );
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.reportFreshness,
    report.reportFreshness,
    "expected finalOutput reportFreshness to match top-level reportFreshness"
  );
	  requireDeepEqual(
	    failures,
	    "acceptance-audit.latest.json",
	    finalOutputCurrentState.reportFreshness,
	    finalOutput.reportFreshness,
	    "expected final output current state reportFreshness to match finalOutput reportFreshness"
	  );
	  requireDeepEqual(
	    failures,
	    "acceptance-audit.latest.json",
	    finalOutputCurrentState.refreshCommands,
	    finalOutput.reportFreshness?.refreshCommands,
	    "expected final output current state refreshCommands to match reportFreshness refreshCommands"
	  );
  const expectedEvidenceTimestamps = {
    wallet: walletState.timestamp,
    liveReceipts: liveReceipts.timestamp,
    registryCoverage: registryCoverage.timestamp,
    mcpSmoke: mcpSmoke.timestamp,
    abiDiff: abiDiff.timestamp,
    forkRehearsal: forkRehearsal.timestamp,
    mixedRouteRehearsal: mixedRouteRehearsal.timestamp,
    rewardClaimRehearsal: rewardClaimRehearsal.timestamp,
    poolCreationRehearsal: poolCreationRehearsal.timestamp,
    validationReadiness: validationReadiness.timestamp,
    validationReadinessProtocolGates: validationReadiness.protocolGates?.timestamp,
    validationReadinessClaimability: validationReadiness.claimability?.timestamp,
    validationReadinessOperatorIncentives: validationReadiness.operatorIncentives?.timestamp,
    protocolGates: protocolGates.timestamp,
    claimability: claimability.timestamp,
    operatorIncentives: operatorIncentives.timestamp,
    sourceProvenance: sourceProvenance.timestamp,
    tokenAnchors: tokenAnchors.timestamp,
    officialAnchors: officialAnchors.timestamp,
    dlmmProvenance: dlmmProvenance.timestamp,
    autoVaultProvenance: autoVaultProvenance.timestamp,
    rewardFixtures: rewardFixtures.timestamp
  };
  const mcpAcceptanceSmokeSummary = mcpSmoke.results
    ?.find((item) => item.name === "pharaoh_acceptance_status_read")
    ?.responseSummary;
  const mcpSmokeCoversCurrentAcceptance = mcpAcceptanceSmokeSummary?.timestamp === report.timestamp &&
    timestampMs(mcpSmoke.timestamp) !== null &&
    timestampMs(report.timestamp) !== null &&
    timestampMs(mcpSmoke.timestamp) >= timestampMs(report.timestamp);
  for (const [key, expected] of Object.entries(expectedEvidenceTimestamps)) {
    if (key === "mcpSmoke" && mcpSmokeCoversCurrentAcceptance) {
      requireTimestamp(
        failures,
        "acceptance-audit.latest.json",
        sourceTimestamps[key],
        "expected acceptance evidenceSourceTimestamps.mcpSmoke to retain the report-time smoke timestamp"
      );
      continue;
    }
    requireTimestampMatch(
      failures,
      "acceptance-audit.latest.json",
      sourceTimestamps[key],
      expected,
      `expected acceptance evidenceSourceTimestamps.${key} to match source report`
    );
  }
  const currentStateFreshnessKeys = [
    "wallet",
    "validationReadiness",
    "validationReadinessProtocolGates",
    "validationReadinessClaimability",
    "validationReadinessOperatorIncentives",
    "protocolGates",
    "claimability",
    "operatorIncentives"
  ];
  const reportFreshness = finalOutput.reportFreshness ?? {};
  requireTruthy(failures, "acceptance-audit.latest.json", reportFreshness.acceptanceTimestamp === report.timestamp, "expected reportFreshness acceptanceTimestamp to match report timestamp");
  requireTruthy(failures, "acceptance-audit.latest.json", reportFreshness.status === "fresh_for_acceptance", "expected reportFreshness status fresh_for_acceptance");
  requireTruthy(failures, "acceptance-audit.latest.json", Number(reportFreshness.maxAgeMinutes ?? 0) === 90, "expected reportFreshness maxAgeMinutes=90");
  requireStringSetEqual(
    failures,
    "acceptance-audit.latest.json",
    (reportFreshness.currentStateReports ?? []).map((item) => item.key),
    currentStateFreshnessKeys,
    "expected reportFreshness current state report keys"
  );
  requireSetIncludes(
    failures,
    "acceptance-audit.latest.json",
    Object.keys(reportFreshness.refreshCommands ?? {}),
    ["wallet", "validationReadiness", "protocolGates", "claimability", "operatorIncentives"],
    "expected reportFreshness refresh commands for every current-state source family"
  );
  for (const key of currentStateFreshnessKeys) {
    const item = byKey(reportFreshness.currentStateReports, key);
    requireTruthy(failures, "acceptance-audit.latest.json", item?.timestamp === sourceTimestamps[key], `expected reportFreshness ${key} timestamp parity`);
    requireTruthy(failures, "acceptance-audit.latest.json", item?.status === "fresh", `expected reportFreshness ${key} status fresh`);
    const acceptanceMs = timestampMs(report.timestamp);
    const evidenceMs = timestampMs(item?.timestamp);
    requireTruthy(failures, "acceptance-audit.latest.json", acceptanceMs !== null && evidenceMs !== null && evidenceMs <= acceptanceMs, `expected reportFreshness ${key} not after acceptance timestamp`);
    requireTruthy(
      failures,
      "acceptance-audit.latest.json",
      typeof item?.ageMinutes === "number" && item.ageMinutes >= 0 && item.ageMinutes <= Number(reportFreshness.maxAgeMinutes ?? 0),
      `expected reportFreshness ${key} age within maxAgeMinutes`
    );
  }
  const expectedEvidenceBlocks = {
    liveTraceBlock: liveTraces.blockNumber ?? null,
    sourceProvenance: sourceProvenance.blockNumber ?? null,
    dlmmProvenance: dlmmProvenance.blockNumber ?? null,
    autoVaultProvenance: autoVaultProvenance.blockNumber ?? null,
    rewardFixturesLatestBlock: rewardFixtures.latestBlock ?? null,
    rewardClaimRehearsalForkStartBlock: rewardClaimRehearsal.forkStartBlock ?? null,
    rewardClaimRehearsalFixtureLatestBlock: rewardClaimRehearsal.fixtureLatestBlock ?? null,
    poolCreationRehearsalForkStartBlock: poolCreationRehearsal.forkStartBlock ?? null,
    poolCreationRehearsalFixtureLatestBlock: poolCreationRehearsal.fixtureLatestBlock ?? null
  };
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    sourceBlocks,
    expectedEvidenceBlocks,
    "expected acceptance evidenceSourceBlocks to match source report block anchors"
  );
  const criticalFreshnessMs = 90 * 60_000;
  for (const key of [
    "wallet",
    "liveReceipts",
    "registryCoverage",
    "mcpSmoke",
    "abiDiff",
    "validationReadiness",
    "protocolGates",
    "claimability",
    "operatorIncentives",
    "sourceProvenance",
    "tokenAnchors",
    "officialAnchors",
    "dlmmProvenance",
    "autoVaultProvenance",
    "rewardFixtures"
  ]) {
    requireFreshEvidence(
      failures,
      "acceptance-audit.latest.json",
      report.timestamp,
      sourceTimestamps[key],
      criticalFreshnessMs,
      `expected current evidenceSourceTimestamps.${key} to be refreshed near the acceptance audit`
    );
  }
  for (const [key, provenanceReport] of Object.entries({
    abiDiff,
    sourceProvenance,
    tokenAnchors,
    officialAnchors,
    dlmmProvenance,
    autoVaultProvenance
  })) {
    requireNotOlderThan(
      failures,
      "acceptance-audit.latest.json",
      provenanceReport.timestamp,
      registryCoverage.timestamp,
      `expected ${key} evidence to be at least as fresh as registry coverage`
    );
  }
  if (!mcpSmokeCoversCurrentAcceptance) {
    requireTimestampMatch(
      failures,
      "acceptance-audit.latest.json",
      byCommand(finalOutput.verificationCommandsAndResults, "npm run smoke:mcp:report")?.timestamp,
      mcpSmoke.timestamp,
      "expected smoke command timestamp to match mcp-smoke.latest.json"
    );
  }
  requireTimestampMatch(
    failures,
    "acceptance-audit.latest.json",
    byCommand(finalOutput.verificationCommandsAndResults, "npm run diff:abi:report")?.timestamp,
    abiDiff.timestamp,
    "expected ABI diff command timestamp to match abi-diff.latest.json"
  );
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.coverageSummaryByDomain?.liveWalletValidation?.receiptSummary?.txCount === liveReceipts.summary?.txCount &&
      liveReceipts.ok === true,
    "expected acceptance live wallet validation to include successful live receipt provenance summary"
  );
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.coverageSummaryByDomain?.liveWalletValidation?.calldataFunctionSummary?.decodedFunctionCount === liveReceipts.summary?.decodedFunctionCount &&
      finalOutput.coverageSummaryByDomain?.liveWalletValidation?.calldataFunctionSummary?.unknownSelectorCount === 0,
    "expected acceptance live wallet validation to include successful calldata function provenance summary"
  );
  requireTimestampMatch(
    failures,
    "acceptance-audit.latest.json",
    sourceTimestamps.liveTraces,
    liveTraces.timestamp,
    "expected acceptance evidenceSourceTimestamps.liveTraces to match source report"
  );
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.coverageSummaryByDomain?.liveWalletValidation?.traceSummary?.fallbackComplete === liveTraces.summary?.fallbackComplete &&
      finalOutput.coverageSummaryByDomain?.liveWalletValidation?.traceSummary?.allTraceMethodsUnavailable === liveTraces.summary?.allTraceMethodsUnavailable,
    "expected acceptance live wallet validation to include historical trace attempt summary"
  );
  requireTruthy(failures, "acceptance-audit.latest.json", Array.isArray(unresolvedTargets), "expected contractsAndProvenance.unresolvedTargets array");
  requireTruthy(failures, "acceptance-audit.latest.json", Array.isArray(officialAddressOnlyAnchors), "expected contractsAndProvenance.officialAddressOnlyAnchors array");
  requireTruthy(failures, "acceptance-audit.latest.json", unresolvedTargets.length === 13, "expected 13 unresolved source-backed ABI targets");
  requireTruthy(failures, "acceptance-audit.latest.json", officialAddressOnlyAnchors.length === 7, "expected 7 official address-only anchors");
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    unresolvedTargets.length > 0 && unresolvedTargets.every((target) => target.status === "source_backed_abi_candidate"),
    "expected unresolvedTargets to contain only source_backed_abi_candidate entries"
  );
  for (const unresolved of unresolvedTargets) {
    const evidence = sourceBackedAcceptanceEvidence(parsed, unresolved.key);
    requireTruthy(failures, "acceptance-audit.latest.json", evidence, `expected unresolved ${unresolved.key} to have source provenance evidence`);
    requireTruthy(
      failures,
      "acceptance-audit.latest.json",
      Number(unresolved.selectorSummary?.functionCount ?? -1) === Number(unresolved.functionCount ?? -2),
      `expected unresolved ${unresolved.key} selector function count to match registry function count`
    );
    requireTruthy(
      failures,
      "acceptance-audit.latest.json",
      Number(unresolved.selectorSummary?.functionCount ?? -1) === Number(evidence?.selectorSummary?.functionCount ?? -2),
      `expected unresolved ${unresolved.key} selector summary parity with provenance report`
    );
    requireZero(failures, "acceptance-audit.latest.json", unresolved.selectorSummary?.selectorsMissing, `expected unresolved ${unresolved.key} zero missing selectors`);
    requireTruthy(
      failures,
      "acceptance-audit.latest.json",
      unresolved.selectorCheckAddress === (evidence?.selectorCheckAddress ?? evidence?.provenanceGate?.selectorEvidence?.checkAddress ?? null),
      `expected unresolved ${unresolved.key} selector check address parity`
    );
    requireTruthy(
      failures,
      "acceptance-audit.latest.json",
      unresolved.provenanceGate?.keepSourceBacked === true &&
        unresolved.provenanceGate?.promotionEligible === false &&
        unresolved.provenanceGate?.selectorEvidence?.selectorComplete === true &&
        Number(unresolved.provenanceGate?.selectorEvidence?.selectorsMissing ?? -1) === 0 &&
        (unresolved.provenanceGate?.promotionBlockers ?? []).length > 0,
      `expected unresolved ${unresolved.key} precise keep-source-backed provenance gate`
    );
    requireTruthy(
      failures,
      "acceptance-audit.latest.json",
      Number(unresolved.provenanceGate?.liveReadEvidence?.failedCount ?? -1) === 0,
      `expected unresolved ${unresolved.key} zero failed provenance live reads`
    );
    requireTruthy(
      failures,
      "acceptance-audit.latest.json",
      isSha256(unresolved.bytecodeEvidence?.localAbiFunctionSignaturesSha256),
      `expected unresolved ${unresolved.key} local ABI signature hash`
    );
    if (unresolved.sourceArtifactEvidence?.status === "no_source_artifact_configured") {
      requireRuntimeSelectorOnlyEvidence(failures, "acceptance-audit.latest.json", unresolved, `unresolved ${unresolved.key}`);
    } else {
      requireSourceArtifactEvidence(failures, "acceptance-audit.latest.json", unresolved, `unresolved ${unresolved.key}`);
    }
    requireDeepEqual(
      failures,
      "acceptance-audit.latest.json",
      unresolved.sourceArtifactEvidence,
      summarizedSourceArtifactEvidence(evidence?.sourceArtifactEvidence ?? (unresolved.key === "autoVault" ? autoVaultProvenance.sourceArtifactEvidence : null)),
      `expected unresolved ${unresolved.key} source artifact evidence parity`
    );
    if (unresolved.key === "autoVault") {
      const expectedProxyExactAbi = summarizedExactAbiReport(autoVaultProvenance.promotion?.proxyExactAbi);
      const expectedImplementationExactAbi = summarizedExactAbiReport(autoVaultProvenance.promotion?.implementationExactAbi);
      requireTruthy(
        failures,
        "acceptance-audit.latest.json",
        stableStringify(unresolved.publicAbiEvidence?.proxyExactAbi ?? null) === stableStringify(expectedProxyExactAbi) &&
          stableStringify(unresolved.publicAbiEvidence?.implementationExactAbi ?? null) === stableStringify(expectedImplementationExactAbi),
        "expected AutoVault unresolved target to expose proxy and implementation exact-ABI attempt evidence"
      );
      requireAbiFetchAttemptEvidence(failures, "acceptance-audit.latest.json", unresolved.publicAbiEvidence?.proxyExactAbi, "autoVault unresolved proxy remote_abi_unavailable", {
        requireSnowtraceAndRoutescan: true
      });
      requireAbiFetchAttemptEvidence(failures, "acceptance-audit.latest.json", unresolved.publicAbiEvidence?.implementationExactAbi, "autoVault unresolved implementation remote_abi_unavailable", {
        requireSnowtraceAndRoutescan: true
      });
      requireTruthy(
        failures,
        "acceptance-audit.latest.json",
        unresolved.bytecodeEvidence?.proxyCodeSha256 === autoVaultProvenance.proxy?.codeSha256 &&
          unresolved.bytecodeEvidence?.implementationCodeSha256 === autoVaultProvenance.implementation?.codeSha256 &&
          isSha256(unresolved.bytecodeEvidence?.implementationCodeSha256),
        "expected AutoVault unresolved target bytecode hashes to match provenance report"
      );
    } else {
      const expectedExactAbi = evidence?.explorer?.exactAbi ?? null;
      const expectedImplementationExactAbi = evidence?.explorer?.implementationExactAbi ?? null;
      const expectedSelectorExactAbi = evidence?.explorer?.selectorExactAbi ?? null;
      if (expectedExactAbi) {
        const expectedSummary = summarizedExactAbiReport(expectedExactAbi);
        requireTruthy(
          failures,
          "acceptance-audit.latest.json",
          stableStringify(unresolved.publicAbiEvidence?.exactAbi ?? null) === stableStringify(expectedSummary),
          `expected unresolved ${unresolved.key} exact ABI attempt evidence`
        );
        requireAbiFetchAttemptEvidence(failures, "acceptance-audit.latest.json", unresolved.publicAbiEvidence?.exactAbi, `unresolved ${unresolved.key} ${expectedExactAbi.classification}`, {
          requireSnowtraceAndRoutescan: expectedExactAbi.classification === "remote_abi_unavailable"
        });
      }
      if (expectedImplementationExactAbi) {
        const expectedSummary = summarizedExactAbiReport(expectedImplementationExactAbi);
        requireTruthy(
          failures,
          "acceptance-audit.latest.json",
          stableStringify(unresolved.publicAbiEvidence?.implementationExactAbi ?? null) === stableStringify(expectedSummary),
          `expected unresolved ${unresolved.key} implementation exact ABI attempt evidence`
        );
        requireAbiFetchAttemptEvidence(failures, "acceptance-audit.latest.json", unresolved.publicAbiEvidence?.implementationExactAbi, `unresolved ${unresolved.key} implementation ${expectedImplementationExactAbi.classification}`, {
          requireSnowtraceAndRoutescan: expectedImplementationExactAbi.classification === "remote_abi_unavailable"
        });
      }
      if (expectedSelectorExactAbi) {
        const expectedSummary = summarizedExactAbiReport(expectedSelectorExactAbi);
        requireTruthy(
          failures,
          "acceptance-audit.latest.json",
          stableStringify(unresolved.publicAbiEvidence?.selectorExactAbi ?? null) === stableStringify(expectedSummary),
          `expected unresolved ${unresolved.key} selector exact ABI attempt evidence`
        );
        requireAbiFetchAttemptEvidence(failures, "acceptance-audit.latest.json", unresolved.publicAbiEvidence?.selectorExactAbi, `unresolved ${unresolved.key} selector ${expectedSelectorExactAbi.classification}`, {
          requireSnowtraceAndRoutescan: expectedSelectorExactAbi.classification === "remote_abi_unavailable"
        });
      }
      const expectedProxyHash = evidence?.proxy?.targetCodeSha256 ?? null;
      const expectedImplementationHash = evidence?.proxy?.implementationCodeSha256 ?? null;
      const expectedTargetHash = evidence?.targetCodeSha256 ?? expectedProxyHash;
      const expectedSelectorHash = evidence?.selectorCodeSha256 ?? expectedImplementationHash;
      if (expectedProxyHash) {
        requireTruthy(
          failures,
          "acceptance-audit.latest.json",
          unresolved.bytecodeEvidence?.proxyCodeSha256 === expectedProxyHash && isSha256(unresolved.bytecodeEvidence?.proxyCodeSha256),
          `expected unresolved ${unresolved.key} proxy bytecode hash`
        );
      }
      if (expectedImplementationHash) {
        requireTruthy(
          failures,
          "acceptance-audit.latest.json",
          unresolved.bytecodeEvidence?.implementationCodeSha256 === expectedImplementationHash && isSha256(unresolved.bytecodeEvidence?.implementationCodeSha256),
          `expected unresolved ${unresolved.key} implementation bytecode hash`
        );
      }
      if (expectedTargetHash) {
        requireTruthy(
          failures,
          "acceptance-audit.latest.json",
          unresolved.bytecodeEvidence?.targetCodeSha256 === expectedTargetHash && isSha256(unresolved.bytecodeEvidence?.targetCodeSha256),
          `expected unresolved ${unresolved.key} target bytecode hash`
        );
      }
      if (expectedSelectorHash) {
        requireTruthy(
          failures,
          "acceptance-audit.latest.json",
          unresolved.bytecodeEvidence?.selectorCodeSha256 === expectedSelectorHash && isSha256(unresolved.bytecodeEvidence?.selectorCodeSha256),
          `expected unresolved ${unresolved.key} selector bytecode hash`
        );
      }
    }
  }
  const expectedSourceArtifactCoverageSummary = sourceArtifactCoverageSummary(unresolvedTargets);
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    provenance.sourceArtifactCoverageSummary,
    expectedSourceArtifactCoverageSummary,
    "expected finalOutput sourceArtifactCoverageSummary to derive from unresolved targets"
  );
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    report.coverageByDomain?.contractsAndProvenance?.sourceArtifactCoverageSummary,
    expectedSourceArtifactCoverageSummary,
    "expected coverageByDomain sourceArtifactCoverageSummary to derive from unresolved targets"
  );
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    provenanceBlocker?.sourceArtifactCoverageSummary,
    expectedSourceArtifactCoverageSummary,
    "expected source-backed blocker sourceArtifactCoverageSummary to derive from unresolved targets"
  );
  requireZero(
    failures,
    "acceptance-audit.latest.json",
    expectedSourceArtifactCoverageSummary.unexpectedMissingLocalFunctionNames.length,
    "expected zero unexpected source-artifact local function-name gaps"
  );
  requireStringSetEqual(
    failures,
    "acceptance-audit.latest.json",
    [
      ...(expectedSourceArtifactCoverageSummary.sourceArtifactsFetchedTargets ?? []),
      ...(expectedSourceArtifactCoverageSummary.runtimeSelectorOnlyTargets ?? [])
    ],
    unresolvedKeys,
    "expected every unresolved source-backed target to have fetched source artifacts or runtime selector-only evidence"
  );
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.coverageSummaryByDomain?.contractsAndProvenance?.tokenAnchorSummary?.wavaxExactVerified === true,
    "expected finalOutput token anchor summary to record exact verified WAVAX"
  );
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.coverageSummaryByDomain?.contractsAndProvenance?.tokenAnchorSummary?.usdcProxyAdminOnly === true,
    "expected finalOutput token anchor summary to record native USDC proxy-admin caveat"
  );
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.coverageSummaryByDomain?.contractsAndProvenance?.officialAnchorSummary?.nonUserAnchors === 7,
    "expected finalOutput official anchor summary to record seven non-user anchors"
  );
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    promotionReadyTargets,
    expectedPromotionReadyTargets,
    "expected promotionReadyTargets to derive from unresolved provenanceGate.promotionEligible"
  );
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    report.coverageByDomain?.contractsAndProvenance?.promotionReadyTargets,
    expectedPromotionReadyTargets,
    "expected coverageByDomain promotionReadyTargets to derive from unresolved provenanceGate.promotionEligible"
  );
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    provenanceBlocker?.promotionReadyTargets,
    expectedPromotionReadyTargets,
    "expected source-backed blocker promotionReadyTargets to derive from unresolved provenanceGate.promotionEligible"
  );
  requireZero(failures, "acceptance-audit.latest.json", promotionReadyTargets.length, "expected zero promotion-ready source-backed targets");
  requireDeepEqual(failures, "acceptance-audit.latest.json", provenance.autoVaultSummary, autoVaultProvenance.summary, "expected finalOutput AutoVault summary to match provenance report");
  requireDeepEqual(failures, "acceptance-audit.latest.json", report.coverageByDomain?.contractsAndProvenance?.autoVaultSummary, autoVaultProvenance.summary, "expected coverageByDomain AutoVault summary to match provenance report");
  requireStringSetEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.coverageSummaryByDomain?.contractsAndProvenance?.sourceBackedEvidenceClasses?.proxyImplementationSelectorBacked,
    ["autoVault", "accessHub", "treasuryHelper", "voter"],
    "expected proxy implementation selector-backed source targets"
  );
  requireStringSetEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.coverageSummaryByDomain?.contractsAndProvenance?.sourceBackedEvidenceClasses?.runtimeSelectorBacked,
    ["legacyGauge", "feeDistributor", "feeRecipient", "pairFactory"],
    "expected runtime selector-backed source targets"
  );
  requireStringSetEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.coverageSummaryByDomain?.contractsAndProvenance?.sourceBackedEvidenceClasses?.dlmmRuntimeSelectorBacked,
    ["dlmmRouter", "dlmmFactory", "dlmmPoolImplementation", "dlmmRewarderImplementation"],
    "expected DLMM runtime selector-backed source targets"
  );
  requireStringSetEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.coverageSummaryByDomain?.contractsAndProvenance?.sourceBackedEvidenceClasses?.dlmmCloneImplementationLinked,
    ["dlmmWavaxUsdc5Pool"],
    "expected DLMM clone implementation-linked source targets"
  );
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    officialAddressOnlyAnchors.length > 0 && officialAddressOnlyAnchors.every((target) => target.status === "official_address_only"),
    "expected officialAddressOnlyAnchors to contain only official_address_only entries"
  );
  requireSetIncludes(failures, "acceptance-audit.latest.json", unresolvedKeys, expectedUnresolvedKeys, "expected unresolvedTargets key membership");
  requireSetIncludes(failures, "acceptance-audit.latest.json", officialAnchorKeys, expectedOfficialAnchorKeys, "expected officialAddressOnlyAnchors key membership");
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    provenanceBlocker?.unresolvedTargets?.every((target) => target.status !== "official_address_only") === true,
    "expected source_backed_abi_caveats blocker unresolvedTargets to exclude official_address_only entries"
  );
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    !Object.hasOwn(provenanceBlocker ?? {}, "officialAddressOnlyAnchors"),
    "expected source_backed_abi_caveats blocker to keep officialAddressOnlyAnchors out of remaining blockers"
  );
	  requireTruthy(
	    failures,
	    "acceptance-audit.latest.json",
	    finalOutputNextSteps.some((step) => step.includes("unresolvedTargets") && step.includes("officialAddressOnlyAnchors")) === true,
	    "expected final output next steps to reference separated provenance arrays"
	  );
  if (p33LiveRoundtripValidated) {
    requireTruthy(failures, "acceptance-audit.latest.json", p33Blocker === undefined, "expected p33_live_deposit to be absent from remaining blockers after live deposit/redeem proof");
    requireSetIncludes(
      failures,
      "acceptance-audit.latest.json",
      finalOutput.resolvedVsRemainingIncompleteComponents?.resolvedOrCovered,
      ["p33 xPHAR deposit/redeem is fork/live validated with bounded approval cleanup."],
      "expected p33 live proof in resolved component summary"
    );
  } else {
    requireTruthy(
      failures,
      "acceptance-audit.latest.json",
      p33Blocker?.status === p33Readiness.evidence?.status &&
        p33Blocker?.status === p33Gate.status &&
        p33Blocker?.status === validationReadiness.protocolGates?.summary?.p33?.status &&
        p33Blocker?.status === protocolGates.summary?.p33?.status,
      "expected p33_live_deposit blocker status to match readiness and protocol-gate reports"
    );
    requireStringSetEqual(failures, "acceptance-audit.latest.json", p33Blocker?.blockers, p33Readiness.blockers, "expected p33 acceptance blockers to match readiness blockers");
    requireStringSetEqual(failures, "acceptance-audit.latest.json", p33Blocker?.blockers, p33Gate.blockers, "expected p33 acceptance blockers to match embedded protocol gate blockers");
  }
  if (p33MintWithdrawLiveValidated) {
    requireSetIncludes(
      failures,
      "acceptance-audit.latest.json",
      finalOutput.resolvedVsRemainingIncompleteComponents?.resolvedOrCovered,
      ["p33 xPHAR mint/withdraw is fork/live validated with bounded approval cleanup."],
      "expected p33 mint/withdraw live proof in resolved component summary"
    );
  }
  requireTruthy(failures, "acceptance-audit.latest.json", coverageContext.p33Complete === p33Complete, "expected structured p33Complete to match receipt-derived proof");
  requireTruthy(failures, "acceptance-audit.latest.json", coverageContext.p33LiveRoundtripValidated === p33LiveRoundtripValidated, "expected structured p33 live roundtrip proof flag to match receipt-derived proof");
  requireTruthy(failures, "acceptance-audit.latest.json", coverageContext.p33MintWithdrawValidated === p33MintWithdrawLiveValidated, "expected structured p33 mint/withdraw proof flag to match receipt-derived proof");
  requireTruthy(failures, "acceptance-audit.latest.json", coverageContext.p33?.depositRedeem?.validated === p33LiveRoundtripValidated, "expected structured p33 deposit/redeem coverage detail");
  requireTruthy(failures, "acceptance-audit.latest.json", coverageContext.p33?.mintWithdraw?.validated === p33MintWithdrawLiveValidated, "expected structured p33 mint/withdraw coverage detail");
	  requireTruthy(failures, "acceptance-audit.latest.json", coverageContext.coverageAwareRecommendedNextAction === finalOutputCurrentState.recommendedNextAction, "expected structured coverage-aware action to match final output current state action");
	  requireTruthy(failures, "acceptance-audit.latest.json", coverageContext.currentStateRecommendedNextAction === finalOutputCurrentState.currentStateRecommendedNextAction, "expected structured current-state action to match final output current state raw action");
	  if (p33LiveRoundtripValidated && p33MintWithdrawLiveValidated && report.goalComplete !== true) {
	    const continuationAction = finalOutputCurrentState.recommendedNextAction;
    const p33Criterion = (report.acceptanceCriteria ?? [])
      .find((item) => item.criterion === "Incomplete or caveated components are either resolved or documented with precise blockers.");
    requireTruthy(
      failures,
      "acceptance-audit.latest.json",
      continuationAction !== "run_fork_p33" && continuationAction !== "run_fork_p33_mint_withdraw",
      "expected coverage-aware continuation action not to recommend already proven p33 live flows"
    );
    requireSetIncludes(
      failures,
      "acceptance-audit.latest.json",
      p33Criterion?.evidence,
      ["p33Complete=true"],
      "expected acceptance evidence to record complete p33 live proof"
    );
  }
  if (p33Gate.status === "blocked_protocol_locked") {
    requireTruthy(failures, "validation-readiness.latest.json", p33Gate.isUnlocked === false, "expected locked p33 gate to have isUnlocked=false");
    requireTruthy(failures, "validation-readiness.latest.json", p33Gate.periodUnlockStatus === false, "expected locked p33 gate to have periodUnlockStatus=false");
    requireTruthy(failures, "validation-readiness.latest.json", p33Gate.protocolOpen === false, "expected locked p33 gate to have protocolOpen=false");
    requireTruthy(failures, "validation-readiness.latest.json", p33Gate.liveTxActionableForProbe === false, "expected locked p33 gate to have liveTxActionableForProbe=false");
    requireSetIncludes(failures, "validation-readiness.latest.json", p33Gate.blockers, ["p33.isUnlocked() is false", "p33.periodUnlockStatus(getPeriod()) is false"], "expected locked p33 blockers");
    requireTruthy(failures, "validation-readiness.latest.json", !(p33Gate.blockers ?? []).some((blocker) => blocker.includes("allowance")), "expected locked p33 actionable blockers to exclude gas-spending approval state");
    requireSetIncludes(failures, "validation-readiness.latest.json", p33Gate.deferredWalletBlockers, ["wallet xPHAR allowance to p33 is below probe deposit amount"], "expected locked p33 deferred wallet blockers to retain allowance state");
    requireSetIncludes(failures, "validation-readiness.latest.json", p33Gate.allBlockers, ["wallet xPHAR allowance to p33 is below probe deposit amount"], "expected locked p33 allBlockers to retain wallet readiness state");
    requireTruthy(failures, "validation-readiness.latest.json", p33Gate.buildHintsStatus === "blocked_protocol_locked", "expected locked p33 build hints status");
    requireTruthy(failures, "validation-readiness.latest.json", p33Gate.buildHints === null, "expected locked p33 build hints to be suppressed");
    requireTruthy(failures, "claimability.latest.json", p33ClaimabilityDepositSimulationError.includes("LOCKED"), "expected p33 deposit simulation to decode LOCKED custom error");
    requireTruthy(failures, "claimability.latest.json", !p33ClaimabilityDepositSimulationError.includes("Unable to decode signature"), "expected p33 deposit simulation error not to contain undecoded custom-error text");
    requireTruthy(failures, "validation-readiness.latest.json", p33ReadinessDepositSimulationError.includes("LOCKED"), "expected embedded p33 deposit simulation to decode LOCKED custom error");
    requireTruthy(failures, "validation-readiness.latest.json", !p33ReadinessDepositSimulationError.includes("Unable to decode signature"), "expected embedded p33 deposit simulation error not to contain undecoded custom-error text");
    requireSetIncludes(failures, "claimability.latest.json", p33ClaimabilityDepositQuote.quote?.blockers, ["simulation failed: LOCKED() (0xa1422f69)"], "expected p33 claimability blocker to preserve compact LOCKED selector evidence");
  }
  if (p33Gate.protocolOpen === true) {
    requireTruthy(failures, "acceptance-audit.latest.json", p33Blocker?.status !== "blocked_protocol_locked", "p33 acceptance blocker cannot remain protocol-locked when protocolOpen=true");
  }
  requireTruthy(
    failures,
    "acceptance-audit.latest.json",
    dlmmBlocker?.status === dlmmReadiness.evidence?.status &&
      dlmmBlocker?.status === dlmmGate.status &&
      dlmmBlocker?.status === validationReadiness.protocolGates?.summary?.dlmmPoolCreation?.normalUserCreationStatus &&
      dlmmBlocker?.status === protocolGates.summary?.dlmmPoolCreation?.normalUserCreationStatus,
    "expected dlmm_pool_creation blocker status to match readiness and protocol-gate reports"
  );
  requireStringSetEqual(failures, "acceptance-audit.latest.json", dlmmReadiness.evidence?.openBinSteps, dlmmGate.openBinSteps, "expected DLMM readiness openBinSteps to match embedded gate");
  requireStringSetEqual(failures, "acceptance-audit.latest.json", dlmmGate.openBinSteps, validationReadiness.protocolGates?.summary?.dlmmPoolCreation?.openBinSteps, "expected DLMM embedded gate openBinSteps to match summary");
  for (const row of dlmmGate.binStepRows ?? []) {
    requireTruthy(
      failures,
      "validation-readiness.latest.json",
      row.openByGetOpenBinSteps === (dlmmGate.openBinSteps ?? []).includes(row.binStep),
      `expected DLMM binStepRows open flag to match openBinSteps for ${row.binStep}`
    );
  }
  if ((dlmmGate.openBinSteps ?? []).length === 0) {
    requireTruthy(failures, "acceptance-audit.latest.json", dlmmBlocker?.status === "blocked_no_open_presets", "expected no-open DLMM gate to keep blocked_no_open_presets status");
    requireTruthy(failures, "validation-readiness.latest.json", dlmmGate.openAbsentCandidate === null, "expected no-open DLMM gate to have no openAbsentCandidate");
    requireSetIncludes(failures, "acceptance-audit.latest.json", dlmmBlocker?.blockers, ["DLMMFactory.getOpenBinSteps() returned no open presets."], "expected no-open DLMM blocker reason");
  } else {
    requireTruthy(failures, "acceptance-audit.latest.json", dlmmBlocker?.status !== "blocked_no_open_presets", "DLMM acceptance blocker cannot remain no-open when open presets exist");
  }
  const expectedRewardClaimabilitySummary = summarizeRewardClaimability(claimable);
  const expectedRewardCoverageStatus = claimable.claimable === true
    ? "current_wallet_claimable"
    : rewardClaimRehearsal.ok === true
      ? "fixture_covered_current_wallet_state_gated"
      : "needs_attention";
  requireTruthy(failures, "acceptance-audit.latest.json", report.coverageByDomain?.rewards?.status === expectedRewardCoverageStatus, "expected acceptance reward coverage status to derive from claimability and fixture rehearsal state");
  requireTruthy(failures, "acceptance-audit.latest.json", finalOutput.coverageSummaryByDomain?.rewards?.status === expectedRewardCoverageStatus, "expected finalOutput reward coverage status to derive from claimability and fixture rehearsal state");
  requireTruthy(failures, "acceptance-audit.latest.json", report.coverageByDomain?.rewards?.currentWalletClaimable === claimable.claimable, "expected acceptance reward claimability to match claimability report");
  requireTruthy(failures, "acceptance-audit.latest.json", finalOutput.coverageSummaryByDomain?.rewards?.currentWalletClaimable === claimable.claimable, "expected finalOutput reward claimability to match claimability report");
  requireDeepEqual(failures, "acceptance-audit.latest.json", report.coverageByDomain?.rewards?.claimabilityDomainSummary, expectedRewardClaimabilitySummary, "expected acceptance reward domain summary to match claimability report");
  requireDeepEqual(failures, "acceptance-audit.latest.json", finalOutput.coverageSummaryByDomain?.rewards?.claimabilityDomainSummary, expectedRewardClaimabilitySummary, "expected finalOutput reward domain summary to match claimability report");
  requireDeepEqual(failures, "acceptance-audit.latest.json", walletRewardBlocker?.evidence, expectedRewardClaimabilitySummary, "expected current-wallet reward blocker evidence to match claimability report");
  requireDeepEqual(failures, "validation-readiness.latest.json", walletRewardReadiness.evidence, {
    source: "claimability.rewardClaimability",
    status: claimable.claimable === true ? "current_wallet_rewards_claimable" : "blocked_no_current_wallet_claims",
    ...expectedRewardClaimabilitySummary
  }, "expected wallet reward readiness evidence to derive from claimability report");
  requireTruthy(failures, "validation-readiness.latest.json", walletRewardReadiness.ready === (claimable.claimable === true), "expected wallet reward readiness ready flag to match claimability");
  requireStringSetEqual(failures, "validation-readiness.latest.json", walletRewardReadiness.blockers, claimable.claimable === true ? [] : claimable.blockers, "expected wallet reward readiness blockers to match claimability");
  requireStringSetEqual(failures, "acceptance-audit.latest.json", report.coverageByDomain?.rewards?.claimabilityBlockers, claimable.blockers, "expected coverage reward blockers to match claimability report");
  requireStringSetEqual(failures, "acceptance-audit.latest.json", walletRewardBlocker?.blockers, claimable.blockers, "expected current-wallet reward blocker list to match claimability report");
  requireSetIncludes(failures, "acceptance-audit.latest.json", Object.keys(expectedRewardClaimabilitySummary.domains ?? {}), claimable.blockers ?? [], "expected reward blocker domains to have detailed domain summaries");
  requireTruthy(failures, "claimability.latest.json", claimability.safety?.readOnly === true && claimability.safety?.privateKeyRead === false && claimability.safety?.liveBroadcastAllowed === false, "expected claimability report readonly safety envelope");
  requireTruthy(failures, "claimability.latest.json", Number(claimability.inputs?.operatorIncentivePeriodsBack ?? -1) === Number(claimabilityOperator.periodsBack ?? -2), "expected claimability operator periodsBack input parity");
  requireDeepEqual(failures, "claimability.latest.json", validationReadiness.claimability?.operatorIncentiveClaimability?.summary, claimabilityOperator.summary, "expected validation-readiness embedded operator claimability summary to match claimability report");
  requireDeepEqual(failures, "validation-readiness.latest.json", operatorReadiness.evidence?.summary, claimabilityOperator.summary, "expected operator readiness summary to derive from claimability operator gate");
  requireDeepEqual(failures, "validation-readiness.latest.json", operatorReadiness.evidence?.positiveRows, claimabilityOperator.positiveRowsFlat, "expected operator readiness positive rows to derive from claimability operator gate");
  requireDeepEqual(failures, "claimability.latest.json", claimabilityOperator.summary, operatorIncentives.summary, "expected claimability operator summary to match operator-incentives watch summary");
  requireArraySetEqual(failures, "claimability.latest.json", flattenedOperatorRows(claimabilityOperator), flattenedOperatorRows(operatorIncentives), "expected claimability operator positive rows to match operator-incentives positive rows");
  requireTruthy(
    failures,
    "operator-incentives.latest.json",
    String(operatorIncentives.currentPeriod) === String(claimabilityOperator.currentPeriod) &&
      Number(operatorIncentives.periodsBack ?? 0) >= Number(claimabilityOperator.periodsBack ?? 0),
    "expected operator-incentives watch to cover the claimability operator period/range"
  );
  requireDeepEqual(
    failures,
    "acceptance-audit.latest.json",
    finalOutput.coverageSummaryByDomain?.rewards?.operatorIncentiveClaimability?.summary,
    claimabilityOperator.summary,
    "expected acceptance reward operator claimability summary to match claimability report"
  );
  requireTruthy(
    failures,
    "claimability.latest.json",
    claimabilityOperator.plans?.p33?.caller === claimabilityOperator.summary?.p33?.operator?.result &&
      claimabilityOperator.plans?.p33?.domains?.p33?.callerIsOperator === true,
    "expected p33 operator claimability plan to use configured operator caller"
  );
  requireTruthy(
    failures,
    "claimability.latest.json",
    claimabilityOperator.plans?.autoVault?.caller === claimabilityOperator.summary?.autoVault?.operator?.result &&
      claimabilityOperator.plans?.autoVault?.domains?.autoVault?.incentives?.callerIsOperator === true,
    "expected AutoVault operator claimability plan to use configured OPERATOR caller"
  );
  if (claimable.claimable === false) {
    requireTruthy(failures, "acceptance-audit.latest.json", walletRewardBlocker?.status === "blocked_no_current_wallet_claims", "expected no-claim wallet state to have blocked_no_current_wallet_claims status");
  } else if (claimable.claimable === true) {
    requireTruthy(failures, "acceptance-audit.latest.json", walletRewardBlocker?.status !== "blocked_no_current_wallet_claims", "wallet reward blocker cannot remain blocked when claimability=true");
  }
  requireDeepEqual(failures, "validation-readiness.latest.json", operatorReadiness.evidence?.summary, operatorIncentives.summary, "expected operator incentive readiness summary to match operator-incentives report");
  requireArraySetEqual(failures, "validation-readiness.latest.json", operatorReadiness.evidence?.positiveRows, flattenedOperatorRows(operatorIncentives), "expected operator incentive positive rows to match flattened operator-incentives report");
  requireTruthy(failures, "validation-readiness.latest.json", String(operatorIncentives.currentPeriod) === String(validationReadiness.protocolGates?.summary?.p33?.period?.result), "expected operator-incentives period to match protocol-gate p33 period");
  if (
    Number(operatorIncentives.summary?.p33?.positiveEarnedRows ?? 0) === 0 &&
    Number(operatorIncentives.summary?.autoVault?.positiveEarnedRows ?? 0) === 0
  ) {
    requireTruthy(failures, "operator-incentives.latest.json", operatorIncentives.summary?.p33?.status === "blocked_no_current_positive_earned", "expected p33 operator incentives to be blocked_no_current_positive_earned");
    requireTruthy(failures, "operator-incentives.latest.json", operatorIncentives.summary?.autoVault?.status === "blocked_no_current_positive_earned", "expected AutoVault operator incentives to be blocked_no_current_positive_earned");
    requireTruthy(failures, "operator-incentives.latest.json", operatorIncentives.summary?.p33?.operatorClaimable === false, "expected p33 operatorClaimable=false");
    requireTruthy(failures, "operator-incentives.latest.json", operatorIncentives.summary?.autoVault?.operatorClaimable === false, "expected AutoVault operatorClaimable=false");
    requireZero(failures, "operator-incentives.latest.json", operatorIncentives.positiveRows?.p33?.length, "expected zero p33 positive operator rows");
    requireZero(failures, "operator-incentives.latest.json", operatorIncentives.positiveRows?.autoVault?.length, "expected zero AutoVault positive operator rows");
    requireTruthy(failures, "acceptance-audit.latest.json", operatorBlocker?.status === "blocked_no_current_positive_earned", "expected acceptance operator incentive blocker to preserve no-positive-earned status");
  } else {
    requireTruthy(failures, "acceptance-audit.latest.json", operatorBlocker?.status !== "blocked_no_current_positive_earned", "operator incentive blocker cannot remain no-positive-earned when positive rows exist");
  }
	  if (report.goalComplete === false) {
	    requireTruthy(failures, "acceptance-audit.latest.json", typeof finalOutput.continuationJsonPrompt === "object" && finalOutput.continuationJsonPrompt !== null, "expected continuationJsonPrompt while goalComplete=false");
    requireDeepEqual(failures, "acceptance-audit.latest.json", finalOutput.continuationJsonPrompt?.verification_commands, finalOutput.verificationCommands, "expected continuation prompt verification_commands to match finalOutput.verificationCommands");
    requireTruthy(failures, "acceptance-audit.latest.json", typeof finalOutput.continuationJsonPrompt?.fundingTopUpRequest === "object", "expected continuation prompt fundingTopUpRequest while goalComplete=false");
    requireDeepEqual(failures, "acceptance-audit.latest.json", finalOutput.fundingTopUpRequest, finalOutput.continuationJsonPrompt?.fundingTopUpRequest, "expected finalOutput fundingTopUpRequest to match continuation prompt");
    requireTruthy(failures, "acceptance-audit.latest.json", typeof finalOutput.fundingTopUpRequest?.required === "boolean", "expected fundingTopUpRequest.required boolean");
    requireTruthy(failures, "acceptance-audit.latest.json", typeof finalOutput.fundingTopUpRequest?.status === "string", "expected fundingTopUpRequest.status string");
    requireTruthy(failures, "acceptance-audit.latest.json", typeof finalOutput.fundingTopUpRequest?.reason === "string" && finalOutput.fundingTopUpRequest.reason.length > 0, "expected fundingTopUpRequest.reason");
    requireDeepEqual(failures, "acceptance-audit.latest.json", finalOutput.fundingTopUpRequest?.currentBalances, finalOutput.currentWalletBalancesAndApprovals?.balances, "expected fundingTopUpRequest current balances to match final wallet balances");
    requireTruthy(failures, "acceptance-audit.latest.json", typeof finalOutput.fundingTopUpRequest?.minimumGuidance?.avaxForGas?.raw === "string", "expected fundingTopUpRequest AVAX minimum guidance");
    requireTruthy(failures, "acceptance-audit.latest.json", typeof finalOutput.fundingTopUpRequest?.minimumGuidance?.usdcForMinimalProbe?.raw === "string", "expected fundingTopUpRequest USDC minimum guidance");
    const avaxRaw = parseRawAmount(finalOutput.currentWalletBalancesAndApprovals?.balances?.AVAX?.raw);
    const usdcRaw = parseRawAmount(finalOutput.currentWalletBalancesAndApprovals?.balances?.USDC?.raw);
    const fundRelatedBlockerCount = (report.completionBlockingItems ?? [])
      .filter((item) => /fund|insufficient|balance|gas/i.test([
        item?.key,
        item?.status,
        ...(item?.blockers ?? [])
      ].filter(Boolean).join(" "))).length;
    if (
      fundRelatedBlockerCount === 0 &&
      avaxRaw !== null &&
      avaxRaw >= 50_000_000_000_000_000n &&
      usdcRaw !== null &&
      usdcRaw >= 1_000_000n
	    ) {
	      requireTruthy(failures, "acceptance-audit.latest.json", finalOutput.fundingTopUpRequest.required === false, "expected no top-up request when remaining blockers are state-gated and balances exceed minimum guidance");
	      requireTruthy(failures, "acceptance-audit.latest.json", finalOutput.fundingTopUpRequest.status === "no_top_up_required", "expected no_top_up_required funding status when balances are adequate");
	    }
	  } else {
	    requireTruthy(failures, "acceptance-audit.latest.json", finalOutput.continuationJsonPrompt === null, "expected continuationJsonPrompt to be null when goalComplete=true");
	    requireTruthy(failures, "acceptance-audit.latest.json", finalOutput.fundingTopUpRequest?.required === false, "expected no top-up request when goalComplete=true");
	    requireTruthy(failures, "acceptance-audit.latest.json", finalOutputCurrentState.goalComplete === true, "expected final output current state goalComplete=true");
	  }
	}

for (const [file, report] of Object.entries(parsed)) {
  const source = `reports/${file}`;
  if (report?.mode === "live" && !Object.hasOwn(report, "liveConfirmationAddress") && !hasLiveReceiptProvenance(parsed, source)) {
    warnings.push({
      file,
      message: "legacy live report does not include liveConfirmationAddress and no live receipt provenance report proved it"
    });
  }
}

const result = {
  ok: failures.length === 0,
  checkedFiles: files.length,
  failures,
  warnings
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
