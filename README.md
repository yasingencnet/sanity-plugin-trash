# sanity-plugin-trash

A Trash for Sanity Studio: browse documents that were deleted from your dataset and restore them as drafts, for any schema type, with zero configuration.

Sanity has no built-in trash or recycle bin. When a document is deleted it disappears from every list, and recovering it means scripting against the History API. This plugin turns that into a Studio tool: deleting a document in the Studio saves a copy to a navbar **Trash** view first, and where the project's transaction history can be read, deletions made elsewhere (or before the plugin was installed) show up too.

## Features

- **Works with every schema type automatically.** The Studio's Delete action saves a copy of whatever it deletes, no per-type configuration. Filter tabs are built from whatever was actually deleted.
- **Kept until you decide.** Saved copies don't depend on your plan's history retention: they stay in the Trash until they're restored or deleted permanently.
- **Restore as draft.** Restoring recreates the document as a *draft* with its **original ID**, so references reconnect when published. Nothing goes back on your live site until an editor reviews and publishes it. When a deleted document had a draft with newer work than its published version, that newer content is what gets restored.
- **Human-readable previews.** A details dialog renders the deleted document's content using your schema's field titles, with rich-text excerpts, image thumbnails, and resolved reference titles. References whose targets are also deleted get flagged, with a warning that publishing will fail until they're restored too. Raw JSON is available behind an "Advanced" toggle.
- **Search and filters.** Search by title, slug, type, or ID; filter by document type; pick a window (24 hours to all time).
- **Delete permanently.** Multi-select with select-all, guarded by a confirmation dialog. Saved copies are deleted; entries found in the transaction log are hidden for **all** Studio users (state is stored in a hidden `trash.purged` document in the dataset).
- **Permission-aware.** Restore and Delete permanently are disabled (with an explanatory tooltip) for users whose role can't perform them, using the Studio's own grants system.
- **Retention display.** Where the transaction history can be read, the tool shows how far back it reaches.
- **Noise-free.** Publishes, draft discards, and unpublishes are correctly excluded: a document only appears in the Trash when *neither* its published version *nor* its draft exists.

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

## How it works

Sanity deletion is real: there is no soft delete. The Trash draws on two sources.

- **Saved copies.** The plugin wraps the Studio's Delete action: once a delete is confirmed, the published document and its draft are saved to a hidden `trash.*` document before the delete runs. If the copy can't be saved, nothing is deleted. Dotted ids are never readable without a token, and the content is stored as a JSON string, so the copy holds no references that would block deleting other documents or assets.
- **The transaction log.** Deletions made outside the Studio (CLI, API scripts) or before the plugin was installed are found by scanning transactions and checking which touched documents no longer exist, in either published or draft form. The dataset-wide transaction feed isn't available on every project; where it returns nothing, the Trash shows the saved copies only. Transaction history is only kept for your plan's retention window, so keep dataset export backups for anything older.
- Restore recreates the document as a draft with its original ID and removes its saved copy. A document that exists again is never overwritten.
- **"Delete permanently"** deletes saved copies. Entries from the transaction log can only be hidden: Sanity's transaction history is immutable, so raw revisions remain readable via the History API until retention expires. Hidden entries are recorded in a hidden `trash.purged` document, keyed by deletion so a future re-deletion of a recreated document still shows up. The confirmation dialog says exactly this.

## Programmatic API

The underlying data layer is exported for scripts (e.g. `sanity exec` recovery tooling):

```ts
import {
  findDeletedDocuments, // saved copies and logged deletions since a timestamp
  loadRevision,         // a deleted doc's content, from its saved copy or the History API
  saveToTrash,          // save a copy before deleting a document yourself
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
