'use strict';

const { TemplateError } = require('./errors');
const { parse } = require('./parser');

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"'`]/g, (ch) => ESCAPE_MAP[ch]);
}

function isTruthy(value) {
  if (value == null || value === false) return false;
  if (value === 0 || value !== value) return false; // 0 and NaN
  if (value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function stringify(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Resolve a dotted path ("user.address.city", "this", "@index") against the
 * scope stack. Scopes are searched innermost-first; the first scope that
 * contains the first path segment wins. A leading "this." anchors resolution
 * at the innermost scope with no outer fallback.
 * Returns { found: boolean, value: any }.
 */
function resolvePath(path, scopes) {
  if (path === 'this' || path === '.') {
    return { found: true, value: scopes[scopes.length - 1].value };
  }
  let segments = path.split('.');
  if (segments[0] === 'this') {
    segments = segments.slice(1);
    let value = scopes[scopes.length - 1].value;
    for (const seg of segments) {
      if (value == null || typeof value !== 'object' || !(seg in value)) {
        return { found: false, value: undefined };
      }
      value = value[seg];
    }
    return { found: true, value };
  }
  const first = segments[0];

  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const scope = scopes[i];
    if (first.startsWith('@')) {
      if (!(first in scope.meta)) continue;
      // Loop metadata variables (@index, @first, @last) have no nested props.
      return segments.length === 1
        ? { found: true, value: scope.meta[first] }
        : { found: false, value: undefined };
    }
    const root = scope.value;
    if (root == null || typeof root !== 'object' || !(first in root)) continue;
    let value = root;
    let ok = true;
    for (const seg of segments) {
      if (value == null || typeof value !== 'object' || !(seg in value)) {
        ok = false;
        break;
      }
      value = value[seg];
    }
    if (ok) return { found: true, value };
  }
  return { found: false, value: undefined };
}

class TemplateEngine {
  /**
   * @param {object} options
   * @param {Object<string,string>} [options.partials] partial name -> template source (in-memory)
   * @param {(name: string) => string} [options.loadPartial] local loader (e.g. reads
   *        a file from disk). Used when `partials` has no entry for the name.
   * @param {'empty'|'keep'|'throw'} [options.onMissing='empty'] missing-variable policy
   * @param {number} [options.maxDepth=32] maximum partial nesting depth
   */
  constructor(options = {}) {
    this.partials = options.partials || {};
    this.loadPartial = options.loadPartial || null;
    this.onMissing = options.onMissing || 'empty';
    this.maxDepth = options.maxDepth != null ? options.maxDepth : 32;
    this._cache = new Map(); // partial name -> parsed AST
    if (!['empty', 'keep', 'throw'].includes(this.onMissing)) {
      throw new TemplateError(`invalid onMissing policy "${this.onMissing}"`);
    }
  }

  /** Compile template source into a reusable render function. */
  compile(source, templateName = '<anonymous>') {
    const ast = parse(source, templateName);
    return (context = {}) => this._renderNodes(ast, context, {
      scopes: [{ value: context, meta: {} }],
      includeStack: [templateName],
      templateName,
    });
  }

  /** Compile and render in one step. */
  render(source, context = {}, templateName = '<anonymous>') {
    return this.compile(source, templateName)(context);
  }

  _renderNodes(nodes, context, state) {
    let out = '';
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          out += node.value;
          break;
        case 'var': {
          const { found, value } = resolvePath(node.path, state.scopes);
          out += found ? escapeHtml(stringify(value)) : this._missing(node, state);
          break;
        }
        case 'raw': {
          const { found, value } = resolvePath(node.path, state.scopes);
          out += found ? stringify(value) : this._missing(node, state);
          break;
        }
        case 'if': {
          const { found, value } = resolvePath(node.path, state.scopes);
          const branch = found && isTruthy(value) ? node.consequent : node.alternate;
          out += this._renderNodes(branch, context, state);
          break;
        }
        case 'each': {
          const { found, value } = resolvePath(node.path, state.scopes);
          if (!found || value == null) break;
          if (!Array.isArray(value)) {
            throw new TemplateError(
              `"{{#each ${node.path}}}" requires an array, got ${typeof value}`,
              { templateName: state.templateName, line: node.line, column: node.column },
            );
          }
          value.forEach((item, index) => {
            state.scopes.push({
              value: item,
              meta: {
                '@index': index,
                '@first': index === 0,
                '@last': index === value.length - 1,
              },
            });
            out += this._renderNodes(node.body, context, state);
            state.scopes.pop();
          });
          break;
        }
        case 'partial':
          out += this._renderPartial(node, context, state);
          break;
        default:
          throw new TemplateError(`internal error: unknown node type "${node.type}"`, {
            templateName: state.templateName, line: node.line, column: node.column,
          });
      }
    }
    return out;
  }

  _missing(node, state) {
    switch (this.onMissing) {
      case 'keep':
        return node.type === 'raw' ? `{{{${node.path}}}}` : `{{${node.path}}}`;
      case 'throw':
        throw new TemplateError(`missing variable "${node.path}"`, {
          templateName: state.templateName, line: node.line, column: node.column,
        });
      default:
        return '';
    }
  }

  _renderPartial(node, context, state) {
    const name = node.name;
    const loc = { templateName: state.templateName, line: node.line, column: node.column };

    if (state.includeStack.includes(name)) {
      const chain = [...state.includeStack, name].join(' -> ');
      throw new TemplateError(`circular partial include detected: ${chain}`, loc);
    }
    if (state.includeStack.length > this.maxDepth) {
      throw new TemplateError(
        `partial nesting exceeds maximum depth of ${this.maxDepth}`,
        loc,
      );
    }

    let ast = this._cache.get(name);
    if (!ast) {
      let source;
      if (Object.prototype.hasOwnProperty.call(this.partials, name)) {
        source = this.partials[name];
      } else if (this.loadPartial) {
        source = this.loadPartial(name);
      }
      if (typeof source !== 'string') {
        throw new TemplateError(`partial "${name}" not found`, loc);
      }
      ast = parse(source, name);
      this._cache.set(name, ast);
    }

    state.includeStack.push(name);
    const previousName = state.templateName;
    state.templateName = name;
    try {
      return this._renderNodes(ast, context, state);
    } finally {
      state.includeStack.pop();
      state.templateName = previousName;
    }
  }
}

module.exports = { TemplateEngine, TemplateError, escapeHtml };
