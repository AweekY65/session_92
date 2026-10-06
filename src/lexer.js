'use strict';

const { TemplateError } = require('./errors');

/**
 * Token types:
 *  text    { value }
 *  var     { path }            {{ user.name }}   (HTML-escaped output)
 *  raw     { path }            {{{ html }}} or {{& html }}  (unescaped output)
 *  open    { kind, path }      {{#if cond}} / {{#each items}}
 *  close   { kind }            {{/if}} / {{/each}}
 *  else    {}                  {{else}}
 *  partial { name }            {{> header}}
 * Every token carries { line, column } (1-based) and trimLeft/trimRight flags
 * set by the whitespace-control markers {{~ and ~}}.
 */
function tokenize(source, templateName) {
  const tokens = [];
  let pos = 0;
  let line = 1;
  let column = 1;
  let pendingTrimRight = false;

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
    if (value === '') return;
    let v = value;
    if (pendingTrimRight) {
      v = v.replace(/^\s+/, '');
      pendingTrimRight = false;
    }
    if (v === '') return;
    const last = tokens[tokens.length - 1];
    if (last && last.type === 'text') {
      last.value += v;
    } else {
      tokens.push({ type: 'text', value: v, line: startLine, column: startColumn });
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

    // Triple-mustache raw output: {{{ path }}}
    if (source.startsWith('{{{', pos)) {
      const end = source.indexOf('}}}', pos + 3);
      if (end === -1) {
        throw new TemplateError('unclosed raw output tag "{{{"', {
          templateName, line: tagLine, column: tagColumn,
        });
      }
      const inner = source.slice(pos + 3, end).trim();
      advance(source.slice(pos, end + 3));
      pos = end + 3;
      tokens.push({ type: 'raw', path: inner, line: tagLine, column: tagColumn });
      continue;
    }

    let i = pos + 2;
    let trimLeft = false;
    if (source[i] === '~') {
      trimLeft = true;
      i += 1;
    }

    let sigil = '';
    if (source[i] === '#' || source[i] === '/' || source[i] === '>' ||
        source[i] === '&' || source[i] === '!') {
      sigil = source[i];
      i += 1;
    }

    // Find the closing "}}" (optionally preceded by "~").
    const end = source.indexOf('}}', i);
    if (end === -1) {
      throw new TemplateError('unclosed tag "{{"', {
        templateName, line: tagLine, column: tagColumn,
      });
    }
    let inner = source.slice(i, end);
    let trimRight = false;
    if (inner.endsWith('~')) {
      trimRight = true;
      inner = inner.slice(0, -1);
    }
    inner = inner.trim();

    advance(source.slice(pos, end + 2));
    pos = end + 2;

    if (sigil === '!') continue; // comment: dropped entirely

    const base = {
      line: tagLine, column: tagColumn,
      trimLeft, trimRight,
    };

    switch (sigil) {
      case '#': {
        const m = inner.match(/^(if|each)\s+(.+)$/s);
        if (!m) {
          throw new TemplateError(
            `invalid block opener "{{#${inner}}}", expected "{{#if <path>}}" or "{{#each <path>}}"`,
            { templateName, line: tagLine, column: tagColumn },
          );
        }
        tokens.push({ ...base, type: 'open', kind: m[1], path: m[2].trim() });
        break;
      }
      case '/': {
        if (inner !== 'if' && inner !== 'each') {
          throw new TemplateError(`invalid block closer "{{/${inner}}}"`, {
            templateName, line: tagLine, column: tagColumn,
          });
        }
        tokens.push({ ...base, type: 'close', kind: inner });
        break;
      }
      case '>': {
        if (!inner) {
          throw new TemplateError('partial tag "{{> }}" requires a partial name', {
            templateName, line: tagLine, column: tagColumn,
          });
        }
        tokens.push({ ...base, type: 'partial', name: inner });
        break;
      }
      case '&':
        tokens.push({ ...base, type: 'raw', path: inner });
        break;
      default: {
        if (inner === 'else') {
          tokens.push({ ...base, type: 'else' });
        } else if (inner === '') {
          throw new TemplateError('empty tag "{{}}"', {
            templateName, line: tagLine, column: tagColumn,
          });
        } else {
          tokens.push({ ...base, type: 'var', path: inner });
        }
      }
    }

    if (trimLeft) {
      // Strip trailing whitespace from the text token immediately before this tag.
      const prev = tokens[tokens.length - 2]; // token just pushed is last
      if (prev && prev.type === 'text') {
        prev.value = prev.value.replace(/\s+$/, '');
        if (prev.value === '') tokens.splice(tokens.length - 2, 1);
      }
    }
    if (trimRight) pendingTrimRight = true;
  }

  return tokens;
}

module.exports = { tokenize };
