---
version: alpha
name: Hermes Cloud
description: "Minimal, intelligent, professional SaaS. Dark-neutral first: near-black and charcoal surfaces, neutral white/gray typography, restrained terracotta primary action. Compact, deliberate information hierarchy."
colors:
  primary: "#F3F4F6"
  secondary: "#9CA3AA"
  tertiary: "#AD5B3C"
  neutral: "#0B0D0F"
  on-tertiary: "#FFFFFF"
  border: "#2A2F34"
  border-strong: "#6B747C"
  card-bg: "#14171A"
  elevated: "#1B1F23"
  secondary-surface: "#24292E"
  destructive: "#B84A4A"
typography:
  h1:
    fontFamily: Bricolage Grotesque
    fontSize: 1.75rem
    fontWeight: 700
  body-md:
    fontFamily: Onest
    fontSize: 0.875rem
    fontWeight: 400
  label-caps:
    fontFamily: Bricolage Grotesque
    fontSize: 0.75rem
    fontWeight: 600
  mono:
    fontFamily: ui-monospace, SFMono-Regular, Menlo, monospace
    fontSize: 0.8125rem
    fontWeight: 400
rounded:
  sm: 4px
  md: 8px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xl2: 32px
  xl3: 40px
  xl4: 48px
components:
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-tertiary}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
    typography: "{typography.body-md}"
  card:
    backgroundColor: "{colors.card-bg}"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
    padding: 16px
    typography: "{typography.body-md}"
  input:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
    typography: "{typography.body-md}"
  button-secondary:
    backgroundColor: "{colors.secondary-surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
    typography: "{typography.body-md}"
  button-outline:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
    typography: "{typography.body-md}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.on-tertiary}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
    typography: "{typography.body-md}"
  muted-text:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.secondary}"
    rounded: "{rounded.sm}"
    padding: 0
    typography: "{typography.body-md}"
  border-demo:
    backgroundColor: "{colors.border}"
    textColor: "{colors.on-tertiary}"
    rounded: "{rounded.sm}"
    padding: 1px
    typography: "{typography.body-md}"
  border-strong-demo:
    backgroundColor: "{colors.border-strong}"
    textColor: "{colors.on-tertiary}"
    rounded: "{rounded.sm}"
    padding: 1px
    typography: "{typography.body-md}"
---

# Hermes Cloud

## Overview

