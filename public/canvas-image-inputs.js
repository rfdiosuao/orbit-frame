// Replace only the image owned by this video's slot, never a shared source.
export function reusableFrameImage(cards, edges, targetId, role) {
  if (!targetId || !['first_frame', 'last_frame'].includes(role)) return null;
  const sourceId = edges.find(e => e.to === targetId && e.role === role)?.from;
  const source = cards.find(c => c.id === sourceId);
  if (source?.frame_owner === targetId && edges.filter(e => e.from === source.id).length === 1) return source;
  return cards.find(c => c.type === 'image' && c.frame_owner === targetId && !edges.some(e => e.from === c.id)) || null;
}
