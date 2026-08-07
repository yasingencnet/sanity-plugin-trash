/**
 * Pure data layer for the Trash tool. No React: everything takes a Sanity
 * client, so the same code runs in the Studio and in Node harnesses/tests.
 *
 * "Trash" is virtual: Sanity has no soft delete, so deleted documents only
 * exist in the dataset's transaction log (bounded by the plan's history
 * retention). This module finds real deletions in that log, filtering out
 * the draft-delete noise that publish/discard operations produce, and
 * restores documents from their last pre-deletion revision.
 */
import type {SanityClient} from 'sanity'

export interface DeletedDoc {
  /** Published id, or the drafts.* id for never-published documents */
  id: string
  /** Companion drafts.* id that vanished alongside the published doc */
  draftId?: string
  /** True when the document only ever existed as a draft */
  draftOnly: boolean
  deletedAt: string
  deletedBy: string
  /** Filled in by loadRevision */
  type?: string
  title?: string
  slug?: string
  revision?: Record<string, any>
  draftRevision?: Record<string, any>
  /** True when no recoverable content exists in the history retention window */
  unrecoverable?: boolean
}

interface TouchInfo {
  timestamp: string
  author: string
}

const DRAFTS = 'drafts.'

/**
 * Hidden plugin-state document recording trash entries that were "deleted
 * permanently". The dotted id keeps it invisible to unauthenticated API
 * queries; sharing it in the dataset makes purges apply to every Studio user.
 * Entries are keyed by (id, deletedAt) so purging one deletion never hides a
 * future deletion of a recreated document with the same id.
 */
export const PURGED_DOC_ID = 'trash.purged'

interface PurgeEntry {
  _key?: string
  id: string
  deletedAt: string
}

function purgeKey(id: string, deletedAt: string): string {
  return `${id}@${deletedAt}`
}

export async function getPurged(client: SanityClient): Promise<Set<string>> {
  const entries: PurgeEntry[] | null = await client.fetch(
    '*[_id == $id][0].entries',
    {id: PURGED_DOC_ID},
    {perspective: 'raw', tag: 'trash.purged'} as any,
  )
  return new Set((entries ?? []).map((e) => purgeKey(e.id, e.deletedAt)))
}

/**
 * "Delete permanently": hide these trash entries from the Trash tool for all
 * Studio users. Sanity's transaction history itself is immutable: the raw
 * revisions remain readable via the history API until retention expires.
 */
export async function purgeFromTrash(client: SanityClient, docs: DeletedDoc[]): Promise<void> {
  const entries: PurgeEntry[] = docs.map((d) => ({
    _key: purgeKey(d.id, d.deletedAt).replace(/[^\w-]/g, '-'),
    id: d.id,
    deletedAt: d.deletedAt,
  }))
  await client.createIfNotExists({_id: PURGED_DOC_ID, _type: PURGED_DOC_ID, entries: []} as any)
  await client
    .patch(PURGED_DOC_ID)
    .setIfMissing({entries: []})
    .append('entries', entries)
    .commit()
}

function isSystemId(id: string): boolean {
  return id.startsWith('sanity.') || id.startsWith(`${DRAFTS}sanity.`)
}

/**
 * Scan the transaction log since `fromTime` and return documents that were
 * touched in the window but no longer exist, classified so that drafts
 * consumed by a publish/discard (published doc still exists) are excluded.
 */
