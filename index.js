'use strict';

const { TemplateEngine, escapeHtml } = require('./src/engine');
const { TemplateError } = require('./src/errors');

module.exports = { TemplateEngine, TemplateError, escapeHtml };
