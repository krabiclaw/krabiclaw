import { defineHandler, HTTPError } from 'nitro'

export default defineHandler(() => {
  throw new HTTPError({ statusCode: 404, message: 'API route not found' })
})