Hermes Cloud is a managed hosting control plane for Hermes AI agents: one dedicated, isolated container per customer. The interface is a quiet, dense operations console. Near-black (#0B0D0F) and charcoal (#14171A, #1B1F23) surfaces carry neutral white/gray text. Terracotta (#AD5B3C) marks the single highest-emphasis action on a screen; everything else stays neutral. Compact 4px-based spacing, hairline borders, no decorative gradients, glassmorphism or heavy shadows.

## Colors

The palette is rooted in semantic tokens. Use the role (e.g. `{colors.primary}`) — never the hex literal — when authoring components.

- **primary (#F3F4F6)**
- **secondary (#9CA3AA)**
- **tertiary (#AD5B3C)**
- **neutral (#0B0D0F)**
- **on-tertiary (#FFFFFF)**
- **border (#2A2F34)**
- **border-strong (#6B747C)**
- **card-bg (#14171A)**
- **elevated (#1B1F23)**
- **secondary-surface (#24292E)**
- **destructive (#B84A4A)**

## Typography

| Token | Font | Size | Weight |
| --- | --- | --- | --- |
| `h1` | Bricolage Grotesque | 1.75rem | 700 |
| `body-md` | Onest | 0.875rem | 400 |
| `label-caps` | Bricolage Grotesque | 0.75rem | 600 |
| `mono` | ui-monospace, SFMono-Regular, Menlo, monospace | 0.8125rem | 400 |

## Layout

Spacing scale (use the named scale; avoid arbitrary values):

- `spacing.xs` — 4px
- `spacing.sm` — 8px
- `spacing.md` — 12px
- `spacing.lg` — 16px
- `spacing.xl` — 24px
- `spacing.xl2` — 32px
- `spacing.xl3` — 40px
- `spacing.xl4` — 48px

## Elevation & Depth

Depth comes from tonal layering and hairline borders, not drop shadows. Background #0B0D0F sits lowest, card surfaces #14171A above it, elevated surfaces #1B1F23 on top. Use border #2A2F34 at 1px for all containment. Never rely on shadow or glow to signal interactivity.

## Shapes

Corner radius scale:

- `rounded.sm` — 4px
- `rounded.md` — 8px

## Components

### button-primary
- backgroundColor: `{colors.tertiary}`
- textColor: `{colors.on-tertiary}`
- rounded: `{rounded.sm}`
- padding: `10px 16px`
- typography: `{typography.body-md}`

### card
- backgroundColor: `{colors.card-bg}`
- textColor: `{colors.primary}`
- rounded: `{rounded.md}`
- padding: `16px`
- typography: `{typography.body-md}`

### input
- backgroundColor: `{colors.elevated}`
- textColor: `{colors.primary}`
- rounded: `{rounded.sm}`
- padding: `10px 12px`
- typography: `{typography.body-md}`

### button-secondary
- backgroundColor: `{colors.secondary-surface}`
- textColor: `{colors.primary}`
- rounded: `{rounded.sm}`
- padding: `10px 16px`
- typography: `{typography.body-md}`

### button-outline
- backgroundColor: `{colors.neutral}`
- textColor: `{colors.primary}`
- rounded: `{rounded.sm}`
- padding: `10px 16px`
- typography: `{typography.body-md}`

### button-destructive
- backgroundColor: `{colors.destructive}`
- textColor: `{colors.on-tertiary}`
- rounded: `{rounded.sm}`
- padding: `10px 16px`
- typography: `{typography.body-md}`

### muted-text
- backgroundColor: `{colors.neutral}`
- textColor: `{colors.secondary}`
- rounded: `{rounded.sm}`
- padding: `0`
- typography: `{typography.body-md}`

### border-demo
- backgroundColor: `{colors.border}`
- textColor: `{colors.on-tertiary}`
- rounded: `{rounded.sm}`
- padding: `1px`
- typography: `{typography.body-md}`

### border-strong-demo
- backgroundColor: `{colors.border-strong}`
- textColor: `{colors.on-tertiary}`
- rounded: `{rounded.sm}`
- padding: `1px`
- typography: `{typography.body-md}`

## Do's and Don'ts

- Do read DESIGN.md before any UI work and use shadcn/ui primitives composed with these tokens.
- Do use {colors.tertiary} only for the primary action on a screen; never for decorative accents.
- Do use Bricolage Grotesque for headings, Onest for body/UI, and ui-monospace for code, IDs and technical values.
- Do use the named spacing scale (4,8,12,16,24,32,40,48px) and rounded.sm/md only.
- Do keep WCAG AA contrast (4.5:1) for all text and expose a visible focus ring on every interactive element.
- Do communicate status with an icon or text label in addition to color.
- Do respect prefers-reduced-motion and keep every control reachable by keyboard.
- Don't introduce another component library (Ant Design, MUI, Chakra, Mantine, DaisyUI) or a parallel design system.
- Don't use pill-shaped buttons, glassmorphism, gradient fills, or heavy shadows.
- Do use {colors.border-strong} only for the boundary of input, textarea, select, the unchecked checkbox, the off-state switch track, and the outline and secondary buttons (3:1 or better on neutral, card-bg and elevated, as WCAG 1.4.11 asks of component boundaries); keep {colors.border} for decorative and structural lines.
- Don't use the terracotta or destructive colors for body text, links or backgrounds of large surfaces.
- Don't invent hex values outside the semantic token set; extend tokens instead of hard-coding.
- Don't use color alone to convey instance state; pair badges with text (active, degraded, stopped, failed).
