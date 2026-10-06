'use strict';

const { TemplateError } = require('./errors');

/**
 * Tokenize template source. Token shapes:
 *  text    { value }              literal output
 *  var     { path }               {{ user.name }}   HTML-escaped output
 *  raw     { path }               {{{ html }}} / {{& html }}  unescaped output
 *  open    { kind, path }         {{#if cond}} / {{#each items}}
 *  close   { kind }               {{/if}} / {{/each}}
 *  else    {}                     {{else}}
 *  partial { name }               {{> header}}
 * Every token carries 1-based { line, column }. Whitespace control markers
 * {{~ and ~}} are applied during lexing, so whitespace handling is purely
 * lexical and identical input always produces identical tokens.
 */
function tokenize(source, templateName) {
  const tokens = [];
  let pos = 0;
  let line = 1;
  let column = 1;
  let trimNextTextLeft = false;

  const advance = (text) => {
    for (const ch of text) {
      if (ch === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
  };

  const pushText = (value, startLine, startColumn) => {
    let text = value;
    if (trimNextTextLeft) {
      text = text.replace(/^\s+/, '');
      trimNextTextLeft = false;
    }
    if (text === '') return;
    const last = tokens[tokens.length - 1];
    if (last && last.type === 'text') {
      last.value += text;
    } else {
      tokens.push({ type: 'text', value: text, line: startLine, column: startColumn });
    }
  };

  const trimPreviousText = () => {
    const last = tokens[tokens.length - 1];
    if (last && last.type === 'text') {
      last.value = last.value.replace(/\s+$/, '');
      if (last.value === '') tokens.pop();
    }
  };

  while (pos < source.length) {
    const openIdx = source.indexOf('{{', pos);
    if (openIdx === -1) {
      pushText(source.slice(pos), line, column);
      break;
    }

    pushText(source.slice(pos, openIdx), line, column);
    advance(source.slice(pos, openIdx));
    pos = openIdx;

    const tagLine = line;
    const tagColumn = column;
    const fail = (message) => {
      throw new TemplateError(message, { templateName, line: tagLine, column: tagColumn });
    };

    // Triple-mustache raw output: {{{ path }}}
    if (source.startsWith('{{{', pos)) {
      const end = source.indexOf('}}}', pos + 3);
      if (end === -1) fail('unclosed raw output tag "{{{"');
      const path = source.slice(pos + 3, end).trim();
      if (path === '') fail('empty raw output tag "{{{}}}"');
      advance(source.slice(pos, end + 3));
      pos = end + 3;
      tokens.push({ type: 'raw', path, line: tagLine, column: tagColumn });
      continue;
    }

    let i = pos + 2;
    let trimLeft = false;
    if (source[i] === '~') {
      trimLeft = true;
      i += 1;
    }

    let sigil = '';
    if ('#/>&!'.includes(source[i])) {
      sigil = source[i];
      i += 1;
    }

    const end = source.indexOf('}}', i);
    if (end === -1) fail('unclosed tag "{{"');
    let inner = source.slice(i, end);
    let trimRight = false;
    if (inner.endsWith('~')) {
      trimRight = true;
      inner = inner.slice(0, -1);
    }
    inner = inner.trim();

    advance(source.slice(pos, end + 2));
    pos = end + 2;

    if (trimLeft) trimPreviousText();
    if (trimRight) trimNextTextLeft = true;

    if (sigil === '!') {
      // Comment: dropped entirely, but whitespace control still applies.
    } else if (sigil === '#') {
      const m = inner.match(/^(if|each)\s+(.+)$/s);
      if (!m) {
        fail(`invalid block opener "{{#${inner}}}", expected "{{#if <path>}}" or "{{#each <path>}}"`);
      }
      tokens.push({ type: 'open', kind: m[1], path: m[2].trim(), line: tagLine, column: tagColumn });
    } else if (sigil === '/') {
      if (inner !== 'if' && inner !== 'each') {
        fail(`invalid block closer "{{/${inner}}}", expected "{{/if}}" or "{{/each}}"`);
      }
      tokens.push({ type: 'close', kind: inner, line: tagLine, column: tagColumn });
    } else if (sigil === '>') {
      if (inner === '') fail('partial tag "{{> }}" requires a partial name');
      tokens.push({ type: 'partial', name: inner, line: tagLine, column: tagColumn });
    } else if (sigil === '&') {
      if (inner === '') fail('empty raw output tag "{{& }}"');
      tokens.push({ type: 'raw', path: inner, line: tagLine, column: tagColumn });
    } else if (inner === 'else') {
      tokens.push({ type: 'else', line: tagLine, column: tagColumn });
    } else if (inner === '') {
      fail('empty tag "{{}}"');
    } else {
      tokens.push({ type: 'var', path: inner, line: tagLine, column: tagColumn });
    }
  }

  return tokens;
}

module.exports = { tokenize };
