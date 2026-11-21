import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { AgreementField } from '~/shared/agreements'
import type { ProductKind } from '~/shared/product-details'

export interface GenerateAgreementOptions {
  kind: ProductKind
  title?: string
  businessName: string
  businessRole?: string
  counterpartyKey: string
  counterpartyName: string
  counterpartyEmail?: string
  hostKey: string
  hostName: string
  propertyOrMatter: string
  termType: 'fixed' | 'month_to_month'
  startDate: string
  endDate?: string | null
  monthlyRentMinor: number
  depositMinor: number
  currency: string
  customRules?: string[]
}

function formatMoney(minor: number, currency: string): string {
  const amount = (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${currency.toUpperCase()} ${amount}`
}

/**
 * Generates a clean, professional multi-page agreement PDF from canonical booking terms (#2038).
 * Includes rent schedule terms (#1907) and security deposit escrow provisions (#1908).
 * Automatically places signature and date fields precisely on the signature blocks.
 */
function sanitizeWinAnsi(text: string): string {
  let result = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255) || code === 10 || code === 9) {
      result += text[i]
    } else {
      const decomposed = text[i].normalize('NFKD')
      let replaced = ''
      for (let j = 0; j < decomposed.length; j++) {
        const dCode = decomposed.charCodeAt(j)
        if ((dCode >= 32 && dCode <= 126) || (dCode >= 160 && dCode <= 255)) replaced += decomposed[j]
      }
      result += replaced || '?'
    }
  }
  return result
}

export async function generateAgreementPdf(options: GenerateAgreementOptions): Promise<{
  bytes: Uint8Array
  fileName: string
  fields: AgreementField[]
}> {
  const pdf = await PDFDocument.create()
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const fontRegular = await pdf.embedFont(StandardFonts.Helvetica)
  const fontItalic = await pdf.embedFont(StandardFonts.HelveticaOblique)

  const PAGE_WIDTH = 612
  const PAGE_HEIGHT = 792
  const MARGIN = 54
  const CONTENT_WIDTH = PAGE_WIDTH - (MARGIN * 2)

  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let cursorY = PAGE_HEIGHT - MARGIN

  const drawText = (
    text: string,
    font = fontRegular,
    size = 10,
    color = rgb(0.12, 0.14, 0.17),
  ) => {
    const safeText = sanitizeWinAnsi(text)
    page.drawText(safeText, { x: MARGIN, y: cursorY, font, size, color })
    cursorY -= size + 5
  }

  const drawParagraph = (text: string, font = fontRegular, size = 9.5, lineHeight = 14) => {
    const safeText = sanitizeWinAnsi(text)
    const words = safeText.split(' ')
    let line = ''
    for (const word of words) {
      const testLine = line ? `${line} ${word}` : word
      const textWidth = font.widthOfTextAtSize(testLine, size)
      if (textWidth > CONTENT_WIDTH) {
        page.drawText(line, { x: MARGIN, y: cursorY, font, size, color: rgb(0.2, 0.22, 0.25) })
        cursorY -= lineHeight
        line = word
      } else {
        line = testLine
      }
    }
    if (line) {
      page.drawText(line, { x: MARGIN, y: cursorY, font, size, color: rgb(0.2, 0.22, 0.25) })
      cursorY -= lineHeight
    }
    cursorY -= 4
  }

  const drawHeading = (title: string) => {
    cursorY -= 8
    page.drawText(title, { x: MARGIN, y: cursorY, font: fontBold, size: 12, color: rgb(0.08, 0.1, 0.15) })
    cursorY -= 6
    page.drawLine({
      start: { x: MARGIN, y: cursorY },
      end: { x: PAGE_WIDTH - MARGIN, y: cursorY },
      thickness: 0.75,
      color: rgb(0.85, 0.88, 0.92),
    })
    cursorY -= 12
  }

  // 1. Title Banner
  const defaultTitle = options.kind === 'service'
    ? 'ATTORNEY-CLIENT ENGAGEMENT LETTER'
    : options.kind === 'experience'
      ? 'MEMBERSHIP AGREEMENT & LIABILITY WAIVER'
      : options.kind === 'table'
        ? 'PRIVATE EVENT CONTRACT'
        : 'RESIDENTIAL LEASE AGREEMENT'

  const docTitle = options.title?.trim() || defaultTitle
  page.drawText(docTitle, {
    x: MARGIN,
    y: cursorY,
    font: fontBold,
    size: 16,
    color: rgb(0.08, 0.1, 0.18),
  })
  cursorY -= 20

  const subtitle = options.kind === 'service'
    ? 'Legal Services Agreement'
    : options.kind === 'stay'
      ? (options.termType === 'fixed' ? 'Fixed-Term Residential Lease' : 'Month-to-Month Rental Agreement')
      : 'Service Terms & Agreement'

  page.drawText(subtitle, {
    x: MARGIN,
    y: cursorY,
    font: fontItalic,
    size: 10,
    color: rgb(0.4, 0.45, 0.52),
  })
  cursorY -= 16

  page.drawLine({
    start: { x: MARGIN, y: cursorY },
    end: { x: PAGE_WIDTH - MARGIN, y: cursorY },
    thickness: 1.5,
    color: rgb(0.15, 0.23, 0.4),
  })
  cursorY -= 16

  // 2. Section 1: Parties
  drawHeading('1. PARTIES')
  const hostRole = options.kind === 'service' ? 'Attorney / Law Firm' : options.kind === 'stay' ? 'Landlord' : 'Host'
  const guestRole = options.kind === 'service' ? 'Client' : options.kind === 'stay' ? 'Tenant' : 'Guest'

  drawText(`${hostRole}: ${options.businessName}`, fontBold, 10)
  drawText(`${guestRole}: ${options.counterpartyName}${options.counterpartyEmail ? ` (${options.counterpartyEmail})` : ''}`, fontBold, 10)
  cursorY -= 6

  // 3. Section 2: Property / Matter Scope
  drawHeading(options.kind === 'service' ? '2. SCOPE OF REPRESENTATION' : '2. PREMISES')
  drawText(`Location / Subject: ${options.propertyOrMatter}`, fontRegular, 10)
  cursorY -= 6

  // 4. Section 3: Term & Duration
  drawHeading('3. TERM & DURATION')
  const termStr = options.termType === 'fixed' && options.endDate
    ? `Fixed Term: Commencing on ${options.startDate} and terminating on ${options.endDate}.`
    : `Month-to-Month: Commencing on ${options.startDate} and continuing month-to-month until terminated by either party.`
  drawParagraph(termStr)

  // 5. Section 4: Rent / Retainer Payments (#1907)
  drawHeading(options.kind === 'service' ? '4. LEGAL FEES & PAYMENT SCHEDULE' : '4. RENT & PAYMENT SCHEDULE')
  const rentStr = options.monthlyRentMinor > 0
    ? `Monthly Payment: ${formatMoney(options.monthlyRentMinor, options.currency)} due on the first day of each calendar month. Payments may be made by electronic bank transfer, card, or approved payment methods.`
    : 'Services and access are rendered subject to agreed terms and booking commitments.'
  drawParagraph(rentStr)

  // 6. Section 5: Security Deposit & Escrow (#1908)
  drawHeading(options.kind === 'service' ? '5. TRUST ACCOUNT RETAINER / ESCROW' : '5. SECURITY DEPOSIT & ESCROW')
  const depositStr = options.depositMinor > 0
    ? `Security Deposit: ${formatMoney(options.depositMinor, options.currency)} to be held in trust/escrow. The deposit is held as security against damages, defaults, or unpaid charges, and is strictly refundable upon termination subject to inspection and terms.`
    : 'No security deposit or trust retainer required unless separately invoiced.'
  drawParagraph(depositStr)

  // 7. Section 6: Terms & Conditions
  drawHeading('6. TERMS & CONDITIONS')
  const defaultRules = options.customRules?.length ? options.customRules : [
    'Use of Premises/Services: Shall be used exclusively for lawful, agreed purposes.',
    'Care & Compliance: Parties agree to comply with all applicable community rules, building policies, and safety standards.',
    'Quiet Hours & Conduct: Peaceful enjoyment and standard quiet hours shall be observed at all times.',
    'Electronic Signatures: The parties agree that this document may be executed electronically pursuant to ESIGN and UETA standards.',
  ]
  for (const rule of defaultRules) {
    drawParagraph(`• ${rule}`)
  }

  // Check if signature block fits on page 1, else add page 2
  if (cursorY < 220) {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    cursorY = PAGE_HEIGHT - MARGIN
  }

  // 8. Signatures Section
  drawHeading('7. EXECUTION & ELECTRONIC SIGNATURES')
  drawParagraph('IN WITNESS WHEREOF, the parties have executed this agreement as of the dates indicated below.')
  cursorY -= 15

  const pageIndex = pdf.getPageCount() // 1-based page index

  // Tenant / Counterparty Signature Line
  const guestSigY = cursorY
  page.drawText(`${guestRole.toUpperCase()} SIGNATURE:`, { x: MARGIN, y: guestSigY, font: fontBold, size: 9, color: rgb(0.3, 0.35, 0.4) })
  page.drawLine({ start: { x: MARGIN, y: guestSigY - 32 }, end: { x: MARGIN + 220, y: guestSigY - 32 }, thickness: 1, color: rgb(0.6, 0.65, 0.7) })
  page.drawText('Date:', { x: MARGIN + 260, y: guestSigY, font: fontBold, size: 9, color: rgb(0.3, 0.35, 0.4) })
  page.drawLine({ start: { x: MARGIN + 260, y: guestSigY - 32 }, end: { x: PAGE_WIDTH - MARGIN, y: guestSigY - 32 }, thickness: 1, color: rgb(0.6, 0.65, 0.7) })

  // Host / Business Signature Line
  const hostSigY = guestSigY - 65
  page.drawText(`${hostRole.toUpperCase()} SIGNATURE:`, { x: MARGIN, y: hostSigY, font: fontBold, size: 9, color: rgb(0.3, 0.35, 0.4) })
  page.drawLine({ start: { x: MARGIN, y: hostSigY - 32 }, end: { x: MARGIN + 220, y: hostSigY - 32 }, thickness: 1, color: rgb(0.6, 0.65, 0.7) })
  page.drawText('Date:', { x: MARGIN + 260, y: hostSigY, font: fontBold, size: 9, color: rgb(0.3, 0.35, 0.4) })
  page.drawLine({ start: { x: MARGIN + 260, y: hostSigY - 32 }, end: { x: PAGE_WIDTH - MARGIN, y: hostSigY - 32 }, thickness: 1, color: rgb(0.6, 0.65, 0.7) })

  // Calculate normalized coordinates for fields
  // In AgreementField: x, y, width, height are fractions [0, 1] from TOP-LEFT.
  // Signature box dimensions in points: width 220, height 32
  // Date box dimensions in points: width 120, height 32
  const toNormalizedField = (
    signerKey: string,
    kind: 'signature' | 'date',
    ptX: number,
    ptYFromBottom: number,
    ptW: number,
    ptH: number,
  ): AgreementField => ({
    signer_key: signerKey,
    kind,
    page: pageIndex,
    x: Number((ptX / PAGE_WIDTH).toFixed(4)),
    y: Number(((PAGE_HEIGHT - (ptYFromBottom + ptH)) / PAGE_HEIGHT).toFixed(4)),
    width: Number((ptW / PAGE_WIDTH).toFixed(4)),
    height: Number((ptH / PAGE_HEIGHT).toFixed(4)),
  })

  const fields: AgreementField[] = [
    // Counterparty (signs first)
    toNormalizedField(options.counterpartyKey, 'signature', MARGIN, guestSigY - 30, 220, 30),
    toNormalizedField(options.counterpartyKey, 'date', MARGIN + 260, guestSigY - 30, 120, 30),
    // Host (signs last)
    toNormalizedField(options.hostKey, 'signature', MARGIN, hostSigY - 30, 220, 30),
    toNormalizedField(options.hostKey, 'date', MARGIN + 260, hostSigY - 30, 120, 30),
  ]

  const fileName = `${options.kind}-agreement.pdf`
  const bytes = await pdf.save()

  return { bytes, fileName, fields }
}
