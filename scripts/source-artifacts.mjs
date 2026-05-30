import { createHash } from "node:crypto";

const PHARAOH_CONTRACTS_COMMIT = "f59c300b622b6e761433ee939a0f80ec128b1920";
const OPENZEPPELIN_5_1_TAG = "v5.1.0";
const SOURCE_ARTIFACT_FETCH_ATTEMPTS = 3;
const SOURCE_ARTIFACT_RETRY_DELAY_MS = 500;

function githubRaw(repository, commit, path) {
  return `https://raw.githubusercontent.com/${repository}/${commit}/${path}`;
}

function githubTree(repository, commit, path) {
  return `https://github.com/${repository}/blob/${commit}/${path}`;
}

function githubArtifact(repository, commit, path) {
  return {
    kind: "github_raw_source",
    repository,
    commit,
    path,
    sourceUrl: githubTree(repository, commit, path),
    fetchUrl: githubRaw(repository, commit, path)
  };
}

function snowtraceSourceArtifact(address, path) {
  const sourceUrl = `https://snowtrace.io/address/${address}#code`;
  return {
    kind: "etherscan_source_api",
    repository: null,
    commit: null,
    path,
    sourceUrl,
    fetchUrl: `https://api.snowtrace.io/api?module=contract&action=getsourcecode&address=${address}`
  };
}

export const sourceArtifactDefinitions = {
  accessHub: [
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/AccessHub.sol"),
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/interfaces/IAccessHub.sol"),
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/interfaces/IVoter.sol"),
    githubArtifact("OpenZeppelin/openzeppelin-contracts-upgradeable", OPENZEPPELIN_5_1_TAG, "contracts/access/AccessControlUpgradeable.sol"),
    githubArtifact("OpenZeppelin/openzeppelin-contracts-upgradeable", OPENZEPPELIN_5_1_TAG, "contracts/access/extensions/AccessControlEnumerableUpgradeable.sol"),
    githubArtifact("OpenZeppelin/openzeppelin-contracts-upgradeable", OPENZEPPELIN_5_1_TAG, "contracts/utils/introspection/ERC165Upgradeable.sol")
  ],
  treasuryHelper: [
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/treasury/RamsesTreasuryHelper.sol")
  ],
  voter: [
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/Voter.sol"),
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/interfaces/IVoter.sol"),
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/libraries/VoterRewardClaimers.sol"),
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/libraries/VoterGovernanceActions.sol")
  ],
  clGaugeFactory: [
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/CL/gauge/ClGaugeFactory.sol"),
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/CL/gauge/interfaces/IClGaugeFactory.sol")
  ],
  legacyGauge: [
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/Gauge.sol"),
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/interfaces/IGauge.sol")
  ],
  feeDistributor: [
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/FeeDistributor.sol"),
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/interfaces/IFeeDistributor.sol")
  ],
  feeRecipient: [
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/FeeRecipient.sol"),
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/interfaces/IFeeRecipient.sol")
  ],
  pairFactory: [
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/factories/PairFactory.sol"),
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/interfaces/IPairFactory.sol")
  ],
  feeDistributorFactory: [
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/factories/FeeDistributorFactory.sol"),
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/interfaces/IFeeDistributorFactory.sol")
  ],
  feeRecipientFactory: [
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/factories/FeeRecipientFactory.sol"),
    githubArtifact("PharaohExchange/pharaoh-contracts", PHARAOH_CONTRACTS_COMMIT, "contracts/interfaces/IFeeRecipientFactory.sol")
  ],
  dlmmRewarderFactory: [
    snowtraceSourceArtifact("0xd28467eDe84cEde6B05070779E39Eaff4988548C", "contracts/DLMM/DLMMRewarderFactory.sol")
  ],
  dlmmRewarderImplementation: [
    snowtraceSourceArtifact("0xd28467eDe84cEde6B05070779E39Eaff4988548C", "contracts/DLMM/DLMMRewarder.sol"),
    snowtraceSourceArtifact("0xd28467eDe84cEde6B05070779E39Eaff4988548C", "contracts/DLMM/DLMMBaseHooks.sol"),
    snowtraceSourceArtifact("0xd28467eDe84cEde6B05070779E39Eaff4988548C", "contracts/DLMM/interfaces/IDLMMHooks.sol"),
    snowtraceSourceArtifact("0xd28467eDe84cEde6B05070779E39Eaff4988548C", "contracts/DLMM/libraries/Hooks.sol"),
    snowtraceSourceArtifact("0xd28467eDe84cEde6B05070779E39Eaff4988548C", "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol"),
    snowtraceSourceArtifact("0xd28467eDe84cEde6B05070779E39Eaff4988548C", "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol"),
    snowtraceSourceArtifact("0xd28467eDe84cEde6B05070779E39Eaff4988548C", "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol")
  ]
};

