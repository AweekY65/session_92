'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TemplateEngine, TemplateError } = require('../index');

const engine = (opts) => new TemplateEngine(opts);

// ---------- variable interpolation ----------

test('interpolates simple variables', () => {
  assert.equal(engine().render('Hello, {{name}}!', { name: 'Ada' }), 'Hello, Ada!');
});

test('resolves nested object properties', () => {
  const tpl = '{{user.name}} lives in {{user.address.city}}, zip {{user.address.zip}}.';
  const out = engine().render(tpl, {
    user: { name: 'Ada', address: { city: 'Paris', zip: '75001' } },
  });
  assert.equal(out, 'Ada lives in Paris, zip 75001.');
});

test('renders numbers, booleans and null deterministically', () => {
  assert.equal(engine().render('{{n}}|{{b}}|{{nothing}}', { n: 42, b: true, nothing: null }), '42|true|');
});

// ---------- missing variable policy ----------

test('missing variables render as empty string by default', () => {
  assert.equal(engine().render('[{{missing}}]', {}), '[]');
  assert.equal(engine().render('[{{a.b.c}}]', { a: {} }), '[]');
});

test('onMissing "keep" preserves the original tag', () => {
  assert.equal(engine({ onMissing: 'keep' }).render('[{{missing}}]', {}), '[{{missing}}]');
});

test('onMissing "throw" raises TemplateError with location', () => {
  assert.throws(
    () => engine({ onMissing: 'throw' }).render('x {{nope}}', {}, 'page'),
    (err) => {
      assert.ok(err instanceof TemplateError);
      assert.match(err.message, /\[page\] line 1, column 3: missing variable "nope"/);
      return true;
    },
  );
});

// ---------- if / else ----------

test('if renders the consequent when truthy', () => {
  assert.equal(engine().render('{{#if ok}}yes{{/if}}', { ok: 1 }), 'yes');
});

test('if/else picks the right branch', () => {
  const tpl = '{{#if admin}}admin{{else}}guest{{/if}}';
  assert.equal(engine().render(tpl, { admin: true }), 'admin');
  assert.equal(engine().render(tpl, { admin: false }), 'guest');
});

test('if treats 0, "", null, undefined, [] as falsy', () => {
  const tpl = '{{#if v}}T{{else}}F{{/if}}';
  for (const v of [0, '', null, undefined, []]) {
    assert.equal(engine().render(tpl, { v }), 'F', `value ${JSON.stringify(v)}`);
  }
});

test('nested if blocks match their own close tags', () => {
  const tpl = '{{#if a}}A{{#if b}}B{{else}}b{{/if}}{{else}}Z{{/if}}';
  assert.equal(engine().render(tpl, { a: true, b: true }), 'AB');
  assert.equal(engine().render(tpl, { a: true, b: false }), 'Ab');
  assert.equal(engine().render(tpl, { a: false, b: true }), 'Z');
});

test('if nested inside each and vice versa', () => {
  const tpl = '{{#each items}}{{#if this}}Y{{else}}N{{/if}}{{/each}}';
  assert.equal(engine().render(tpl, { items: [1, 0, 'x'] }), 'YNY');
});

// ---------- each ----------

test('each iterates arrays with this and @index', () => {
  const tpl = '{{#each items}}[{{@index}}:{{this}}]{{/each}}';
  assert.equal(engine().render(tpl, { items: ['a', 'b', 'c'] }), '[0:a][1:b][2:c]');
});

test('each exposes item properties and @first/@last', () => {
  const tpl = '{{#each users}}{{#if @first}}first:{{/if}}{{name}}{{#if @last}}:last{{/if}};{{/each}}';
  const out = engine().render(tpl, { users: [{ name: 'x' }, { name: 'y' }] });
  assert.equal(out, 'first:x;y:last;');
});

