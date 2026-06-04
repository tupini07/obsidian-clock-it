# Clock In

Track your daily work time directly inside an Obsidian note, inspired by emacs
org-mode's clock. Work in flexible chunks throughout the day, start/stop the
clock with a button, and see a live running total against your daily target.

All data is stored in the note's YAML frontmatter, so you can also edit it by
hand whenever you forget to start or stop the clock.

## Usage

Add a `clock-in` code block to a note (for example at the top of your daily
note, or in your daily-note template):

````markdown
```clock-in
```
````

This renders an interactive widget:

- **▶ Start** — begins a new segment at the current time.
- **■ Stop** — closes the running segment at the current time.
- **Editable rows** — each segment is a pair of `HH:mm` inputs. Fix a forgotten
  start/stop by typing directly; changes commit when you leave the field or
  press <kbd>Enter</kbd>.
- **+ Add row** — manually add a segment.
- **× ** — delete a segment.

The header shows your live total versus your target, e.g.
`5h 20m / 8h  (2h 40m left)`, updating once per second while a segment runs.

## Frontmatter format

Segments are stored under the `clock-in` key as compact `HH:mm-HH:mm` strings.
A running (open) segment has no end time:

```yaml
---
clock-in:
  - 09:00-11:00
  - 13:00-
---
```

In this example the first segment is closed (2h) and the second is still
running. You can add, edit, or remove entries here directly and the widget will
pick up the changes.

### Per-note target (optional)

The default daily target is set in the plugin settings (8 hours by default). A
single note can override it with a `clock-in-target` key:

```yaml
---
clock-in-target: "06:00"
---
```

## Notes & limitations

- Times are `HH:mm` only. A single segment **cannot cross midnight**; an end
  time earlier than its start is flagged as invalid rather than wrapping to the
  next day.
- Only **one** segment may be running at a time. Start is disabled while a
  segment is open; Stop is disabled when none is.
- Use **one** `clock-in` block per note.

## Installation (BRAT)

This plugin is distributed for [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable the **BRAT** community plugin.
2. In BRAT, choose **Add Beta plugin** and enter this repository's URL.
3. BRAT installs the latest release; enable **Clock In** in
   *Settings → Community plugins*.

Releases are produced by the `Release` GitHub Actions workflow (manual
dispatch), which builds the plugin and publishes the `main.js`, `manifest.json`,
and `styles.css` assets that BRAT needs.

## Development

```bash
npm install      # install dependencies
npm run dev      # rollup watch build
npm run build    # production build -> main.js
npm test         # run jest unit tests for clockUtils
```

The pure time logic lives in `clockUtils.ts` and is covered by
`clockUtils.test.ts`. The Obsidian integration (widget rendering, frontmatter
reads/writes, live timer) lives in `main.ts`.

## License

MIT
