import {useEffect, useMemo, useState} from 'react'
import {Box, Button, Card, Code, Dialog, Flex, Stack, Text} from '@sanity/ui'
import {ChevronDownIcon, ChevronRightIcon, RestoreIcon} from '@sanity/icons'
import {useClient, useDocumentValuePermissions, useSchema, UserAvatar} from 'sanity'
import {DocumentPreview} from './DocumentPreview'
import {restoreTarget, type DeletedDoc} from './lib/history'

const API_VERSION = '2025-02-19'

export function DetailDialog(props: {
  doc: DeletedDoc
  restored: boolean
  busy: boolean
  anyBusy: boolean
  onClose: () => void
  onRestore: () => void
  onOpen: () => void
}) {
  const {doc, restored, busy, anyBusy, onClose, onRestore, onOpen} = props
  const schema = useSchema()
  const deleterName = useUserName(doc.deletedBy)
  const [advanced, setAdvanced] = useState(false)
  const [missingRefs, setMissingRefs] = useState(0)

  const target = useMemo(
    () => restoreTarget(doc) ?? {_id: 'trash.placeholder', _type: doc.type ?? 'unknown'},
    [doc],
  )
  const [permissions] = useDocumentValuePermissions({document: target as any, permission: 'create'})
  const canRestore = Boolean(permissions?.granted)

  return (
    <Dialog
      id="trash-detail"
      header={doc.title ?? 'Untitled'}
      width={2}
      onClose={onClose}
      footer={
        <Flex justify="flex-end" gap={2} padding={3}>
          {restored ? (
            <Button mode="ghost" tone="positive" text="Open document" onClick={onOpen} />
          ) : (
            <Button
              icon={RestoreIcon}
              tone="positive"
              text="Restore as draft"
              title={!canRestore ? 'Your role does not allow creating this document' : undefined}
              loading={busy}
              disabled={anyBusy || !canRestore}
              onClick={onRestore}
            />
          )}
        </Flex>
      }
    >
      <Stack space={4} padding={4}>
        <Stack space={3}>
          <DetailRow label="Type" value={schema.get(doc.type ?? '')?.title ?? doc.type} />
          <DetailRow label="Document ID" value={doc.id} />
          {doc.slug && <DetailRow label="Slug" value={`/${doc.slug}`} />}
          <DetailRow label="Deleted" value={new Date(doc.deletedAt).toLocaleString()} />
          <Flex gap={3} align="center">
            <Box style={{width: 110}} flex="none">
              <Text size={1} muted>
                Deleted by
              </Text>
            </Box>
            <Flex gap={2} align="center">
              <UserAvatar user={doc.deletedBy} size={0} />
              <Text size={1}>{deleterName ?? doc.deletedBy}</Text>
            </Flex>
          </Flex>
          {doc.revision?._createdAt && (
            <DetailRow label="Created" value={new Date(doc.revision._createdAt).toLocaleString()} />
          )}
          {doc.revision?._updatedAt && (
            <DetailRow
              label="Last edited"
              value={new Date(doc.revision._updatedAt).toLocaleString()}
            />
          )}
        </Stack>

        {missingRefs > 0 && (
          <Card tone="caution" padding={3} radius={2}>
            <Text size={1}>
              This document references {missingRefs} document{missingRefs === 1 ? '' : 's'} that{' '}
              {missingRefs === 1 ? 'is' : 'are'} also deleted (marked below). You can still
              restore it as a draft, but publishing will fail until those are restored too.
            </Text>
          </Card>
        )}

        {doc.revision && (
          <ContentSection
            label={doc.draftOnly ? 'Draft content (never published)' : 'Content'}
            value={doc.revision}
            onMissingRefs={setMissingRefs}
          />
        )}
        {doc.draftRevision && (
          <ContentSection
            label={`Newer draft (edited ${new Date(
              doc.draftRevision._updatedAt,
            ).toLocaleString()}) — this version is what gets restored`}
            value={doc.draftRevision}
          />
        )}

        <Stack space={2}>
          <Button
            mode="bleed"
            justify="flex-start"
            fontSize={1}
            icon={advanced ? ChevronDownIcon : ChevronRightIcon}
            text="Advanced — raw document JSON"
            onClick={() => setAdvanced((v) => !v)}
          />
          {advanced && doc.revision && <RevisionJson value={doc.revision} />}
          {advanced && doc.draftRevision && <RevisionJson value={doc.draftRevision} />}
        </Stack>
      </Stack>
    </Dialog>
  )
}

function ContentSection(props: {
  label: string
  value: Record<string, any>
  onMissingRefs?: (count: number) => void
}) {
  return (
    <Stack space={2}>
      <Text size={1} weight="semibold">
        {props.label}
      </Text>
      <Card padding={3} radius={2} border>
        <DocumentPreview value={props.value} onMissingRefs={props.onMissingRefs} />
      </Card>
    </Stack>
  )
}

function DetailRow(props: {label: string; value?: string}) {
  return (
    <Flex gap={3}>
      <Box style={{width: 110}} flex="none">
        <Text size={1} muted>
          {props.label}
        </Text>
      </Box>
      <Text size={1} style={{wordBreak: 'break-all'}}>
        {props.value ?? '—'}
      </Text>
    </Flex>
  )
}

function RevisionJson(props: {value: Record<string, any>}) {
  return (
    <Card tone="transparent" padding={3} radius={2} border overflow="auto">
      <Box style={{maxHeight: 320, overflow: 'auto'}}>
        <Code size={1} language="json">
          {JSON.stringify(props.value, null, 2)}
        </Code>
      </Box>
    </Card>
  )
}

/** Resolve a Sanity user id to a display name via the project users API. */
function useUserName(userId: string): string | undefined {
  const client = useClient({apiVersion: API_VERSION})
  const [name, setName] = useState<string>()
  useEffect(() => {
    let alive = true
    ;(client as any).users
      .getById(userId)
      .then((user: any) => {
        if (alive && user?.displayName) setName(user.displayName)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [client, userId])
  return name
}
