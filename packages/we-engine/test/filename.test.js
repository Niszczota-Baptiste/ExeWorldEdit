import test from 'node:test';
import assert from 'node:assert/strict';
import { safeFileName, safeFileNameExt } from '../src/storage/filename.js';

// Un nom de build est écrit par un humain : il a des accents, parfois du
// coréen — la police embarquée du moteur couvre tout le BMP exprès. L'ancienne
// règle (`[^\w.-]` → `_`) les jetait tous, et « 한국어 건물 » devenait « _ ».

test('les lettres sont gardées : accents, CJK, ponctuation courante', () => {
  for (const n of ['Vallée de Minefield', 'Arène N°3', '한국어 건물', 'Château fort', 'Mur — nord', 'Bâtiment (v2)']) {
    assert.equal(safeFileName(n), n, `« ${n} » ne doit pas être abîmé`);
  }
});

test('seuls les caractères que le système refuse partent', () => {
  // La liste de Windows, la plus stricte des trois plateformes.
  assert.equal(safeFileName('fort/est'), 'fort est');
  assert.equal(safeFileName('a<b>c:d"e|f?g*h'), 'a b c d e f g h');
  assert.equal(safeFileName('avec\u0000nul'), 'avec nul');
  assert.equal(safeFileName('C:\\Windows\\x'), 'C Windows x');
});

test('rien ne remonte d’un dossier', () => {
  // La propriété qui compte, pas une chaîne exacte : plus aucun séparateur et
  // plus aucune suite de deux points.
  for (const n of ['../../etc/passwd', '..\\..\\x', 'a/../b']) {
    const out = safeFileName(n);
    assert.ok(!/[/\\]/.test(out), `${out} contient encore un séparateur`);
    assert.ok(!out.includes('..'), `${out} contient encore « .. »`);
  }
  assert.equal(safeFileName('..'), 'build');
  assert.equal(safeFileName('.'), 'build');
});

test('les noms de périphériques réservés sont refusés, extension comprise', () => {
  // `CON.mca` est refusé par Windows aussi sûrement que `CON`.
  for (const n of ['CON', 'con', 'NUL', 'com1', 'LPT9', 'aux.mca', 'PRN.schem']) {
    assert.equal(safeFileName(n), 'build', `« ${n} » est réservé`);
  }
  // Mais pas ce qui leur ressemble sans en être.
  assert.equal(safeFileName('console'), 'console');
  assert.equal(safeFileName('com10'), 'com10');
  assert.equal(safeFileName('mon CON à moi'), 'mon CON à moi');
});

test('un nom qui finit par un point ou une espace est corrigé', () => {
  // Windows les coupe en silence : le fichier n'aurait pas le nom demandé.
  assert.equal(safeFileName('fin.'), 'fin');
  assert.equal(safeFileName('fin   '), 'fin');
  assert.equal(safeFileName('fin. . .'), 'fin');
});

test('un nom vide ou illisible retombe sur le recours', () => {
  for (const n of ['', '   ', null, undefined, '///', '\u0000']) {
    assert.equal(safeFileName(n), 'build');
  }
  assert.equal(safeFileName('', { fallback: 'zone' }), 'zone');
});

test('la longueur est bornée sans couper au milieu d’une lettre', () => {
  const long = 'é'.repeat(200);
  const out = safeFileName(long);
  assert.equal(out.length, 80);
  assert.ok([...out].every((c) => c === 'é'), 'pas de demi-caractère');
});

test('l’extension se colle proprement', () => {
  assert.equal(safeFileNameExt('Vallée', 'schem'), 'Vallée.schem');
  assert.equal(safeFileNameExt('Vallée', '.schem'), 'Vallée.schem');
  assert.equal(safeFileNameExt('', 'mca'), 'build.mca');
});