const expectedLocalFunctionNamesMissingFromSource = {
  treasuryHelper: {
    names: ["USDC"],
    reason: "The deployed TreasuryHelper ABI includes a USDC() helper that is selector/live-read backed, but the pinned Pharaoh helper source artifact does not expose this helper name."
  },
  voter: {
    names: [
      "addAuthorizedDLMMManager",
      "createDLMMRewarder",
      "dlmmFactory",
      "dlmmRewarderFactory",
      "isAuthorizedDLMMManager",
      "isDLMMRewarder",
      "removeAuthorizedDLMMManager",
      "setDLMMFactory",
      "setDLMMRewarderDeltaBins",
      "setDLMMRewarderFactory"
    ],
    reason: "The deployed Voter ABI includes DLMM extension functions that are selector/live-read backed, but the pinned Pharaoh contracts repository revision predates or omits that deployed extension source."
  },
  dlmmFactory: {
    names: [
      "DEFAULT_PROTOCOL_SHARE",
      "GAUGED_PROTOCOL_SHARE",
      "defaultProtocolShare",
      "feeCollector",
      "gaugedProtocolShare",
      "isPool",
      "setPoolDefaultProtocolShare",
      "setPoolGaugedProtocolShare",
      "setPoolProtocolShare",
      "setPresetProtocolShare",
      "setVoter",
      "voter"
    ],
    reason: "The deployed Pharaoh DLMMFactory ABI includes Pharaoh protocol-share and voter extensions that are selector/live-read backed; no non-Pharaoh upstream source artifact is used for DLMM provenance."
  }
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort();
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ");
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&#(x[0-9a-fA-F]+|\d+);/g, (_match, code) => {
      const parsed = code.startsWith("x") || code.startsWith("X")
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _match;
    })
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function verifiedExplorerSourceText(definition, text) {
  if (definition.kind !== "verified_explorer_source_page") return text;
  const embeddedSources = [...String(text ?? "").matchAll(/data-csource='([\s\S]*?)'\s*(?:checked)?><label/g)]
    .map((match) => decodeHtmlEntities(match[1]).replace(/\\n/g, "\n").replace(/\\"/g, "\"").trim())
    .filter((source) => source.includes("pragma solidity") || source.includes("interface ") || source.includes("contract "));
  return embeddedSources.length > 0 ? embeddedSources.join("\n\n") : text;
}

function etherscanSourceApiText(definition, text) {
  if (definition.kind !== "etherscan_source_api") return text;
  const standardJsonSourceText = (standardJson) => {
    const selected = standardJson?.sources?.[definition.path]?.content;
    if (typeof selected === "string" && selected.length > 0) return selected;
    const sources = Object.values(standardJson.sources ?? {})
      .map((source) => source?.content)
      .filter((source) => typeof source === "string" && source.length > 0);
    return sources.length > 0 ? sources.join("\n\n") : null;
  };
  try {
    const body = JSON.parse(text);
    const sourceCode = body?.result?.[0]?.SourceCode;
    if (typeof sourceCode !== "string" || sourceCode.length === 0) return text;

    const trimmed = sourceCode.trim();
    if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
      const standardJson = JSON.parse(trimmed.slice(1, -1));
      return standardJsonSourceText(standardJson) ?? text;
    }

    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const standardJson = JSON.parse(trimmed);
      return standardJsonSourceText(standardJson) ?? text;
    }

    return sourceCode;
  } catch {
    return text;
  }
}

function normalizedArtifactSourceText(definition, text) {
  return etherscanSourceApiText(definition, verifiedExplorerSourceText(definition, text));
}

