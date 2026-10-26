import { FAQ_BLOCK_SOURCES } from '../shared/faq-block'
import { videoUploadDate, youTubeVideoId } from '../shared/youtube-video'
import { isSupportedMediaPlacement } from '../shared/media-placement-contract'
import { PLATFORM_LOCALES } from '../shared/platform-locales'

export const TENANT_PAGE_SCHEMA_VERSION = 1 as const

export type TenantPageBlockType =
  | 'heading'
  | 'markdown'
  | 'image'
  | 'gallery'
  | 'video'
  | 'faq'
  | 'how_to'
  | 'divider'
  | 'cta'
  | 'callout'
  | 'hero'
  | 'button_group'
  | 'feature_grid'
  | 'team_grid'
  | 'testimonial_grid'
  | 'contact_cta'
  | 'booking_cta'
  | 'donation_choices'
  | 'page_grid'
  | 'product_grid'
  | 'location_grid'
  | 'ai_assistance'
  | 'comparison'
  | 'stat_grid'
  | 'workflow_grid'
  | 'showcase'
  | 'language_reach'
  | 'steps'
  | 'video_feature'
  | 'media_text'
  | 'contact_form'
  | 'social_posts'

export type TenantPageType = 'custom' | 'recipe' | 'legal' | 'system'

export interface TenantPageBlock {
  source_block_id?: string | null
  parent_block_id?: string | null
  level?: number | null
  id: string
  type: TenantPageBlockType
  position: number
  data: Record<string, unknown>
  media: TenantPageMedia[]
}

export interface TenantPageHowToStep {
  name: string
  text?: string | null
}

export interface TenantPageHowToData extends Record<string, unknown> {
  title?: string | null
  description?: string | null
  estimated_time?: string | null
  tool_items?: string[]
  supply_items?: string[]
  steps: TenantPageHowToStep[]
}

export interface TenantPageMedia {
  asset_id: string
  slot: string
  sort_order?: number
  public_url?: string | null
  thumbnail_url?: string | null
  kind?: string | null
  alt_text?: string | null
  // What names the asset when it has no alt text — the same label the media
  // endpoint would have supplied, so a picker reading this summary shows what it
  // would have shown after fetching.
  file_name?: string | null
  width?: number | null
  height?: number | null
}

export interface TenantPageSnapshotMetadata {
  locale: string
  path: string
  title: string
  summary: string | null
  pageType: TenantPageType
  recipe: string | null
}

export interface TenantPageSnapshot {
  schemaVersion: typeof TENANT_PAGE_SCHEMA_VERSION
  metadata: TenantPageSnapshotMetadata
  blocks: TenantPageBlock[]
}

/**
 * One field a block stores, described well enough that every surface can be
 * derived from it rather than repeating it.
 *
 * `fields` used to be a list of bare names that nothing read, while the editor's
 * controls, the writer's allow-list, the MCP description and the translatable
 * paths were four more hand-written lists of the same thing. They disagreed:
 * donation tiers were declared at a key nothing writes, so a tier's words could
 * never be translated, and a feature row's Value and Icon were invisible to
 * localization for the same reason. Describing a field once fixes all of them at
 * once, and makes the disagreement unrepresentable.
 */
export interface TenantPageField {
  kind: 'text' | 'markdown' | 'url' | 'enum' | 'media' | 'reference' | 'list' | 'calculator' | 'number' | 'record'
  label: string
  required?: boolean
  /** Long-form prose; a single-line control is wrong for it. */
  multiline?: boolean
  /** Text is translated unless it is a machine value — a url, an icon, an enum. */
  translatable?: boolean
  options?: readonly { value: string; label: string; platformOnly?: boolean }[]
  /** A list's item shape, or a record's fields. Absent means a list of plain strings. */
  of?: Readonly<Record<string, TenantPageField>>
  /** A number's lower bound, or a required list's minimum item count. */
  min?: number
  /** A number's upper bound. */
  max?: number
  /** Which canonical record a reference selects. */
  reference?: 'page' | 'product' | 'collection' | 'location'
  /** The media placement slot this field's asset occupies. */
  slot?: string
  /** What the picker offers for a media field. Images unless the field says otherwise. */
  accept?: 'image' | 'video' | 'any'
  /**
   * `level` writes the block's own column, not its data. The heading level
   * control wrote `data.level`, which the writer deletes and no renderer reads,
   * so choosing a level did nothing at all.
   */
  store?: 'data' | 'level'
  /** Which editor leaf shows this field. */
  section?: string
  /** A field that is meaningless without its partner — a label with no url. */
  pairedWith?: string
  /** Shown only when another field holds one of these values. */
  availableWhen?: { field: string; equals: readonly string[] }
  default?: string
}

export interface TenantPageBlockDefinition {
  type: TenantPageBlockType
  label: string
  /** The section type pictogram in the CMS list and picker. */
  icon: string
  description: string
  schemaVersion: typeof TENANT_PAGE_SCHEMA_VERSION
  allowedRecipes: readonly string[]
  allowedPageTypes: readonly TenantPageType[]
  fields: Readonly<Record<string, TenantPageField>>
  accessibility: 'required' | 'inherited'
  seo: 'structured' | 'inherited' | 'none'
}

export const SOCIAL_POSTS_BLOCK_MAX = 12
export const SOCIAL_POSTS_BLOCK_DEFAULT = 6

const ALL_RECIPES = [
  'custom', 'about', 'pricing', 'donate', 'legal', 'contact', 'schedule', 'home',
  'services', 'privacy', 'terms', 'third-party-notices', 'locations', 'menu', 'order',
  'products', 'reservations', 'qa', 'reviews', 'posts', 'photos', 'blog',
] as const

export const TENANT_PAGE_RECIPE_REGISTRY = new Set<string>(ALL_RECIPES)
export const TENANT_PAGE_TYPES: readonly TenantPageType[] = ['custom', 'recipe', 'legal', 'system']

const text = (label: string, extra: Partial<TenantPageField> = {}): TenantPageField => ({ kind: 'text', label, section: 'copy', ...extra })
const prose = (label: string, extra: Partial<TenantPageField> = {}): TenantPageField => ({ kind: 'text', label, multiline: true, section: 'copy', ...extra })
const link = (label: string, extra: Partial<TenantPageField> = {}): TenantPageField => ({ kind: 'url', label, translatable: false, section: 'button', ...extra })

// Product captures retain their original file; the page owns the visible crop.
const PRODUCT_IMAGE_FIELDS = {
  image_ratio: { kind: 'enum', label: 'Image proportions', translatable: false, section: 'image_display', options: [
    { value: 'original', label: 'Original' }, { value: 'portrait', label: 'Portrait (4:5)' },
    { value: 'square', label: 'Square' }, { value: 'landscape', label: 'Landscape (6:5)' },
  ] },
  image_position: { kind: 'enum', label: 'Image focus', translatable: false, section: 'image_display', options: [
    { value: 'top', label: 'Top' }, { value: 'center', label: 'Centre' }, { value: 'bottom', label: 'Bottom' },
  ] },
} as const

