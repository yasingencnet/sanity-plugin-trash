import {useCallback, useEffect, useMemo, useState} from 'react'
import {
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Dialog,
  Flex,
  Select,
  Spinner,
  Stack,
  Text,
  TextInput,
  useToast,
} from '@sanity/ui'
import {EyeOpenIcon, RestoreIcon, SearchIcon, SyncIcon, TrashIcon} from '@sanity/icons'
import {useClient, useDocumentValuePermissions, useSchema, UserAvatar} from 'sanity'
import {useRouter} from 'sanity/router'
import {DetailDialog} from './DetailDialog'
import {
  findDeletedDocuments,
  getHistoryHorizon,
  loadRevision,
  PURGED_DOC_ID,
  purgeFromTrash,
  restoreDeleted,
  restoreTarget,
  type DeletedDoc,
} from './lib/history'

const API_VERSION = '2025-02-19'

const WINDOWS = [
  {days: 1, label: 'Last 24 hours'},
  {days: 7, label: 'Last 7 days'},
  {days: 30, label: 'Last 30 days'},
  {days: 90, label: 'Last 90 days'},
  {days: 0, label: 'All time'},
] as const

type Status = 'loading' | 'ready' | 'error'

export interface TrashToolOptions {
  defaultWindowDays?: number
}

