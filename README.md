# local-template-engine

一个完全本地化的文本模板引擎：所有模板、变量、partial 和渲染结果只存在于本地文件或内存中，不依赖任何远程 CMS、模板 SaaS 或外部服务。零第三方依赖，模板语言的词法分析、解析和渲染核心全部在本工程内实现（`src/lexer.js`、`src/parser.js`、`src/engine.js`）。

## 快速开始

```js
const { TemplateEngine } = require('./index');

const engine = new TemplateEngine({
  partials: { header: '<h1>{{title}}</h1>' },
});

engine.render('{{> header}}<p>{{body}}</p>', { title: 'Hi', body: '<b>x</b>' });
// => '<h1>Hi</h1><p>&lt;b&gt;x&lt;/b&gt;</p>'
```

## 模板语法

| 语法 | 含义 |
| --- | --- |
| `{{user.name}}` | 变量插值（默认 HTML 转义），支持嵌套属性 |
| `{{{html}}}` 或 `{{& html}}` | raw 输出，不做转义（显式、唯一的不转义方式） |
| `{{#if cond}}...{{else}}...{{/if}}` | 条件块，`{{else}}` 可省略 |
| `{{#each items}}...{{/each}}` | 数组循环 |
| `{{> partialName}}` | 引入本地 partial |
| `{{! comment }}` | 注释，渲染时被移除 |
| `{{~ ... ~}}` | 空白控制（见下文） |

控制结构必须正确嵌套并以匹配的结束标签收尾（`{{#if}}` 对 `{{/if}}`、`{{#each}}` 对 `{{/each}}`），否则解析时报错。

### 循环内的特殊变量

- `{{this}}`：当前元素；`{{this.prop}}` 访问当前元素属性
- `{{@index}}`：当前下标（从 0 开始）
- `{{@first}}` / `{{@last}}`：是否首/末元素

## 转义规则

- `{{var}}` 一律进行 HTML 转义：`& < > " ' \`` 分别转为 `&amp; &lt; &gt; &quot; &#39; &#96;`。
- 只有显式写 `{{{var}}}` 或 `{{& var}}` 才会原样输出，普通变量无法意外绕过转义。
- `null` / `undefined` 渲染为空字符串；对象值以 `JSON.stringify` 输出。

## 作用域模型

- 渲染上下文是一棵作用域栈：根上下文在栈底，每进入一层 `{{#each}}` 压入当前元素作为新作用域。
- 路径（如 `{{name}}`）从最内层作用域向外逐层解析，内层未命中时回退到外层，因此循环体内可以直接引用外层上下文的变量。
- `{{this.xxx}}` 锚定在最内层作用域，不做外层回退。
- partial 继承调用处完整的作用域栈（包括循环内的 `this` 和 `@index`）。
- `{{#if}}` 的 falsy 值：`false`、`0`、`NaN`、`''`、`null`、`undefined`、空数组。

## 缺失变量策略

通过 `onMissing` 配置，默认为 `'empty'`：

- `'empty'`：渲染为空字符串
- `'keep'`：保留原始标签文本（如 `{{name}}`）
- `'throw'`：抛出带模板名、行号、列号的 `TemplateError`

## partial 与安全限制

- partial 来源只有两种：构造参数的 `partials` 映射（内存），或 `loadPartial(name)` 回调（例如读取本地文件），均为本地来源。
- 循环 include（如 `a -> b -> a` 或自引用）会被检测并抛出错误，错误信息包含完整 include 链。
- `maxDepth`（默认 32）限制 partial 最大嵌套深度，超出即报错。

## 空白控制

- `{{~` 移除标签之前的连续空白（含换行），`~}}` 移除标签之后的连续空白。
- 不使用 `~` 时，模板中的空白原样保留。规则纯粹基于词法，相同输入必然得到相同输出。

## 错误报告

所有解析/渲染错误都是 `TemplateError`，消息格式为：

```
[模板名] line 行号, column 列号: 具体原因
```

例如：`[email.tpl] line 2, column 1: unclosed "{{#if}}" block (opened at line 2, column 1); missing "{{/if}}"`。错误对象上同时带有 `templateName`、`line`、`column` 字段。

## 运行测试

```sh
npm test
```

直接调用 Node.js 内置测试运行器，在终端输出每个用例的通过/失败明细与汇总。测试覆盖：嵌套对象、条件与嵌套控制结构、循环与作用域、HTML 转义与 raw 输出、partial（内存与本地文件）、循环 include、最大嵌套深度、缺失变量三种策略、各类非法模板及确定性输出。