/** A call to action is one prompt and one button, and the button needs both halves. */
const CTA_FIELDS = {
  layout: { kind: 'enum', label: 'Layout', translatable: false, section: 'settings', options: [
    { value: 'centered', label: 'Centred' }, { value: 'compact', label: 'Compact', platformOnly: true },
  ] },
  title: text('Title'),
  accent: text('Emphasised phrase'),
  description: prose('Description'),
  label: text('Button label', { section: 'button', pairedWith: 'url' }),
  url: link('Button URL', { pairedWith: 'label' }),
  // A second button, which four platform prompts already carry and no list
  // declared, so it could be written and never translated or validated.
  secondary_label: text('Second button label', { section: 'second_button', pairedWith: 'secondary_url' }),
  secondary_url: link('Second button URL', { section: 'second_button', pairedWith: 'secondary_label' }),
  // The prompt's picture behind its words, and an optional cut-out beside them.
  media: { kind: 'media', label: 'Background image', translatable: false, section: 'image', slot: 'media' },
  featured: { kind: 'media', label: 'Featured image', translatable: false, section: 'image', slot: 'featured' },
} as const

const GRID_ITEM_FIELDS = {
  title: text('Title', { required: true }),
  description: prose('Description'),
  // A card whose words are a list of links — a firm's contact methods — needs
  // rich text, not a paragraph. It was stored as `cardsContent` on a block
  // calling itself a contact CTA, which is why one page held two of those and
  // nothing could tell them apart.
  body: { kind: 'markdown', label: 'Rich text', section: 'copy' } as TenantPageField,
  // Declared because the item editor writes them. They were in no field list,
  // so a feature row's headline number and icon could never be translated or
  // validated.
  value: text('Value'),
  icon: { kind: 'enum', label: 'Icon', translatable: false, section: 'icon' } as TenantPageField,
  media: { kind: 'media', label: 'Image', translatable: false, section: 'image', slot: 'image' } as TenantPageField,
  label: text('Link label', { section: 'link', pairedWith: 'url' }),
  url: link('Link URL', { section: 'link', pairedWith: 'label' }),
} as const

