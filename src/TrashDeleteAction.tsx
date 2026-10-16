import {cloneElement, isValidElement, useRef} from 'react'
import {useToast} from '@sanity/ui'
import {useClient, useCurrentUser, type DocumentActionComponent} from 'sanity'
import {saveToTrash} from './lib/saved'

const API_VERSION = '2025-02-19'

type ConfirmProps = {onConfirm?: (...args: unknown[]) => void}

const wrapped = new WeakMap<DocumentActionComponent, DocumentActionComponent>()

/**
 * The Studio's Delete action, saving a copy of the document to the Trash once
 * the delete is confirmed and before it runs. When the copy can't be saved,
 * the document is left as it is.
 */
export function withTrash(Delete: DocumentActionComponent): DocumentActionComponent {
  const existing = wrapped.get(Delete)
  if (existing) return existing

  const TrashDeleteAction: DocumentActionComponent = (props) => {
    const client = useClient({apiVersion: API_VERSION})
    const user = useCurrentUser()
    const toast = useToast()
    const saving = useRef(false)
    const description = Delete(props)

    // The confirm dialog runs the delete; anything else is passed through.
    const dialog = description?.dialog
    if (!dialog || dialog.type !== 'custom' || !isValidElement<ConfirmProps>(dialog.component)) {
      return description
    }
    const confirm = dialog.component.props.onConfirm
    if (typeof confirm !== 'function') return description

    const onConfirm = (...args: unknown[]) => {
      if (saving.current) return
      saving.current = true
      saveToTrash(client, {
        id: props.id,
        type: props.type,
        published: props.published,
        draft: props.draft,
        deletedBy: user?.id,
      })
        .then(
          () => confirm(...args),
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
