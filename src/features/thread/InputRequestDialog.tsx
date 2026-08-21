import { useState } from 'react'

import { AppDialog } from '../../components/ui/app-dialog'
import { Button } from '../../components/ui/button'

export type InputRequestQuestion = { id: string; question?: string; header?: string }

/// Answers a provider's input request with one form instead of a chain of
/// blocking `prompt()` popups (which also cannot show multi-line context).
export function InputRequestDialog({
  provider,
  questions,
  onSubmit,
  onClose,
}: {
  provider: string
  questions: InputRequestQuestion[]
  onSubmit: (answers: Record<string, { answers: string[] }>) => void
  onClose: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const submit = () => {
    const answers: Record<string, { answers: string[] }> = {}
    for (const question of questions) answers[question.id] = { answers: [values[question.id] || ''] }
    onSubmit(answers)
    onClose()
  }
  return (
    <AppDialog title={`${provider} needs input`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {questions.map((question) => (
          <label key={question.id} className="flex flex-col gap-1.5 text-[13px] text-fg-soft">
            {question.question || question.header || 'Answer'}
            <textarea
              className="min-h-16 rounded-md border border-line bg-ink-850 px-2.5 py-2 text-[13px] text-fg outline-none focus-visible:border-line-strong"
              value={values[question.id] || ''}
              onChange={(event) =>
                setValues((current) => ({ ...current, [question.id]: event.target.value }))
              }
              // Only one question on screen; focusing it saves a click.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus={questions[0]?.id === question.id}
            />
          </label>
        ))}
      </div>
      <footer className="mt-[18px] flex justify-end gap-2.5">
        <Button variant="ghost" size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="lg" onClick={submit}>
          Submit
        </Button>
      </footer>
    </AppDialog>
  )
}