export function TrashTool(props: {tool: {options?: TrashToolOptions | null}}) {
  const client = useClient({apiVersion: API_VERSION})
  const schema = useSchema()
  const router = useRouter()
  const toast = useToast()

  const [windowDays, setWindowDays] = useState(props.tool.options?.defaultWindowDays ?? 30)
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string>()
  const [items, setItems] = useState<DeletedDoc[]>([])
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>()
  const [restoredIds, setRestoredIds] = useState<Set<string>>(new Set())
  const [busyId, setBusyId] = useState<string>()
  const [detail, setDetail] = useState<DeletedDoc>()
  const [horizon, setHorizon] = useState<string>()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmPurge, setConfirmPurge] = useState(false)
  const [purging, setPurging] = useState(false)

  // Purging edits the shared plugin-state document; check the role allows it.
  const purgeDocValue = useMemo(() => ({_id: PURGED_DOC_ID, _type: PURGED_DOC_ID}), [])
  const [purgePermissions] = useDocumentValuePermissions({
    document: purgeDocValue as any,
    permission: 'update',
  })
  const canPurge = Boolean(purgePermissions?.granted)

  const scan = useCallback(async () => {
    setStatus('loading')
    setError(undefined)
    setTypeFilter(undefined)
    setSelected(new Set())
    getHistoryHorizon(client)
      .then(setHorizon)
      .catch(() => {})
    try {
      const from = windowDays ? Date.now() - windowDays * 86_400_000 : 0
      const fromTime = new Date(from).toISOString()
      const found = await findDeletedDocuments(client, fromTime)
      setItems(found)
      setStatus('ready')
      // Enrich progressively with pre-deletion revisions, a few at a time.
      for (let i = 0; i < found.length; i += 5) {
        const chunk = found.slice(i, i + 5)
        const loaded = await Promise.all(chunk.map((doc) => loadRevision(client, doc)))
        setItems((prev) => prev.map((p) => loaded.find((l) => l.id === p.id) ?? p))
      }
    } catch (err: any) {
      setError(err?.message ?? String(err))
      setStatus('error')
    }
  }, [client, windowDays])

  useEffect(() => {
    scan()
  }, [scan])

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((doc) =>
      [doc.title, doc.slug, doc.type, doc.id]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q)),
    )
  }, [items, query])

  const types = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of searched) {
      if (item.type) counts.set(item.type, (counts.get(item.type) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [searched])

  // Drop a type filter that the search has emptied out.
  useEffect(() => {
    if (typeFilter && !types.some(([t]) => t === typeFilter)) setTypeFilter(undefined)
  }, [typeFilter, types])

  const visible = typeFilter ? searched.filter((i) => i.type === typeFilter) : searched

  const handleRestore = useCallback(
    async (doc: DeletedDoc) => {
      setBusyId(doc.id)
      try {
        await restoreDeleted(client, doc)
        setRestoredIds((prev) => new Set(prev).add(doc.id))
        toast.push({
          status: 'success',
          title: `Restored “${doc.title ?? doc.id}” as a draft`,
          description: 'Review and publish it to make it live.',
        })
      } catch (err: any) {
        toast.push({status: 'error', title: 'Restore failed', description: err?.message})
      } finally {
        setBusyId(undefined)
      }
    },
    [client, toast],
  )

  const handleOpen = useCallback(
    (doc: DeletedDoc) => {
      if (!doc.type) return
      const id = doc.draftOnly ? doc.id.slice('drafts.'.length) : doc.id
      router.navigateIntent('edit', {id, type: doc.type})
    },
    [router],
  )

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectedDocs = useMemo(() => items.filter((i) => selected.has(i.id)), [items, selected])

  // Select-all operates on what the user can currently see (search + type
  // filter applied), excluding already-restored rows.
  const selectable = useMemo(
    () => visible.filter((doc) => !restoredIds.has(doc.id)),
    [visible, restoredIds],
  )
  const allSelected = selectable.length > 0 && selectable.every((doc) => selected.has(doc.id))
  const someSelected = selectable.some((doc) => selected.has(doc.id))

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (selectable.every((doc) => next.has(doc.id))) {
        for (const doc of selectable) next.delete(doc.id)
      } else {
        for (const doc of selectable) next.add(doc.id)
      }
      return next
    })
  }, [selectable])

  const handlePurge = useCallback(async () => {
    setPurging(true)
    try {
      await purgeFromTrash(client, selectedDocs)
      setItems((prev) => prev.filter((i) => !selected.has(i.id)))
      setSelected(new Set())
      setConfirmPurge(false)
      toast.push({
        status: 'success',
        title: `Deleted ${selectedDocs.length} document${
          selectedDocs.length === 1 ? '' : 's'
        } from the trash`,
      })
    } catch (err: any) {
      toast.push({status: 'error', title: 'Delete failed', description: err?.message})
    } finally {
      setPurging(false)
    }
  }, [client, selected, selectedDocs, toast])

  return (
    <Card height="fill" overflow="auto">
      <Stack space={4} padding={4} style={{maxWidth: 900, margin: '0 auto'}}>
        <Flex align="center" gap={3}>
          <Box flex={1}>
            <Text size={3} weight="semibold">
              Trash
            </Text>
          </Box>
          <Box flex="none" style={{width: 170}}>
            <Select
              value={String(windowDays)}
              onChange={(event) => setWindowDays(Number(event.currentTarget.value))}
            >
              {WINDOWS.map((w) => (
                <option key={w.days} value={w.days}>
                  {w.label}
                </option>
              ))}
            </Select>
          </Box>
          <Button
            icon={SyncIcon}
            mode="ghost"
            text="Rescan"
            onClick={scan}
            disabled={status === 'loading'}
          />
        </Flex>
        <Text size={1} muted>
          Documents deleted from this dataset, kept until they are restored or deleted
          permanently. Restore recreates a document as a draft with its original ID. Review and
          publish it to put it back on the site.
        </Text>

        {status === 'ready' && items.length > 0 && (
          <TextInput
            icon={SearchIcon}
            placeholder="Search by title, slug, or type…"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        )}

        {types.length > 1 && (
          <Flex gap={2} wrap="wrap">
            <Button
              mode={typeFilter ? 'ghost' : 'default'}
              text={`All (${searched.length})`}
              onClick={() => setTypeFilter(undefined)}
              fontSize={1}
              padding={2}
            />
            {types.map(([type, count]) => (
              <Button
                key={type}
                mode={typeFilter === type ? 'default' : 'ghost'}
                text={`${schema.get(type)?.title ?? type} (${count})`}
                onClick={() => setTypeFilter(type)}
                fontSize={1}
                padding={2}
              />
            ))}
          </Flex>
        )}

        {status === 'loading' && (
          <Flex align="center" justify="center" padding={6} gap={3}>
            <Spinner />
            <Text muted>Loading the trash…</Text>
          </Flex>
        )}

        {status === 'error' && (
          <Card tone="critical" padding={4} radius={2}>
            <Text>Could not load the trash: {error}</Text>
          </Card>
        )}

        {selected.size > 0 && (
          <Card padding={2} radius={2} border tone="transparent">
            <Flex align="center" gap={3}>
              <Flex align="center" gap={2} paddingLeft={2} flex="none">
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected && !allSelected}
                  onChange={toggleSelectAll}
                />
                <Text size={1} muted>
                  Select all ({selectable.length})
                </Text>
              </Flex>
              <Box flex={1}>
                <Text size={1}>{selected.size} selected</Text>
              </Box>
              <Button
                mode="ghost"
                text="Clear"
                fontSize={1}
                onClick={() => setSelected(new Set())}
              />
              <Button
                icon={TrashIcon}
                tone="critical"
                text="Delete permanently…"
                fontSize={1}
                title={!canPurge ? 'Your role does not allow this' : undefined}
                disabled={!canPurge || purging}
                onClick={() => setConfirmPurge(true)}
              />
            </Flex>
          </Card>
        )}

        {status === 'ready' && visible.length === 0 && (
          <Card tone="transparent" padding={6} radius={2}>
            <Text align="center" muted>
              {query.trim()
                ? 'No deleted documents match your search.'
                : 'Trash is empty: no deleted documents found in the selected period.'}
            </Text>
          </Card>
        )}

        {status === 'ready' &&
          visible.map((doc) => (
            <TrashRow
              key={doc.id}
              doc={doc}
              restored={restoredIds.has(doc.id)}
              busy={busyId === doc.id}
              anyBusy={busyId !== undefined}
              selected={selected.has(doc.id)}
              onToggleSelected={() => toggleSelected(doc.id)}
              onDetails={() => setDetail(doc)}
              onRestore={() => handleRestore(doc)}
              onOpen={() => handleOpen(doc)}
            />
          ))}

        {status === 'ready' && items.some((i) => i.unrecoverable) && (
          <Text size={1} muted>
            “Not recoverable” documents have no revision inside your plan’s history retention
            window (often short-lived drafts deleted moments after creation).
          </Text>
        )}

        {horizon && (
          <Text size={1} muted>
            Documents deleted outside the Studio are found in the transaction history, which
            goes back to {new Date(horizon).toLocaleDateString()} for this dataset.
          </Text>
        )}
      </Stack>

      {detail && (
        <DetailDialog
          key={detail.id}
          doc={detail}
          restored={restoredIds.has(detail.id)}
          busy={busyId === detail.id}
          anyBusy={busyId !== undefined}
          onClose={() => setDetail(undefined)}
          onRestore={() => handleRestore(detail)}
          onOpen={() => handleOpen(detail)}
        />
      )}

      {confirmPurge && (
        <Dialog
          id="trash-purge-confirm"
          header="Delete permanently"
          width={1}
          onClose={() => (purging ? undefined : setConfirmPurge(false))}
          footer={
            <Flex justify="flex-end" gap={2} padding={3}>
              <Button
                mode="ghost"
                text="Cancel"
                disabled={purging}
                onClick={() => setConfirmPurge(false)}
              />
              <Button
                icon={TrashIcon}
                tone="critical"
                text="Delete permanently"
                loading={purging}
                onClick={handlePurge}
              />
            </Flex>
          }
        >
          <Stack space={4} padding={4}>
            <Text size={1}>
              Permanently delete {selectedDocs.length} document
              {selectedDocs.length === 1 ? '' : 's'} from the Trash?{' '}
              {selectedDocs.length === 1 ? 'It' : 'They'} will disappear from this list for all
              Studio users and can no longer be restored from here.
            </Text>
            <Card padding={3} radius={2} border tone="critical">
              <Stack space={2}>
                {selectedDocs.slice(0, 8).map((doc) => (
                  <Text key={doc.id} size={1}>
                    • {doc.title ?? doc.id}
                    {doc.type ? ` (${doc.type})` : ''}
                  </Text>
                ))}
                {selectedDocs.length > 8 && (
                  <Text size={1} muted>
                    …and {selectedDocs.length - 8} more
                  </Text>
                )}
              </Stack>
            </Card>
            <Text size={0} muted>
              Note: their saved copies are deleted, but Sanity’s underlying transaction history
              is immutable. Raw revisions remain accessible through the history API until your
              plan’s retention window expires.
            </Text>
          </Stack>
        </Dialog>
      )}
    </Card>
  )
}

