import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../lib/parser.js';

const ALLOWED_TAGS = new Set(['p', 'br', 'b', 'strong', 'em', 'mark', 'code', 'pre', 'blockquote', 'hr', 'ul', 'ol', 'li', 'a']);
const SAFE_HREF = /^(https?:\/\/|mailto:|\/@[a-z0-9_]{3,20}$|\/thread\/[0-9a-f]{24}$)/i;

function assertInert(html, input) {
  const where = `for input ${JSON.stringify(input)}\ngot ${html}`;
  assert.doesNotMatch(html, /<script/i, where);
  for (const [tag, name, attrs] of html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/gi)) {
    assert.ok(ALLOWED_TAGS.has(name.toLowerCase()), `unexpected <${name}> ${where}`);
    assert.doesNotMatch(attrs, /\son[a-z]+\s*=/i, `event handler in ${tag} ${where}`);
    assert.doesNotMatch(attrs, /\sstyle\s*=/i, `style in ${tag} ${where}`);
    const href = attrs.match(/\shref="([^"]*)"/);
    if (href) assert.match(href[1].replaceAll('&amp;', '&'), SAFE_HREF, `href in ${tag} ${where}`);
    for (const [, attr] of attrs.matchAll(/\s([a-z-]+)=/gi)) {
      assert.ok(['href', 'class', 'rel', 'target'].includes(attr), `attribute ${attr} ${where}`);
    }
  }
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), /[<>]/, `raw angle bracket in text ${where}`);
}

test('each dialect rule renders', () => {
  const id = 'a1b2c3d4e5f6a1b2c3d4e5f6';
  const cases = [
    ['*bold*', '<p><b>bold</b></p>'],
    ['**strong**', '<p><strong>strong</strong></p>'],
    ['~italic~', '<p><em>italic</em></p>'],
    ['::highlight::', '<p><mark>highlight</mark></p>'],
    ['> quoted\n> twice', '<blockquote>quoted<br>twice</blockquote>'],
    ['above\n---\nbelow', '<p>above</p>\n<hr>\n<p>below</p>'],
    ['[[alice]]', '<p><a href="/@alice" class="spore-link">@alice</a></p>'],
    [`[[#${id}]]`, `<p><a href="/thread/${id}" class="matter-link">#${id}</a></p>`],
    ['[site](https://spore.bond/about)', '<p><a href="https://spore.bond/about" rel="noopener noreferrer nofollow ugc" target="_blank">site</a></p>'],
    ['[mail](mailto:matter@spore.bond)', '<p><a href="mailto:matter@spore.bond" rel="noopener noreferrer nofollow ugc" target="_blank">mail</a></p>'],
    ['`code`', '<p><code>code</code></p>'],
    ['```js\nconst a = 1 < 2;\n```', '<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>'],
    ['- one\n- two', '<ul><li>one</li><li>two</li></ul>'],
    ['1. one\n2. two', '<ol><li>one</li><li>two</li></ol>'],
    ['line one\nline two\n\nnew paragraph', '<p>line one<br>line two</p>\n<p>new paragraph</p>'],
    ['**~both~**', '<p><strong><em>both</em></strong></p>'],
    ['2 * 3 * 4 and a lone ~ stay text', '<p>2 * 3 * 4 and a lone ~ stay text</p>'],
    ['', ''],
  ];
  for (const [input, expected] of cases) assert.equal(render(input), expected, input);
});

test('internal links only link what passes the rules', () => {
  for (const input of ['[[Alice]]', '[[al]]', '[[alice:label]]', '[[#123]]', '[[#A1B2C3D4E5F6A1B2C3D4E5F6]]', '[["><img src=x>]]']) {
    const html = render(input);
    assert.doesNotMatch(html, /<a /, input);
    assertInert(html, input);
  }
});

test('code spans and fenced blocks are opaque to the dialect', () => {
  assert.equal(render('`*not bold* [[alice]]`'), '<p><code>*not bold* [[alice]]</code></p>');
  assert.equal(render('```\n**no** [x](https://a.io)\n```'), '<pre><code>**no** [x](https://a.io)</code></pre>');
});

const ATTACKS = {
  'raw tags': [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '</p><script>alert(1)</script><p>',
    '<style>body{display:none}</style>',
  ],
  'event handler attributes': [
    '<div onmouseover="alert(1)">hover</div>',
    '<body onload=alert(1)>',
    '"><img src=x onerror=alert(1)>',
    "'><svg/onload=alert(1)>",
  ],
  'javascript and data urls': [
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](javascript://%0aalert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[x](vbscript:msgbox(1))',
    '[x](//evil.example)',
    '[x](/relative/path)',
  ],
  'entity-encoded schemes': [
    '[x](&#106;avascript:alert(1))',
    '[x](&#x6A;avascript:alert(1))',
    '[x](javascript&colon;alert(1))',
    '[x](jav&#x09;ascript:alert(1))',
  ],
  'markers wrapped around html': [
    '*<script>alert(1)</script>*',
    '**<img src=x onerror=alert(1)>**',
    '~<svg onload=alert(1)>~',
    '::<iframe src=x>::',
    '> <script>alert(1)</script>',
    '- <img src=x onerror=alert(1)>',
  ],
  'unclosed markers': [
    '*<img src=x onerror=alert(1)>',
    '**bold <script>alert(1)</script>',
    '[[<img src=x onerror=alert(1)>',
    '[x](https://a.io/<script>',
    '```\n<script>alert(1)</script>',
    '`<img src=x onerror=alert(1)>',
  ],
  'markers nested inside link text and urls': [
    '[*x*](https://a.io/*"onmouseover="alert(1)*)',
    '[x](https://a.io/"onclick="alert(1))',
    '[**<img src=x onerror=alert(1)>**](https://a.io)',
    '[x](https://a.io/::"><script>alert(1)</script>::)',
    '*[x](https://a.io/*)*',
    '[[alice]]*"onmouseover=alert(1)*',
    '[x](https://a.io?q="><img src=x onerror=alert(1)>)',
  ],
  'code spans holding html': [
    '`<script>alert(1)</script>`',
    '```html\n<img src=x onerror=alert(1)>\n```',
    '```"><img src=x onerror=alert(1)>\n<b>x</b>\n```',
    '`</code><script>alert(1)</script>`',
  ],
};

for (const [category, inputs] of Object.entries(ATTACKS)) {
  test(`xss: ${category} render inert`, () => {
    for (const input of inputs) assertInert(render(input), input);
  });
}

test('a hostile fence language never reaches the class attribute', () => {
  assert.equal(render('```"><img src=x onerror=alert(1)>\nx\n```'), '<pre><code>x</code></pre>');
});

test('a javascript link stays visible as text instead of vanishing', () => {
  assert.equal(render('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
});

test('random mixes of markers and attack fragments always render inert', () => {
  const pieces = [
    '*', '**', '~', '::', '`', '```', '[', ']', '(', ')', '[[', ']]', '#', '>', '- ', '1. ', '---', '\n', ' ', '"', "'",
    '<', '>', '=', '/', 'onerror=alert(1)', '<img src=x ', '<script>', '</script>', 'javascript:', 'https://a.io/',
    'mailto:', '&#106;', '&lt;', 'alice', 'a1b2c3d4e5f6a1b2c3d4e5f6', 'text', 'x',
  ];
  let seed = 12345;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let run = 0; run < 5000; run++) {
    let input = '';
    const length = 1 + Math.floor(random() * 24);
    for (let k = 0; k < length; k++) input += pieces[Math.floor(random() * pieces.length)];
    assertInert(render(input), input);
  }
});
