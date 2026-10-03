// ================================================
// unit/kanseki-parse.test.js — 全国漢籍データベース 解析器单测
// ================================================
// 夹具说明：
//   fixtures/kanseki/record_*.html —— 取自原站真实记录页（2026-10 抓取）
//     注意保留原页的大写标签、不成对 HEAD/BODY、FONT 排版与 <key> 用法，
//     这些正是解析器要吃的形态，规范化后会失去测试意义。
//   result_page.html —— 按原站结果页结构构造（含多锚题名、丛书项、机构项、jpg 标记）
// 回归重点：
//   1) <pinyin> 块内嵌 <ti>/<au>，屏蔽不当会把罗马字混进书名/著者（曾出现）
//   2) &nbsp; 与 &#32; 等实体必须还原为普通空白
//   3) 源数据本身无书名的记录须显式标注来源，不得静默留空
// ================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseResultPage, parseRecordPage, recordToPairs, splitKey, clean, decodeEntities, splitTerms,
} from '../../src/js/core/kanseki-parse.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kanseki');
const fx = (name) => readFileSync(join(FIX, name), 'utf8');

// ---------------------------------------------------------------- 基础工具
test('decodeEntities/clean：实体与空白归一', () => {
  assert.equal(decodeEntities('a&nbsp;b&#32;c'), 'a b c');
  assert.equal(decodeEntities('&amp;&lt;&gt;'), '&<>');
  assert.equal(clean(' 甲 <BR> 乙 &nbsp; 丙 '), '甲 乙 丙');
  assert.equal(clean('<FONT SIZE="-2"> 晉 陶潛 </FONT>'), '晉 陶潛');
});

test('splitKey：拆出 <key> 标目与其余著录', () => {
  assert.deepEqual(splitKey('<key>乍ㄚ圖說</key>一卷'), { key: '乍ㄚ圖說', rest: '一卷' });
  assert.deepEqual(splitKey('淸<key>姚瑩</key>撰'), { key: '姚瑩', rest: '淸撰' });
  assert.deepEqual(splitKey('無key'), { key: '無key', rest: '' });
});

test('splitTerms：逗号/空格多值去重', () => {
  assert.deepEqual(splitTerms('論語, 孟子  論語'), ['論語', '孟子']);
});

// ---------------------------------------------------------------- 结果页
test('parseResultPage：命中数、题名、著者/出版项、丛书项、机构', () => {
  const r = parseResultPage(fx('result_page.html'));
  assert.equal(r.total, 3);
  assert.equal(r.isForm, false);
  assert.equal(r.entries.length, 3);

  assert.equal(r.entries[0].title, '捜神後記十卷');
  assert.equal(r.entries[0].authorBib, '晉 陶潛');
  assert.equal(r.entries[0].series, '百子全書小說家異聞類');
  assert.equal(r.entries[0].institution, '阪大総');
  assert.equal(r.entries[0].recordPath, 'data/FA002848/taggedIshihama/0660003.dat');
  assert.ok(r.entries[0].url.endsWith('?record=' + r.entries[0].recordPath));

  // 第二条带 jpg 标记（有卷头画像）
  assert.equal(r.entries[1].hasImage, true);
  assert.equal(r.entries[1].institution, '東京都立 中央');

  // 第三条同一记录有两个题名锚（拉丁题名 + 汉文题名），须都收进来
  assert.equal(r.entries[2].title,
    'Al P.e Po. de Arrabal de la compa. de Jesus De la China Roma ; 從中國致羅馬耶穌會佩德羅德阿拉巴爾神父函不分卷');
  assert.equal(r.entries[2].institution, '京大人文研 東方');
});

test('parseResultPage：表单页 / 无记录页 均可判别', () => {
  const form = '<BODY><FORM ACTION="/kanseki"><INPUT NAME="ti"></FORM></BODY>';
  assert.equal(parseResultPage(form).isForm, true);
  assert.equal(parseResultPage(form).entries.length, 0);

  const none = '<BODY><CENTER>レコードがありません</CENTER></BODY>';
  const r = parseResultPage(none);
  assert.equal(r.total, 0);
  assert.equal(r.isForm, false);
  assert.equal(r.entries.length, 0);
});

