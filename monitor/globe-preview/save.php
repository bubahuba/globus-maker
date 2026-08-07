<?php
/**
 * POST ?name=file.jpg  body=raw image bytes → resize with GD2 and write here.
 * Names ending in -thumb.* get a smaller max edge (gallery screenshots).
 *
 * Optional query meta (embedded as JPEG COM after GD, since GD strips EXIF):
 *   placeName, lat, lng, sideMeters
 * Payload: COM comment `GM1:{"placeName":"…","lat":…,"lng":…,"sideMeters":…}`
 */
header('Cache-Control: no-store');

define('GM_PREVIEW_MAX_WIDTH', 2048);
define('GM_PREVIEW_JPEG_QUALITY', 78);
define('GM_THUMB_MAX_WIDTH', 720);
define('GM_THUMB_JPEG_QUALITY', 72);
define('GM_META_PREFIX', 'GM1:');

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

$meta = gm_archive_meta_from_query($_GET);
if ($meta !== null) {
	gm_inject_jpeg_com_meta($path, $meta);
}

http_response_code($existed ? 204 : 201);
header('Content-Type: text/plain; charset=utf-8');
header('X-Archive-Name: ' . $outName);
echo $existed ? 'Updated' : 'Created';

/**
 * @param array<string, mixed> $query
 * @return array<string, mixed>|null
 */
function gm_archive_meta_from_query(array $query) {
	$meta = array();
	$place = isset($query['placeName']) ? trim((string) $query['placeName']) : '';
	if ($place !== '') {
		if (function_exists('mb_substr')) {
			$place = mb_substr($place, 0, 120);
		} else {
			$place = substr($place, 0, 120);
		}
		$meta['placeName'] = $place;
	}
	if (isset($query['lat']) && is_numeric($query['lat'])) {
		$meta['lat'] = (float) $query['lat'];
	}
	if (isset($query['lng']) && is_numeric($query['lng'])) {
		$meta['lng'] = (float) $query['lng'];
	}
	if (isset($query['sideMeters']) && is_numeric($query['sideMeters'])) {
		$side = (float) $query['sideMeters'];
		if ($side > 0) {
			$meta['sideMeters'] = (int) round($side);
		}
	}
	return count($meta) > 0 ? $meta : null;
}

/**
 * Inject/replace GM1: JPEG COM after SOI. GD cannot preserve EXIF.
 *
 * @param array<string, mixed> $meta
 */
function gm_inject_jpeg_com_meta($path, array $meta) {
	$json = json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
	if ($json === false) {
		return false;
	}
	$comment = GM_META_PREFIX . $json;
	$bytes = file_get_contents($path);
	if ($bytes === false || strlen($bytes) < 2 || $bytes[0] !== "\xFF" || $bytes[1] !== "\xD8") {
		return false;
	}
	$commentBin = $comment;
	if (strlen($commentBin) > 65533) {
		return false;
	}
	$stripped = gm_strip_gm1_com_segments($bytes);
	$segLen = strlen($commentBin) + 2;
	$com = "\xFF\xFE" . chr(($segLen >> 8) & 0xFF) . chr($segLen & 0xFF) . $commentBin;
	$out = "\xFF\xD8" . $com . substr($stripped, 2);
	return file_put_contents($path, $out) !== false;
}

/** Remove existing GM1: COM segments so re-saves stay clean. */
function gm_strip_gm1_com_segments($bytes) {
	$len = strlen($bytes);
	if ($len < 4 || $bytes[0] !== "\xFF" || $bytes[1] !== "\xD8") {
		return $bytes;
	}
	$out = "\xFF\xD8";
	$i = 2;
	while ($i < $len) {
		if ($bytes[$i] !== "\xFF") {
			$out .= substr($bytes, $i);
			break;
		}
		if ($i + 1 >= $len) {
			$out .= substr($bytes, $i);
			break;
		}
		$marker = ord($bytes[$i + 1]);
		if ($marker === 0xD9 || $marker === 0xDA) {
			$out .= substr($bytes, $i);
			break;
		}
		if ($marker === 0x00 || $marker === 0xFF) {
			$out .= $bytes[$i];
			$i += 1;
			continue;
		}
		if ($marker >= 0xD0 && $marker <= 0xD7) {
			$out .= substr($bytes, $i, 2);
			$i += 2;
			continue;
		}
		if ($i + 3 >= $len) {
			$out .= substr($bytes, $i);
			break;
		}
		$segLen = (ord($bytes[$i + 2]) << 8) | ord($bytes[$i + 3]);
		if ($segLen < 2 || $i + 2 + $segLen > $len) {
			$out .= substr($bytes, $i);
			break;
		}
		$seg = substr($bytes, $i, 2 + $segLen);
		if ($marker === 0xFE) {
			$text = substr($seg, 4);
			if (strpos(ltrim($text), GM_META_PREFIX) === 0) {
				$i += 2 + $segLen;
				continue;
			}
		}
		$out .= $seg;
		$i += 2 + $segLen;
	}
	return $out;
}