export const TENANT_PAGE_BLOCK_REGISTRY: Record<TenantPageBlockType, TenantPageBlockDefinition> = {
  heading: blockDefinitionWithMetadata('heading', 'Heading', 'i-lucide-heading', 'A heading a visitor reads.', ALL_RECIPES, {
    text: text('Heading text', { required: true, section: 'content' }),
    // Writes the block's own column. See TenantPageField.store.
    level: {
      kind: 'enum', label: 'Level', translatable: false, section: 'content', store: 'level', default: '2',
      options: [1, 2, 3, 4, 5, 6].map(n => ({ value: String(n), label: `H${n}` })),
    },
  }, { accessibility: 'required', seo: 'structured' }),

  markdown: blockDefinitionWithMetadata('markdown', 'Text', 'i-lucide-text', 'Paragraphs, lists and links.', ALL_RECIPES, {
    title: text('Title'),
    markdown: { kind: 'markdown', label: 'Text', required: true, section: 'content' },
    // The writer requires this; it was declared nowhere, so nothing could tell
    // an author or an assistant that a text block must name its editor mode.
    editor_mode: {
      kind: 'enum', label: 'Editor', required: true, translatable: false, section: 'content', default: 'rich',
      options: [{ value: 'rich', label: 'Rich text' }, { value: 'source', label: 'Markdown source' }],
    },
  }, { accessibility: 'required', seo: 'inherited' }),

  image: blockDefinitionWithMetadata('image', 'Image', 'i-lucide-image', 'One picture.', ALL_RECIPES, {
    media: { kind: 'media', label: 'Image', translatable: false, section: 'content', slot: 'media' },
    caption: text('Caption', { section: 'content' }),
  }),

  gallery: blockDefinitionWithMetadata('gallery', 'Gallery', 'i-lucide-images', 'Pictures in an order you choose.', ALL_RECIPES, {
    media: { kind: 'media', label: 'Images', translatable: false, section: 'content', slot: 'gallery' },
    caption: text('Caption', { section: 'content' }),
  }),

  // A YouTube video, embedded. Its url may be any address YouTube gives out;
  // the upload date is what lets the page describe it to search engines.
  video: blockDefinitionWithMetadata('video', 'Video', 'i-lucide-video', 'A YouTube video.', ALL_RECIPES, {
    url: link('YouTube URL', { required: true, section: 'content' }),
    title: text('Video title', { required: true, section: 'content' }),
    caption: text('Caption', { section: 'content' }),
    upload_date: { kind: 'text', label: 'Upload date (YYYY-MM-DD)', translatable: false, section: 'search' },
  }, { accessibility: 'required', seo: 'structured' }),

  faq: blockDefinitionWithMetadata('faq', 'Questions & answers', 'i-lucide-messages-square', 'The questions published for this page or site.', ALL_RECIPES, {
    title: text('Title', { section: 'settings' }),
    source: {
      kind: 'enum', label: 'Questions', required: true, translatable: false, section: 'settings', default: 'page_qa',
      options: [{ value: 'page_qa', label: "This page's questions" }, { value: 'organization_qa', label: "The site's questions" }],
    },
  }, { accessibility: 'required', seo: 'structured' }),

  how_to: blockDefinitionWithMetadata('how_to', 'How-to', 'i-lucide-list-ordered', 'Steps in order.', ALL_RECIPES, {
    title: text('Title', { section: 'settings' }),
    description: prose('Introduction', { section: 'copy' }),
    label: text('Label', { section: 'settings' }),
    estimated_time: text('Estimated time', { section: 'settings' }),
    // Their own leaf: settings held five controls, and DESIGN.md's answer to a
    // form that grows is another level, never a tighter one.
    tool_items: { kind: 'list', label: 'Tools', section: 'materials' },
    supply_items: { kind: 'list', label: 'Supplies', section: 'materials' },
    steps: {
      kind: 'list', label: 'Steps', required: true, min: 1, section: 'steps',
      of: { name: text('Name', { required: true }), text: prose('Text') },
    },
  }, { accessibility: 'required', seo: 'structured' }),

  // After a hero, a divider closes the hero section with the shield; elsewhere it is a plain break.
  divider: blockDefinitionWithMetadata('divider', 'Divider', 'i-lucide-minus', 'A break between sections.', ALL_RECIPES, {},
    { accessibility: 'inherited', seo: 'none' }),

  cta: blockDefinitionWithMetadata('cta', 'Call to action', 'i-lucide-mouse-pointer-click', 'A prompt with one button.', ALL_RECIPES, CTA_FIELDS),
  contact_cta: blockDefinitionWithMetadata('contact_cta', 'Contact prompt', 'i-lucide-phone', 'A prompt to get in touch.', ALL_RECIPES, CTA_FIELDS),
  // A booking prompt says what it costs and what the visitor is agreeing to.
  // Both were stored and read as `priceLine` and `notice`, which no list
  // declared, so neither could be translated — and the button was a second
  // naming of the one every other prompt uses.
  booking_cta: blockDefinitionWithMetadata('booking_cta', 'Booking prompt', 'i-lucide-calendar-check', 'A prompt to book.', ALL_RECIPES, {
    ...CTA_FIELDS,
    price_line: text('Price line', { section: 'settings' }),
    notice: prose('Small print', { section: 'settings' }),
  }),

  callout: blockDefinitionWithMetadata('callout', 'Callout', 'i-lucide-message-square-text', 'A highlighted message.', ALL_RECIPES, {
    title: text('Title'),
    body: prose('Message'),
    items: { kind: 'list', label: 'Supporting facts', section: 'items', of: GRID_ITEM_FIELDS },
    tone: {
      kind: 'enum', label: 'Tone', translatable: false, section: 'copy', default: 'neutral',
      options: ['neutral', 'info', 'success', 'warning', 'danger'].map(value => ({ value, label: value.replace(/^\w/, c => c.toUpperCase()) })),
    },
    // The word on the panel a callout draws beside its message — "Example",
    // "Saya Theme". Five platform callouts already carried it and no list
    // declared it, so it could be written and never translated.
    badge: text('Badge', { section: 'settings' }),
    buttons: { kind: 'list', label: 'Buttons', section: 'buttons', of: { label: text('Label', { required: true }), url: link('URL') } },
  }),

  hero: blockDefinitionWithMetadata('hero', 'Hero', 'i-lucide-panels-top-left', 'The opening of a page.', ALL_RECIPES, {
    // The headline and the phrase inside it that carries emphasis; the rest of
    // the opening words are their own concern, because four controls is not a
    // leaf (DESIGN.md).
    title: text('Headline', { required: true, section: 'headline' }),
    accent: text('Emphasised phrase', { section: 'headline' }),
    // Phrases that take turns as the headline's closing line, one at a time.
    rotating_accents: { kind: 'list', label: 'Rotating closing phrases', section: 'headline' },
    eyebrow: text('Eyebrow'),
    subtitle: prose('Subheading'),
    media: { kind: 'media', label: 'Image or video', translatable: false, section: 'image', slot: 'media', accept: 'any' },
    featured: { kind: 'media', label: 'Product image', translatable: false, section: 'featured', slot: 'featured' },
    caption: text('Product image caption', { section: 'featured' }),
    ...PRODUCT_IMAGE_FIELDS,
    cta_label: text('Button label', { section: 'button', pairedWith: 'cta_url' }),
    cta_url: link('Button URL', { pairedWith: 'cta_label' }),
    // A second button, which eight platform heroes already carry and no list
    // declared, so it could be written and never translated or validated.
    secondary_label: text('Second button label', { section: 'second_button', pairedWith: 'secondary_url' }),
    secondary_url: link('Second button URL', { section: 'second_button', pairedWith: 'secondary_label' }),
  }, { accessibility: 'required', seo: 'structured' }),

  button_group: blockDefinitionWithMetadata('button_group', 'Buttons', 'i-lucide-mouse-pointer-click', 'A row of links.', ALL_RECIPES, {
    layout: { kind: 'enum', label: 'Layout', translatable: false, section: 'settings', options: [
      { value: 'buttons', label: 'Buttons' }, { value: 'links', label: 'Open links', platformOnly: true },
    ] },
    buttons: { kind: 'list', label: 'Buttons', section: 'buttons', of: { label: text('Label', { required: true }), url: link('URL') } },
  }),

  feature_grid: blockDefinitionWithMetadata('feature_grid', 'Features', 'i-lucide-layout-grid', 'A grid you write, or rows read from your site.', ALL_RECIPES, {
    title: text('Section title', { section: 'headline' }),
    title_muted: text('Closing title', { section: 'headline' }),
    eyebrow: text('Eyebrow', { section: 'copy' }),
    description: prose('Description', { section: 'copy' }),
    source: {
      kind: 'enum', label: 'Rows', translatable: false, section: 'settings', default: 'manual',
      options: [
        { value: 'manual', label: 'Items I write' },
        { value: 'organization_posts', label: 'Published articles' },
        { value: 'calculator', label: 'Pricing calculator' },
        { value: 'billing_plans', label: 'KrabiClaw plans', platformOnly: true },
        { value: 'billing_features', label: 'KrabiClaw plan capabilities', platformOnly: true },
      ],
    },
    items: { kind: 'list', label: 'Items', section: 'items', of: GRID_ITEM_FIELDS, availableWhen: { field: 'source', equals: ['manual'] } },
    limit: { kind: 'number', label: 'Article count', translatable: false, section: 'settings', min: 1, availableWhen: { field: 'source', equals: ['organization_posts'] } },
    // How KrabiClaw's own pages draw written items: as icon cards, or as
    // pictures with their words beneath.
    layout: {
      kind: 'enum', label: 'Layout', translatable: false, section: 'settings', default: 'cards',
      availableWhen: { field: 'source', equals: ['manual'] },
      options: [
        { value: 'cards', label: 'Cards' },
        { value: 'pictures', label: 'Pictures', platformOnly: true },
        { value: 'columns', label: 'Open columns', platformOnly: true },
        { value: 'strip', label: 'Compact strip', platformOnly: true },
      ],
    },
    calculator: { kind: 'calculator', label: 'Calculator', translatable: false, section: 'calculator', availableWhen: { field: 'source', equals: ['calculator'] } },
    // The one button a practice area's feature list carries over its picture.
    // Declared here so the firm writes its words and its destination, the way
    // every other button on a page is written, rather than a template holding
    // an English label and a route no one can change.
    cta_label: text('Button label', { section: 'button', pairedWith: 'cta_url' }),
    cta_url: link('Button URL', { section: 'button', pairedWith: 'cta_label' }),
  }),

  // A comparison is one editorial thing — this without us, this with us — held
  // in one block. It was two feature_grids that only a `section` of
  // "comparison-against" and "comparison-for" told apart, so the document was
  // naming the component that drew it.
  comparison: blockDefinitionWithMetadata('comparison', 'Comparison', 'i-lucide-columns-2', 'Two sides, set against each other.', ALL_RECIPES, {
    title: text('Section title', { section: 'settings' }),
    description: prose('Description', { section: 'settings' }),
    problem_title: text('Without heading', { section: 'without' }),
    problem_label: text('Without label', { section: 'without' }),
    problem_items: {
      kind: 'list', label: 'Without', section: 'problem_items',
      of: { title: text('Title', { required: true }), description: prose('Description') },
    },
    solution_title: text('With heading', { section: 'with' }),
    solution_label: text('With label', { section: 'with' }),
    solution_items: {
      kind: 'list', label: 'With', section: 'solution_items',
      of: { title: text('Title', { required: true }), description: prose('Description') },
    },
  }),

  // Numbers with what they count. Items are a value and its label, which is a
  // different thing from a feature's title and its prose.
  stat_grid: blockDefinitionWithMetadata('stat_grid', 'Stats', 'i-lucide-chart-no-axes-column-increasing', 'Figures and what they measure.', ALL_RECIPES, {
    title: text('Section title', { section: 'settings' }),
    description: prose('Description', { section: 'settings' }),
    label: text('Label', { section: 'settings' }),
    items: {
      kind: 'list', label: 'Stats', section: 'items',
      of: { value: text('Figure', { required: true }), title: text('What it measures', { required: true }) },
    },
  }),

  // Something the reader can ask an assistant to do, and what happens when they
  // do. The prompt is the content; a feature grid has nothing like it.
  workflow_grid: blockDefinitionWithMetadata('workflow_grid', 'Workflows', 'i-lucide-workflow', 'Things to ask for, and what they do.', ALL_RECIPES, {
    title: text('Section title', { section: 'settings' }),
    description: prose('Description', { section: 'settings' }),
    label: text('Label', { section: 'settings' }),
    prompt_heading: text('Prompt heading', { section: 'prompts' }),
    cta_label: text('Link label', { section: 'link', pairedWith: 'cta_url' }),
    cta_url: link('Link URL', { section: 'link', pairedWith: 'cta_label' }),
    items: {
      kind: 'list', label: 'Workflows', section: 'items',
      of: {
        title: text('Title', { required: true }),
        prompt: prose('What to ask'),
        description: prose('What happens'),
        icon: { kind: 'enum', label: 'Icon', translatable: false, section: 'icon' },
      },
    },
  }),

  // Statements that take turns, each shown by its own three pictures: a wide
  // one, a tall one and a wide one. The pictures are the block's placements at
  // `items.<index>.left`, `.center` and `.right`.
  showcase: blockDefinitionWithMetadata('showcase', 'Showcase', 'i-lucide-gallery-horizontal-end', 'Statements that take turns, each with three pictures.', ALL_RECIPES, {
    items: {
      kind: 'list', label: 'Statements', section: 'items',
      of: {
        title: text('Statement', { required: true }),
        left: { kind: 'media', label: 'Left picture (wide)', translatable: false, section: 'pictures', slot: 'left' },
        center: { kind: 'media', label: 'Middle picture (tall)', translatable: false, section: 'pictures', slot: 'center' },
        right: { kind: 'media', label: 'Right picture (wide)', translatable: false, section: 'pictures', slot: 'right' },
      },
    },
  }),

  // The languages a site is read in, each with a picture of the site in it and
  // the places its readers find it. A language's picture is the block's
  // placement at `items.<index>.image`.
  language_reach: blockDefinitionWithMetadata('language_reach', 'Languages', 'i-lucide-languages', 'The languages your site speaks, and where each is found.', ALL_RECIPES, {
    title: text('Section title', { section: 'copy' }),
    subtitle: text('Card title', { section: 'copy' }),
    description: prose('Description', { section: 'copy' }),
    pin_label: text('Map marker label', { section: 'settings' }),
    items: {
      kind: 'list', label: 'Languages', section: 'items',
      of: {
        title: text('Language name', { required: true }),
        locale: {
          kind: 'enum', label: 'Language', translatable: false, required: true,
          options: PLATFORM_LOCALES.map(({ locale }) => ({ value: locale, label: new Intl.DisplayNames('en', { type: 'language' }).of(locale)! })),
        },
        image: { kind: 'media', label: 'Picture of the site in this language', translatable: false, section: 'image', slot: 'image' },
      },
    },
  }),

  // Numbered steps, each a link to where it is explained, beside two pictures
  // and one button. The pictures are the block's ordered `gallery` placement.
  steps: blockDefinitionWithMetadata('steps', 'Steps', 'i-lucide-list-ordered', 'Numbered steps that link to how each is done.', ALL_RECIPES, {
    title: text('Section title', { section: 'settings' }),
    gallery: { kind: 'media', label: 'Pictures', translatable: false, section: 'pictures', slot: 'gallery' },
    items: {
      kind: 'list', label: 'Steps', section: 'items',
      of: { title: text('Step', { required: true }), url: link('Link', { section: 'copy' }) },
    },
    cta_label: text('Button label', { section: 'button', pairedWith: 'cta_url' }),
    cta_url: link('Button URL', { section: 'button', pairedWith: 'cta_label' }),
  }),

  // A video with the points it makes.
  video_feature: blockDefinitionWithMetadata('video_feature', 'Video', 'i-lucide-clapperboard', 'A video and what it shows.', ALL_RECIPES, {
    title: text('Section title', { section: 'settings' }),
    description: prose('Description', { section: 'settings' }),
    video_title: text('Video title', { section: 'video' }),
    video_url: link('YouTube URL', { section: 'video' }),
    upload_date: { kind: 'text', label: 'Upload date (YYYY-MM-DD)', translatable: false, section: 'video' },
    items: {
      kind: 'list', label: 'Points', section: 'items',
      of: { title: text('Title', { required: true }), description: prose('Description') },
    },
  }),

  // A picture and the words beside it — "Media & Text" in WordPress, "Image
  // with text" in Shopify. It exists because a brand story is one editorial
  // thing and was stored as three unrelated blocks (`story.title`,
  // `story.image`, `story.body`) that the renderer re-assembled at display
  // time, in the alphabetical order the migration wrote them.
  media_text: blockDefinitionWithMetadata('media_text', 'Image with text', 'i-lucide-panels-top-left', 'A picture and the words beside it.', ALL_RECIPES, {
    layout: { kind: 'enum', label: 'Layout', translatable: false, section: 'settings', options: [
      { value: 'standard', label: 'Standard' }, { value: 'editorial', label: 'Editorial', platformOnly: true },
    ] },
    tone: { kind: 'enum', label: 'Background', translatable: false, section: 'settings', options: [
      { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' },
    ] },
    ...PRODUCT_IMAGE_FIELDS,
    title: text('Title'),
    body: prose('Text'),
    media: { kind: 'media', label: 'Image or video', translatable: false, section: 'image', slot: 'media', accept: 'any' },
    label: text('Link label', { section: 'link', pairedWith: 'url' }),
    url: link('Link URL', { section: 'link', pairedWith: 'label' }),
    eyebrow: text('Product name'),
    caption: text('Example caption', { section: 'examples' }),
    example_type: { kind: 'enum', label: 'Example type', translatable: false, section: 'examples', options: [
      { value: 'websites', label: 'Website examples' },
      { value: 'posts', label: 'Photos and posts' },
      { value: 'app_screens', label: 'App screenshots' },
    ] },
    items: { kind: 'list', label: 'Details & examples', section: 'items', of: {
      title: text('Title', { required: true }),
      description: prose('Description'),
      image: { kind: 'media', label: 'Picture', translatable: false, slot: 'image' },
    } },
  }),

  // The form a visitor writes in. It has no fields of its own — what it asks
  // for is the site's contact form — but it is a block so that a page says
  // where on it the form sits, which was fixed in the markup before.
  contact_form: blockDefinitionWithMetadata('contact_form', 'Contact form', 'i-lucide-mail', 'A form a visitor writes in.', ['contact', 'custom'], {},
    { accessibility: 'inherited', seo: 'none' }),

  team_grid: blockDefinitionWithMetadata('team_grid', 'Team', 'i-lucide-users', 'The people behind the business.', ALL_RECIPES, {
    title: text('Section title', { section: 'settings' }),
    description: prose('Description', { section: 'settings' }),
    items: {
      kind: 'list', label: 'People', section: 'items',
      of: {
        // A person's own name is translated too: a Japanese or Thai site writes
        // it in its own script rather than transliterating at read time.
        first_name: text('First name', { required: true }),
        last_name: text('Last name'),
        title: text('Role'),
        bio: prose('Bio'),
        media: { kind: 'media', label: 'Photo', translatable: false, section: 'image', slot: 'image' },
      },
    },
  }),

  testimonial_grid: blockDefinitionWithMetadata('testimonial_grid', 'Reviews', 'i-lucide-quote', "The site's published reviews.", ALL_RECIPES, {
    title: text('Section title', { section: 'settings' }),
    description: prose('Description', { section: 'settings' }),
  }),

  donation_choices: blockDefinitionWithMetadata('donation_choices', 'Donation amounts', 'i-lucide-hand-heart', 'The amounts a donor may choose.', ['donate'], {
    title: text('Title'),
    description: prose('Description'),
    destination: link('Destination', { section: 'destination' }),
    tiers: {
      kind: 'list', label: 'Amounts', section: 'tiers',
      // The editor writes amount/title/description. The old declaration named a
      // `label` key that nothing writes, so no tier was ever translatable.
      of: {
        amount: { kind: 'text', label: 'Amount', translatable: false, section: 'copy' },
        title: text('Title', { required: true }),
        description: prose('Description'),
      },
    },
    // A donate page is a recipe the template guarantees, and NCLS's is stored
    // as a `system` page like every other recipe page on that site. Restricting
    // this block to `recipe` pages made that page unsaveable: the writer
    // validates every block on write, so the whole document was refused. The
    // recipe list above is the gate that matters.
  }, { allowedPageTypes: ['custom', 'recipe', 'system'] }),

  page_grid: blockDefinitionWithMetadata('page_grid', 'Pages', 'i-lucide-files', 'Cards linking to other pages.', ['home', 'about', 'pricing', 'custom', 'services'], {
    title: text('Section title', { section: 'settings' }),
    accent: text('Emphasised phrase', { section: 'settings' }),
    description: prose('Description', { section: 'settings' }),
    page_ids: { kind: 'reference', label: 'Pages', required: true, min: 1, translatable: false, section: 'pages', reference: 'page' },
  }, { allowedPageTypes: ['custom', 'recipe', 'system'] }),

  product_grid: blockDefinitionWithMetadata('product_grid', 'Products', 'i-lucide-package', 'Cards linking to products.', ['home', 'about', 'pricing', 'custom', 'services', 'menu', 'order', 'products'], {
    title: text('Section title', { section: 'settings' }),
    description: prose('Description', { section: 'settings' }),
    collection_id: { kind: 'reference', label: 'Collection', translatable: false, section: 'products', reference: 'collection' },
    product_ids: { kind: 'reference', label: 'Products', translatable: false, section: 'products', reference: 'product' },
  }, { allowedPageTypes: ['custom', 'recipe', 'system'] }),

  location_grid: blockDefinitionWithMetadata('location_grid', 'Locations', 'i-lucide-map-pin', 'Cards linking to locations.', ['home', 'about', 'contact', 'custom'], {
    title: text('Section title', { section: 'settings' }),
    description: prose('Description', { section: 'settings' }),
    location_ids: { kind: 'reference', label: 'Locations', translatable: false, section: 'locations', reference: 'location' },
  }, { allowedPageTypes: ['custom', 'recipe', 'system'] }),

  // The organization's short posts, read from the same feed /posts shows. The
  // block holds what the author chose — its heading, how many, which location,
  // an optional button — and never a copy of a post.
  social_posts: blockDefinitionWithMetadata('social_posts', 'Social posts', 'i-lucide-megaphone', 'The latest short posts, with their photos, dates and where else they were posted.', ALL_RECIPES, {
    title: text('Section title', { section: 'settings' }),
    description: prose('Description', { section: 'settings' }),
    limit: { kind: 'number', label: 'How many posts', translatable: false, section: 'posts', min: 1, max: SOCIAL_POSTS_BLOCK_MAX, default: String(SOCIAL_POSTS_BLOCK_DEFAULT) },
    location_id: { kind: 'reference', label: 'Location', translatable: false, section: 'posts', reference: 'location' },
    call_to_action: {
      kind: 'record', label: 'Button', section: 'button',
      of: { label: text('Button label', { section: 'button', pairedWith: 'url' }), url: link('Button URL', { pairedWith: 'label' }) },
    },
  }),

  // An article block, not a page block: it is registered so that one list of
  // block types is the only list, and refused on every page by holding no
  // recipe and no page type. Before this it existed only in the server's own
  // type list, so a page carrying one threw "not registered" on read instead of
  // being refused on write.
  ai_assistance: blockDefinitionWithMetadata('ai_assistance', 'Ask AI', 'i-lucide-sparkles', 'Suggested prompts for an assistant.', [], {
    label: text('Label', { section: 'settings' }),
    intro: prose('Intro', { section: 'settings' }),
    prompts: {
      kind: 'list', label: 'Prompts', section: 'items',
      of: {
        title: text('Title', { required: true }),
        prompt: prose('Prompt'),
        description: prose('Description'),
        copy_label: text('Copy button label'),
      },
    },
  }, { allowedPageTypes: [] }),
}

const BLOCK_TYPES = new Set(Object.keys(TENANT_PAGE_BLOCK_REGISTRY))
const EMBEDDED_MEDIA_FIELDS = new Set(['asset_id', 'asset_ids', 'image_url', 'public_url', 'thumbnail_url', 'media'])

export function assertNoEmbeddedMediaFields(value: unknown, path = 'data'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEmbeddedMediaFields(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (EMBEDDED_MEDIA_FIELDS.has(key)) throw new Error(`${path}.${key} must use the block media array.`)
    assertNoEmbeddedMediaFields(item, `${path}.${key}`)
  }
}

export function isTenantPageBlockAllowed(
  definitionOrType: TenantPageBlockDefinition | TenantPageBlockType,
  recipe: string | null | undefined,
  pageType: TenantPageType,
): boolean {
  const definition = typeof definitionOrType === 'string'
    ? TENANT_PAGE_BLOCK_REGISTRY[definitionOrType]
    : definitionOrType
  const normalizedRecipe = recipe?.trim().toLowerCase() || 'custom'
  return Boolean(definition)
    && definition.allowedRecipes.includes(normalizedRecipe)
    && definition.allowedPageTypes.includes(pageType)
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object.')
  return value as Record<string, unknown>
}

function asString(value: unknown, label: string, required = false): string | null {
  if (value == null || value === '') {
    if (required) throw new Error(label + ' is required.')
    return null
  }
  if (typeof value !== 'string') throw new Error(label + ' must be a string.')
  return value.trim()
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function blockDefinitionWithMetadata(
  type: TenantPageBlockType,
  label: string,
  icon: string,
  description: string,
  allowedRecipes: readonly string[],
  fields: Readonly<Record<string, TenantPageField>>,
  options: Partial<Pick<TenantPageBlockDefinition, 'accessibility' | 'seo' | 'allowedPageTypes'>> = {},
): TenantPageBlockDefinition {
  return {
    type,
    label,
    icon,
    description,
    schemaVersion: TENANT_PAGE_SCHEMA_VERSION,
    allowedRecipes,
    allowedPageTypes: options.allowedPageTypes ?? TENANT_PAGE_TYPES,
    fields,
    accessibility: options.accessibility ?? 'required',
    seo: options.seo ?? 'inherited',
  }
}


export function validateContentBlockData(type: string, data: Record<string, unknown>): Record<string, unknown> {
  const fields = TENANT_PAGE_BLOCK_REGISTRY[type as TenantPageBlockType]?.fields
  if (!fields) throw new Error(`Block type ${type} is not registered.`)
  for (const key of Object.keys(data)) {
    const field = fields[key]
    if (!field || field.kind === 'media' || field.store === 'level') throw new Error(`${type}.${key} is not a stored field.`)
  }
  assertNoEmbeddedMediaFields(data, type)
  for (const [key, field] of Object.entries(fields)) {
    const value = data[key]
    if (value === undefined && !field.required) continue
    if (['text', 'markdown', 'url', 'enum'].includes(field.kind) && value !== undefined && value !== null && typeof value !== 'string') {
      throw new Error(`${type}.${key} must be a string.`)
    }
    if (field.kind === 'reference') {
      if (key.endsWith('_ids')) {
        if (field.required && (!Array.isArray(value) || value.length < (field.min ?? 1))) throw new Error(`${type}.${key} requires at least ${field.min ?? 1} item.`)
        if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim()))) throw new Error(`${type}.${key} must be an array of non-empty strings.`)
      } else if (value !== undefined && value !== null && typeof value !== 'string') throw new Error(`${type}.${key} must be a string.`)
    }
    if (field.kind !== 'list') continue
    if (field.required && (!Array.isArray(value) || value.length < (field.min ?? 1))) throw new Error(`${type}.${key} requires at least ${field.min ?? 1} item.`)
    if (!Array.isArray(value)) throw new Error(`${type}.${key} must be an array.`)
    if (!field.of) {
      if (value.some(item => typeof item !== 'string')) throw new Error(`${type}.${key} must be an array of strings.`)
      continue
    }
    if (value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error(`${type}.${key} must be an array of objects.`)
    for (const [index, item] of (value as Record<string, unknown>[]).entries()) {
      for (const [itemKey, itemField] of Object.entries(field.of)) {
        const itemValue = item[itemKey]
        if (itemField.required && (typeof itemValue !== 'string' || !itemValue.trim())) throw new Error(`${type}.${key}[${index}].${itemKey} is required.`)
        if (itemValue !== undefined && itemValue !== null && ['text', 'markdown', 'url', 'enum'].includes(itemField.kind) && typeof itemValue !== 'string') {
          throw new Error(`${type}.${key}[${index}].${itemKey} must be a string.`)
        }
        if (itemField.kind === 'enum' && itemField.options && !itemField.options.some(option => option.value === itemValue)) {
          throw new Error(`${type}.${key}[${index}].${itemKey} must be one of: ${itemField.options.map(option => option.value).join(', ')}.`)
        }
      }
    }
  }
  // These blocks select canonical read-only records; they never store copies.
  // A testimonial grid has no source to choose — reviews are the site's reviews —
  // so it declares no `source` field. The editor used to offer "Items I write"
  // for it, which the writer refused: an editing surface for data it rejected.
  if (type === 'faq' || type === 'testimonial_grid') {
    if (data.items !== undefined) throw new Error(`${type}.items is not stored; Q&A and reviews are read-only records.`)
    if (type === 'faq' && !FAQ_BLOCK_SOURCES.some(source => source === data.source)) throw new Error('faq.source must select page_qa or organization_qa.')
  }
  if (type === 'social_posts') {
    // A new block shows six; a stored one keeps the number it was given.
    if (data.limit === undefined) data = { ...data, limit: SOCIAL_POSTS_BLOCK_DEFAULT }
    // An empty location choice is the organization-wide feed; so is an empty button.
    if (data.location_id === '') { const { location_id: _none, ...rest } = data; data = rest }
    if (data.call_to_action === null) { const { call_to_action: _none, ...rest } = data; data = rest }
    const unknown = Object.keys(data).find(key => !['title', 'description', 'limit', 'location_id', 'call_to_action'].includes(key))
    if (unknown) throw new Error(`social_posts.${unknown} is not stored; the posts are read from the organization's feed.`)
    if (!Number.isInteger(data.limit) || (data.limit as number) < 1 || (data.limit as number) > SOCIAL_POSTS_BLOCK_MAX) {
      throw new Error(`social_posts.limit must be a whole number from 1 to ${SOCIAL_POSTS_BLOCK_MAX}.`)
    }
    if (data.location_id !== undefined && data.location_id !== null && (typeof data.location_id !== 'string' || !data.location_id.trim())) {
      throw new Error('social_posts.location_id must be a location id or null.')
    }
    if (data.call_to_action !== undefined && data.call_to_action !== null) {
      const action = data.call_to_action as Record<string, unknown>
      if (!action || typeof action !== 'object' || Array.isArray(action) || Object.keys(action).some(key => key !== 'label' && key !== 'url')
        || typeof action.label !== 'string' || !action.label.trim() || typeof action.url !== 'string' || !action.url.trim()) {
        throw new Error('social_posts.call_to_action must carry a label and a url.')
      }
    }
  }
  if (type === 'video') {
    if (!youTubeVideoId(data.url)) throw new Error('video.url must be a YouTube video URL.')
    if (typeof data.title !== 'string' || !data.title.trim()) throw new Error('video.title is required.')
  }
  if (type === 'video_feature' && data.video_url && !youTubeVideoId(data.video_url)) {
    throw new Error('video_feature.video_url must be a YouTube video URL.')
  }
  if ((type === 'video' || type === 'video_feature') && data.upload_date && !videoUploadDate(data.upload_date)) {
    throw new Error(`${type}.upload_date must be a date written YYYY-MM-DD.`)
  }
  return { ...data }
}

