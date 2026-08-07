# sanity-plugin-trash

A WordPress-style **Trash** for Sanity Studio: browse documents that were deleted from your dataset and restore them as drafts — for **any** schema type, with zero configuration.

Sanity has no built-in trash or recycle bin. When a document is deleted it disappears from every list, and recovering it means scripting against the History API. This plugin turns that into a Studio tool: a navbar **Trash** view that reconstructs deletions from the dataset's transaction log, so it even works retroactively for documents deleted before the plugin was installed.

## Features

- **Works with every schema type automatically** — deletions are discovered from the transaction log, not per-type configuration. Filter tabs are built from whatever was actually deleted.
- **Restore as draft** — restoring recreates the document as a *draft* with its **original ID** (so references reconnect when published). Nothing goes back on your live site until an editor reviews and publishes it. When a deleted document had a draft with newer work than its published version, that newer content is what gets restored.
- **Human-readable previews** — a details dialog renders the deleted document's content using your schema's field titles, with rich-text excerpts, image thumbnails, and resolved reference titles. References whose targets are also deleted get flagged, with a warning that publishing will fail until they're restored too. Raw JSON is available behind an "Advanced" toggle.
- **Search & filters** — search by title, slug, type, or ID; filter by document type; pick a scan window (24 hours to 90 days).
- **Delete permanently** — multi-select with select-all, guarded by a confirmation dialog. Purged entries disappear from the Trash for **all** Studio users (state is stored in a hidden `trash.purged` document in the dataset).
- **Permission-aware** — Restore and Delete permanently are disabled (with an explanatory tooltip) for users whose role can't perform them, using the Studio's own grants system.
- **Retention honesty** — the tool shows how far back your dataset's transaction history reaches, so an empty trash is never falsely reassuring.
- **Noise-free** — publishes, draft discards, and unpublishes are correctly excluded: a document only appears in the Trash when *neither* its published version *nor* its draft exists.

## Installation

```sh
npm install sanity-plugin-trash
```

## Usage

Add it as a plugin in `sanity.config.ts` (or .js):

```ts
import {defineConfig} from 'sanity'
import {trashTool} from 'sanity-plugin-trash'

export default defineConfig({
  // ...
  plugins: [trashTool()],
})
```

### Options

```ts
trashTool({
  /** Initial scan window in days (default 30) */
  defaultWindowDays: 7,
})
```

### Moving the tool to the end of the navbar

The plugin doesn't force a navbar position. To place Trash last (after core tools like Releases), reorder in your config:

```ts
export default defineConfig({
  // ...
  tools: (prev) => {
    const trash = prev.find((tool) => tool.name === 'trash')
    return trash ? [...prev.filter((tool) => tool !== trash), trash] : prev
  },
})
```

## How it works (and honest limitations)

Sanity deletion is real — there is no soft delete. This plugin reconstructs a *virtual* trash from the dataset's **transaction log**:

- Deletions are found by scanning transactions and checking which touched documents no longer exist (in either published or draft form).
- Restore fetches the document's last pre-deletion revision from the History API and recreates it as a draft via `createIfNotExists` — an existing document is never overwritten.
- **Retention applies.** Transaction history is only kept for your plan's retention window (shown at the bottom of the tool). Documents deleted before that window are unrecoverable — keep dataset export backups for anything older.
- **"Delete permanently" hides, it cannot scrub.** Sanity's transaction history is immutable; purging removes entries from the Trash UI for all users (recorded in a hidden `trash.purged` document, keyed by deletion so a future re-deletion of a recreated document still shows up), but raw revisions remain readable via the History API until retention expires. The confirmation dialog says exactly this.
- Deletions made outside the Studio (CLI, API scripts) are found too — the transaction log sees everything.

## Programmatic API

The underlying data layer is exported for scripts (e.g. `sanity exec` recovery tooling):

```ts
import {
  findDeletedDocuments, // scan + classify deletions since a timestamp
  loadRevision,         // fetch a deleted doc's last pre-deletion revision
  restoreDeleted,       // recreate as draft with original id
  restoreTarget,        // the exact draft a restore would create
  getHistoryHorizon,    // oldest retained transaction timestamp
  getPurged,            // entries hidden via "delete permanently"
  purgeFromTrash,       // hide entries from the Trash for all users
} from 'sanity-plugin-trash'
```

## License

[MIT](LICENSE) © Yasin Genc

## Develop & test

This plugin uses [@sanity/plugin-kit](https://github.com/sanity-io/plugins/tree/main/packages/@sanity/plugin-kit)
with default configuration for build & watch scripts.

See [Testing a plugin in Sanity Studio](https://github.com/sanity-io/plugins/tree/main/packages/@sanity/plugin-kit#testing-a-plugin-in-sanity-studio)
on how to run this plugin with hotreload in the studio.
