<?php
/**
 * GET → JSON list of archived preview image filenames.
 */
header('Cache-Control: no-store');
header('Content-Type: application/json; charset=utf-8');

$dir = __DIR__;
$names = array();
$entries = @scandir($dir);
if ($entries !== false) {
	foreach ($entries as $name) {
		if ($name === '.' || $name === '..') {
			continue;
		}
		if (!preg_match('/\.(jpe?g|png|webp)$/i', $name)) {
			continue;
		}
		if (!is_file($dir . DIRECTORY_SEPARATOR . $name)) {
			continue;
		}
		$names[] = $name;
	}
	natcasesort($names);
	$names = array_values($names);
}

echo json_encode($names);
