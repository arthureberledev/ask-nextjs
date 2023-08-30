import { sql } from '@vercel/postgres'
import dotenv from 'dotenv'

dotenv.config({
  path: '.env.local',
})

async function seed() {
  console.log('------------- Seeding -------------')

  try {
    await sql.query(`
        CREATE EXTENSION vector;
    `)
    console.log("Created extension 'vector'")

    await sql.query(`
        CREATE TABLE IF NOT EXISTS page (
            id              BIGSERIAL PRIMARY KEY,
            parent_page_id  BIGINT REFERENCES page,
            path            TEXT NOT NULL UNIQUE,
            checksum        TEXT,
            meta            JSONB,
            type            TEXT,
            source          TEXT
        );
    `)
    console.log("Created table 'page'")

    await sql.query(`
        CREATE TABLE IF NOT EXISTS page_section (
            id              BIGSERIAL PRIMARY KEY,
            page_id         BIGINT NOT NULL REFERENCES page ON DELETE CASCADE,
            content         TEXT,
            token_count     INT,
            embedding       VECTOR(1536),
            slug            TEXT,
            heading         TEXT
        );
    `)
    console.log("Created table 'page_section'")

    console.log('------------- Seeding Complete -------------')
  } catch (error) {
    console.error(error)
    process.exit(1)
  } finally {
    await sql.end()
  }
}

seed()
