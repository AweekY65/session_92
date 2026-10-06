'use strict';

const { TemplateError } = require('./errors');
const { tokenize } = require('./lexer');

/**
 * Parse template source into an AST (array of nodes). Node shapes:
 *  { type: 'text', value }
 *  { type: 'var',  path, line, column }
 *  { type: 'raw',  path, line, column }
 *  { type: 'if',   path, line, column, consequent: [...], alternate: [...] }
 *  { type: 'each', path, line, column, body: [...] }
 *  { type: 'partial', name, line, column }
 * Nested control structures must close with their matching tag; any mismatch
 * throws a TemplateError carrying template name, line and column.
 */
function parse(source, templateName = '<anonymous>') {
  if (typeof source !== 'string') {
    throw new TemplateError('template source must be a string', { templateName });
  }
  const tokens = tokenize(source, templateName);
  const root = [];
  // Stack frames: { kind, node, target, line, column }; `target` is the array
  // that newly parsed nodes are appended to.
  const stack = [{ kind: 'root', target: root, line: null, column: null }];
  const top = () => stack[stack.length - 1];

  for (const tok of tokens) {
    const loc = { templateName, line: tok.line, column: tok.column };
    switch (tok.type) {
      case 'text':
        top().target.push({ type: 'text', value: tok.value });
        break;
      case 'var':
      case 'raw':
        top().target.push({ type: tok.type, path: tok.path, line: tok.line, column: tok.column });
        break;
      case 'partial':
        top().target.push({ type: 'partial', name: tok.name, line: tok.line, column: tok.column });
        break;
      case 'open': {
        const node = tok.kind === 'if'
          ? { type: 'if', path: tok.path, line: tok.line, column: tok.column, consequent: [], alternate: [] }
          : { type: 'each', path: tok.path, line: tok.line, column: tok.column, body: [] };
        top().target.push(node);
        stack.push({
          kind: tok.kind,
          node,
          target: tok.kind === 'if' ? node.consequent : node.body,
          line: tok.line,
          column: tok.column,
        });
        break;
      }
      case 'else': {
        const frame = top();
        if (frame.kind !== 'if') {
          throw new TemplateError('"{{else}}" without a matching "{{#if}}"', loc);
        }
        if (frame.target === frame.node.alternate) {
          throw new TemplateError('duplicate "{{else}}" in the same "{{#if}}" block', loc);
        }
        frame.target = frame.node.alternate;
        break;
      }
      case 'close': {
        const frame = top();
        if (frame.kind === 'root') {
          throw new TemplateError(`unexpected "{{/${tok.kind}}}" with no open block`, loc);
        }
        if (frame.kind !== tok.kind) {
          throw new TemplateError(
            `mismatched close tag: expected "{{/${frame.kind}}}" (opened at line ${frame.line}, column ${frame.column}) but found "{{/${tok.kind}}}"`,
            loc,
          );
        }
        stack.pop();
        break;
      }
      default:
        throw new TemplateError(`internal error: unknown token type "${tok.type}"`, loc);
    }
  }

  const leftover = top();
  if (leftover.kind !== 'root') {
    throw new TemplateError(
      `unclosed "{{#${leftover.kind}}}" block (opened at line ${leftover.line}, column ${leftover.column}); missing "{{/${leftover.kind}}}"`,
      { templateName, line: leftover.line, column: leftover.column },
    );
  }

  return root;
}

module.exports = { parse };
