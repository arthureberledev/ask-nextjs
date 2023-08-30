import { createHash } from 'crypto'
import dotenv from 'dotenv'
import { ObjectExpression } from 'estree'
import { readFile } from 'fs/promises'
import GithubSlugger from 'github-slugger'
import { Content, Root } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { mdxFromMarkdown, MdxjsEsm } from 'mdast-util-mdx'
import { toMarkdown } from 'mdast-util-to-markdown'
import { toString } from 'mdast-util-to-string'
import { mdxjs } from 'micromark-extension-mdxjs'
import { Prisma } from '@prisma/client'
import { u } from 'unist-builder'
import { filter } from 'unist-util-filter'
import yargs from 'yargs'
import { OpenAI } from 'openai'

import { prisma } from '~/lib/prisma'
import { walk } from '~/lib/utils'
import { generateEmbedding } from './generate-embedding'

dotenv.config({
  path: '.env.local',
})

const ignoredFiles: string[] = []

/**
 * Extracts ES literals from an `estree` `ObjectExpression`
 * into a plain JavaScript object.
 */
function getObjectFromExpression(node: ObjectExpression) {
  return node.properties.reduce<
    Record<string, string | number | bigint | true | RegExp | undefined>
  >((object, property) => {
    if (property.type !== 'Property') {
      return object
    }

    const key = (property.key.type === 'Identifier' && property.key.name) || undefined
    const value = (property.value.type === 'Literal' && property.value.value) || undefined

    if (!key) {
      return object
    }

    return {
      ...object,
      [key]: value,
    }
  }, {})
}

/**
 * Extracts the `meta` ESM export from the MDX file.
 *
 * This info is akin to frontmatter.
 */
function extractMetaExport(mdxTree: Root) {
  const metaExportNode = mdxTree.children.find((node): node is MdxjsEsm => {
    return (
      node.type === 'mdxjsEsm' &&
      node.data?.estree?.body[0]?.type === 'ExportNamedDeclaration' &&
      node.data.estree.body[0].declaration?.type === 'VariableDeclaration' &&
      node.data.estree.body[0].declaration.declarations[0]?.id.type === 'Identifier' &&
      node.data.estree.body[0].declaration.declarations[0].id.name === 'meta'
    )
  })

  if (!metaExportNode) {
    return undefined
  }

  const objectExpression =
    (metaExportNode.data?.estree?.body[0]?.type === 'ExportNamedDeclaration' &&
      metaExportNode.data.estree.body[0].declaration?.type === 'VariableDeclaration' &&
      metaExportNode.data.estree.body[0].declaration.declarations[0]?.id.type === 'Identifier' &&
      metaExportNode.data.estree.body[0].declaration.declarations[0].id.name === 'meta' &&
      metaExportNode.data.estree.body[0].declaration.declarations[0].init?.type ===
        'ObjectExpression' &&
      metaExportNode.data.estree.body[0].declaration.declarations[0].init) ||
    undefined

  if (!objectExpression) {
    return undefined
  }

  return getObjectFromExpression(objectExpression)
}

/**
 * Splits a `mdast` tree into multiple trees based on
 * a predicate function. Will include the splitting node
 * at the beginning of each tree.
 *
 * Useful to split a markdown file into smaller sections.
 */
function splitTreeBy(tree: Root, predicate: (node: Content) => boolean) {
  return tree.children.reduce<Root[]>((trees, node) => {
    const [lastTree] = trees.slice(-1)

    if (!lastTree || predicate(node)) {
      const tree: Root = u('root', [node])
      return trees.concat(tree)
    }

    lastTree.children.push(node)
    return trees
  }, [])
}

type Meta = ReturnType<typeof extractMetaExport>

type Section = {
  content: string
  heading?: string
  slug?: string
}

type ProcessedMdx = {
  checksum: string
  meta: Meta
  sections: Section[]
}

/**
 * Processes MDX content for search indexing.
 * It extracts metadata, strips it of all JSX,
 * and splits it into sub-sections based on criteria.
 */
function processMdxForSearch(content: string): ProcessedMdx {
  const checksum = createHash('sha256').update(content).digest('base64')

  const mdxTree = fromMarkdown(content, {
    extensions: [mdxjs()],
    mdastExtensions: [mdxFromMarkdown()],
  })

  const meta = extractMetaExport(mdxTree)

  // Remove all MDX elements from markdown
  const mdTree = filter(
    mdxTree,
    (node) =>
      ![
        'mdxjsEsm',
        'mdxJsxFlowElement',
        'mdxJsxTextElement',
        'mdxFlowExpression',
        'mdxTextExpression',
      ].includes(node.type)
  )

  if (!mdTree) {
    return {
      checksum,
      meta,
      sections: [],
    }
  }

  const sectionTrees = splitTreeBy(mdTree, (node) => node.type === 'heading')

  const slugger = new GithubSlugger()

  const sections = sectionTrees.map((tree) => {
    const [firstNode] = tree.children

    const heading = firstNode.type === 'heading' ? toString(firstNode) : undefined
    const slug = heading ? slugger.slug(heading) : undefined

    return {
      content: toMarkdown(tree),
      heading,
      slug,
    }
  })

  return {
    checksum,
    meta,
    sections,
  }
}