test('nested each loops and parent scope fallback', () => {
  const tpl = '{{#each groups}}{{name}}={{#each members}}{{this}} of {{name}};{{/each}} {{/each}}';
  const out = engine().render(tpl, {
    groups: [
      { name: 'g1', members: ['a', 'b'] },
      { name: 'g2', members: ['c'] },
    ],
  });
  assert.equal(out, 'g1=a of g1;b of g1; g2=c of g2; ');
});

test('each over missing or empty arrays renders nothing', () => {
  assert.equal(engine().render('{{#each nope}}x{{/each}}', {}), '');
  assert.equal(engine().render('{{#each items}}x{{/each}}', { items: [] }), '');
});

test('each on a non-array throws a located error', () => {
  assert.throws(
    () => engine().render('{{#each v}}x{{/each}}', { v: 5 }, 'loop'),
    /\[loop\] line 1, column 1: .*requires an array/,
  );
});

// ---------- HTML escaping & raw output ----------

test('variables are HTML-escaped by default', () => {
  const out = engine().render('{{html}}', { html: '<b>"a" & \'b\'</b>' });
  assert.equal(out, '&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;');
});

test('triple mustache outputs raw HTML', () => {
  assert.equal(engine().render('{{{html}}}', { html: '<b>hi</b>' }), '<b>hi</b>');
});

test('{{& var}} outputs raw HTML', () => {
  assert.equal(engine().render('{{& html}}', { html: '<i>x</i>' }), '<i>x</i>');
});

test('mixed escaped and raw output in one template', () => {
  assert.equal(engine().render('{{safe}} vs {{{safe}}}', { safe: '<em>' }), '&lt;em&gt; vs <em>');
});

// ---------- partials ----------

test('renders partials from the partials map', () => {
  const e = engine({ partials: { header: '<h1>{{title}}</h1>' } });
  assert.equal(e.render('{{> header}}<p>body</p>', { title: 'Hi' }), '<h1>Hi</h1><p>body</p>');
});

test('partials inherit the caller context and see each-loop scope', () => {
  const e = engine({ partials: { item: '<li>{{@index}}.{{this}}</li>' } });
  const out = e.render('<ul>{{#each list}}{{> item}}{{/each}}</ul>', { list: ['a', 'b'] });
  assert.equal(out, '<ul><li>0.a</li><li>1.b</li></ul>');
});

test('partials can be loaded from local files via loadPartial', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
  fs.writeFileSync(path.join(dir, 'footer.tpl'), '<footer>{{year}}</footer>');
  const e = engine({ loadPartial: (name) => fs.readFileSync(path.join(dir, `${name}.tpl`), 'utf8') });
  assert.equal(e.render('{{> footer}}', { year: 2026 }), '<footer>2026</footer>');
});

test('partials can include other partials', () => {
  const e = engine({ partials: { outer: 'A{{> inner}}C', inner: 'B' } });
  assert.equal(e.render('{{> outer}}', {}), 'ABC');
});

test('missing partial throws a located error', () => {
  assert.throws(
    () => engine().render('{{> ghost}}', {}, 'page'),
    /\[page\] line 1, column 1: partial "ghost" not found/,
  );
});

test('circular partial includes are detected', () => {
  const e = engine({ partials: { a: 'a>{{> b}}', b: 'b>{{> a}}' } });
  assert.throws(
    () => e.render('{{> a}}', {}, 'main'),
    /circular partial include detected: main -> a -> b -> a/,
  );
});

test('self-including partial is detected as circular', () => {
  const e = engine({ partials: { loop: '{{> loop}}' } });
  assert.throws(() => e.render('{{> loop}}', {}, 'main'), /circular partial include/);
});

test('partial nesting beyond maxDepth is rejected', () => {
  // Deep but finite chain: p0 -> p1 -> ... -> p40
  const partials = {};
  for (let i = 0; i <= 40; i += 1) {
    partials[`p${i}`] = i < 40 ? `{{> p${i + 1}}}` : 'end';
  }
  const e = engine({ partials, maxDepth: 10 });
  assert.throws(() => e.render('{{> p0}}', {}, 'main'), /maximum depth of 10/);
  // With a generous limit the same chain renders fine.
  const deep = engine({ partials, maxDepth: 100 });
  assert.equal(deep.render('{{> p0}}', {}), 'end');
});

