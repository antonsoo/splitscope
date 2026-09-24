# Contributing

splitscope is a small, focused tool. Contributions that fit its scope are
welcome.

## Setup

```sh
npm install
npm run dev       # local dev server
npm run ci         # lint + typecheck + test + build, same as CI
```

## Before opening a PR

- `npm run ci` passes.
- New logic in `src/core/` has tests in `tests/` (see `docs/format.md` for
  the parser's own testing philosophy: check against a real reference, not
  vibes).
- UI changes: run `npm run build && npm run preview`, and actually look at
  the result at 375px and at desktop width, light and dark.
- If you change the `.lss` parsing, update `docs/format.md` to match and cite
  your source.

## Regenerating the sample data

`examples/*.lss` are generated, not hand-written:

```sh
npm run sample:generate
```

## Reporting a parser bug

If splitscope mis-parses a real `.lss` file, the most useful bug report is
the file itself (or a trimmed-down version reproducing the issue) plus which
LiveSplit version wrote it. Please redact anything you don't want public —
game/category names and attempt timestamps are usually fine to share, but
it's your call.