function splitTopLevel(value, separator = ",") {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function findMatchingParen(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function namesFromSource(source, keyword) {
  const clean = stripComments(source);
  return uniqueSorted([...clean.matchAll(new RegExp(`\\b${keyword}\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*[\\(;]`, "g"))]
    .map((match) => match[1]));
}

function typeDefinitions(source) {
  const clean = stripComments(source);
  return {
    addressLike: new Set([...clean.matchAll(/\b(?:contract|interface|library)\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1])),
    structs: new Map([...clean.matchAll(/\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}/g)]
      .map((match) => [
        match[1],
        match[2]
          .split(";")
          .map((field) => parameterType(field.trim()))
          .filter(Boolean)
      ])),
    enums: new Set([...clean.matchAll(/\benum\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1])),
    valueTypes: new Map([...clean.matchAll(/\btype\s+([A-Za-z_][A-Za-z0-9_]*)\s+is\s+([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((match) => [match[1], match[2]]))
  };
}

function mergeTypeDefinitions(definitions = []) {
  const merged = {
    addressLike: new Set(),
    structs: new Map(),
    enums: new Set(),
    valueTypes: new Map()
  };
  for (const definition of definitions) {
    for (const value of definition.addressLike ?? []) merged.addressLike.add(value);
    for (const [key, value] of definition.structs ?? []) merged.structs.set(key, value);
    for (const value of definition.enums ?? []) merged.enums.add(value);
    for (const [key, value] of definition.valueTypes ?? []) merged.valueTypes.set(key, value);
  }
  return merged;
}

function canonicalType(rawType, definitions, stack = []) {
  let value = String(rawType ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s*\[\s*/g, "[")
    .replace(/\s*\]\s*/g, "]")
    .trim();
  if (!value) return null;

  let arraySuffix = "";
  while (/\[[^\]]*\]$/.test(value)) {
    const match = value.match(/(\[[^\]]*\])$/);
    arraySuffix = `${match[1]}${arraySuffix}`;
    value = value.slice(0, -match[1].length).trim();
  }

  if (value === "uint") value = "uint256";
  if (value === "int") value = "int256";
  if (value === "byte") value = "bytes1";
  if (value === "address payable") value = "address";

  const bareName = value.includes(".") ? value.split(".").at(-1) : value;
  if (definitions.valueTypes?.has(bareName)) {
    const resolved = canonicalType(definitions.valueTypes.get(bareName), definitions, stack);
    return resolved ? `${resolved}${arraySuffix}` : null;
  }
  if (definitions.addressLike?.has(bareName)) return `address${arraySuffix}`;
  if (/^I[A-Z][A-Za-z0-9_]*$/.test(bareName)) return `address${arraySuffix}`;
  if (definitions.structs?.has(bareName)) {
    if (stack.includes(bareName)) return null;
    const fieldTypes = definitions.structs.get(bareName)
      .map((field) => canonicalType(field, definitions, [...stack, bareName]));
    if (fieldTypes.some((field) => !field)) return null;
    return `(${fieldTypes.join(",")})${arraySuffix}`;
  }
  if (definitions.enums?.has(bareName)) return `uint8${arraySuffix}`;
  if (/^(?:address|bool|string|bytes|bytes[1-9][0-9]?|uint(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)|int(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256))$/.test(value)) {
    return `${value}${arraySuffix}`;
  }
  return null;
}

function parameterType(parameter) {
  const withoutDefault = String(parameter ?? "").split("=")[0].trim();
  const parts = withoutDefault.split(/\s+/).filter((part) =>
    !["calldata", "memory", "storage", "payable", "indexed"].includes(part)
  );
  if (parts.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(parts.at(-1))) parts.pop();
  return parts.join(" ");
}

function functionSignatureExtractionFromSource(source, definitions) {
  const clean = stripComments(source);
  const signatures = [];
  const skippedCandidates = [];
  const pattern = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  for (const match of clean.matchAll(pattern)) {
    const openIndex = match.index + match[0].lastIndexOf("(");
    const closeIndex = findMatchingParen(clean, openIndex);
    if (closeIndex < 0) continue;
    const parameters = clean.slice(openIndex + 1, closeIndex).trim();
    const parameterTypes = splitTopLevel(parameters).map(parameterType);
    const types = parameterTypes.map((parameter) => canonicalType(parameter, definitions));
    if (types.some((type) => !type)) {
      skippedCandidates.push({
        name: match[1],
        parameters,
        parameterTypes,
        reason: "unresolved_parameter_type"
      });
      continue;
    }
    signatures.push(`${match[1]}(${types.join(",")})`);
  }
  return { signatures: uniqueSorted(signatures), skippedCandidates };
}

function publicStateGetterDeclarations(source) {
  const clean = stripComments(source);
  const declarations = [];
  const pattern = /\b((?:mapping\s*\([^;{}]+?\)|[A-Za-z_][A-Za-z0-9_.]*(?:\s*\[[^\]]*\])?(?:\s+[A-Za-z_][A-Za-z0-9_.]*(?:\s*\[[^\]]*\])?)*))\s+public\s+(?:(?:constant|immutable|override|virtual)\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)/g;
  for (const match of clean.matchAll(pattern)) {
    declarations.push({ type: match[1].trim(), name: match[2] });
  }
  return declarations;
}

function publicStateGetterNames(source) {
  return uniqueSorted(publicStateGetterDeclarations(source).map((declaration) => declaration.name));
}

function mappingKeyTypes(typeText, definitions) {
  let value = typeText.trim();
  const keys = [];
  while (value.startsWith("mapping")) {
    const openIndex = value.indexOf("(");
    const closeIndex = findMatchingParen(value, openIndex);
    if (openIndex < 0 || closeIndex < 0) return null;
    const body = value.slice(openIndex + 1, closeIndex);
    const parts = body.split(/=>/);
    if (parts.length < 2) return null;
    const keyType = canonicalType(parameterType(parts[0].trim()), definitions);
    if (!keyType) return null;
    keys.push(keyType);
    value = parts.slice(1).join("=>").trim();
  }
  return keys;
}

function arrayIndexCount(typeText) {
  return [...String(typeText ?? "").matchAll(/\[[^\]]*\]/g)].length;
}

