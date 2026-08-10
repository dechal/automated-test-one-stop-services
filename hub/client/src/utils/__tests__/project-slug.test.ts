import { describe, expect, it } from 'vitest';
import { finalizeProjectSlug, toProjectSlug } from '../project-slug.js';

describe('toProjectSlug', () => {
  it('lowercases and turns spaces into the separator', () => {
    expect(toProjectSlug('My Awesome Project')).toBe('my-awesome-project');
  });

  it('drops symbols outright, but promotes underscore to the separator', () => {
    expect(toProjectSlug('pay@ment_v2!#(flow)')).toBe('payment-v2flow');
  });

  it('drops non-Latin characters so the folder name stays ASCII', () => {
    expect(toProjectSlug('โปรเจกต์ shop')).toBe('shop');
  });

  it('collapses separator runs and never leads with one', () => {
    expect(toProjectSlug('  --a   __  b  ')).toBe('a-b-');
  });

  it('keeps a trailing separator so typing "my-" is not fought', () => {
    expect(toProjectSlug('my-')).toBe('my-');
  });

  it('is idempotent — re-sanitising a slug changes nothing', () => {
    const once = toProjectSlug('Order Service #3');
    expect(toProjectSlug(once)).toBe(once);
  });
});

describe('finalizeProjectSlug', () => {
  it('trims the dangling separator kept during typing', () => {
    expect(finalizeProjectSlug('my-project-')).toBe('my-project');
  });

  it('returns an empty string when nothing usable was typed', () => {
    expect(finalizeProjectSlug('!!! ***')).toBe('');
  });
});