// Convert to url friendy path
// Before: docs\\02-app\\01-building-your-application\\01-routing\\08-parallel-routes.mdx
// After: docs/app/building-your-application/routing/parallel-routes
function formatPath(path: string) {
  return path
    .replace(/\\\\/g, '/') // Replaces double backslashes with single forward slashes
    .replace(/\d{2}-/g, '') // Remove leading numbers and dashes
    .replace(/\.mdx$/, '') // Remove .mdx extension
    .replace(/\\index$/, '') // Remove trailing /index
}

abstract class BaseEmbeddingSource {
  checksum?: string
  meta?: Meta
  sections?: Section[]

  constructor(public source: string, public path: string, public parentPath?: string) {}

  abstract load(): Promise<{
    checksum: string
    meta?: Meta
    sections: Section[]
  }>
}

class MarkdownEmbeddingSource extends BaseEmbeddingSource {
  type: 'markdown' = 'markdown'

  constructor(source: string, public filePath: string, public parentFilePath?: string) {
    const path = formatPath(filePath)
    const parentPath = parentFilePath ? formatPath(parentFilePath) : undefined
    super(source, path, parentPath)
  }

  async load() {
    const contents = await readFile(this.filePath, 'utf8')

    const { checksum, meta, sections } = processMdxForSearch(contents)

    this.checksum = checksum
    this.meta = meta
    this.sections = sections

    return {
      checksum,
      meta,
      sections,
    }
  }
}

type EmbeddingSource = MarkdownEmbeddingSource

async function indexFiles() {
  const argv = await yargs.option('refresh', {
    alias: 'r',
    description: 'Refresh data',
    type: 'boolean',
  }).argv
  const shouldRefresh = argv.refresh

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('process.env.OPENAI_API_KEY is not defined.')
  }

  const embeddingSources: EmbeddingSource[] = [
    ...(await walk('docs'))
      .filter(({ path }) => /\.mdx?$/.test(path))
      .filter(({ path }) => !ignoredFiles.includes(path))
      .map((entry) => new MarkdownEmbeddingSource('guide', entry.path, entry.parentPath)),
  ]

  console.log(`Discovered ${embeddingSources.length} pages`)

  if (!shouldRefresh) {
    console.log('Checking which pages are new or have changed')
  } else {
    console.log('Refresh flag set, re-generating all pages')
  }

  for (const embeddingSource of embeddingSources) {
    const { type, source, path, parentPath } = embeddingSource

    try {
      const { checksum, meta, sections } = await embeddingSource.load()

      //Check for existing page in DB and compare checksums
      const existingPage = await prisma.page.findUnique({
        where: { path: path },
        select: {
          id: true,
          path: true,
          checksum: true,
          parentPage: true,
        },
      })

      // We use checksum to determine if this page & its sections need to be regenerated
      if (!shouldRefresh && existingPage?.checksum === checksum) {
        if (existingPage.parentPage?.path !== parentPath) {
          console.log(`[${path}] Parent page has changed. Updating to '${parentPath}'...`)
          const parentPage = await prisma.page.findUnique({ where: { path: parentPath } })
          await prisma.page.update({
            where: { id: existingPage.id },
            data: { parentPageId: parentPage?.id },
          })
        }
        continue
      }

      if (existingPage) {
        console.log(`[${path}] Refresh flag set, removing old page sections and their embeddings`)
        await prisma.pageSection.deleteMany({ where: { pageId: existingPage.id } })
      }

      const parentPage = await prisma.page.findUnique({ where: { path: parentPath } })

      // Create/update page record. Intentionally clear checksum until we
      // have successfully generated all page sections.
      const page = await prisma.page.upsert({
        where: { path: path },
        update: {
          checksum: null,
          path,
          type,
          source,
          meta: meta as Prisma.InputJsonValue,
          parentPageId: parentPage?.id,
        },
        create: {
          checksum: null,
          path,
          type,
          source,
          meta: meta as Prisma.InputJsonValue,
          parentPageId: parentPage?.id,
        },
      })

      console.log(`[${path}] Adding ${sections.length} page sections (with embeddings)`)

      // Generate embeddings and upload to vercel postgres
      for (const { slug, heading, content } of sections) {
        try {
          // concat heading and content to get full text
          const concattedContent = heading ? `${heading} ${content}` : content
          const embedding = await generateEmbedding(concattedContent)

          const pageSection = await prisma.pageSection.create({
            data: {
              pageId: page.id,
              slug,
              heading,
              content,
              tokenCount: embedding.tokens,
            },
          })

          // Add the embedding manually
          await prisma.$executeRaw`
            UPDATE page_section
            SET embedding = ${embedding.vectors}::vector
            WHERE id = ${pageSection.id}
          `
        } catch (err) {
          console.error(
            `Failed to generate embeddings for '${path}' page section starting with '${content.slice(
              0,
              40
            )}...'`
          )
          throw err
        }
      }

      // Set page checksum so that we know this page was stored successfully
      await prisma.page.update({
        where: { id: page.id },
        data: { checksum: checksum },
      })
    } catch (error) {
      console.error(
        `Page '${path}' or one/multiple of its page sections failed to store properly. Page has been marked with null checksum to indicate that it needs to be re-generated.`
      )
      console.error(error)
    } finally {
      await prisma.$disconnect()
    }
  }

  console.log('Embedding generation complete')
}

async function main() {
  await indexFiles()
}

main().catch((err) => console.error(err))
