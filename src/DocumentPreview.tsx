/**
 * Generic human-readable rendering of a recovered document revision. Works
 * for any schema type: field labels come from the schema when available,
 * portable text collapses to a plain-text excerpt, images render as CDN
 * thumbnails, and references resolve to live document titles, flagging
 * references whose targets are themselves deleted.
 */
import {useEffect, useMemo, useState} from 'react'
import {Badge, Box, Flex, Stack, Text} from '@sanity/ui'
import {useClient, useDataset, useProjectId, useSchema} from 'sanity'
import type {ReactNode} from 'react'
import {titleOf} from './lib/saved'

const API_VERSION = '2025-02-19'

interface RefInfo {
  title?: string
  missing?: boolean
}

interface Ctx {
  refs: Map<string, RefInfo>
  projectId: string
  dataset: string
}

export function DocumentPreview(props: {
  value: Record<string, any>
  /** Called once references resolve, with the number of dangling (deleted) targets. */
  onMissingRefs?: (count: number) => void
}) {
  const {value, onMissingRefs} = props
  const schema = useSchema()
  const client = useClient({apiVersion: API_VERSION})
  const projectId = useProjectId()
  const dataset = useDataset()
  const [refs, setRefs] = useState<Map<string, RefInfo>>(new Map())

  const refIds = useMemo(() => {
    const acc = new Set<string>()
    collectRefs(value, acc)
    return [...acc]
  }, [value])

  useEffect(() => {
    if (refIds.length === 0) return undefined
    let alive = true
    client
      .fetch(
        '*[_id in $ids]{_id, title, name, label, heading}',
        {ids: [...refIds, ...refIds.map((id) => `drafts.${id}`)]},
        {perspective: 'raw', tag: 'trash.refs'} as any,
      )
      .then((found: any[]) => {
        if (!alive) return
        const map = new Map<string, RefInfo>()
        let missing = 0
        for (const id of refIds) {
          const doc =
            found.find((d) => d._id === id) ?? found.find((d) => d._id === `drafts.${id}`)
          if (doc) {
            map.set(id, {title: titleOf(doc) ?? id})
          } else {
            map.set(id, {missing: true})
            missing++
          }
        }
        setRefs(map)
        onMissingRefs?.(missing)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // onMissingRefs deliberately omitted: identity changes must not refetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, refIds])

  const schemaType = schema.get(value._type) as any
  const fieldTitles = useMemo(() => {
    const map = new Map<string, string>()
    for (const field of schemaType?.fields ?? []) {
      map.set(field.name, field.type?.title ?? prettify(field.name))
    }
    return map
  }, [schemaType])

  const ctx: Ctx = {refs, projectId, dataset}
  const entries = Object.entries(value).filter(([k, v]) => !k.startsWith('_') && !isEmpty(v))

  if (entries.length === 0) {
    return (
      <Text size={1} muted>
        This document has no content fields.
      </Text>
    )
  }

  return (
    <Stack space={3}>
      {entries.map(([key, v]) => (
        <Flex key={key} gap={3} align="flex-start">
          <Box style={{width: 130}} flex="none">
            <Text size={1} muted>
              {fieldTitles.get(key) ?? prettify(key)}
            </Text>
          </Box>
          <Box flex={1}>{renderValue(v, ctx, 0)}</Box>
        </Flex>
      ))}
    </Stack>
  )
}

function renderValue(v: any, ctx: Ctx, depth: number): ReactNode {
  if (typeof v === 'string') return <Text size={1}>{truncate(v, 400)}</Text>
  if (typeof v === 'number' || typeof v === 'boolean') return <Text size={1}>{String(v)}</Text>

  if (Array.isArray(v)) {
    // Translated fields (sanity-plugin-internationalized-array): one line per language.
    const translated = (x: any) =>
      typeof x?._type === 'string' && x._type.startsWith('internationalizedArray')
    if (v.every(translated)) {
      return (
        <Stack space={2}>
          {v.map((item, index) => (
            <Flex key={item._key ?? index} gap={2}>
              <Text size={1} muted>
                {String(item.language ?? item._key).toUpperCase()}
              </Text>
              <Box flex={1}>{renderValue(item.value, ctx, depth + 1)}</Box>
            </Flex>
          ))}
        </Stack>
      )
    }
    if (v.some((b) => b?._type === 'block')) {
      return (
        <Text size={1} style={{whiteSpace: 'pre-wrap'}}>
          {truncate(blocksToText(v), 600)}
        </Text>
      )
    }
    if (v.every((x) => x === null || typeof x !== 'object')) {
      return <Text size={1}>{v.map(String).join(', ')}</Text>
    }
    const shown = v.slice(0, 10)
    return (
      <Stack space={2}>
        {shown.map((item, index) => (
          <Text key={item?._key ?? index} size={1}>
            • {itemLabel(item)}
          </Text>
        ))}
        {v.length > 10 && (
          <Text size={1} muted>
            …and {v.length - 10} more
          </Text>
        )}
      </Stack>
    )
  }

  if (v && typeof v === 'object') {
    if (typeof v.current === 'string') return <Text size={1}>/{v.current}</Text>
    if (typeof v._ref === 'string') return <RefValue refId={v._ref} ctx={ctx} />
    if (typeof v.asset?._ref === 'string' && v.asset._ref.startsWith('image-')) {
      const url = imageUrl(v.asset._ref, ctx.projectId, ctx.dataset)
      return url ? (
        <img
          src={url}
          alt={typeof v.alt === 'string' ? v.alt : ''}
          style={{maxWidth: 160, maxHeight: 100, borderRadius: 3, display: 'block'}}
        />
      ) : (
        <Text size={1} muted>
          Image
        </Text>
      )
    }
    if (typeof v.asset?._ref === 'string') {
      return (
        <Text size={1} muted>
          File attachment
        </Text>
      )
    }
    if (depth < 1) {
      const entries = Object.entries(v).filter(([k, x]) => !k.startsWith('_') && !isEmpty(x))
      if (entries.length === 0) return <Text size={1} muted>-</Text>
      return (
        <Stack space={2}>
          {entries.map(([key, x]) => (
            <Flex key={key} gap={2} align="flex-start">
              <Box style={{width: 110}} flex="none">
                <Text size={1} muted>
                  {prettify(key)}
                </Text>
              </Box>
              <Box flex={1}>{renderValue(x, ctx, depth + 1)}</Box>
            </Flex>
          ))}
        </Stack>
      )
    }
    return <Text size={1}>{itemLabel(v)}</Text>
  }

  return (
    <Text size={1} muted>
      -
    </Text>
  )
}

function RefValue(props: {refId: string; ctx: Ctx}) {
  const info = props.ctx.refs.get(props.refId)
  if (!info) {
    return (
      <Text size={1} muted>
        …
      </Text>
    )
  }
  if (info.missing) {
    return (
      <Flex gap={2} align="center">
        <Badge tone="critical">deleted</Badge>
        <Text size={1} muted style={{wordBreak: 'break-all'}}>
          {props.refId}
        </Text>
      </Flex>
    )
  }
  return <Text size={1}>→ {info.title}</Text>
}

/** Best human label for an arbitrary object (array item, nested block, …). */
function itemLabel(item: any): string {
  if (item === null || typeof item !== 'object') return truncate(String(item), 80)
  const direct =
    item.title ?? item.heading ?? item.label ?? item.name ?? item.text ?? item.quote ?? item.alt
  if (typeof direct === 'string' && direct) return truncate(direct, 80)
  for (const v of Object.values(item)) {
    if (Array.isArray(v) && v.some((b: any) => b?._type === 'block')) {
      const text = blocksToText(v)
      if (text) return truncate(text, 80)
    }
  }
  return item._type ? prettify(String(item._type)) : 'Item'
}

function collectRefs(v: any, acc: Set<string>): void {
  if (!v || typeof v !== 'object') return
  if (Array.isArray(v)) {
    for (const item of v) collectRefs(item, acc)
    return
  }
  // Asset references render as thumbnails; no need to resolve titles.
  if (typeof v._ref === 'string' && !/^(image|file)-/.test(v._ref)) acc.add(v._ref)
  for (const value of Object.values(v)) collectRefs(value, acc)
}

function blocksToText(blocks: any[]): string {
  return blocks
    .filter((b) => b?._type === 'block')
    .map((b) => (b.children ?? []).map((c: any) => c?.text ?? '').join(''))
    .join('\n')
    .trim()
}

function imageUrl(ref: string, projectId: string, dataset: string): string | undefined {
  const m = ref.match(/^image-(.+)-(\d+x\d+)-(\w+)$/)
  return m
    ? `https://cdn.sanity.io/images/${projectId}/${dataset}/${m[1]}-${m[2]}.${m[3]}?w=320&fit=max`
    : undefined
}

function isEmpty(v: any): boolean {
  if (v === null || v === undefined || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') {
    if (typeof v._ref === 'string') return false
    return Object.keys(v).every((k) => k.startsWith('_'))
  }
  return false
}

function prettify(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
