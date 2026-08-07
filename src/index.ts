import {definePlugin} from 'sanity'
import {TrashIcon} from '@sanity/icons'
import {TrashTool} from './TrashTool'

/**
 * Configuration for {@link trashTool}.
 *
 * @public
 */
export interface TrashToolConfig {
  /** Initial scan window in days (default 30). */
  defaultWindowDays?: number
}

/**
 * A Trash tool for Sanity Studio.
 *
 * Adds a navbar tool listing documents deleted from the dataset, recovered
 * from the transaction log so it works retroactively and for every schema
 * type, with search, per-type filters, a human-readable content preview,
 * and one-click restore. Restore always recreates the document as a draft
 * with its original id, so nothing goes live without an editor publishing it.
 *
 * Usage in `sanity.config.ts` (or .js):
 *
 * ```ts
 * import {defineConfig} from 'sanity'
 * import {trashTool} from 'sanity-plugin-trash'
 *
 * export default defineConfig({
 *   // ...
 *   plugins: [trashTool()],
 * })
 * ```
 *
 * @public
 */
export const trashTool = definePlugin<TrashToolConfig | void>((config) => ({
  name: 'sanity-plugin-trash',
  tools: [
    {
      name: 'trash',
      title: 'Trash',
      icon: TrashIcon,
      component: TrashTool,
      options: config ?? {},
    },
  ],
}))

export {
  findDeletedDocuments,
  getHistoryHorizon,
  getPurged,
  loadRevision,
  PURGED_DOC_ID,
  purgeFromTrash,
  restoreDeleted,
  restoreTarget,
} from './lib/history'
export type {DeletedDoc} from './lib/history'