export function createTenantPageBlock(type: TenantPageBlockType, data: Record<string, unknown> = {}, position = 0): TenantPageBlock {
  if (!BLOCK_TYPES.has(type)) throw new Error('Unsupported tenant page block type: ' + type)
  return { id: crypto.randomUUID(), type, position, level: type === 'heading' ? 2 : null, data: { ...data }, media: [] }
}

export type LocalizedContentFieldSegment = string | '*'

/** Plain text is interpolated; Markdown is parsed and sanitized. */
export type ContentTextFormat = 'plain' | 'markdown'

export interface ContentBlockTextField {
  /** Path into the block's data. `*` walks every element of an array. */
  readonly path: readonly LocalizedContentFieldSegment[]
  readonly format: ContentTextFormat
}

/** The block registry owns the text fields shared by authoring and localization. */
function blockTextFields(fields: Readonly<Record<string, TenantPageField>>, prefix: LocalizedContentFieldSegment[] = []): ContentBlockTextField[] {
  const collected: ContentBlockTextField[] = []
  for (const [key, field] of Object.entries(fields)) {
    if (field.translatable === false) continue
    if (field.kind === 'list') {
      // A list of records describes its item's fields; a list of plain strings
      // is itself the text — how_to's tools and supplies are the latter.
      if (field.of) collected.push(...blockTextFields(field.of, [...prefix, key, '*']))
      else collected.push({ path: [...prefix, key, '*'], format: 'plain' })
      continue
    }
    // A record is one object of named fields — a button's label and url.
    if (field.kind === 'record') {
      if (field.of) collected.push(...blockTextFields(field.of, [...prefix, key]))
      continue
    }
    if (field.kind !== 'text' && field.kind !== 'markdown') continue
    collected.push({ path: [...prefix, key], format: field.kind === 'markdown' ? 'markdown' : 'plain' })
  }
  return collected
}

