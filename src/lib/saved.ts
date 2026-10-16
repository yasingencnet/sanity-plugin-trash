/**
 * Copies of deleted documents, saved by the Studio's Delete action just before
 * the delete runs (see TrashDeleteAction). They keep the Trash working where
 * the transaction log can't help: it isn't available on every project, and
 * it only reaches back as far as the plan's history retention.
 *
 * Each copy is a hidden `trash.*` document (dotted ids are never readable
 * without a token). The deleted document is stored as a JSON string, so its
 * references don't hold on to the documents and assets they point at.
 */
import type {SanityClient, SanityDocument} from 'sanity'
import type {DeletedDoc} from './history'

export const SAVED_TYPE = 'trash.item'

/** Days a saved copy is kept before it's emptied from the Trash. */
export const DEFAULT_RETENTION_DAYS = 30

const DRAFTS = 'drafts.'

interface SavedRow {
  _id: string
  documentId: string
  documentType: string
  deletedAt: string
  deletedBy: string
  title?: string
  slug?: string
  draftOnly: boolean
}

/** The text of a field, taking the first language of a translated one. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textOf(item?.value ?? item)
      if (text) return text
    }
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const text = key.startsWith('_') ? undefined : textOf(item)
      if (text) return text
    }
  }
  return undefined
}

/** A readable title for a document: its title, name, label or heading. */
export function titleOf(doc: Record<string, any>): string | undefined {
  for (const key of ['title', 'name', 'label', 'heading']) {
    const text = textOf(doc[key])
    if (text) return text
  }
  return undefined
}

export function slugOf(doc: Record<string, any>): string | undefined {
  return typeof doc.slug?.current === 'string' ? doc.slug.current : undefined
}

/** A copy saved by saveToTrash: what Undo puts back. */
export interface SavedCopy {
  savedId: string
  published?: SanityDocument
  draft?: SanityDocument
}

/** Deletes the copies older than `retentionDays` (none when it's 0). */
function expired(retentionDays = DEFAULT_RETENTION_DAYS) {
  if (!retentionDays) return []
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
  const query = '*[_type == $type && deletedAt < $cutoff]'
  return [{delete: {query, params: {type: SAVED_TYPE, cutoff}}}]
}

/** Empty the copies kept longer than `retentionDays`. */
export async function emptyExpired(client: SanityClient, retentionDays?: number): Promise<void> {
  const mutations = expired(retentionDays)
  if (mutations.length) await client.mutate(mutations, {tag: 'trash.expire'})
}

/**
 * Save a copy of a document that is about to be deleted, as stored in the
 * dataset: the Studio's own view can lag behind (a publish still on its way).
 * `published` and `draft` are only used when the dataset has neither, as with
 * a new document that hasn't been saved yet. A newer copy replaces older ones
 * of the same document (deleted, brought back another way, then deleted
 * again), and copies past `retentionDays` are emptied on the way.
 */
export async function saveToTrash(
  client: SanityClient,
  input: {
    id: string
    type: string
    published?: SanityDocument | null
    draft?: SanityDocument | null
    deletedBy?: string
    retentionDays?: number
  },
): Promise<SavedCopy | undefined> {
  const {id, type, deletedBy, retentionDays} = input
  const draftId = `${DRAFTS}${id}`
  const stored: SanityDocument[] = await client.fetch(
    '*[_id in $ids]',
    {ids: [id, draftId]},
    {perspective: 'raw', tag: 'trash.save'} as any,
  )
  const published = stored.length
    ? stored.find((doc) => doc._id === id)
    : (input.published ?? undefined)
  const draft = stored.length
    ? stored.find((doc) => doc._id === draftId)
    : (input.draft ?? undefined)
  const source = draft ?? published
  if (!source) return undefined

  const savedId = `trash.${crypto.randomUUID()}`
  await client.mutate(
    [
      ...expired(retentionDays),
      {delete: {query: '*[_type == $type && documentId == $id]', params: {type: SAVED_TYPE, id}}},
      {
        create: {
          _id: savedId,
          _type: SAVED_TYPE,
          documentId: id,
          documentType: type,
          deletedAt: new Date().toISOString(),
          deletedBy: deletedBy ?? '',
          title: titleOf(source),
          slug: slugOf(source),
          published: published ? JSON.stringify(published) : undefined,
          draft: draft ? JSON.stringify(draft) : undefined,
        },
      },
    ],
    {tag: 'trash.save'},
  )
  return {savedId, published, draft}
}

/**
 * Undo a delete: put the published document and its draft back exactly as
 * they were, and drop the saved copy. Fails if the document exists again.
 */
export async function undoDelete(client: SanityClient, copy: SavedCopy): Promise<void> {
  const tx = client.transaction()
  for (const doc of [copy.published, copy.draft]) {
    if (!doc) continue
    const {_rev, _updatedAt, ...rest} = doc
    tx.create(rest as any)
  }
  tx.delete(copy.savedId)
  await tx.commit({tag: 'trash.undo'})
}

/**
 * Saved copies of documents deleted since `fromTime`, newest first. A copy
 * whose document exists again (brought back without the Trash) is left out.
 */
export async function findSaved(client: SanityClient, fromTime: string): Promise<DeletedDoc[]> {
  const rows: SavedRow[] = await client.fetch(
    `*[_type == $type && deletedAt >= $fromTime
      && count(*[_id in [^.documentId, $drafts + ^.documentId]]) == 0]{
      _id, documentId, documentType, deletedAt, deletedBy, title, slug,
      "draftOnly": !defined(published)
    } | order(deletedAt desc)`,
    {type: SAVED_TYPE, fromTime, drafts: DRAFTS},
    {perspective: 'raw', tag: 'trash.saved'} as any,
  )
  return rows.map((row) => ({
    id: row.draftOnly ? `${DRAFTS}${row.documentId}` : row.documentId,
    draftId: row.draftOnly ? undefined : `${DRAFTS}${row.documentId}`,
    draftOnly: row.draftOnly,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    type: row.documentType,
    title: row.title,
    slug: row.slug,
    savedId: row._id,
  }))
}

/** The document as it was when deleted, from its saved copy. */
export async function loadSaved(client: SanityClient, doc: DeletedDoc): Promise<DeletedDoc> {
  const saved: {published?: string; draft?: string} | null = await client.fetch(
    '*[_id == $id][0]{published, draft}',
    {id: doc.savedId},
    {perspective: 'raw', tag: 'trash.saved'} as any,
  )
  const published = saved?.published ? JSON.parse(saved.published) : undefined
  const draft = saved?.draft ? JSON.parse(saved.draft) : undefined
  const revision = published ?? draft
  if (!revision) return {...doc, unrecoverable: true}
  // A draft next to a published document holds its unpublished changes.
  return {...doc, revision, draftRevision: published ? draft : undefined}
}
