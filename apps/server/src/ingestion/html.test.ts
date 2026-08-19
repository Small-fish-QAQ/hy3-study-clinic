import { describe, expect, it } from 'vitest';
import { parseHtmlBytes } from './html.js';

const fixture = `<!doctype html><html><head><title>Signals | Course</title><style>.x{}</style><script>throw new Error('never');</script></head><body><nav>Home | Pricing | Login</nav><main><article><h1>Signals</h1><p>Signals carry information.</p><h2>Core forms</h2><ul><li>Analog</li><li>Digital</li></ul><blockquote>Meaning depends on context.</blockquote><pre><code class="language-ts">const signal = true;\nconsole.log(signal);</code></pre><table><caption>Types</caption><tr><th>Kind</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table><p><a href="/next">Next lesson</a></p><figure><img src="https://cdn.example/image.png" alt="waveform"/><figcaption>Waveform</figcaption></figure></article></main><footer>Cookie policy and unrelated links</footer></body></html>`;

describe('HTML normalization', () => {
  it('extracts learning structure without executing scripts or fetching resources', () => {
    const parsed = parseHtmlBytes(Buffer.from(fixture), {
      revisionId: 'rev_html',
      baseUrl: 'https://example.test/course',
    });
    expect(parsed.content).toContain('Signals carry information.');
    expect(parsed.content).toContain('- Analog');
    expect(parsed.content).toContain('const signal = true;');
    expect(parsed.content).toContain('Kind | Value');
    expect(parsed.content).toContain('[Next lesson](https://example.test/next)');
    expect(parsed.content).toContain('waveform');
    expect(parsed.content).not.toContain('throw new Error');
    expect(parsed.normalizedDocument.units.some((unit) => unit.kind === 'heading')).toBe(true);
    expect(parsed.normalizedDocument.units.some((unit) => unit.location.domPath)).toBe(true);
  });

  it('handles malformed HTML deterministically and rejects empty extraction', () => {
    const parsed = parseHtmlBytes(Buffer.from('<html><body><h1>Broken<h2>Nested<p>Useful text'), {
      revisionId: 'rev_malformed',
    });
    expect(parsed.content).toContain('Useful text');
    expect(() =>
      parseHtmlBytes(
        Buffer.from('<html><head><script>only()</script></head><body></body></html>'),
        { revisionId: 'rev_empty' },
      ),
    ).toThrow(/没有可用的正文/u);
  });
});
