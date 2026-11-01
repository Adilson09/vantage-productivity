# Vantage Productivity brand system

**Saddle Blue and Navy** is the recommended palette for the supplied saddle-point logo. Navy gives the workspace a stable text color; electric blue keeps the identity recognizable; cool white surfaces leave documents visually central. The UI action blue is deliberately darker than the logo blue so white button text has sufficient contrast.

This is a practical recommendation based on the supplied artwork, interface roles and calculated contrast. There is no single mathematically optimal palette for every user or display.

## Artwork and brand anchors

![Supplied Vantage Productivity master artwork](brand/vantage-logo-original.png)

| Anchor        | Hex       | Intended use                                   |
| ------------- | --------- | ---------------------------------------------- |
| Electric blue | `#0072FC` | Supplied-logo identity and decorative emphasis |
| Deep navy     | `#0D264A` | Brand identity and primary light-theme text    |
| Cool white    | `#F5F8FC` | Light workspace background                     |
| White         | `#FFFFFF` | Panels and original-artwork backing            |
| Action blue   | `#0064D9` | Light-theme buttons, links and focus rings     |

The original raster has blue/navy gradients and near-white background texture. These fixed colors are representative design anchors, not exact values for every original pixel. Keep the [original supplied PNG](brand/vantage-logo-original.png) as the master reference.

Preserve the artwork's aspect ratio and colors. Do not invert the full-color logo for dark mode. Use a separately prepared dark lockup, or show the original on a white backing. Use the saddle mark alone for app icons and small UI placements; the complete wordmark is unsuitable at small icon sizes. Do not stretch, rotate, add effects to, or recolor the mark without creating a clearly identified derivative.

## Interface roles

The machine-readable palette specification is [brand/palette.json](brand/palette.json). The running app uses semantic tokens in `packages/ui/src/tokens.css` and the shell styles. Changing the JSON alone does not update the interface; keep these values aligned and rebuild affected renderers. The values below describe chrome and controls, not document content.

| Role                    | Light     | Dark      |
| ----------------------- | --------- | --------- |
| Workspace background    | `#F5F8FC` | `#0B1526` |
| Panel surface           | `#FFFFFF` | `#13243B` |
| Raised surface          | `#FFFFFF` | `#1B314D` |
| Primary text            | `#0D264A` | `#F5F8FC` |
| Secondary text          | `#52647B` | `#B1C1D5` |
| Muted readable text     | `#5D6F88` | `#9AAFC9` |
| Action / link           | `#0064D9` | `#78B7FF` |
| Action text             | `#FFFFFF` | `#0D264A` |
| Action hover            | `#0053B5` | `#92CAFF` |
| Accent tint             | `#EAF3FF` | `#1B365A` |
| Decorative divider      | `#D8E1ED` | `#2C4360` |
| Required control border | `#7A8CA5` | `#7187A4` |
| Focus ring              | `#0064D9` | `#92CAFF` |

The pale decorative divider is for separation. If a border is necessary to recognize an input or other control, use **Required control border**. Use a visible focus ring with an offset so it is separated from a same-colored filled button. Verify the complete focus indicator in the real layout.

## Status messages

Always pair status color with explicit text or a meaningful icon. Color alone must not carry the status.

| Status      | Light text / background | Dark text / background |
| ----------- | ----------------------- | ---------------------- |
| Success     | `#167045` / `#E9F7EF`   | `#75DAA7` / `#16382C`  |
| Warning     | `#8C5700` / `#FFF4D6`   | `#FFD481` / `#3B2D15`  |
| Error       | `#B42332` / `#FFF0F2`   | `#FF9AA7` / `#40232D`  |
| Information | `#0064D9` / `#EAF3FF`   | `#78B7FF` / `#1B365A`  |

## Calculated contrast pairs

Ratios use the WCAG sRGB relative-luminance formula, without transparency or blending. Values are rounded for display; target decisions use the unrounded calculation.

Normal text uses a **4.5:1** target. Large text uses **3:1**. Visual information needed to identify controls and states uses **3:1** against adjacent colors. Logotypes are exempt from the text criterion. The logo-blue/white pair is included to explain why the UI action shade differs.