export const CONTENT_BLOCK_TEXT_FIELDS = Object.fromEntries<readonly ContentBlockTextField[]>(
  Object.entries(TENANT_PAGE_BLOCK_REGISTRY).map(([type, definition]) => [type, blockTextFields(definition.fields)]),
) as Record<TenantPageBlockType, readonly ContentBlockTextField[]>

export type ContentFieldPath = ReadonlyArray<string | number>

/** Resolves declared field patterns against the array indices a block holds. */
export function expandContentFieldPath(
  data: Record<string, unknown>,
  pattern: readonly LocalizedContentFieldSegment[],
  path: ContentFieldPath = [],
): ContentFieldPath[] {
  const [segment, ...remaining] = pattern
  if (segment === undefined) return [path]
  if (segment !== '*') return expandContentFieldPath(data, remaining, [...path, segment])
  const collection = readContentFieldValue(data, path)
  if (!Array.isArray(collection)) return []
  return collection.flatMap((_, index) => expandContentFieldPath(data, remaining, [...path, index]))
}

export function readContentFieldValue(data: Record<string, unknown>, path: ContentFieldPath): unknown {
  let value: unknown = data
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(value)) return undefined
      value = value[segment]
    } else {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
      value = (value as Record<string, unknown>)[segment]
    }
  }
  return value
}

