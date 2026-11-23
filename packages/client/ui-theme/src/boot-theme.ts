/**
 * Host-rendered theme bootstrap for the browser's pre-plugin interval. Each
 * index response embeds the current durable built-in preference; the browser
 * resolves only `system`, then writes the same DOM fields ui-layout's
 * ThemePresenter owns after the client plugin tree activates.
 */

import { DEFAULT_PALETTE, DEFAULT_PREFERENCE, type ThemePalette, type ThemePreference } from './theme-settings.ts'
import { ARK_PALETTE } from './ark-palette.ts'

/** Build the inline script for one schema-validated built-in preference. */
function bootThemeScript(preference: ThemePreference, palette: ThemePalette): string {
  return `<script>(() => {
  const preference = ${JSON.stringify(preference)}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  const palette = ${JSON.stringify(palette)}
  if (palette === 'ark') {
    const pairs = ${JSON.stringify(ARK_PALETTE)}
    const scheme = dark ? 'dark' : 'light'
    for (const [name, modes] of Object.entries(pairs)) document.body.style.setProperty(name, modes[scheme])
    document.body.setAttribute('data-dsw-boot-tokens', Object.keys(pairs).join(' '))
  }
})()</script>`
}

/**
 * Insert the theme bootstrap immediately after the opening body tag, before
 * the shell mount and module script. Body-less fragments receive it at the
 * end, where the HTML parser has already synthesized a body.
 * @param html - Raw application index HTML.
 * @param preference - Current Host-backed built-in preference.
 * @param palette - Current Host-backed visual palette.
 * @returns HTML containing the theme bootstrap.
 */
export function injectBootTheme(
  html: string,
  preference: ThemePreference = DEFAULT_PREFERENCE,
  palette: ThemePalette = DEFAULT_PALETTE,
): string {
  const script = bootThemeScript(preference, palette)
  const body = /<body(?:\s[^>]*)?>/i.exec(html)
  if (body === null) return `${html}${script}`
  const at = body.index + body[0].length
  return `${html.slice(0, at)}${script}${html.slice(at)}`
}