// ---------------------------------------------------------------- 记录页
test('parseRecordPage：子目记录（丛书内一条）', () => {
  const rec = parseRecordPage(fx('record_child.html'), { path: 'data/FA001379/tagged/0225040.dat' });
  assert.deepEqual(rec.nu, ['0225040']);
  assert.deepEqual(rec.or, ['東北大']);
  assert.deepEqual(rec.oy, ['0223015']);
  assert.deepEqual(rec.co, ['小方壺齋輿地叢鈔第三帙第一册']);
  assert.deepEqual(rec.ti, ['乍ㄚ圖說一卷']);
  assert.deepEqual(rec.tiKey, ['乍ㄚ圖說']);
  assert.deepEqual(rec.au, ['淸姚瑩撰']);
  assert.deepEqual(rec.auKey, ['姚瑩']);
  // 罗马字必须落在拼音字段，绝不能混进 ti/au（回归点 1）
  assert.deepEqual(rec.pinyinTi, ['ZHA4 A1 TU2 SHUO1']);
  assert.deepEqual(rec.pinyinAu, ['YAO2 YING2']);
  assert.equal(rec.ti.join('').includes('ZHA4'), false);
  assert.equal(rec.au.join('').includes('YAO2'), false);
  // 母丛书（页首链接 + 出版项）
  assert.equal(rec.parentTitle, '小方壺齋輿地叢鈔');
  assert.match(rec.parentBib, /王錫祺/);
  assert.equal(rec.institutionDir, 'FA001379');
});

test('parseRecordPage：独立著录（四部分类 + 索书号）', () => {
  const rec = parseRecordPage(fx('record_standalone.html'), { path: 'data/FA001379/tagged/1500502.dat' });
  assert.deepEqual(rec.nu, ['1500502']);
  assert.deepEqual(rec.fi, ['子部']);
  assert.deepEqual(rec.sf, ['釋家類']);
  assert.deepEqual(rec.tg, ['經之屬']);
  assert.deepEqual(rec.ti, ['中阿含經六十卷']);
  assert.deepEqual(rec.tiKey, ['中阿含經']);
  assert.deepEqual(rec.auKey, ['瞿曇僧伽提婆']);
  // 可见分类行与索书号（&nbsp; 需还原为普通空格）
  assert.equal(rec.classificationVisible, '子部 釋家類 經之屬');
  assert.deepEqual(rec.si, ['本館 乙B・3－3・2']);
  assert.equal(rec.hasImage, false);
});

test('parseRecordPage：源数据无书名的记录须标注来源', () => {
  const rec = parseRecordPage(fx('record_notitle.html'), { path: 'data/FAKUNAICHO/tagged/0310073.dat' });
  assert.equal(rec.ti, undefined);
  assert.equal(rec.tiSource, '源记录无书名（仅有拼音）');
  assert.deepEqual(rec.pinyinTi, ['A1 PI2 DA2 MO2 JU4 SHE4 SHI4 LUN4']);
  assert.deepEqual(rec.co, ['日本校訂大藏經第二十四套']);
  assert.deepEqual(rec.or, ['宮内庁書陵部']);
});