export async function findDeletedDocuments(
  client: SanityClient,
  fromTime: string,
): Promise<DeletedDoc[]> {
  const {dataset} = client.config()
  const [ndjson, purged] = await Promise.all([
    client.request<string>({
      uri: `/data/history/${dataset}/transactions?fromTime=${encodeURIComponent(
        fromTime,
      )}&excludeContent=true&reverse=true`,
      tag: 'trash.scan',
    }),
    getPurged(client),
  ])

  const txs = String(ndjson)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

  // reverse=true yields newest first; keeping the first occurrence per id
  // records each document's most recent transaction (= its deletion, for
  // documents that no longer exist).
  const touched = new Map<string, TouchInfo>()
  for (const tx of txs) {
    for (const id of tx.documentIDs ?? []) {
      if (!touched.has(id)) touched.set(id, {timestamp: tx.timestamp, author: tx.author})
    }
  }

  const ids = [...touched.keys()].filter((id) => !isSystemId(id))
  if (ids.length === 0) return []

  // Existence must also cover each id's counterpart, even when the window
  // never touched it: the draft of a deleted published doc may exist (the doc
  // lives on unpublished, e.g. an unpublish or a trash restore-as-draft),
  // and the published doc of a deleted draft may exist (just a discard).
  const toCheck = new Set<string>(ids)
  for (const id of ids) {
    if (id.startsWith(DRAFTS)) toCheck.add(id.slice(DRAFTS.length))
    else toCheck.add(`${DRAFTS}${id}`)
  }

  // Which of these still exist? (raw perspective: drafts must be visible)
  const existing = new Set<string>()
  const checkIds = [...toCheck]
  for (let i = 0; i < checkIds.length; i += 500) {
    const chunk = checkIds.slice(i, i + 500)
    const found: string[] = await client.fetch(
      '*[_id in $ids][]._id',
      {ids: chunk},
      {perspective: 'raw', tag: 'trash.existence'} as any,
    )
    for (const id of found) existing.add(id)
  }

  const gone = new Set(ids.filter((id) => !existing.has(id)))

  const result: DeletedDoc[] = []
  for (const id of gone) {
    if (id.startsWith(DRAFTS)) {
      const base = id.slice(DRAFTS.length)
      // Draft gone but published doc exists → publish or discard, not a loss.
      if (existing.has(base)) continue
      // Both gone → reported via the published entry below.
      if (gone.has(base)) continue
      const info = touched.get(id)!
      if (purged.has(purgeKey(id, info.timestamp))) continue
      result.push({
        id,
        draftOnly: true,
        deletedAt: info.timestamp,
        deletedBy: info.author,
      })
    } else {
      const draftId = `${DRAFTS}${id}`
      // Published gone but a draft exists → the document still exists in the
      // Studio (unpublished or already restored). Not trash.
      if (existing.has(draftId)) continue
      const info = touched.get(id)!
      if (purged.has(purgeKey(id, info.timestamp))) continue
      result.push({
        id,
        draftId,
        draftOnly: false,
        deletedAt: info.timestamp,
        deletedBy: info.author,
      })
    }
  }

  return result.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

/** Timestamp 1s before `iso`, the last instant the doc verifiably existed. */
function justBefore(iso: string): string {
  return new Date(new Date(iso).getTime() - 1000).toISOString()
}

async function revisionAt(
  client: SanityClient,
  id: string,
  time: string,
): Promise<Record<string, any> | undefined> {
  const {dataset} = client.config()
  try {
    const res = await client.request<{documents?: Record<string, any>[]}>({
      uri: `/data/history/${dataset}/documents/${id}?time=${encodeURIComponent(time)}`,
      tag: 'trash.revision',
    })
    return res.documents?.[0]
  } catch {
    return undefined
  }
}

/**
 * Fetch the last pre-deletion revision(s) for a deleted document and fill in
 * display metadata. For published docs whose draft vanished in the same
 * window, the draft revision is kept only if it holds newer work than the
 * published revision (a draft consumed by the final publish adds nothing).
 */
export async function loadRevision(client: SanityClient, doc: DeletedDoc): Promise<DeletedDoc> {
  const revision = await revisionAt(client, doc.id, justBefore(doc.deletedAt))
  const out: DeletedDoc = {...doc, revision}

  if (!doc.draftOnly && doc.draftId && revision) {
    const draftRevision = await revisionAt(client, doc.draftId, justBefore(doc.deletedAt))
    if (
      draftRevision &&
      String(draftRevision._updatedAt) > String(revision._updatedAt)
    ) {
      out.draftRevision = draftRevision
    }
  }

  const src = revision ?? out.draftRevision
  if (src) {
    out.type = src._type
    out.title = src.title ?? src.name ?? src.label ?? undefined
    out.slug = src.slug?.current
  } else {
    out.unrecoverable = true
  }
  return out
}

/**
 * The document a restore would create: always a DRAFT (`drafts.` + original
 * id), carrying the newest recovered content (the deleted draft when it was newer
 * than the published revision). Restoring as a draft keeps restored content
 * off the live site until an editor reviews and publishes it. Draft
 * creation also skips strong reference validation, so a document pointing at
 * still-deleted documents can be restored first and repaired before publish.
 *
 * Exported separately so the UI can permission-check the exact document that
 * would be created.
 */
export function restoreTarget(doc: DeletedDoc): Record<string, any> | undefined {
  const source = doc.draftRevision ?? doc.revision
  if (!source) return undefined
  const {_rev, _updatedAt, ...rest} = source
  const draftId = doc.id.startsWith(DRAFTS) ? doc.id : `${DRAFTS}${doc.id}`
  return {...rest, _id: draftId}
}

/**
 * Restore a deleted document as a draft with its original id (so references
 * reconnect once published). Uses createIfNotExists so an existing draft is
 * never clobbered. Returns the created draft id.
 */
export async function restoreDeleted(client: SanityClient, doc: DeletedDoc): Promise<string> {
  const target = restoreTarget(doc)
  if (!target) throw new Error(`No recoverable revision for ${doc.id}`)
  await client.createIfNotExists(target as any)
  return target._id as string
}

/**
 * The timestamp of the oldest transaction still retained for this dataset,
 * the horizon of what the trash can see. Deletions before it are gone for
 * good (short of a dataset export backup).
 */
export async function getHistoryHorizon(client: SanityClient): Promise<string | undefined> {
  const {dataset} = client.config()
  const ndjson = await client.request<string>({
    uri: `/data/history/${dataset}/transactions?fromTime=2000-01-01T00:00:00Z&limit=1&excludeContent=true`,
    tag: 'trash.horizon',
  })
  const first = String(ndjson).split('\n').filter(Boolean)[0]
  return first ? JSON.parse(first).timestamp : undefined
}
