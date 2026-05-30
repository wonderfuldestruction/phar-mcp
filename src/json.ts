/** @summary Recursively convert BigInt values to strings for JSON serialization */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => jsonSafe(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonSafe(item)])
    );
  }

  return value;
}

/** @summary Serialize a value to JSON string with BigInt-safe conversion and pretty formatting */

export function stringifyJson(value: unknown): string {
  return JSON.stringify(jsonSafe(value), null, 2);
}
