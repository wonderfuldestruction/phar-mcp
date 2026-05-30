import type { Abi, AbiFunction, AbiParameter } from "viem";
import { getAddress, isAddress } from "viem";
import { contractAbis } from "./abis.js";
import { contractRegistry, registryEntries, type ContractRegistryEntry } from "./contracts.js";

export class LookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LookupError";
  }
}

type FunctionEntry = AbiFunction & {
  name: string;
  inputs: readonly AbiParameter[];
  stateMutability: "pure" | "view" | "nonpayable" | "payable";
};

const contractAliasMap = new Map<string, ContractRegistryEntry>(
  registryEntries().flatMap((entry) => [
    [normalizeKey(entry.key), entry],
    [normalizeKey(entry.name), entry]
  ])
);

/** @summary Normalize a contract key or name to lowercase alphanumeric string for lookup */

export function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** @summary Look up a contract registry entry by key or name, throwing on unknown contracts */

export function lookupContract(contract: string): ContractRegistryEntry {
  const entry = contractAliasMap.get(normalizeKey(contract));
  if (!entry) {
    throw new LookupError(`Unknown contract "${contract}". Use pharaoh_contracts_get or pharaoh_functions_list to inspect supported registry keys.`);
  }
  return entry;
}

/** @summary Retrieve the ABI for a contract registry entry, throwing if no ABI is available */

export function getContractAbi(entry: ContractRegistryEntry): Abi {
  if (!entry.abiKey) {
    throw new LookupError(`Contract "${entry.key}" has status "${entry.status}" and no verified ABI functions in this server.`);
  }
  return contractAbis[entry.abiKey] as Abi;
}

/** @summary Extract all function entries from an ABI array */

export function abiFunctions(abi: Abi): FunctionEntry[] {
  return abi.filter((item): item is FunctionEntry => item.type === "function") as FunctionEntry[];
}

/** @summary Format an ABI parameter type including nested tuple components */

export function canonicalParameterType(parameter: AbiParameter): string {
  if (parameter.type.startsWith("tuple")) {
    const tupleSuffix = parameter.type.slice("tuple".length);
    const components = "components" in parameter && parameter.components
      ? parameter.components.map((component) => canonicalParameterType(component)).join(",")
      : "";
    return `(${components})${tupleSuffix}`;
  }

  return parameter.type;
}

/** @summary Build a function signature string from name and parameter types */

export function functionSignature(fn: FunctionEntry): string {
  return `${fn.name}(${fn.inputs.map((input) => canonicalParameterType(input)).join(",")})`;
}

/** @summary Find a function in an ABI by name or full signature, resolving overloads */

export function lookupFunction(abi: Abi, functionNameOrSignature: string): FunctionEntry {
  const functions = abiFunctions(abi);
  const bySignature = functions.find((fn) => functionSignature(fn) === functionNameOrSignature);
  if (bySignature) {
    return bySignature;
  }

  const byName = functions.filter((fn) => fn.name === functionNameOrSignature);
  if (byName.length === 1) {
    return byName[0];
  }

  if (byName.length > 1) {
    throw new LookupError(`Function "${functionNameOrSignature}" is overloaded. Use one full signature: ${byName.map(functionSignature).join(", ")}.`);
  }

  throw new LookupError(`Unknown function "${functionNameOrSignature}". Use pharaoh_functions_list to inspect supported signatures.`);
}

/** @summary Validate and checksum an EVM address string */

export function normalizeAddress(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new LookupError(`${label} must be an EVM address string.`);
  }
  return getAddress(value);
}

/** @summary Validate and normalize function arguments against ABI input types */

export function normalizeArgs(fn: FunctionEntry, args: unknown[] | undefined): unknown[] {
  const provided = args ?? [];
  if (provided.length !== fn.inputs.length) {
    throw new LookupError(`${functionSignature(fn)} expects ${fn.inputs.length} args, received ${provided.length}.`);
  }

  return fn.inputs.map((input, index) => normalizeAbiValue(input, provided[index], `args[${index}]`));
}

/** @summary Parse a bigint-compatible value from string, number, or bigint input */

export function parseBigIntLike(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new LookupError(`${label} must be a safe integer number, decimal string, or hex string.`);
    }
    return BigInt(value);
  }

  if (typeof value === "string") {
    if (/^-?0x[0-9a-fA-F]+$/.test(value) || /^-?[0-9]+$/.test(value)) {
      return BigInt(value);
    }
  }

  throw new LookupError(`${label} must be a bigint-compatible decimal string, hex string, or safe integer number.`);
}

function normalizeAbiValue(parameter: AbiParameter, value: unknown, label: string): unknown {
  if (isArrayType(parameter.type)) {
    if (!Array.isArray(value)) {
      throw new LookupError(`${label} must be an array for ABI type ${parameter.type}.`);
    }
    return value.map((item, index) => normalizeAbiValue(arrayElementParameter(parameter), item, `${label}[${index}]`));
  }

  if (parameter.type === "tuple") {
    return normalizeTupleValue(parameter, value, label);
  }

  if (/^u?int([0-9]+)?$/.test(parameter.type)) {
    return parseBigIntLike(value, label);
  }

  if (parameter.type === "address") {
    return normalizeAddress(value, label);
  }

  if (parameter.type === "bool") {
    if (typeof value !== "boolean") {
      throw new LookupError(`${label} must be a boolean.`);
    }
    return value;
  }

  if (parameter.type === "string") {
    if (typeof value !== "string") {
      throw new LookupError(`${label} must be a string.`);
    }
    return value;
  }

  if (parameter.type === "bytes" || /^bytes[0-9]+$/.test(parameter.type)) {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
      throw new LookupError(`${label} must be a 0x-prefixed hex string for ABI type ${parameter.type}.`);
    }
    return value;
  }

  return value;
}

function normalizeTupleValue(parameter: AbiParameter, value: unknown, label: string): unknown {
  if (!("components" in parameter) || !parameter.components) {
    throw new LookupError(`${label} is tuple typed but has no ABI components.`);
  }

  if (Array.isArray(value)) {
    if (value.length !== parameter.components.length) {
      throw new LookupError(`${label} tuple expects ${parameter.components.length} values, received ${value.length}.`);
    }
    return parameter.components.map((component, index) => normalizeAbiValue(component, value[index], `${label}.${component.name || index}`));
  }

  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(
      parameter.components.map((component, index) => {
        const key = component.name || String(index);
        if (!(key in input)) {
          throw new LookupError(`${label} tuple is missing component "${key}".`);
        }
        return [key, normalizeAbiValue(component, input[key], `${label}.${key}`)];
      })
    );
  }

  throw new LookupError(`${label} must be an object or array for tuple ABI type.`);
}

function isArrayType(type: string): boolean {
  return /\[[0-9]*\]$/.test(type);
}

function arrayElementParameter(parameter: AbiParameter): AbiParameter {
  const elementType = parameter.type.replace(/\[[0-9]*\]$/, "");
  if (elementType === "tuple") {
    return { ...parameter, type: "tuple" } as AbiParameter;
  }
  return { ...parameter, type: elementType } as AbiParameter;
}
