import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('project page', () => {
  it('UC-8/S1 links OpenStuff to its own front page in the family row', () => {
    const page = readFileSync(new URL('../../../site/index.html', import.meta.url), 'utf8');
    const row = page.slice(page.search(/class="(os-)?family-row"/));
    expect(row.match(/<a[^>]*href="([^"]+)"/)?.[1]).toBe('https://openstuff.dev');
  });
});
