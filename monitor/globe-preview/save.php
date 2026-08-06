<?php
/**
 * POST ?name=file.jpg  body=raw image bytes → write into this folder.
 * (POST is more reliable than PUT behind nginx → Apache → PHP-FPM.)
 */
header('Cache-Control: no-store');

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

$name = isset($_GET['name']) ? $_GET['name'] : '';
$name = basename(str_replace('\\', '/', $name));
if ($name === '' || !preg_match('/^[A-Za-z0-9._-]+\.(jpe?g|png|webp)$/i', $name)) {
	http_response_code(400);
	header('Content-Type: text/plain; charset=utf-8');
	echo 'Invalid filename';
	exit;
}

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

$path = __DIR__ . DIRECTORY_SEPARATOR . $name;
$existed = is_file($path);
if (@file_put_contents($path, $body, LOCK_EX) === false) {
	http_response_code(500);
	header('Content-Type: text/plain; charset=utf-8');
	echo 'Write failed - chmod globe-preview writable for PHP';
	exit;
}

http_response_code($existed ? 204 : 201);
header('Content-Type: text/plain; charset=utf-8');
echo $existed ? 'Updated' : 'Created';