// ---------- whitespace control ----------

test('{{~ trims whitespace before a tag', () => {
  assert.equal(engine().render('hello   {{~name}}', { name: 'x' }), 'hellox');
});

test('~}} trims whitespace after a tag', () => {
  assert.equal(engine().render('{{name~}}   world', { name: 'hi' }), 'hiworld');
});

test('whitespace control works across newlines and is deterministic', () => {
  const tpl = '<ul>\n  {{~#each items~}}\n  <li>{{this}}</li>\n  {{~/each~}}\n</ul>';
  const expected = '<ul><li>a</li><li>b</li></ul>';
  const e = engine();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(e.render(tpl, { items: ['a', 'b'] }), expected);
  }
});

test('comments are removed without touching surrounding text', () => {
  assert.equal(engine().render('a{{! note }}b', {}), 'ab');
});

// ---------- parse errors ----------

test('unclosed block reports template name, line and column', () => {
  assert.throws(
    () => engine().render('line1\n{{#if ok}}never closed', {}, 'email.tpl'),
    (err) => {
      assert.ok(err instanceof TemplateError);
      assert.match(err.message, /\[email\.tpl\] line 2, column 1: unclosed "\{\{#if\}\}" block/);
      assert.equal(err.templateName, 'email.tpl');
      assert.equal(err.line, 2);
      assert.equal(err.column, 1);
      return true;
    },
  );
});

test('mismatched close tag reports both locations', () => {
  assert.throws(
    () => engine().render('{{#if a}}\n{{/each}}', {}, 'mix.tpl'),
    /\[mix\.tpl\] line 2, column 1: mismatched close tag: expected "\{\{\/if\}\}" \(opened at line 1, column 1\)/,
  );
});

test('close tag without an open block is rejected', () => {
  assert.throws(
    () => engine().render('hello {{/if}}', {}, 'stray.tpl'),
    /\[stray\.tpl\] line 1, column 7: unexpected "\{\{\/if\}\}" with no open block/,
  );
});

test('unclosed tag is rejected with position', () => {
  assert.throws(
    () => engine().render('abc {{name', {}, 'bad.tpl'),
    /\[bad\.tpl\] line 1, column 5: unclosed tag "\{\{"/,
  );
});

test('unclosed triple mustache is rejected with position', () => {
  assert.throws(
    () => engine().render('{{{raw}}', {}, 'raw.tpl'),
    /\[raw\.tpl\] line 1, column 1: unclosed raw output tag/,
  );
});

test('else outside if is rejected', () => {
  assert.throws(
    () => engine().render('{{#each xs}}{{else}}{{/each}}', { xs: [] }, 'else.tpl'),
    /\[else\.tpl\] line 1, column 13: "\{\{else\}\}" without a matching "\{\{#if\}\}"/,
  );
});

test('invalid block opener is rejected', () => {
  assert.throws(
    () => engine().render('{{#unknown x}}{{/unknown}}', {}, 'unk.tpl'),
    /\[unk\.tpl\] line 1, column 1: invalid block opener/,
  );
});

test('empty tag is rejected', () => {
  assert.throws(
    () => engine().render('a {{}} b', {}, 'empty.tpl'),
    /\[empty\.tpl\] line 1, column 3: empty tag/,
  );
});

// ---------- determinism ----------

test('same input always produces the same output', () => {
  const tpl = '{{#each users}}{{name}}<{{email}}>;{{/each}}';
  const ctx = { users: [{ name: 'a', email: 'a@x' }, { name: 'b', email: 'b@x' }] };
  const e = engine();
  const first = e.render(tpl, ctx);
  for (let i = 0; i < 5; i += 1) assert.equal(e.render(tpl, ctx), first);
  assert.equal(first, 'a<a@x>;b<b@x>;');
});
