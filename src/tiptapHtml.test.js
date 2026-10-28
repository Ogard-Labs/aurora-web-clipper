import assert from 'node:assert/strict'
import test from 'node:test'
import { htmlNodesToBlocks } from './tiptapHtml.js'

const TEXT_NODE = 3
const ELEMENT_NODE = 1

function text(value) {
  return {
    nodeType: TEXT_NODE,
    textContent: value,
  }
}

function element(tagName, children = [], attributes = {}) {
  const normalizedTag = tagName.toUpperCase()
  const childNodes = children
  const elementNode = {
    nodeType: ELEMENT_NODE,
    tagName: normalizedTag,
    childNodes,
    children: childNodes.filter((child) => child.nodeType === ELEMENT_NODE),
    textContent: childNodes.map((child) => child.textContent ?? '').join(''),
    getAttribute(name) {
      return attributes[name] ?? null
    },
  }
  return elementNode
}

test('preserves bold links inside selected paragraphs', () => {
  const blocks = htmlNodesToBlocks([
    element('p', [
      text('Read '),
      element('strong', [
        element('a', [text('Aurora')], { href: 'https://aurora.ink' }),
      ]),
    ]),
  ])

  assert.deepEqual(blocks, [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Read ' },
        {
          type: 'text',
          text: 'Aurora',
          marks: [
            { type: 'bold' },
            { type: 'link', attrs: { href: 'https://aurora.ink', target: '_blank' } },
          ],
        },
      ],
    },
  ])
})

test('resolves relative selected links against the clipped page URL', () => {
  const blocks = htmlNodesToBlocks([
    element('p', [
      element('a', [text('Docs')], { href: '/docs' }),
    ]),
  ], { baseUrl: 'https://aurora.ink/product/overview' })

  assert.deepEqual(blocks, [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Docs',
          marks: [{ type: 'link', attrs: { href: 'https://aurora.ink/docs', target: '_blank' } }],
        },
      ],
    },
  ])
})

test('preserves bullet lists from selected HTML', () => {
  const blocks = htmlNodesToBlocks([
    element('ul', [
      element('li', [text('First')]),
      element('li', [text('Second')]),
    ]),
  ])

  assert.deepEqual(blocks, [
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second' }] }] },
      ],
    },
  ])
})

test('wraps loose inline selected nodes in one paragraph', () => {
  const blocks = htmlNodesToBlocks([
    text('Loose '),
    element('em', [text('inline')]),
    text(' text'),
  ])

  assert.deepEqual(blocks, [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Loose ' },
        { type: 'text', text: 'inline', marks: [{ type: 'italic' }] },
        { type: 'text', text: ' text' },
      ],
    },
  ])
})
