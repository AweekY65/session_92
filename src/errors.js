'use strict';

/**
 * Error thrown for template parse/render problems.
 * Always carries the template name plus 1-based line and column when known,
 * so failures are never reported as a bare "parse failed".
 */
class TemplateError extends Error {
  constructor(message, { templateName = '<anonymous>', line = null, column = null } = {}) {
    const loc = line != null ? `line ${line}, column ${column}` : 'unknown location';
    super(`[${templateName}] ${loc}: ${message}`);
    this.name = 'TemplateError';
    this.templateName = templateName;
    this.line = line;
    this.column = column;
  }
}

module.exports = { TemplateError };
