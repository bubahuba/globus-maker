<?php
/**
 * POST ?name=file.jpg  body=raw image bytes → resize with GD2 and write here.
 * Names ending in -thumb.* get a smaller max edge (gallery screenshots).
 */
header('Cache-Control: no-store');

define('GM_PREVIEW_MAX_WIDTH', 2048);
define('GM_PREVIEW_JPEG_QUALITY', 78);
define('GM_THUMB_MAX_WIDTH', 720);
define('GM_THUMB_JPEG_QUALITY', 72);

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
	header('Allow: POST, OPTIONS');
	http_response_code(204);
	exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
	http_response_code(405);
	header('Allow: POST, OPTIONS');
	header('Content-Type: text/plain; charset=utf-8');
	echo 'POST only';
	exit;
}

if (!function_exists('imagecreatefromstring') || !function_exists('imagejpeg')) {
	http_response_code(500);
	header('Content-Type: text/plain; charset=utf-8');
	echo 'GD2 with JPEG support is required';
	exit;
}

$name = isset($_GET['name']) ? $_GET['name'] : '';
$name = basename(str_replace('\\', '/', $name));
if ($name === '' || !preg_match('/^[A-Za-z0-9._-]+\.(jpe?g|png|webp)$/i', $name)) {
	http_response_code(400);
	header('Content-Type: text/plain; charset=utf-8');
	echo 'Invalid filename';
	exit;
}

$isThumb = (bool) preg_match('/-thumb\.(jpe?g|png|webp)$/i', $name);
$maxW = $isThumb ? GM_THUMB_MAX_WIDTH : GM_PREVIEW_MAX_WIDTH;
$quality = $isThumb ? GM_THUMB_JPEG_QUALITY : GM_PREVIEW_JPEG_QUALITY;

$body = file_get_contents('php://input');
if ($body === false || $body === '') {
	http_response_code(400);
	header('Content-Type: text/plain; charset=utf-8');
	echo 'Empty body';
	exit;
}
if (strlen($body) > 32 * 1024 * 1024) {
	http_response_code(413);
	header('Content-Type: text/plain; charset=utf-8');
	echo 'Too large';
	exit;
}

$src = @imagecreatefromstring($body);
if ($src === false) {
	http_response_code(400);
	header('Content-Type: text/plain; charset=utf-8');
	echo 'Invalid image';
	exit;
}

$srcW = imagesx($src);
$srcH = imagesy($src);
if ($srcW < 1 || $srcH < 1) {
	imagedestroy($src);
	http_response_code(400);
	header('Content-Type: text/plain; charset=utf-8');
	echo 'Invalid image size';
	exit;
}

$dstW = $srcW;
$dstH = $srcH;
$scale = 1.0;
if ($srcW > $maxW) {
	$scale = $maxW / $srcW;
}
// Thumbs: also cap height so tall screenshots stay light.
if ($isThumb && $srcH * $scale > $maxW) {
	$scale = $maxW / $srcH;
}
if ($scale < 1.0) {
	$dstW = max(1, (int) round($srcW * $scale));
	$dstH = max(1, (int) round($srcH * $scale));
	$dst = imagecreatetruecolor($dstW, $dstH);
	if ($dst === false) {
		imagedestroy($src);
		http_response_code(500);
		header('Content-Type: text/plain; charset=utf-8');
		echo 'Resize failed';
		exit;
	}
	imagecopyresampled($dst, $src, 0, 0, 0, 0, $dstW, $dstH, $srcW, $srcH);
	imagedestroy($src);
	$src = $dst;
}

$outName = preg_replace('/\.(png|webp)$/i', '.jpg', $name);
if (!preg_match('/\.jpe?g$/i', $outName)) {
	$outName .= '.jpg';
}

$path = __DIR__ . DIRECTORY_SEPARATOR . $outName;
$existed = is_file($path);
$ok = @imagejpeg($src, $path, $quality);
imagedestroy($src);

if ($ok === false || !is_file($path) || filesize($path) < 32) {
	@unlink($path);
	http_response_code(500);
	header('Content-Type: text/plain; charset=utf-8');
	echo 'Write failed - chmod globe-preview writable for PHP (GD JPEG)';
	exit;
}

http_response_code($existed ? 204 : 201);
header('Content-Type: text/plain; charset=utf-8');
header('X-Archive-Name: ' . $outName);
echo $existed ? 'Updated' : 'Created';