test('parseRecordPage：丛书母记录的子目清单（册次分组）', () => {
  const html = `<BODY><FONT SIZE="-1"> 叢書 前代 </FONT><H2>五朝小說 </H2>
<BR><UL>
</UL>&nbsp;魏晉第一册<UL>
<A HREF="http://kanji.zinbun.kyoto-u.ac.jp/kanseki?record=data/FASEIKADO/tagged/0960026.dat&back=-8">穆天子傳一卷</A>
<FONT SIZE="-2">
</FONT>
<BR>
<A HREF="http://kanji.zinbun.kyoto-u.ac.jp/kanseki?record=data/FASEIKADO/tagged/0960027.dat&back=-8">西王母傳一卷</A>
<FONT SIZE="-2">
&#32;漢&#32;桓驎&#32;
</FONT>
<BR>
</UL>&nbsp;魏晉第二册<UL>
<A HREF="http://kanji.zinbun.kyoto-u.ac.jp/kanseki?record=data/FASEIKADO/tagged/0960039.dat&back=-8">搜神後記一卷</A>
<FONT SIZE="-2">
&#32;晉&#32;陶潛&#32;
</FONT>
<BR>
</UL>
<!--
<nu>0960025</nu>
<si>四九函&nbsp;一六架</si>
<fi>叢書</fi>
<sf>前代</sf>
<ti><key>五朝小說</key></ti>
<pinyin><ti><key>WU3 CHAO2 XIAO3 SHUO1</key></ti></pinyin>
<yr>明</yr>
<ed>刊</ed>
<vi>31</vi>
<no>有缺</no>
<ko>0960026</ko>
<ko>0960027</ko>
<ko>0960039</ko>
<or>静嘉堂文庫</or>
-->
</BODY>`;
  const rec = parseRecordPage(html, { path: 'data/FASEIKADO/tagged/0960025.dat' });
  assert.equal(rec.childrenList.length, 3);
  assert.deepEqual(rec.childrenList[0], {
    group: '魏晉第一册', title: '穆天子傳一卷', author: '', recordPath: 'data/FASEIKADO/tagged/0960026.dat',
  });
  assert.equal(rec.childrenList[1].author, '漢 桓驎');
  assert.equal(rec.childrenList[2].group, '魏晉第二册');
  assert.equal(rec.childrenList[2].author, '晉 陶潛');
  assert.deepEqual(rec.ko, ['0960026', '0960027', '0960039']);
  assert.deepEqual(rec.no, ['有缺']);
  assert.deepEqual(rec.vi, ['31']);
  // 拼音不得混入书名（回归点 1）
  assert.deepEqual(rec.ti, ['五朝小說']);
});

test('parseRecordPage：卷头画像链接', () => {
  const html = `<BODY><H2>中日對照日語寶典 </H2>
<CENTER><IMG SRC="http://kanji.zinbun.kyoto-u.ac.jp/kanseki?jpg=data/FATORITSU/jpg/taggedSaneto/015002.jpg"></CENTER>
<!--<nu>015002</nu><ti><key>中日對照日語寶典</key></ti><or>東京都立 中央</or>--></BODY>`;
  const rec = parseRecordPage(html, { path: 'data/FATORITSU/taggedSaneto/015002.dat' });
  assert.equal(rec.hasImage, true);
  assert.match(rec.imageUrl, /\?jpg=data\/FATORITSU\/jpg/);
});

test('parseRecordPage：记录不存在时给出 error 标记', () => {
  const rec = parseRecordPage('<BODY><CENTER>レコードがありません</CENTER></BODY>', { path: 'data/X/1.dat' });
  assert.equal(rec.error, 'no-record');
});

// ---------------------------------------------------------------- 展示辅助
test('recordToPairs：按字段表输出中文标签，跳过空值', () => {
  const rec = parseRecordPage(fx('record_child.html'), { path: 'data/FA001379/tagged/0225040.dat' });
  const pairs = recordToPairs(rec);
  const map = Object.fromEntries(pairs.map((p) => [p.label, p.value]));
  assert.equal(map['记录号'], '0225040');
  assert.equal(map['收藏机构'], '東北大');
  assert.equal(map['书名'], '乍ㄚ圖說一卷');
  assert.equal(map['书名标目'], '乍ㄚ圖說');
  assert.equal(map['丛书名(含册次)'], '小方壺齋輿地叢鈔第三帙第一册');
  assert.equal(map['书名拼音'], 'ZHA4 A1 TU2 SHUO1');
  assert.equal(map['刊年'], undefined); // 该记录无刊年，应被跳过
});
