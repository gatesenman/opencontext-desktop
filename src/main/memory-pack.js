'use strict';

function parseMemoryPack(text) {
  const raw = JSON.parse(text);
  if (!raw || raw.kind !== 'memory-pack') throw new Error('Invalid memory pack');
  const notes = Array.isArray(raw.notes) ? raw.notes : [];
  const cleaned = notes
    .map((note) => ({
      id: String(note.id || ''),
      text: String(note.text || '').trim(),
      tag: note.tag ? String(note.tag) : '',
    }))
    .filter((note) => note.id && note.text);
  if (cleaned.length === 0) throw new Error('Invalid memory pack: no notes');
  return { kind: 'memory-pack', version: raw.version || 1, notes: cleaned };
}

function searchNotes(pack, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return pack.notes.slice();
  return pack.notes.filter((note) => {
    return note.text.toLowerCase().includes(q) || note.tag.toLowerCase().includes(q);
  });
}

const SAMPLE_MEMORY_PACK = {
  kind: 'memory-pack',
  version: 1,
  notes: [
    { id: 'n1', text: 'The weekly design review is on Thursday.', tag: 'calendar' },
    { id: 'n2', text: 'OpenContext stores memories locally first.', tag: 'product' },
    { id: 'n3', text: 'Preferred airline for the Tokyo trip is ANA.', tag: 'travel' },
  ],
};

module.exports = { parseMemoryPack, searchNotes, SAMPLE_MEMORY_PACK };