export interface TenantPageLocalizedTextField {
  path: Array<string | number>
  label: string
  value: string
}

function localizedFieldLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/^\w/, character => character.toUpperCase())
}

export function tenantPageLocalizedTextFields(block: TenantPageBlock): TenantPageLocalizedTextField[] {
  return CONTENT_BLOCK_TEXT_FIELDS[block.type].flatMap(({ path: pattern }) =>
    expandContentFieldPath(block.data, pattern).flatMap(path => {
      const value = readContentFieldValue(block.data, path)
      const key = pattern.filter(segment => segment !== '*').at(-1)!
      return typeof value === 'string' ? [{ path: [...path], label: localizedFieldLabel(key), value }] : []
    }))
}

export function writeTenantPageLocalizedText(block: TenantPageBlock, path: readonly (string | number)[], value: string): void {
  if (path.length === 0) throw new Error('Localized page field path is empty.')
  let target: unknown = block.data
  for (const segment of path.slice(0, -1)) {
    if (!target || typeof target !== 'object') throw new Error('Localized page field path is invalid.')
    target = (target as Record<string | number, unknown>)[segment]
  }
  if (!target || typeof target !== 'object') throw new Error('Localized page field path is invalid.')
  ;(target as Record<string | number, unknown>)[path[path.length - 1]!] = value
}

