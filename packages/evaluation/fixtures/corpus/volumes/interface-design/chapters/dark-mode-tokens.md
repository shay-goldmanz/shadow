---
title: Dark mode is a palette, not an inversion
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Building a dark theme for a product: choosing surface, border, and
  text tokens that hold up on their own rather than being computed by
  inverting the light theme's values.
not_for: brand illustration, marketing site theming, print design
keywords: [dark mode, color tokens, contrast, theme, surface, elevation]
confidence: high
---
Inverting a light theme's white background to pure black and its black
text to pure white produces a theme that vibrates — pure black next to
pure white is a higher-contrast pairing than most light themes ever
use, and it reads as harsher, not calmer, which defeats the reason
most people reach for dark mode at night.

A dark theme needs its own near-black surface color (not #000000, more
like a very dark warm or cool grey) and its own near-white text color
(not #FFFFFF, something closer to a light grey). Elevation in a light
theme is usually communicated with shadows; shadows barely read against
a dark background, so a dark theme needs to communicate elevation with
progressively lighter surface tones instead — a modal sits on a
lighter grey than the page behind it, not a darker one with a shadow.

Every semantic color — success green, warning amber, error red — needs
a dark-mode-specific value too, usually desaturated slightly and
lightened, because a saturated color calibrated for a white background
will glow uncomfortably against black. Treat dark mode as a second,
complete palette that happens to share the same semantic roles as the
light one, never as a CSS filter applied to the first.
