import { seedE2e } from './seed.ts'

/** `yarn local:seed`: the E2E businesses in the local Worker `yarn dev` serves on port 3000. */
await seedE2e('http://localhost:3000')
