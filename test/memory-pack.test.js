'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseMemoryPack, searchNotes, SAMPLE_MEMORY_PACK } = require('../src/main/memory-pack');

describe('sample memory pack', () => {
  it('imports the fixture and searches locally without a window', () => {
    const pack = parseMemoryPack(JSON.stringify(SAMPLE_MEMORY_PACK));
    assert.equal(pack.notes.length, 3);
    const hits = searchNotes(pack, 'Tokyo');
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /ANA/);
    const all = searchNotes(pack, '');
    assert.equal(all.length, 3);
  });

  it('rejects an empty or invalid pack', () => {
    assert.throws(() => parseMemoryPack('{"kind":"nope","notes":[]}'));
    assert.throws(() => parseMemoryPack('{"kind":"memory-pack","notes":[]}'));
  });
});
