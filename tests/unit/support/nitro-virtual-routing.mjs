// `#nitro/virtual/routing` is emitted by the Nitro build from the route tree.
// Nothing under node --test routes through Nitro, so reading a route rule throws.
export function findRouteRules() {
  throw new Error('#nitro/virtual/routing is a build artifact and is unavailable under node --test.')
}
