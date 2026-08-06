# Globe preview archive

- `list.php` — JSON filename list
- `save.php?name=file.jpg` — POST raw image bytes
- `*.jpg` — static files

Avoid Apache `Options` / `Rewrite` / `Dav` here; they 500 on this host.

## Deploy

1. Upload `list.php`, `save.php`, and an empty/minimal `.htaccess`.
2. Remove old `index.php` if present.
3. `chmod` this folder writable for PHP-FPM.
