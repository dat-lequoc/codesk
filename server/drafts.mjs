export async function startDraft(store, gateway, id, body) {
  const draft = store.state.drafts.find((item) => item.id === id)
  if (!draft) throw Object.assign(new Error('Draft not found'), { statusCode: 404 })
  const input = { ...body, hostId: draft.hostId, project_id: draft.projectId, provider: body.provider || draft.provider, workspace_mode: body.workspace_mode || draft.workspaceMode }
  const run = await gateway.request(draft.hostId, '/v1/runs', { method: 'POST', body: JSON.stringify(input), timeout: 30000 })
  store.deleteDraft(draft.id)
  return { draft, run }
}
