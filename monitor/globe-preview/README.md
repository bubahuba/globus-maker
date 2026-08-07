# Globe preview archive

- `list.php` — JSON filename list (textures + `*-thumb.jpg` screenshots)
- `save.php?name=file.jpg` — POST raw image; GD2 resizes (textures ≤2048px, thumbs ≤720px)
- Optional query meta on save: `placeName`, `lat`, `lng`, `sideMeters`
- `Place-id.jpg` — equirect texture for the globe
- `Place-id-thumb.jpg` — Three.js canvas screenshot for the gallery pane

## Metadata

GD re-encodes strip EXIF, so after JPEG write `save.php` injects a JPEG COM comment:

```
GM1:{"placeName":"Paris","lat":48.85,"lng":2.35,"sideMeters":2500}
```

FE `/latest-planet` and the monitor sidebar read this from thumbs (JS) for gallery labels and hover tooltips.

## Deploy

1. Upload `list.php`, `save.php`, and an empty/minimal `.htaccess`.
2. Make this folder writable for PHP-FPM.
3. Needs PHP GD with JPEG.
4. Also deploy updated `../globe.js` + `../archive-image-meta.js` on the monitor host.
