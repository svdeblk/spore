// matter dialect: *bold* **strong** ~italic~ ::highlight:: > quotes
// --- dividers, [[links]], [text](url), `code`, fenced blocks, - and 1. lists
// all usr char text escaped before any markup is added; only tags in the
// output are the ones written by parser comp

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (text) => text.replace(/[&<>"']/g, (char) => ESCAPES[char]);

const HANDLE = /^[a-z0-9_]{3,20}$/;
const POST_ID = /^[0-9a-f]{24}$/;
const LANGUAGE = /^[a-z0-9_+-]{1,20}$/i;

// scheme checked on raw txt before escaping; entity-encoded scheme never matches
function safeUrl(raw) {
  if (!/^(https?:\/\/|mailto:)/i.test(raw)) return null;
  try {
    const url = new URL(raw);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? raw : null;
  } catch {
    return null;
  }
}

const EMPHASIS = [
  [/\*\*(\S(?:.*?\S)?)\*\*/g, 'strong'],
  [/\*(\S(?:.*?\S)?)\*/g, 'b'],
  [/~(\S(?:.*?\S)?)~/g, 'em'],
  [/::(\S(?:.*?\S)?)::/g, 'mark'],
];

// runs already escaped txt; holds no markup for a marker to land inside
function emphasize(escaped) {
  return EMPHASIS.reduce((html, [pattern, tag]) => html.replace(pattern, `<${tag}>$1</${tag}>`), escaped);
}

// code spans & links become finished markup; no marker can reach into them
const TOKEN = /`([^`]+)`|\[\[([^\]\n]*)\]\]|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function inline(text) {
  let html = '';
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const [whole, code, internal, label, url] = match;
    html += emphasize(escape(text.slice(last, match.index)));
    last = match.index + whole.length;

    if (code !== undefined) {
      html += `<code>${escape(code)}</code>`;
    } else if (internal !== undefined) {
      if (HANDLE.test(internal)) {
        html += `<a href="/@${internal}" class="spore-link">@${internal}</a>`;
      } else if (internal.startsWith('#') && POST_ID.test(internal.slice(1))) {
        html += `<a href="/thread/${internal.slice(1)}" class="matter-link">${internal}</a>`;
      } else {
        html += emphasize(escape(whole));
      }
    } else {
      const href = safeUrl(url);
      html += href
        ? `<a href="${escape(href)}" rel="noopener noreferrer nofollow ugc" target="_blank">${escape(label)}</a>`
        : emphasize(escape(whole));
    }
  }
  return html + emphasize(escape(text.slice(last)));
}

const listItem = (line) => /^\s*(?:- |\d+\. )/.test(line);
const ordered = (line) => /^\s*\d+\. /.test(line);

export function render(content) {
  if (typeof content !== 'string' || content === '') return '';
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim();
      const body = [];
      i++;
      // unclosed fence runs to end: its text stays escaped 
      while (i < lines.length && lines[i].trim() !== '```') body.push(lines[i++]);
      i++;
      const attr = LANGUAGE.test(language) ? ` class="language-${language.toLowerCase()}"` : '';
      blocks.push(`<pre><code${attr}>${escape(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (trimmed === '') {
      i++;
      continue;
    }

    if (trimmed === '---') {
      blocks.push('<hr>');
      i++;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoted = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) quoted.push(inline(lines[i++].trim().slice(1).trim()));
      blocks.push(`<blockquote>${quoted.join('<br>')}</blockquote>`);
      continue;
    }

    if (listItem(line)) {
      const tag = ordered(line) ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length && listItem(lines[i]) && ordered(lines[i]) === (tag === 'ol')) {
        items.push(`<li>${inline(lines[i++].trim().replace(/^(?:- |\d+\. )/, ''))}</li>`);
      }
      blocks.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    const paragraph = [];
    while (i < lines.length) {
      const next = lines[i].trim();
      if (next === '' || next === '---' || next.startsWith('```') || next.startsWith('>') || listItem(lines[i])) break;
      paragraph.push(inline(next));
      i++;
    }
    blocks.push(`<p>${paragraph.join('<br>')}</p>`);
  }

  return blocks.join('\n');
}

// start of a long post as plain text for a feed card: markers & tags gone, whitespace collapsed,
// cut at a word; the page shows it as text, never html
const UNESCAPES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

export function excerpt(content, length = 280) {
  const text = render(content.slice(0, length * 4))
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => UNESCAPES[entity])
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...text];
  if (chars.length <= length) return text;
  const cut = chars.slice(0, length).join('');
  return `${cut.replace(/\s+\S*$/, '') || cut}...`;
}