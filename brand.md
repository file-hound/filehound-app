# FileHound Brand Guidelines

## Palette: The Navigator

| Name      | Hex       | Role                          |
|-----------|-----------|-------------------------------|
| Navy      | #0D1E3D   | Primary, dog body (dark bg)   |
| Ice       | #F0F4F8   | Background, dog body (dark bg)|
| Flare     | #E8641A   | Accent, CTAs, tongue (default)|
| Steel     | #5B7283   | Secondary text, icons         |
| Frost     | #D0DCE8   | Borders, dividers             |
| Dawn      | #FEF0E6   | Light tint, badge backgrounds |

## Tongue Color Rule

The tongue is always Flare (#E8641A) except:
- Dog body is Flare (orange text version) → tongue is Navy (#0D1E3D)
- Dog body is Dawn (very warm light) → tongue is Navy (#0D1E3D)

## Logo Exports

Located in `/public/media/logos/`

| File                  | Dog   | Tongue | Background  |
|-----------------------|-------|--------|-------------|
| logo_navy.png         | Navy  | Flare  | Transparent |
| logo_navy_text.png    | Navy  | Flare  | Transparent |
| logo_ice.png          | Ice   | Flare  | Transparent |
| logo_ice_text.png     | Ice   | Flare  | Transparent |
| logo_flare.png        | Flare | Navy   | Transparent |
| logo_flare_text.png   | Flare | Navy   | Transparent |
| logo_steel.png        | Steel | Flare  | Transparent |
| logo_steel_text.png   | Steel | Flare  | Transparent |
| logo_frost.png        | Frost | Flare  | Transparent |
| logo_frost_text.png   | Frost | Flare  | Transparent |
| logo_dawn.png         | Dawn  | Navy   | Transparent |
| logo_dawn_text.png    | Dawn  | Navy   | Transparent |

Use `_text` versions when the motto "WE DIG. YOU DEAL." should appear.
Default to `logo_navy.png` on light backgrounds, `logo_ice.png` on dark.

## Typography

| Role              | Font           | Weight |
|-------------------|----------------|--------|
| Wordmark/headings | Space Grotesk  | 700    |
| Body/UI/subtitles | Inter          | 400/500|

Both loaded via Google Fonts in Next.js using `next/font`.

## Motto

**WE DIG. YOU DEAL.**

Set in Inter, all caps, tracked out. Used beneath the wordmark in logo lockup and as a secondary brand statement.

## Favicon

Located in `/public/media/icons/`
Source: 512x512 Navy background, Ice dog, Flare tongue.
Generated via realfavicongenerator.net.

## OG Image

Located at `/public/media/og-image.jpg`
Dimensions: 1200x630px
Navy background, Ice wordmark and dog, Flare tongue, motto centered below.

## Domain

filehound.io

## GitHub

github.com/file-hound/filehound-app

## Tagline

We dig. You deal.

## Elevator pitch

FileHound scrapes public business license filings from all 50 state Secretary of State websites and delivers organized, daily lead lists to B2B service companies who want to reach brand new businesses before their competitors do.
