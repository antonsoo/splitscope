/**
 * Small, defensive accessors over the loosely-typed tree `fast-xml-parser`
 * produces. Every accessor tolerates a missing element (returns `undefined`
 * / `[]`) rather than throwing, because `.lss` files in the wild vary a lot
 * by LiveSplit version and by what the runner actually did (e.g. no
 * `AttemptHistory` at all on a brand-new splits file). Callers that require
 * a field throw a `LssParseError` themselves, with a message naming the
 * field, so the failure is legible to a user, not a stack trace.
 */
export type XmlNode = Record<string, unknown>;

function isNode(value: unknown): value is XmlNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a child element's text content. Self-closing/empty elements come through as `""`. */
export function childText(node: unknown, tag: string): string | undefined {
  if (!isNode(node)) return undefined;
  const value = node[tag];
  if (value === undefined) return undefined;
  if (typeof value === "string" || typeof value === "number") return String(value);
  // An element with only attributes and no text (e.g. `<Foo bar="1"/>`) parses to an object;
  // treat that as empty text rather than a crash.
  if (isNode(value)) return "";
  return undefined;
}

/** Reads a child element as a node (for elements with their own children/attributes). */
export function childNode(node: unknown, tag: string): XmlNode | undefined {
  if (!isNode(node)) return undefined;
  const value = node[tag];
  return isNode(value) ? value : undefined;
}

/** Reads a repeated child element as an array, regardless of whether it parsed to 0, 1, or N. */
export function childArray(node: unknown, tag: string): XmlNode[] {
  if (!isNode(node)) return [];
  const value = node[tag];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.filter(isNode);
  return isNode(value) ? [value] : [];
}

/** Reads an XML attribute (`fast-xml-parser` prefixes attribute keys with `@_`). */
export function attr(node: unknown, name: string): string | undefined {
  if (!isNode(node)) return undefined;
  const value = node[`@_${name}`];
  return typeof value === "string" ? value : undefined;
}

/**
 * Reads an element's own text content, for elements that mix an attribute
 * with a plain-text value (e.g. LiveSplit's pre-1.4.1 `<Time id="3">00:01:00</Time>`).
 * `fast-xml-parser` represents that shape as `{ "@_id": "3", "#text": "00:01:00" }`
 * rather than nesting the value under a child tag. A pure self-closing element
 * (`<Time id="3"/>`) has no `#text` and is treated as an empty value.
 */
export function ownText(node: unknown): string | undefined {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (isNode(node)) {
    const text = node["#text"];
    if (typeof text === "string" || typeof text === "number") return String(text);
    return "";
  }
  return undefined;
}
