import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FALLBACK_ICON,
  findLucideIconKey,
  getAllLucideIconNames,
  hasLucideIcon,
  renderLucideSvg,
  resolveLucideIcon,
} from './icons.js'

describe('Lucide icons support', () => {
  it('contains the full Lucide catalog (1800+ icons)', () => {
    const all = getAllLucideIconNames()
    expect(all.length).toBeGreaterThan(1800)
    expect(all).toContain('play')
    expect(all).toContain('git-branch')
    expect(all).toContain('folder-git-2')
    expect(all).toContain('circle-check')
    expect(all).toContain('sparkles')
    expect(all).toContain('terminal')
    expect(all).toContain('settings')
    expect(all).toContain('box')
  })

  describe('Criterion 1 & 2: Formats and resolution', () => {
    it('resolves direct kebab-case names', () => {
      expect(findLucideIconKey('play')).toBe('play')
      expect(findLucideIconKey('git-branch')).toBe('git-branch')
      expect(findLucideIconKey('folder-git-2')).toBe('folder-git-2')
      expect(findLucideIconKey('circle-check')).toBe('circle-check')
      expect(findLucideIconKey('sparkles')).toBe('sparkles')
    })

    it('resolves PascalCase and camelCase names', () => {
      expect(findLucideIconKey('GitBranch')).toBe('git-branch')
      expect(findLucideIconKey('gitBranch')).toBe('git-branch')
      expect(findLucideIconKey('FolderGit2')).toBe('folder-git-2')
      expect(findLucideIconKey('folderGit2')).toBe('folder-git-2')
      expect(findLucideIconKey('CheckCircle')).toBe('circle-check')
      expect(findLucideIconKey('checkCircle')).toBe('circle-check')
      expect(findLucideIconKey('AlertTriangle')).toBe('triangle-alert')
    })

    it('resolves names with optional Icon suffix', () => {
      expect(findLucideIconKey('SparklesIcon')).toBe('sparkles')
      expect(findLucideIconKey('PlayIcon')).toBe('play')
      expect(findLucideIconKey('GitBranchIcon')).toBe('git-branch')
      expect(findLucideIconKey('FolderGit2Icon')).toBe('folder-git-2')
      expect(findLucideIconKey('CheckCircleIcon')).toBe('circle-check')
      expect(findLucideIconKey('play-icon')).toBe('play')
      expect(findLucideIconKey('git-branch-icon')).toBe('git-branch')
    })

    it('resolves special and legacy aliases', () => {
      expect(findLucideIconKey('BranchIcon')).toBe('git-branch')
      expect(findLucideIconKey('GearIcon')).toBe('settings')
      expect(findLucideIconKey('StopIcon')).toBe('square')
      expect(findLucideIconKey('TerminalIcon')).toBe('terminal')
      expect(findLucideIconKey('OpenExternalIcon')).toBe('external-link')
      expect(findLucideIconKey('InfoIcon')).toBe('info')
      expect(findLucideIconKey('SearchIcon')).toBe('search')
      expect(findLucideIconKey('PencilIcon')).toBe('pencil')
      expect(findLucideIconKey('CheckIcon')).toBe('check')
    })

    it('resolves alphanumeric and number variations', () => {
      expect(findLucideIconKey('ArrowDown01')).toBe('arrow-down-0-1')
      expect(findLucideIconKey('arrow-down-0-1')).toBe('arrow-down-0-1')
      expect(findLucideIconKey('Axis3d')).toBe('axis-3d')
      expect(findLucideIconKey('Axis3D')).toBe('axis-3d')
    })

    it('hasLucideIcon returns true for valid icons and false for unknown', () => {
      expect(hasLucideIcon('play')).toBe(true)
      expect(hasLucideIcon('FolderGit2Icon')).toBe(true)
      expect(hasLucideIcon('definitely-not-an-icon-12345')).toBe(false)
      expect(hasLucideIcon('')).toBe(false)
    })
  })

  describe('Criterion 3: Fallback and SVG rendering', () => {
    it('renders valid Lucide SVG with standard attributes', () => {
      const svg = resolveLucideIcon('play')
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
      expect(svg).toContain('viewBox="0 0 24 24"')
      expect(svg).toContain('stroke="currentColor"')
      expect(svg).toContain('class="lucide lucide-play"')
      expect(svg).toContain('<path')
    })

    it('renders custom options (className, size, strokeWidth)', () => {
      const svg = renderLucideSvg('git-branch', {
        className: 'w-4 h-4 text-blue-500',
        size: 16,
        strokeWidth: 1.5,
        color: 'red',
      })
      expect(svg).toContain('class="w-4 h-4 text-blue-500"')
      expect(svg).toContain('width="16"')
      expect(svg).toContain('height="16"')
      expect(svg).toContain('stroke-width="1.5"')
      expect(svg).toContain('stroke="red"')
    })

    it('preserves raw SVG string as-is without modification', () => {
      const customSvg = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>'
      expect(resolveLucideIcon(customSvg)).toBe(customSvg)
    })

    it('returns default fallback icon when icon is unknown or empty without throwing', () => {
      const fallbackSvg = resolveLucideIcon('unknown-non-existent-icon')
      expect(fallbackSvg).toBeDefined()
      expect(fallbackSvg).toContain(`class="lucide lucide-${DEFAULT_FALLBACK_ICON}"`)

      const undefinedFallback = resolveLucideIcon(undefined)
      expect(undefinedFallback).toBeDefined()
      expect(undefinedFallback).toContain(`class="lucide lucide-${DEFAULT_FALLBACK_ICON}"`)

      const emptyFallback = resolveLucideIcon('')
      expect(emptyFallback).toBeDefined()
      expect(emptyFallback).toContain(`class="lucide lucide-${DEFAULT_FALLBACK_ICON}"`)
    })
  })
})
