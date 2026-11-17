import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api'
import * as schema from '../../../server/db/schema.ts'

let statements: Promise<string[]> | undefined

/** Builds the declared schema in a fresh D1 in one batch, generating its SQL once per test file. */
export async function applySchema(db: D1Database): Promise<void> {
  statements ??= Promise.all([generateSQLiteDrizzleJson({}), generateSQLiteDrizzleJson(schema)]).then(([empty, current]) => generateSQLiteMigration(empty, current))
  await db.batch((await statements).map(sql => db.prepare(sql)))
}