export function tenantPageTranslationSourceBlockId(block: TenantPageBlock): string {
  const value = block.source_block_id
  if (typeof value !== 'string' || !value) {
    throw new Error('A translated page block is missing its canonical source block identity.')
  }
  return value
}

function pageFieldPathKey(path: readonly (string | number)[]): string {
  return JSON.stringify(path)
}

function blankTenantPageTranslationBlock(block: TenantPageBlock, id: string = crypto.randomUUID()): TenantPageBlock {
  const translated = {
    ...block,
    id,
    source_block_id: block.id,
    data: structuredClone(block.data),
    media: block.media.map(item => ({ ...item, alt_text: null })),
  }
  for (const field of tenantPageLocalizedTextFields(translated)) writeTenantPageLocalizedText(translated, field.path, '')
  return translated
}

export function createTenantPageTranslationBlocks(blocks: readonly TenantPageBlock[]): TenantPageBlock[] {
  return blocks.map((block, position) => ({ ...blankTenantPageTranslationBlock(block), position }))
}

export function alignTenantPageTranslationBlocks(
  sourceBlocks: readonly TenantPageBlock[],
  translatedBlocks: readonly TenantPageBlock[],
): TenantPageBlock[] {
  const translatedBySourceId = new Map<string, TenantPageBlock>()
  for (const block of translatedBlocks) {
    const sourceBlockId = tenantPageTranslationSourceBlockId(block)
    if (translatedBySourceId.has(sourceBlockId)) {
      throw new Error(`Multiple translated page blocks reference source block ${sourceBlockId}.`)
    }
    translatedBySourceId.set(sourceBlockId, block)
  }

  return sourceBlocks.map((source, position) => {
    const translated = translatedBySourceId.get(source.id)
    if (!translated) return { ...blankTenantPageTranslationBlock(source), position }
    if (translated.type !== source.type) {
      throw new Error(`Translated page block ${translated.id} does not match source block ${source.id}.`)
    }

    const aligned = blankTenantPageTranslationBlock(source, translated.id)
    const translatedFields = new Map(tenantPageLocalizedTextFields(translated)
      .map(field => [pageFieldPathKey(field.path), field.value]))
    for (const field of tenantPageLocalizedTextFields(source)) {
      const translatedValue = translatedFields.get(pageFieldPathKey(field.path))
      if (translatedValue !== undefined) writeTenantPageLocalizedText(aligned, field.path, translatedValue)
    }
    return { ...aligned, position }
  })
}