| Pair                                   | Foreground | Background | Ratio   | Reference              |
| -------------------------------------- | ---------- | ---------- | ------- | ---------------------- |
| Original logo blue on white            | `#0072FC`  | `#FFFFFF`  | 4.36:1  | Logo reference; exempt |
| Light primary text on workspace        | `#0D264A`  | `#F5F8FC`  | 14.15:1 | 4.5:1 target           |
| Light primary text on panel            | `#0D264A`  | `#FFFFFF`  | 15.07:1 | 4.5:1 target           |
| Light secondary text on workspace      | `#52647B`  | `#F5F8FC`  | 5.69:1  | 4.5:1 target           |
| Light secondary text on panel          | `#52647B`  | `#FFFFFF`  | 6.06:1  | 4.5:1 target           |
| Light muted readable text on workspace | `#5D6F88`  | `#F5F8FC`  | 4.81:1  | 4.5:1 target           |
| Light muted readable text on panel     | `#5D6F88`  | `#FFFFFF`  | 5.13:1  | 4.5:1 target           |
| Light primary action text              | `#FFFFFF`  | `#0064D9`  | 5.49:1  | 4.5:1 target           |
| Light hovered action text              | `#FFFFFF`  | `#0053B5`  | 7.23:1  | 4.5:1 target           |
| Light link on panel                    | `#0064D9`  | `#FFFFFF`  | 5.49:1  | 4.5:1 target           |
| Light link on accent tint              | `#0064D9`  | `#EAF3FF`  | 4.91:1  | 4.5:1 target           |
| Light required border on panel         | `#7A8CA5`  | `#FFFFFF`  | 3.43:1  | 3:1 target             |
| Light required border on workspace     | `#7A8CA5`  | `#F5F8FC`  | 3.22:1  | 3:1 target             |
| Light focus ring on panel              | `#0064D9`  | `#FFFFFF`  | 5.49:1  | 3:1 target             |
| Light success text                     | `#167045`  | `#E9F7EF`  | 5.53:1  | 4.5:1 target           |
| Light warning text                     | `#8C5700`  | `#FFF4D6`  | 5.51:1  | 4.5:1 target           |
| Light error text                       | `#B42332`  | `#FFF0F2`  | 5.89:1  | 4.5:1 target           |
| Light information text                 | `#0064D9`  | `#EAF3FF`  | 4.91:1  | 4.5:1 target           |
| Dark primary text on workspace         | `#F5F8FC`  | `#0B1526`  | 17.15:1 | 4.5:1 target           |
| Dark primary text on panel             | `#F5F8FC`  | `#13243B`  | 14.68:1 | 4.5:1 target           |
| Dark secondary text on workspace       | `#B1C1D5`  | `#0B1526`  | 9.97:1  | 4.5:1 target           |
| Dark secondary text on panel           | `#B1C1D5`  | `#13243B`  | 8.53:1  | 4.5:1 target           |
| Dark muted readable text on workspace  | `#9AAFC9`  | `#0B1526`  | 8.13:1  | 4.5:1 target           |
| Dark muted readable text on panel      | `#9AAFC9`  | `#13243B`  | 6.96:1  | 4.5:1 target           |
| Dark primary action text               | `#0D264A`  | `#78B7FF`  | 7.19:1  | 4.5:1 target           |
| Dark hovered action text               | `#0D264A`  | `#92CAFF`  | 8.70:1  | 4.5:1 target           |
| Dark link on panel                     | `#78B7FF`  | `#13243B`  | 7.46:1  | 4.5:1 target           |
| Dark link on accent tint               | `#78B7FF`  | `#1B365A`  | 5.82:1  | 4.5:1 target           |
| Dark required border on panel          | `#7187A4`  | `#13243B`  | 4.25:1  | 3:1 target             |
| Dark required border on workspace      | `#7187A4`  | `#0B1526`  | 4.96:1  | 3:1 target             |
| Dark focus ring on panel               | `#92CAFF`  | `#13243B`  | 9.02:1  | 3:1 target             |
| Dark success text                      | `#75DAA7`  | `#16382C`  | 7.54:1  | 4.5:1 target           |
| Dark warning text                      | `#FFD481`  | `#3B2D15`  | 9.53:1  | 4.5:1 target           |
| Dark error text                        | `#FF9AA7`  | `#40232D`  | 6.97:1  | 4.5:1 target           |
| Dark information text                  | `#78B7FF`  | `#1B365A`  | 5.82:1  | 4.5:1 target           |

These are individual color-pair calculations. They do **not** certify the application, establish complete WCAG conformance, or prove screen-reader, keyboard, focus-area or high-contrast-mode acceptance. Transparency, overlays, disabled states, font size, text weight, adjacent controls and operating-system rendering need separate inspection.

Sources: [W3C Understanding Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum) and [W3C WCAG 2.2 Non-text Contrast](https://www.w3.org/TR/WCAG22/#non-text-contrast).

## Implementation boundaries

- Shared chrome colors belong in `packages/ui/src/tokens.css`. Keep light, explicit-dark and system-dark definitions synchronized.
- The shell also defines accents in `apps/shell/src/renderer/src/home.css` and `VantageWorkspace.css`; keep its native controls aligned with this palette.
- Preserve per-editor identification accents. A spreadsheet's identity green is distinct from the suite's main action blue.
- Do not rewrite authored page colors, cell fills, chart palettes, PDF page images, highlights, print styles or export data to match the brand. Interface theming must not alter the document.
- Keep the original supplied artwork and any generated or derived icon assets separately identified. Branding changes do not establish a new application release or validation result.
