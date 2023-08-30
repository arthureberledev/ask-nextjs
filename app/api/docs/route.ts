import { NextRequest, NextResponse } from 'next/server'

import { generateEmbedding } from '~/lib/generate-embedding'
import { prisma } from '~/lib/prisma'

// Workaround for Prisma not supporting BigInt
// @see https://github.com/prisma/studio/issues/614
// @ts-ignore: Unreachable code error
BigInt.prototype.toJSON = function (): string {
  return this.toString()
}

export async function GET(req: NextRequest) {
  try {
    const query = req.nextUrl.searchParams.get('query')
    if (!query) return NextResponse.json({ error: 'No query provided' }, { status: 400 })
    // const query = 'What is the difference between the app and pages folder'

    const embedding = await generateEmbedding(query)
    const context = (await prisma.$queryRaw`
      SELECT
        ps.id,
        ps.page_id,
        ps.heading,
        ps.content,
        1 - (ps.embedding <=> ${embedding.vectors}::vector) as similarity,
        p.path
      FROM page_section AS ps
      JOIN page AS p ON ps.page_id = p.id
      WHERE 1 - (ps.embedding <=> ${embedding.vectors}::vector) > .5
      AND LENGTH(ps.content) > 50
      ORDER BY similarity DESC
      LIMIT 15;
    `) as JSON

    return NextResponse.json({
      ...context,
    })
  } catch (error) {
    console.error(error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