export function normalizeTenantPageBlocks(value: unknown): TenantPageBlock[] {
  if (!Array.isArray(value)) throw new Error('blocks must be an array.')
  if (value.length > 50) throw new Error('A page may contain at most 50 blocks.')
  return value.map((rawBlock, index) => {
    const block = asRecord(rawBlock, 'blocks[' + index + ']')
    const type = asString(block.type, 'blocks[' + index + '].type', true) as TenantPageBlockType
    if (!BLOCK_TYPES.has(type)) throw new Error('blocks[' + index + '].type "' + type + '" is not registered.')
    const id = asString(block.id, 'blocks[' + index + '].id') || crypto.randomUUID()
    const sourceBlockId = block.source_block_id == null ? null : asString(block.source_block_id, 'blocks[' + index + '].source_block_id', true)
    const parentBlockId = block.parent_block_id == null ? null : asString(block.parent_block_id, 'blocks[' + index + '].parent_block_id', true)
    const position = block.position === undefined ? index : block.position
    if (typeof position !== 'number' || !Number.isSafeInteger(position)) throw new Error(`blocks[${index}].position must be an integer.`)
    const level = block.level ?? null
    if (level !== null && (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6)) throw new Error(`blocks[${index}].level must be null or an integer from 1 to 6.`)
    const data = asRecord(block.data ?? {}, 'blocks[' + index + '].data')
    const media = block.media === undefined ? [] : block.media
    if (!Array.isArray(media)) throw new Error('blocks[' + index + '].media must be an array.')
    const normalizedMedia = media.map((rawMedia, mediaIndex) => {
      const item = asRecord(rawMedia, `blocks[${index}].media[${mediaIndex}]`)
      const assetId = asString(item.asset_id, `blocks[${index}].media[${mediaIndex}].asset_id`, true)!
      const slot = asString(item.slot, `blocks[${index}].media[${mediaIndex}].slot`, true)!
      return { asset_id: assetId, slot, sort_order: mediaIndex }
    })
    const canonicalSlot = type === 'gallery' ? 'gallery' : type === 'hero' || type === 'image' ? 'media' : null
    const declaredSlots = Object.values(TENANT_PAGE_BLOCK_REGISTRY[type].fields)
      .filter(field => field.kind === 'media').map(field => field.slot)
    if (canonicalSlot && normalizedMedia.some(item => !declaredSlots.includes(item.slot) && !(type === 'hero' && item.slot.startsWith('parallax_') && isSupportedMediaPlacement({ owner_type: 'content_block', slot: item.slot })))) {
      throw new Error(`blocks[${index}].media must use a declared media slot for ${type} blocks: ${declaredSlots.join(', ')}.`)
    }
    if (canonicalSlot) {
      // Media references belong in the placement array, not block data.
      if (data.url !== undefined) throw new Error(`${type}.url must use the block media array.`)
      if (data.asset_id !== undefined) throw new Error(`${type}.asset_id must use the block media array.`)
    }
    if (byteLength(data) > 32 * 1024) throw new Error('blocks[' + index + '] exceeds the 32KB payload limit.')
    const normalized = validateContentBlockData(type, data)
    return { id, source_block_id: sourceBlockId, parent_block_id: parentBlockId, level, type, position, data: normalized, media: normalizedMedia }
  })
}

export function validateTenantPageSnapshot(value: unknown): TenantPageSnapshot {
  const snapshot = asRecord(value, 'snapshot')
  if (snapshot.schemaVersion !== TENANT_PAGE_SCHEMA_VERSION) throw new Error('snapshot.schemaVersion must be ' + TENANT_PAGE_SCHEMA_VERSION + '.')
  const metadata = asRecord(snapshot.metadata, 'snapshot.metadata')
  const normalizedMetadata: TenantPageSnapshotMetadata = {
    locale: asString(metadata.locale, 'snapshot.metadata.locale', true)!,
    path: normalizeTenantPagePath(asString(metadata.path, 'snapshot.metadata.path', true)!),
    title: asString(metadata.title, 'snapshot.metadata.title', true)!,
    summary: asString(metadata.summary, 'snapshot.metadata.summary'),
    pageType: (() => {
      const type = asString(metadata.pageType, 'snapshot.metadata.pageType', true)!
      if (!TENANT_PAGE_TYPES.includes(type as TenantPageType)) throw new Error('snapshot.metadata.pageType is invalid.')
      return type as TenantPageType
    })(),
    recipe: asString(metadata.recipe, 'snapshot.metadata.recipe'),
  }
  const blocks = normalizeTenantPageBlocks(snapshot.blocks)
  if (byteLength({ schemaVersion: TENANT_PAGE_SCHEMA_VERSION, metadata: normalizedMetadata, blocks }) > 256 * 1024) {
    throw new Error('The page snapshot exceeds the 256KB payload limit.')
  }
  return { schemaVersion: TENANT_PAGE_SCHEMA_VERSION, metadata: normalizedMetadata, blocks }
}

export function normalizeTenantPagePath(value: string): string {
  const path = value.trim().replace(/\\+/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Page paths must be rooted and normalized.')
  if (path.includes('?') || path.includes('#')) throw new Error('Page paths may not contain query strings or fragments.')
  return path
}

export function blockDefinition(type: TenantPageBlockType): TenantPageBlockDefinition {
  return TENANT_PAGE_BLOCK_REGISTRY[type]
}


export function findTenantPageBlock(
  blocks: TenantPageBlock[],
  type: TenantPageBlockType,
): Record<string, unknown> | null {
  const matches = blocks.filter(candidate => candidate.type === type)
  if (matches.length > 1) throw new Error(`Multiple ${type} blocks require an explicit selection.`)
  const block = matches[0]
  return block ? { ...block.data, media: block.media } : null
}