function TrashRow(props: {
  doc: DeletedDoc
  restored: boolean
  busy: boolean
  anyBusy: boolean
  selected: boolean
  onToggleSelected: () => void
  onDetails: () => void
  onRestore: () => void
  onOpen: () => void
}) {
  const {doc, restored, busy, anyBusy, selected, onToggleSelected, onDetails, onRestore, onOpen} =
    props
  const schema = useSchema()
  const loaded = doc.revision !== undefined || doc.unrecoverable

  // Restoring means creating this exact draft; check the user's role allows it.
  const target = useMemo(
    () => restoreTarget(doc) ?? {_id: 'trash.placeholder', _type: doc.type ?? 'unknown'},
    [doc],
  )
  const [permissions] = useDocumentValuePermissions({document: target as any, permission: 'create'})
  const canRestore = Boolean(permissions?.granted)

  return (
    <Card padding={3} radius={2} border tone={selected ? 'primary' : undefined}>
      <Flex align="center" gap={3}>
        {!restored && (
          <Box flex="none">
            <Checkbox checked={selected} onChange={onToggleSelected} />
          </Box>
        )}
        <Stack space={2} flex={1}>
          <Flex align="center" gap={2}>
            <Text weight="semibold">{doc.title ?? (loaded ? <em>Untitled</em> : '…')}</Text>
            {doc.type && <Badge tone="primary">{schema.get(doc.type)?.title ?? doc.type}</Badge>}
            {doc.draftOnly && <Badge tone="caution">draft, never published</Badge>}
            {doc.draftRevision && <Badge tone="positive">+ newer draft</Badge>}
            {doc.unrecoverable && <Badge tone="critical">not recoverable</Badge>}
          </Flex>
          <Flex align="center" gap={2}>
            <UserAvatar user={doc.deletedBy} size={0} />
            <Text size={1} muted>
              {doc.slug ? `/${doc.slug} · ` : ''}
              deleted {new Date(doc.deletedAt).toLocaleString()}
            </Text>
          </Flex>
        </Stack>
        <Button
          icon={EyeOpenIcon}
          mode="bleed"
          text="Details"
          disabled={!loaded || doc.unrecoverable}
          onClick={onDetails}
        />
        {restored ? (
          <Button mode="ghost" tone="positive" text="Open" onClick={onOpen} />
        ) : (
          <Button
            icon={RestoreIcon}
            tone="positive"
            text="Restore"
            title={
              loaded && !doc.unrecoverable && !canRestore
                ? 'Your role does not allow creating this document'
                : undefined
            }
            loading={busy}
            disabled={!loaded || doc.unrecoverable || anyBusy || !canRestore}
            onClick={onRestore}
          />
        )}
      </Flex>
    </Card>
  )
}
