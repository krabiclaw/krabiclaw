import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

const NOTO_FONTS = {
  latin: 'NotoSans-Regular.ttf',
  thai: 'NotoSansThai-Regular.ttf',
  jp: 'NotoSansJP-Regular.ttf',
  kr: 'NotoSansKR-Regular.ttf',
  sc: 'NotoSansSC-Regular.ttf',
  tc: 'NotoSansTC-Regular.ttf',
} as const

test('Noto fonts exist in public/fonts and load with fontkit', async () => {
  for (const [key, file] of Object.entries(NOTO_FONTS)) {
    const filePath = path.resolve(process.cwd(), 'public/fonts', file)
    const bytes = await fs.readFile(filePath)
    assert.ok(bytes.length > 0, `Font ${file} must have content`)
    const parsed = fontkit.create(bytes)
    assert.ok(parsed, `Fontkit must parse ${key} (${file})`)
  }
})

test('Stamping non-WinAnsi names (Vietnamese, Thai, Japanese) succeeds with subsetting', async () => {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)

  const [latinBytes, thaiBytes, jpBytes] = await Promise.all([
    fs.readFile(path.resolve(process.cwd(), 'public/fonts', NOTO_FONTS.latin)),
    fs.readFile(path.resolve(process.cwd(), 'public/fonts', NOTO_FONTS.thai)),
    fs.readFile(path.resolve(process.cwd(), 'public/fonts', NOTO_FONTS.jp)),
  ])

  const fontLatin = await pdf.embedFont(latinBytes, { subset: true })
  const fontThai = await pdf.embedFont(thaiBytes, { subset: true })
  const fontJP = await pdf.embedFont(jpBytes, { subset: true })
  const fontWinAnsi = await pdf.embedFont(StandardFonts.TimesRomanItalic)

  const page = pdf.addPage([612, 792])

  // Latin standard font
  page.drawText('John Doe', { x: 50, y: 700, size: 16, font: fontWinAnsi })

  // Vietnamese (Latin extended with tone marks)
  page.drawText('Nguyễn Văn An', { x: 50, y: 650, size: 16, font: fontLatin })

  // Thai
  page.drawText('สมชาย', { x: 50, y: 600, size: 16, font: fontThai })

  // Japanese
  page.drawText('山田太郎', { x: 50, y: 550, size: 16, font: fontJP })

  const saved = await pdf.save()
  assert.ok(saved.length > 0, 'PDF must save successfully')
  assert.ok(saved.length < 50000, `Subsetted PDF should be small, got ${saved.length} bytes`)
})
