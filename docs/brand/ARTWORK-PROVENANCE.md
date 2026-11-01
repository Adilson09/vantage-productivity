# Artwork provenance

The canonical Vantage Productivity artwork was supplied by the project owner as `Vantage Productivity saddle point logo.png`. It is preserved unchanged in [vantage-logo-original.png](vantage-logo-original.png).

Original SHA-256: `f5768a1d47e0871e6108aea0006f441427fdf3fff21d6df4209ec722f5480a61`.

A mark-only derivative was prepared with the built-in image-generation tool. It is intended for small app icons and does not claim exact pixel equivalence with the full original. The original remains the identity reference. No image-generation CLI or external API key was used.

## Symbol preparation prompt

The [exact built-in tool prompt](image-generation-prompt.txt) is retained alongside the mark master. The summary below describes the same edit.

> Create an icon-ready transparent PNG containing only the existing blue-and-navy saddle/ribbon symbol above the word Vantage. Remove all lettering and the white textured background. Preserve the shorter left rising navy ribbon, blue lower-left lobe, small central saddle-point gap, taller blue upper-right lobe, curved navy lower-right ribbon and slim curved seam. Preserve orientation, navy and vivid blue. Use clean edges and actual alpha transparency. No letters, badges, extra shapes, new logo design or watermark.

## Platform asset preparation

The final app icon uses that mark on a clean white rounded tile so the navy remains legible on dark taskbars. `tools/build-brand-assets.mjs` crops the substantial alpha components, scales the mark, and writes PNG, Windows ICO and macOS ICNS formats. The unused generated tile draft was discarded from project deliverables.

To reproduce platform formats from the committed mark master:

```powershell
Set-Location tools/brand-assets
npm ci --workspaces=false
Set-Location ../..
node tools/build-brand-assets.mjs
```

Windows ICO includes 16, 20, 24, 32, 48, 64, 128 and 256 pixel frames. Generated macOS/Linux icon files do not establish application acceptance on those platforms. See [asset-manifest.json](asset-manifest.json) for output hashes. Vantage Mail keeps its separate companion identity.
