import { OpenAI } from 'openai'
import dotenv from 'dotenv'

dotenv.config({
  path: '.env.local',
})

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function generateEmbedding(_input: string) {
  // OpenAI recommends replacing newlines with spaces for best results
  const input = _input.replace(/\n/g, ' ')

  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input,
  })
  const [{ embedding }] = embeddingResponse.data

  return { vectors: embedding, tokens: embeddingResponse.usage.total_tokens }
}
