# Adding product photos and videos

Each product has its own folder under `src/assets/products/`. Its current photos are already included. The website automatically reads supported media from these folders and shows them on the matching product detail page.

| Product | Folder |
| --- | --- |
| Mauve Mist | `src/assets/products/mauve-mist/` |
| Ivory Whisper | `src/assets/products/ivory-whisper/` |
| Midnight Fig | `src/assets/products/midnight-fig/` |
| Rose Dawn | `src/assets/products/rose-dawn/` |
| Pearl Essence | `src/assets/products/pearl-essence/` |
| Deep Plum | `src/assets/products/deep-plum/` |
| Blush Silk | `src/assets/products/blush-silk/` |
| Moonlit Ivory | `src/assets/products/moonlit-ivory/` |
| Royal Fig | `src/assets/products/royal-fig/` |

## Example

To add another photo and a video to Mauve Mist, copy them into this folder:

```text
src/assets/products/mauve-mist/
  01-main.jpg
  02-detail.jpg
  03-back.jpg
  04-video.mp4
  README.md
```

Media are ordered by filename, using natural numeric ordering. The first image is the collection card cover. Keep at least one image in each folder; use `01-main.jpg` for the intended cover. You may replace that file with another image of the same name.

Supported photos: JPG, JPEG, PNG, WebP, AVIF, and GIF. Supported video files: MP4 and WebM. Use broadly supported codecs, such as H.264 in MP4. Convert iPhone HEIC photos and MOV videos to a supported format before adding them. Keep filenames simple, such as `02-detail.jpg`, without quotes or special characters.

Product videos have playback controls and do not autoplay. Adding a video to a product folder does not create a background video.

## See the changes

During local development, run:

```bash
npm ci
npm run dev
```

Refresh the browser after adding or replacing media. Open the collection and select the product’s “View details” link. If newly added media do not appear immediately, restart the development server.

For an already published website, adding files alone does not update the live build. Run:

```bash
npm run build
```

Then redeploy the new `dist/` output using your usual hosting process. Commit the media files if your hosting builds from GitHub. Vite copies the discovered assets into the production build with durable, content-hashed URLs.

## Where the logo is stored

The attached illustrated hero logo is `src/assets/brand/silkiiittt.png`. It appears to the left of the hero copy on desktop, with its frame aligned to the top tagline and bottom hand-finished note, and stacks above the copy on phones. The navigation and footer keep the written brand wordmark.

The background plays `public/source-assets/videos/silkinmotion2.mp4` automatically, muted and looping, beneath a translucent pastel gradient whose colors continue changing.
