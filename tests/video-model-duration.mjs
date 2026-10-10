import assert from 'node:assert/strict';
import { test } from 'node:test';
import { videoDurationRange, validateVideoDuration } from '../src/video-models.js';

test('Seedance 2.5 supports its documented 30 second boundary across model aliases', () => {
  for (const model of ['Seedance 2.5', 'seedance_2.5', 'seedance_2_5', 'doubao-seedance-2-5-260628']) {
    assert.deepEqual(videoDurationRange(model), { min: 4, max: 30 });
    assert.doesNotThrow(() => validateVideoDuration(model, 4));
    assert.doesNotThrow(() => validateVideoDuration(model, 30));
    for (const duration of [3, 31, 30.5, NaN]) assert.throws(() => validateVideoDuration(model, duration), /duration/);
  }
});

test('long duration does not leak to Fast, unknown models or names containing 2.5', () => {
  for (const model of ['Seedance 2.0 Fast', 'Seedance 2.0', undefined, 'unknown', 'Seedance 2.5 Fast', 'pretend seedance_2.5']) {
    assert.deepEqual(videoDurationRange(model), { min: 1, max: 15 });
    assert.doesNotThrow(() => validateVideoDuration(model, 15));
    assert.throws(() => validateVideoDuration(model, 16), /duration/);
    assert.throws(() => validateVideoDuration(model, 30), /duration/);
  }
});
