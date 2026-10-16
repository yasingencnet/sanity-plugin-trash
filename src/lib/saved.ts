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

/**
 * Save a copy of a document that is about to be deleted. A newer copy replaces
 * older ones of the same document (deleted, brought back another way, then
 * deleted again).
 */
export async function saveToTrash(
  client: SanityClient,
  input: {
    id: string
    type: string
    published?: SanityDocument | null
    draft?: SanityDocument | null
    deletedBy?: string
  },
): Promise<void> {
  const {id, type, published, draft, deletedBy} = input
  const source = draft ?? published
  if (!source) return
  await client.mutate(
    [
      {delete: {query: '*[_type == $type && documentId == $id]', params: {type: SAVED_TYPE, id}}},
      {
        create: {
          _id: `trash.${crypto.randomUUID()}`,
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
  const newerDraft =
    published && draft && String(draft._updatedAt) > String(published._updatedAt)
      ? draft
      : undefined
  return {...doc, revision, draftRevision: newerDraft}
}
