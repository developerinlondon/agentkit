import { describe, expect, test } from 'bun:test';
import { houseRoot } from '../../skills/diagram/scripts/house-root.ts';

describe('the house root every register shares', () => {
  test('the class and the source marker are the register\'s to add, not the root\'s', () => {
    const bare = houseRoot('<svg viewBox="0 0 10 20"></svg>', { label: 'x' });
    expect(bare).toStartWith('<svg role="img" aria-label="x" width="10" height="20"');
    expect(bare).not.toContain('class=');
    const marked = houseRoot('<svg viewBox="0 0 10 20"></svg>', {
      label: 'x',
      className: 'reg',
      sourceMark: 'svg-source:reg',
    });
    expect(marked).toStartWith('<!-- svg-source:reg -->\n<svg class="reg" role="img"');
  });

  test('dropPriorStyle is what separates draw.io from the other two registers', () => {
    const input = '<svg style="color:red" viewBox="0 0 10 20"></svg>';
    expect(houseRoot(input, { label: 'x' })).toContain('style="color:red;max-width:100%;height:auto"');
    expect(houseRoot(input, { label: 'x', dropPriorStyle: true }))
      .toContain('style="max-width:100%;height:auto"');
  });

  test('a prior style ending in a semicolon does not double the separator', () => {
    const out = houseRoot('<svg style="color:red;" viewBox="0 0 10 20"></svg>', { label: 'x' });
    expect(out).toContain('style="color:red;max-width:100%;height:auto"');
    expect(out).not.toContain(';;');
  });

  test('a dollar sign in a label is data, not a replacement pattern', () => {
    // $& in a replacement string splices the matched <svg back into the
    // aria-label — the same break the label escaping exists to stop.
    const out = houseRoot('<svg viewBox="0 0 10 20"></svg>', { label: "costs $& and $' and $`" });
    expect(out).toContain('aria-label="costs $&amp; and $\' and $`"');
  });
});
