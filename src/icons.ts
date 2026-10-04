import lucideIconsData from './lucide-data.json' with { type: 'json' }

export type LucideIconNode = [tag: string, attrs: Record<string, string | number>]
export type LucideIconsMap = Record<string, LucideIconNode[]>

const ICONS = lucideIconsData as unknown as LucideIconsMap

const ALIASES: Record<string, string> = {
  branch: 'git-branch',
  gear: 'settings',
  cog: 'settings',
  stop: 'square',
  console: 'terminal',
  edit: 'pencil',
  'edit-2': 'pencil',
  'edit-3': 'pencil',
  'open-external': 'external-link',
  'external-link': 'external-link',
  trash: 'trash-2',
  refresh: 'refresh-cw',
  sync: 'refresh-cw',
  help: 'circle-question-mark',
  'help-circle': 'circle-question-mark',
  'circle-help': 'circle-question-mark',
  'check-circle': 'circle-check',
  'alert-triangle': 'triangle-alert',
  'alert-circle': 'circle-alert',
  'x-circle': 'circle-x',
  'plus-circle': 'circle-plus',
  'minus-circle': 'circle-minus',
  'play-circle': 'circle-play',
  'stop-circle': 'circle-stop',
  'pause-circle': 'circle-pause',
  'user-circle': 'circle-user',
  'arrow-down-circle': 'circle-arrow-down',
  'arrow-up-circle': 'circle-arrow-up',
  'arrow-left-circle': 'circle-arrow-left',
  'arrow-right-circle': 'circle-arrow-right',
  'more-horizontal': 'ellipsis',
  'more-vertical': 'ellipsis-vertical',
  close: 'x',
  cross: 'x',
  doc: 'file-text',
  document: 'file-text',
  warning: 'triangle-alert',
}

const ALPHANUMERIC_MAP = new Map<string, string>()
for (const key of Object.keys(ICONS)) {
  const stripped = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (!ALPHANUMERIC_MAP.has(stripped)) {
    ALPHANUMERIC_MAP.set(stripped, key)
  }
}

// Add stripped aliases to ALPHANUMERIC_MAP as well
for (const [aliasKey, targetKey] of Object.entries(ALIASES)) {
  const stripped = aliasKey.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (!ALPHANUMERIC_MAP.has(stripped)) {
    ALPHANUMERIC_MAP.set(stripped, targetKey)
  }
}

export const DEFAULT_FALLBACK_ICON = 'box'

/**
 * Converts camelCase, PascalCase, or kebab-case string into kebab-case
 * Stripping trailing "Icon", "-icon", or "_icon" suffixes.
 */
export function normalizeLucideIconName(name: string): string {
  if (!name || typeof name !== 'string') return ''
  let cleaned = name.trim()

  // If it's already an SVG, don't normalize
  if (cleaned.startsWith('<svg') || cleaned.startsWith('<SVG')) {
    return cleaned
  }

  // Strip trailing "Icon" (e.g. "PlayIcon", "play-icon", "play_icon")
  cleaned = cleaned.replace(/[_-]?icon$/i, '')

  // Convert PascalCase or camelCase to kebab-case
  cleaned = cleaned
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])([0-9]+)/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()

  return cleaned
}

/**
 * Resolves a given icon name to its canonical Lucide icon key.
 * Returns undefined if no matching icon was found.
 */
export function findLucideIconKey(name: string): string | undefined {
  if (!name || typeof name !== 'string') return undefined
  const trimmed = name.trim()
  if (!trimmed || trimmed.startsWith('<svg') || trimmed.startsWith('<SVG')) return undefined

  // 1. Direct match in icons table
  if (ICONS[trimmed]) return trimmed

  // 2. Normalized kebab-case
  const normalized = normalizeLucideIconName(trimmed)
  if (ICONS[normalized]) return normalized

  // 3. Aliases match
  if (ALIASES[normalized] && ICONS[ALIASES[normalized]]) {
    return ALIASES[normalized]
  }

  // 4. Case-insensitive lookup in direct keys
  const lower = trimmed.toLowerCase()
  if (ICONS[lower]) return lower

  // 5. Alphanumeric match (handles numbers like "0-1" or "3d" or aliases)
  const stripped = trimmed.replace(/[_-]?icon$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase()
  const alphaMatch = ALPHANUMERIC_MAP.get(stripped)
  if (alphaMatch && ICONS[alphaMatch]) {
    return alphaMatch
  }

  return undefined
}

/**
 * Checks if a given name corresponds to a supported Lucide icon.
 */
export function hasLucideIcon(name: string): boolean {
  return findLucideIconKey(name) !== undefined
}

export interface LucideSvgOptions {
  className?: string
  size?: number | string
  strokeWidth?: number | string
  color?: string
}

/**
 * Generates an SVG string for a given Lucide icon key.
 */
export function renderLucideSvg(iconKey: string, options: LucideSvgOptions = {}): string {
  const nodes = ICONS[iconKey] ?? ICONS[DEFAULT_FALLBACK_ICON] ?? []
  const {
    className = `lucide lucide-${iconKey}`,
    size = 24,
    strokeWidth = 2,
    color = 'currentColor',
  } = options

  const innerSvg = nodes
    .map(([tag, attrs]) => {
      const attrString = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ')
      return `<${tag} ${attrString}/>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" class="${className}">${innerSvg}</svg>`
}

/**
 * Resolves any icon name, SVG string, or undefined to a safe SVG string.
 * If the input is already an SVG string, it returns it as-is.
 * If the input matches a Lucide icon, returns its SVG.
 * If not found or invalid, returns the fallback icon SVG.
 */
export function resolveLucideIcon(nameOrSvg: string | undefined, options: LucideSvgOptions = {}): string {
  if (!nameOrSvg || typeof nameOrSvg !== 'string') {
    return renderLucideSvg(DEFAULT_FALLBACK_ICON, options)
  }

  const trimmed = nameOrSvg.trim()
  if (trimmed.startsWith('<svg') || trimmed.startsWith('<SVG')) {
    return trimmed
  }

  const key = findLucideIconKey(trimmed)
  if (key) {
    return renderLucideSvg(key, options)
  }

  return renderLucideSvg(DEFAULT_FALLBACK_ICON, options)
}

/**
 * Returns all available Lucide icon names.
 */
export function getAllLucideIconNames(): string[] {
  return Object.keys(ICONS)
}
