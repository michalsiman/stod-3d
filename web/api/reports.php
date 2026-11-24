<?php
// 3D Stodsko – API pro hlášení chyb a změn (varianta pro běžný webhosting s PHP).
// Stejné chování jako tools/server.py:
//   GET  api/reports  → seznam hlášení (bez e-mailů), nejnovější první
//   POST api/reports  → nové hlášení (JSON)
// Data: api/data/reports.json (přístup zvenku zakazuje api/data/.htaccess).

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$dir = __DIR__ . '/data';
$store = $dir . '/reports.json';
$types = ['chyba', 'chybi', 'zmena', 'jine'];
$cooldown = 30;

function out($code, $obj) {
  http_response_code($code);
  echo json_encode($obj, JSON_UNESCAPED_UNICODE);
  exit;
}
function load_all($store) {
  if (!is_file($store)) return [];
  $d = json_decode(file_get_contents($store), true);
  return is_array($d) ? $d : [];
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $items = array_reverse(load_all($store));
  foreach ($items as &$r) { unset($r['email'], $r['ip']); }
  out(200, $items);
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(405, ['error' => 'nepodporovaná metoda']);

$raw = file_get_contents('php://input', false, null, 0, 20000);
$d = json_decode($raw, true);
if (!is_array($d)) out(400, ['error' => 'neplatná data']);
if (!empty($d['website'])) out(200, ['ok' => true]);              // honeypot
$text = trim((string)($d['text'] ?? ''));
if (mb_strlen($text) < 5) out(400, ['error' => 'Popište prosím problém (aspoň pár slov).']);

if (!is_dir($dir)) mkdir($dir, 0775, true);
$fp = fopen($store . '.lock', 'c');
flock($fp, LOCK_EX);
$items = load_all($store);
$ip = hash('sha256', $_SERVER['REMOTE_ADDR'] ?? '');
foreach (array_reverse($items) as $r) {
  if (($r['ip'] ?? '') === $ip && time() - strtotime($r['time']) < $cooldown) {
    flock($fp, LOCK_UN);
    out(429, ['error' => 'Chvilku počkejte, než pošlete další hlášení.']);
  }
}
$num = fn($v) => is_numeric($v) ? round((float)$v, 1) : null;
$id = 1;
foreach ($items as $r) $id = max($id, ($r['id'] ?? 0) + 1);
$items[] = [
  'id' => $id,
  'type' => in_array($d['type'] ?? '', $types, true) ? $d['type'] : 'jine',
  'text' => mb_substr($text, 0, 2000),
  'name' => mb_substr(trim((string)($d['name'] ?? '')), 0, 80),
  'email' => mb_substr(trim((string)($d['email'] ?? '')), 0, 120),
  'x' => $num($d['x'] ?? null), 'z' => $num($d['z'] ?? null),
  'place' => mb_substr(trim((string)($d['place'] ?? '')), 0, 120),
  'view' => mb_substr((string)($d['view'] ?? ''), 0, 120),
  'time' => date('Y-m-d\TH:i:s'),
  'status' => 'nové',
  'ip' => $ip,
];
file_put_contents($store . '.tmp', json_encode($items, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
rename($store . '.tmp', $store);
flock($fp, LOCK_UN);
out(201, ['ok' => true, 'id' => $id]);