function publicStateGetterSignatureExtractionFromSource(source, definitions) {
  const signatures = [];
  const skippedCandidates = [];
  for (const declaration of publicStateGetterDeclarations(source)) {
    let inputs = [];
    if (declaration.type.startsWith("mapping")) {
      inputs = mappingKeyTypes(declaration.type, definitions);
      if (!inputs) {
        skippedCandidates.push({
          name: declaration.name,
          type: declaration.type,
          reason: "unresolved_public_mapping_key_type"
        });
        continue;
      }
    } else {
      inputs = Array.from({ length: arrayIndexCount(declaration.type) }, () => "uint256");
    }
    signatures.push(`${declaration.name}(${inputs.join(",")})`);
  }
  return { signatures: uniqueSorted(signatures), skippedCandidates };
}

function namesFromSignatures(signatures = []) {
  return uniqueSorted(signatures.map((signature) => String(signature).split("(")[0]));
}

function missingExpectedByName(signatures, expectedNames) {
  const expectedSet = new Set(expectedNames);
  return signatures.filter((signature) => expectedSet.has(String(signature).split("(")[0]));
}

function missingUnexpectedByName(signatures, expectedNames) {
  const expectedSet = new Set(expectedNames);
  return signatures.filter((signature) => !expectedSet.has(String(signature).split("(")[0]));
}

