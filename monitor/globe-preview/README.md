# Globe preview archive

- `list.php` — JSON filename list (textures + `*-thumb.jpg` screenshots)
- `save.php?name=file.jpg` — POST raw image; GD2 resizes (textures ≤2048px, thumbs ≤720px)
- `Place-id.jpg` — equirect texture for the globe
- `Place-id-thumb.jpg` — Three.js canvas screenshot for the gallery pane

## Deploy

1. Upload `list.php`, `save.php`, and an empty/minimal `.htaccess`.
2. Make this folder writable for PHP-FPM.
3. Needs PHP GD with JPEG.
