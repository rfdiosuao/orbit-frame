// A submitted/retryable request uses its saved prompt, never a later note edit.
export function videoPrompt(card, cards, edges) {
  if (card.task_id || card.request_key) return card.prompt || '';
  const edge = edges.find(edge => edge.to === card.id && edge.role === 'prompt');
  if (!edge) return card.prompt || '';
  return cards.find(source => source.id === edge.from && source.type === 'note')?.text || '';
}

export function acceptsVideoInput(source, target, role) {
  if (!source || target?.type !== 'video' || source.id === target.id) return false;
  return role === 'prompt' ? source.type === 'note'
    : ['first_frame', 'last_frame'].includes(role) && source.type === 'image' && !!source.asset;
}
