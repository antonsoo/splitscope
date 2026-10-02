/**
 * LiveSplit's subsplit naming convention, as its Subsplits component reads it.
 *
 * A segment whose name starts with `-` is a subsplit: a step inside a
 * section. The section ends at the next segment that does not start with
 * `-`, and that segment may be written `{Section name}Segment name` to give
 * the section a name of its own; otherwise the section is named after it.
 * The prefixes are layout instructions, not part of what the runner called
 * the split, so they are taken off for display and the section is kept.
 */
export interface SegmentLabel {
  /** The segment's name without the `-` or `{Section}` prefix. */
  readonly label: string;
  /** The section the segment belongs to, or null when it is not part of one. */
  readonly group: string | null;
  /** True for a `-` segment: a step inside a section, not its last split. */
  readonly isSubsplit: boolean;
}

// The same pattern LiveSplit.Subsplits uses to pull the section name out of a split's name.
const SECTION = /^\{(.+)\}\s*(.+)$/;

export function segmentLabels(names: readonly string[]): SegmentLabel[] {
  const out: { label: string; group: string | null; isSubsplit: boolean }[] = [];
  let open: number[] = [];
  names.forEach((name, i) => {
    if (name.startsWith("-")) {
      // A name that is nothing but the prefix has no label to show; it keeps its dash.
      out.push({ label: name.slice(1).trim() || name, group: null, isSubsplit: true });
      open.push(i);
      return;
    }
    const match = SECTION.exec(name);
    const section = match?.[1]?.trim();
    const group = section !== undefined ? section : open.length > 0 ? name : null;
    const closing = { label: match?.[2] ?? name, group, isSubsplit: false };
    for (const j of open) {
      const step = out[j];
      if (step) step.group = group;
    }
    out.push(closing);
    open = [];
  });
  // Subsplits after the last section end belong to no section: there is no split to name it.
  return out;
}
