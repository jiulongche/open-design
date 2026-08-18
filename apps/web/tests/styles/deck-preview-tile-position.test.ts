import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The deck override for the home rail's example-prompt tiles renders the
// preview iframe at a fixed 1280x720 logical viewport and scales it down to the
// tile. Where the scaled box lands is load-bearing and easy to lose to a
// plausible-looking edit, so the rule's anchoring is pinned here.
//
// Measured on a 206x150 tile before this was fixed: the iframe kept its correct
// visual size (206x115.9 = 1280x720 x 0.1609) but sat at (-1158, -45), entirely
// outside the tile — which the frame's `overflow: hidden` renders as an empty
// card.
//
// The behavioural counterpart is `[P1] home hero deck preview keeps its scaled
// slide inside the tile` (e2e/ui/home-hero-rail.test.ts), which measures the
// rendered geometry rather than the stylesheet. It is kept in addition to, not
// instead of, this spec: `uiP0Groups['entry-settings']` greps `\[P0\]`, so a
// P1 UI spec does not run on PR CI, while this file runs in the Web workspace
// lane on every PR that touches the stylesheet it guards.

const homeHeroCss = readFileSync(new URL('../../src/styles/home/home-hero.css', import.meta.url), 'utf8');

const DECK_IFRAME_SELECTOR = '.home-hero__plugin-preset[data-od-mode="deck"] .plugins-home__html-iframe';

function cssDeclarations(css: string, selector: string): string {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(cssWithoutComments)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

describe('deck preview tile position', () => {
  it('anchors with `inset` alone, never alongside `top`/`left` longhands', () => {
    // `inset` is the shorthand for all four longhands, so the two forms cannot
    // safely coexist: the rule shipped as `top: 50%; left: 50%; inset: auto`,
    // where the trailing shorthand reset both back to `auto` and dropped the
    // absolutely-positioned iframe to its static position. Ordering them the
    // other way also works, but only until the next edit reorders them —
    // stating the anchor once removes the hazard rather than documenting it.
    const block = cssDeclarations(homeHeroCss, DECK_IFRAME_SELECTOR);

    expect(block, 'the deck override should anchor via the `inset` shorthand').toMatch(
      /(?:^|[;\n])\s*inset\s*:/,
    );
    expect(block, '`top` longhand alongside `inset` is the shipped regression').not.toMatch(
      /(?:^|[;\n])\s*top\s*:/,
    );
    expect(block, '`left` longhand alongside `inset` is the shipped regression').not.toMatch(
      /(?:^|[;\n])\s*left\s*:/,
    );
  });

  it('restates `transform-origin` instead of inheriting the base rule corner origin', () => {
    // `.plugins-home__html-iframe` (plugins-home.css) sets `transform-origin: 0 0`
    // for its own top-left scaling. The deck override centres with
    // `translate(-50%, -50%)`, which is only correct about the element's centre;
    // with the corner origin it shifts by half the *unscaled* 1280x720.
    const block = cssDeclarations(homeHeroCss, DECK_IFRAME_SELECTOR);

    expect(block).toMatch(/transform-origin\s*:\s*(?:50%\s+50%|center)/);
    expect(block, 'the centering transform is what depends on the origin').toMatch(
      /transform\s*:\s*translate\(-50%,\s*-50%\)/,
    );
  });
});
