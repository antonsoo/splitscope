# Contributing

splitscope is a small, focused tool. Contributions that fit its scope are
welcome.

## Setup

```sh
npm install
npm run dev       # local dev server
npm run ci         # lint + typecheck + test + build
npx playwright install chromium firefox  # once per machine
npm run test:browser # production build, Chromium and Firefox workflows
```

## Before opening a PR

- `npm run ci` and `npm run test:browser` pass.
- New logic in `src/core/` has tests in `tests/` (see `docs/format.md` for
  the parser's own testing philosophy: check against a real reference, not
  vibes).
- UI changes: run `npm run build && npm run preview`, and actually look at
  the result at 375px and at desktop width, light and dark.
- If you change the `.lss` parsing, update `docs/format.md` to match and cite
  your source.

## Reproducing the screenshots

Build, start a preview with `npm run preview -- --port 4331`, then run
`node scripts/capture-workspace.mjs`. It captures desktop and phone layouts,
the PB panel, import recovery, and the actual downloaded PNG card under
`docs/assets/`. Review every image before committing it.

The sum-of-best inspection has a separate capture command:
`node scripts/capture-best-route.mjs`, after building and starting preview on
port 4337. It retains unedited offline downloads in the study's results folder.
See [the compiled-oracle replay](studies/sum-of-best/README.md) for checking changes
to the calculation against LiveSplit and the original XML.

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

## Community and private reports

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Anton Soloviev
maintains this project and handles conduct reports at
[anton@praviel.com](mailto:anton@praviel.com).

Use the bug or improvement forms for public issues. For a suspected security
vulnerability or a conduct concern, email the maintainer privately with the
repository name and relevant details. Do not post credentials, personal data,
private logs, or confidential documents in a public issue.
