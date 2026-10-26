[**@mrmeku/dagraph**](README.md)

---

[@mrmeku/dagraph](README.md) / mermaid

# mermaid

## Interfaces

### MermaidOptions

#### Type Parameters

##### Meta

`Meta` = `unknown`

#### Properties

##### classOf?

> `optional` **classOf?**: (`node`) => `string` \| `undefined`

A class name per node, applied with `class` lines. Default: none.

###### Parameters

###### node

[`Node`](index.md#node)\<`Meta`\>

###### Returns

`string` \| `undefined`

##### label?

> `optional` **label?**: (`node`) => `string`

Text inside a node's box. Default: its full name.

###### Parameters

###### node

[`Node`](index.md#node)\<`Meta`\>

###### Returns

`string`

##### subgraphLabel?

> `optional` **subgraphLabel?**: (`subgraph`, `index`) => `string`

Title of a box, given its subgraph and its index. Default: the subgraph itself.

###### Parameters

###### subgraph

`string`

###### index

`number`

###### Returns

`string`

##### subgraphOf?

> `optional` **subgraphOf?**: (`meta`) => `string`

The box a node is drawn in, from its `meta`; "" for none. Without it, nothing is boxed.

###### Parameters

###### meta

`Meta` \| `undefined`

###### Returns

`string`

## Functions

### mermaidBody()

> **mermaidBody**\<`Meta`\>(`nodes`, `opts?`): `object`

The body of a mermaid flowchart for a set of nodes: one box per node, each `subgraphOf` box as a
subgraph (ids `s0`, `s1`, …), one edge per dependency (dashed when settled), then `class` lines
grouping nodes by the class `classOf` gives them. Callers add the header (`flowchart LR`),
any `classDef`/`style` lines, and whatever surrounds the graph. `id` maps a node name to its
id in the lines and `subgraphs` lists the subgraph ids, so a caller can style them or draw
edges to its own pseudo-nodes.

#### Type Parameters

##### Meta

`Meta`

#### Parameters

##### nodes

[`Node`](index.md#node)\<`Meta`\>[]

##### opts?

[`MermaidOptions`](#mermaidoptions)\<`Meta`\> = `{}`

#### Returns

`object`

##### id

> **id**: (`name`) => `string`

###### Parameters

###### name

`string`

###### Returns

`string`

##### lines

> **lines**: `string`[]

##### subgraphs

> **subgraphs**: `string`[]

---

### mermaidQuote()

> **mermaidQuote**(`text`): `string`

A mermaid label as a quoted string. The characters mermaid would read as an entity, an HTML tag
or a markdown string (# " < > `) become numeric entity codes, and an empty label, which mermaid
refuses to parse, becomes a space.

#### Parameters

##### text

`string`

#### Returns

`string`