function publicStateGetterNamesLegacy(source) {
  const clean = stripComments(source);
  const names = [];
  const pattern = /\b(?:mapping\s*\([^;{}]+?\)|[A-Za-z_][A-Za-z0-9_]*(?:\s*\[[^\]]*\])?(?:\s+[A-Za-z_][A-Za-z0-9_]*)*)\s+public\s+(?:(?:constant|immutable|override|virtual)\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)/g;
  for (const match of clean.matchAll(pattern)) {
    names.push(match[1]);
  }
  return uniqueSorted(names);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchArtifact(definition) {
  const retrievedAt = new Date().toISOString();
  let lastError = null;
  for (let attempt = 1; attempt <= SOURCE_ARTIFACT_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(definition.fetchUrl);
      const rawText = await response.text();
      const text = response.ok ? normalizedArtifactSourceText(definition, rawText) : "";
      return {
        kind: definition.kind,
        repository: definition.repository ?? null,
        commit: definition.commit ?? null,
        path: definition.path,
        sourceUrl: definition.sourceUrl,
        fetchHost: new URL(definition.fetchUrl).host,
        retrievedAt,
        ok: response.ok,
        httpStatus: response.status,
        httpStatusText: response.statusText,
        contentLength: text.length,
        contentSha256: response.ok ? sha256(text) : null,
        functionNames: response.ok ? namesFromSource(text, "function") : [],
        publicStateGetterNames: response.ok ? uniqueSorted([...publicStateGetterNamesLegacy(text), ...publicStateGetterNames(text)]) : [],
        errorNames: response.ok ? namesFromSource(text, "error") : [],
        typeDefinitions: response.ok ? typeDefinitions(text) : typeDefinitions(""),
        text: response.ok ? text : "",
        error: response.ok ? null : `HTTP ${response.status}`,
        fetchAttempt: attempt,
        fetchMaxAttempts: SOURCE_ARTIFACT_FETCH_ATTEMPTS
      };
    } catch (error) {
      lastError = error;
      if (attempt < SOURCE_ARTIFACT_FETCH_ATTEMPTS) await sleep(SOURCE_ARTIFACT_RETRY_DELAY_MS * attempt);
    }
  }
  return {
    kind: definition.kind,
    repository: definition.repository ?? null,
    commit: definition.commit ?? null,
    path: definition.path,
    sourceUrl: definition.sourceUrl,
    fetchHost: new URL(definition.fetchUrl).host,
    retrievedAt,
    ok: false,
    httpStatus: null,
    httpStatusText: null,
    contentLength: 0,
    contentSha256: null,
    functionNames: [],
    publicStateGetterNames: [],
    errorNames: [],
    typeDefinitions: typeDefinitions(""),
    text: "",
    error: lastError?.message ?? String(lastError),
    fetchAttempt: SOURCE_ARTIFACT_FETCH_ATTEMPTS,
    fetchMaxAttempts: SOURCE_ARTIFACT_FETCH_ATTEMPTS
  };
}

