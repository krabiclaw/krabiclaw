import { buildOgImageCard, type RenderInputs } from './shared.ts'
import type { SatoriNode } from '../satori-node.ts'

const VARIANT = {
  accentColor: '#fdba74',
}

export function renderTenantCard(payload: RenderInputs): SatoriNode {
  return buildOgImageCard(payload, VARIANT)
}
