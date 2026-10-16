import {cloneElement, isValidElement, useRef, useState} from 'react'
import {Button, useToast} from '@sanity/ui'
import {useClient, useCurrentUser, useDocumentStore, type DocumentActionComponent} from 'sanity'
import {useRouter} from 'sanity/router'
import {saveToTrash, undoDelete, type SavedCopy} from './lib/saved'

const API_VERSION = '2025-02-19'

/** How long Undo is offered after a delete. */
const UNDO_MS = 10_000

type ConfirmProps = {onConfirm?: (...args: unknown[]) => void}

/**
 * Wraps the Studio's Delete action so a copy of the document goes to the
 * Trash once the delete is confirmed and before it runs. When the copy can't
 * be saved, the document is left as it is. Once the delete has gone through,
 * a toast offers to undo it.
 */
export function trashDelete(options: {retentionDays?: number}) {
  const wrapped = new WeakMap<DocumentActionComponent, DocumentActionComponent>()

  return function withTrash(Delete: DocumentActionComponent): DocumentActionComponent {
    const existing = wrapped.get(Delete)
    if (existing) return existing

    const TrashDeleteAction: DocumentActionComponent = (props) => {
      const client = useClient({apiVersion: API_VERSION})
      const user = useCurrentUser()
      const toast = useToast()
      const router = useRouter()
      const documentStore = useDocumentStore()
      const saving = useRef(false)
      const description = Delete(props)

      // The confirm dialog runs the delete; anything else is passed through.
      const dialog = description?.dialog
      if (!dialog || dialog.type !== 'custom' || !isValidElement<ConfirmProps>(dialog.component)) {
        return description
      }
      const confirm = dialog.component.props.onConfirm
      if (typeof confirm !== 'function') return description

      const offerUndo = (copy: SavedCopy) => {
        const toastId = `trash-undo-${copy.savedId}`
        const undo = () =>
          undoDelete(client, copy).then(
            () => {
              toast.push({id: toastId, status: 'success', title: 'Delete undone'})
              router.navigateIntent('edit', {id: props.id, type: props.type})
            },
            (error) =>
              toast.push({
                id: toastId,
                status: 'error',
                title: 'Could not undo the delete',
                description: error?.message,
              }),
          )
        let done = false
        const subscription = documentStore.pair
          .operationEvents(props.id, props.type)
          .subscribe((event) => {
            if (done || event.op !== 'delete') return
            done = true
            if (event.type !== 'success') return
            toast.push({
              id: toastId,
              status: 'success',
              title: 'Moved to the Trash',
              description: <UndoButton onUndo={undo} />,
              duration: UNDO_MS,
              closable: true,
            })
          })
        setTimeout(() => subscription.unsubscribe(), 30_000)
      }

      const onConfirm = (...args: unknown[]) => {
        if (saving.current) return
        saving.current = true
        saveToTrash(client, {
          id: props.id,
          type: props.type,
          published: props.published,
          draft: props.draft,
          deletedBy: user?.id,
          retentionDays: options.retentionDays,
        })
          .then(
            (copy) => {
              if (copy) offerUndo(copy)
              confirm(...args)
            },
            (error) =>
              toast.push({
                status: 'error',
                title: 'Could not move the document to the Trash',
                description: `It was not deleted. ${error?.message ?? ''}`,
              }),
          )
          .finally(() => {
            saving.current = false
          })
      }

      return {
        ...description,
        dialog: {...dialog, component: cloneElement(dialog.component, {onConfirm})},
      }
    }
    TrashDeleteAction.action = Delete.action
    TrashDeleteAction.displayName = 'TrashDeleteAction'

    wrapped.set(Delete, TrashDeleteAction)
    return TrashDeleteAction
  }
}

function UndoButton(props: {onUndo: () => Promise<unknown>}) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      mode="ghost"
      text="Undo"
      fontSize={1}
      padding={2}
      loading={busy}
      disabled={busy}
      onClick={() => {
        setBusy(true)
        props.onUndo().finally(() => setBusy(false))
      }}
    />
  )
}
