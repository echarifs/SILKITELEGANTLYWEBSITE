// Vite discovers each product's local media at development/build time.
// Keep product media in src/assets/products/<product-id>/.
const mediaFiles = import.meta.glob(
  './assets/products/**/*.{jpg,jpeg,png,webp,avif,gif,mp4,webm,JPG,JPEG,PNG,WEBP,AVIF,GIF,MP4,WEBM}',
  { eager: true, query: '?url', import: 'default' }
);

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function getProductMedia(productId) {
  const prefix = `./assets/products/${productId}/`;
  return Object.entries(mediaFiles)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, url]) => {
      const filename = path.slice(prefix.length);
      const extension = filename.split('.').pop().toLowerCase();
      return {
        url,
        filename,
        type: ['mp4', 'webm'].includes(extension) ? 'video' : 'image',
        mime: extension === 'webm' ? 'video/webm' : 'video/mp4',
      };
    })
    .sort((a, b) => collator.compare(a.filename, b.filename));
}