export async function sourceArtifactEvidence(key, { localFunctionSignatures = [], localErrorSignatures = [] } = {}) {
  const definitions = sourceArtifactDefinitions[key] ?? [];
  if (definitions.length === 0) {
    const localFunctionNames = namesFromSignatures(localFunctionSignatures);
    const localErrorNames = namesFromSignatures(localErrorSignatures);
    return {
      status: "no_source_artifact_configured",
      evidenceLevel: "runtime_selector_and_live_read_only",
      signatureExtractionStatus: "not_configured",
      signatureExtractionWarnings: [],
      skippedSignatureCandidates: [],
      artifactCount: 0,
      fetchedArtifactCount: 0,
      artifacts: [],
      sourceFunctionSignatureCount: 0,
      sourceFunctionSignaturesSha256: sha256(""),
      sourceExplicitFunctionSignatureCount: 0,
      sourceExplicitFunctionSignaturesSha256: sha256(""),
      sourcePublicGetterSignatureCount: 0,
      sourcePublicGetterSignaturesSha256: sha256(""),
      sourceFunctionNameCount: 0,
      sourceFunctionNamesSha256: sha256(""),
      sourceExplicitFunctionNameCount: 0,
      sourceExplicitFunctionNamesSha256: sha256(""),
      sourcePublicGetterNameCount: 0,
      sourcePublicGetterNamesSha256: sha256(""),
      sourceErrorNameCount: 0,
      sourceErrorNamesSha256: sha256(""),
      localFunctionSignatureCount: localFunctionSignatures.length,
      localFunctionSignaturesSha256: sha256([...localFunctionSignatures].sort().join("\n")),
      localErrorSignatureCount: localErrorSignatures.length,
      localErrorSignaturesSha256: sha256([...localErrorSignatures].sort().join("\n")),
      comparison: {
        sourceFunctionNames: [],
        sourceFunctionSignatures: [],
        sourceExplicitFunctionNames: [],
        sourceExplicitFunctionSignatures: [],
        sourcePublicGetterNames: [],
        sourcePublicGetterSignatures: [],
        sourceErrorNames: [],
        localFunctionNames,
        localErrorNames,
        commonFunctionNames: [],
        commonFunctionSignatures: [],
        commonErrorNames: [],
        localFunctionNamesMissingFromSource: [],
        localFunctionSignaturesMissingFromSource: [],
        expectedLocalFunctionNamesMissingFromSource: [],
        expectedLocalFunctionSignaturesMissingFromSource: [],
        unexpectedLocalFunctionNamesMissingFromSource: [],
        unexpectedLocalFunctionSignaturesMissingFromSource: [],
        expectedMissingReason: null,
        localErrorNamesMissingFromSource: [],
        sourceOnlyFunctionNames: [],
        sourceOnlyFunctionSignatures: [],
        localFunctionNameCoverage: null,
        localFunctionSignatureCoverage: null,
        localErrorNameCoverage: null,
        comparisonScope: "No source artifact is configured for this target. Runtime selector coverage and representative live reads are the authoritative provenance evidence."
      }
    };
  }
  const fetched = await Promise.all(definitions.map(fetchArtifact));
  const sourceTypeDefinitions = mergeTypeDefinitions(fetched.map((artifact) => artifact.typeDefinitions));
  const explicitSignatureExtractions = fetched.map((artifact) =>
    artifact.ok
      ? functionSignatureExtractionFromSource(artifact.text, sourceTypeDefinitions)
      : { signatures: [], skippedCandidates: [] }
  );
  const getterSignatureExtractions = fetched.map((artifact) =>
    artifact.ok
      ? publicStateGetterSignatureExtractionFromSource(artifact.text, sourceTypeDefinitions)
      : { signatures: [], skippedCandidates: [] }
  );
  const sourceExplicitFunctionSignatures = uniqueSorted(explicitSignatureExtractions.flatMap((extraction) => extraction.signatures));
  const sourcePublicGetterSignatures = uniqueSorted(getterSignatureExtractions.flatMap((extraction) => extraction.signatures));
  const sourceFunctionSignatures = uniqueSorted([...sourceExplicitFunctionSignatures, ...sourcePublicGetterSignatures]);
  const skippedSignatureCandidates = [
    ...explicitSignatureExtractions.flatMap((extraction) => extraction.skippedCandidates),
    ...getterSignatureExtractions.flatMap((extraction) => extraction.skippedCandidates)
  ];
  const signatureExtractionStatus = sourceFunctionSignatures.length === 0
    ? "name_only"
    : skippedSignatureCandidates.length > 0
      ? "partial"
      : "complete";
  const signatureExtractionWarnings = skippedSignatureCandidates.length > 0
    ? [`${skippedSignatureCandidates.length} source signature candidate(s) could not be normalized conservatively.`]
    : [];
  const sourceExplicitFunctionNames = uniqueSorted(fetched.flatMap((artifact) => artifact.functionNames));
  const sourcePublicGetterNames = uniqueSorted(fetched.flatMap((artifact) => artifact.publicStateGetterNames));
  const sourceFunctionNames = uniqueSorted([...sourceExplicitFunctionNames, ...sourcePublicGetterNames]);
  const sourceErrorNames = uniqueSorted(fetched.flatMap((artifact) => artifact.errorNames));
  const localFunctionNames = namesFromSignatures(localFunctionSignatures);
  const localErrorNames = namesFromSignatures(localErrorSignatures);
  const commonFunctionNames = localFunctionNames.filter((name) => sourceFunctionNames.includes(name));
  const commonErrorNames = localErrorNames.filter((name) => sourceErrorNames.includes(name));
  const localFunctionNamesMissingFromSource = localFunctionNames.filter((name) => !sourceFunctionNames.includes(name));
  const expectedMissing = expectedLocalFunctionNamesMissingFromSource[key] ?? { names: [], reason: null };
  const expectedMissingSet = new Set(expectedMissing.names);
  const expectedMissingLocalFunctionNames = localFunctionNamesMissingFromSource.filter((name) => expectedMissingSet.has(name));
  const unexpectedLocalFunctionNamesMissingFromSource = localFunctionNamesMissingFromSource.filter((name) => !expectedMissingSet.has(name));
  const commonFunctionSignatures = localFunctionSignatures.filter((signature) => sourceFunctionSignatures.includes(signature));
  const localFunctionSignaturesMissingFromSource = localFunctionSignatures.filter((signature) => !sourceFunctionSignatures.includes(signature));
  const expectedMissingLocalFunctionSignatures = missingExpectedByName(localFunctionSignaturesMissingFromSource, expectedMissing.names);
  const unexpectedLocalFunctionSignaturesMissingFromSource = missingUnexpectedByName(localFunctionSignaturesMissingFromSource, expectedMissing.names);
  const localErrorNamesMissingFromSource = localErrorNames.filter((name) => !sourceErrorNames.includes(name));
  const sourceOnlyFunctionNames = sourceFunctionNames.filter((name) => !localFunctionNames.includes(name));
  const sourceOnlyFunctionSignatures = sourceFunctionSignatures.filter((signature) => !localFunctionSignatures.includes(signature));
  const fetchedArtifacts = fetched.map(({ text, typeDefinitions: _typeDefinitions, ...artifact }) => artifact);
  const okArtifacts = fetchedArtifacts.filter((artifact) => artifact.ok);

  return {
    status: definitions.length === 0
      ? "no_source_artifact_configured"
      : okArtifacts.length === definitions.length
        ? "source_artifacts_fetched"
        : okArtifacts.length > 0
          ? "source_artifacts_partial"
          : "source_artifacts_unavailable",
    evidenceLevel: sourceFunctionSignatures.length > 0
      ? "source_text_hash_and_signature_level_abi_comparison"
      : "source_text_hash_and_name_level_abi_comparison",
    signatureExtractionStatus,
    signatureExtractionWarnings,
    skippedSignatureCandidates,
    artifactCount: definitions.length,
    fetchedArtifactCount: okArtifacts.length,
    artifacts: fetchedArtifacts,
    sourceFunctionSignatureCount: sourceFunctionSignatures.length,
    sourceFunctionSignaturesSha256: sha256(sourceFunctionSignatures.join("\n")),
    sourceExplicitFunctionSignatureCount: sourceExplicitFunctionSignatures.length,
    sourceExplicitFunctionSignaturesSha256: sha256(sourceExplicitFunctionSignatures.join("\n")),
    sourcePublicGetterSignatureCount: sourcePublicGetterSignatures.length,
    sourcePublicGetterSignaturesSha256: sha256(sourcePublicGetterSignatures.join("\n")),
    sourceFunctionNameCount: sourceFunctionNames.length,
    sourceFunctionNamesSha256: sha256(sourceFunctionNames.join("\n")),
    sourceExplicitFunctionNameCount: sourceExplicitFunctionNames.length,
    sourceExplicitFunctionNamesSha256: sha256(sourceExplicitFunctionNames.join("\n")),
    sourcePublicGetterNameCount: sourcePublicGetterNames.length,
    sourcePublicGetterNamesSha256: sha256(sourcePublicGetterNames.join("\n")),
    sourceErrorNameCount: sourceErrorNames.length,
    sourceErrorNamesSha256: sha256(sourceErrorNames.join("\n")),
    localFunctionSignatureCount: localFunctionSignatures.length,
    localFunctionSignaturesSha256: sha256([...localFunctionSignatures].sort().join("\n")),
	    localErrorSignatureCount: localErrorSignatures.length,
	    localErrorSignaturesSha256: sha256([...localErrorSignatures].sort().join("\n")),
	    comparison: {
	      sourceFunctionNames,
	      sourceFunctionSignatures,
	      sourceExplicitFunctionNames,
	      sourceExplicitFunctionSignatures,
	      sourcePublicGetterNames,
	      sourcePublicGetterSignatures,
	      sourceErrorNames,
	      localFunctionNames,
	      localErrorNames,
	      commonFunctionNames,
	      commonFunctionSignatures,
	      commonErrorNames,
	      localFunctionNamesMissingFromSource,
	      localFunctionSignaturesMissingFromSource,
	      expectedLocalFunctionNamesMissingFromSource: expectedMissingLocalFunctionNames,
	      expectedLocalFunctionSignaturesMissingFromSource: expectedMissingLocalFunctionSignatures,
	      unexpectedLocalFunctionNamesMissingFromSource,
	      unexpectedLocalFunctionSignaturesMissingFromSource,
	      expectedMissingReason: expectedMissing.reason,
	      localErrorNamesMissingFromSource,
	      sourceOnlyFunctionNames,
	      sourceOnlyFunctionSignatures,
	      localFunctionNameCoverage: localFunctionNames.length === 0 ? 0 : commonFunctionNames.length / localFunctionNames.length,
	      localFunctionSignatureCoverage: localFunctionSignatures.length === 0 ? 0 : commonFunctionSignatures.length / localFunctionSignatures.length,
	      localErrorNameCoverage: localErrorNames.length === 0 ? null : commonErrorNames.length / localErrorNames.length,
	      comparisonScope: "Signature-level comparison where pinned Solidity source parameter types can be conservatively normalized, plus name-level comparison against explicit functions and public state-variable ABI getters; selector bytecode checks remain the authoritative runtime evidence."
	    }
	  };
}
