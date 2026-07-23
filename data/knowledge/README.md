# Aviation Knowledge Map — content source

This folder is the **source of truth** for the knowledge map at `/knowledge.html`.
Edit the Markdown here, run the build, commit both the Markdown and the
regenerated `data/knowledge.json`. Never hand-edit `data/knowledge.json` or the
data inside `js/knowledge.js` — `js/knowledge.js` is just the rendering engine.

## Files

- `_root.md` — the map's root node ("Aviation"): frontmatter + a summary. Its
  children are the domains, ordered by each domain's `order`.
- one file per **domain** (e.g. `wx.md`, `emerg.md`), named by its group key.

## Editing

Each line is a concept. Indentation (2 spaces per level) is containment:

```markdown
- Airframe Icing {#icing} :: Structural ice needs visible moisture… -> icing-conditions "same moisture"
  - Rime, Clear & Mixed :: Rime is rough and milky…
  - Effects on the Wing :: Even light ice… -> stall "raises stall speed"
```

Line grammar: `- <label> [{#id}] :: <summary> [-> <target-id> "<link label>"] …`

- **`{#id}`** — an explicit id, needed only if another line links *to* this node.
  Nodes with no id get one auto-assigned (they're never referenced).
- **`-> target-id "label"`** — a cross-link (the dashed gold lines). `target-id`
  is another node's `{#id}`, in this file or any other. Repeat for several links.
- The **group/colour** comes from the file's frontmatter and applies to every
  node in the file — don't set it per line.

To add a domain: create `<groupkey>.md` with frontmatter
(`id`, `group`, `label`, `groupName`, `color`, `order`) and a summary, then bullets.

## Build

From the repo root:

```
python scripts/build_knowledge.py
```

It compiles every `.md` here into `data/knowledge.json` (which the page fetches)
and **validates** as it goes — duplicate ids and unresolved `-> ` link targets
are fatal errors, so a broken cross-link fails the build instead of silently
vanishing. Stdlib only; no dependencies. Commit the regenerated JSON alongside
your Markdown changes.
