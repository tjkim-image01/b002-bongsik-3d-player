// b002 v2 — 원작 댄서 관절(MediaPipe, 졸라맨)을 그대로 따라 움직이는 3D 봉식이(Mixamo 리그) 플레이어.
// 대역 인형(봉식이 체형으로 바꾼 졸라맨)이 아니라 원본 댄서의 관절 방향을 프레임마다 뼈에 옮긴다.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const $ = id => document.getElementById(id);
const M = await (await fetch('data/motion.json')).json();
const HB = await (await fetch('data/hands-beats.json', { cache: 'no-store' })).json();
// 모델: 기본 dance2(다리 늘림 + 손 모양별 손 바꿔 끼우기) · ?model=dance1(팔만 늘림, 만든 손) · ?model=v1(처음)
// 모델: 기본 remake(2026-10-31 지금 비율로 원화부터 새로 만든 봉식이 + 손 모양별 손 + 노래 입 모양)
// ?model=dance2(이전 모델을 늘리고 덧댄 것) · dance1 · v1(처음)
const MODEL_KEY = new URLSearchParams(location.search).get('model') ?? 'remake';
const MODEL = { v1: 'media/bongsik.glb', dance1: 'media/bongsik-dance.glb', dance2: 'media/bongsik-dance2.glb', remake: 'media/bongsik-remake.glb' }[MODEL_KEY] ?? 'media/bongsik-remake.glb';
const COLLIDE = await fetch({ dance1: 'media/bongsik-dance-collide.json', dance2: 'media/bongsik-dance2-collide.json' }[MODEL_KEY] ?? 'media/bongsik-remake-collide.json').then(r => r.ok ? r.json() : null).catch(() => null);
const VIS = await fetch('data/visemes.json').then(r => r.ok ? r.json() : null).catch(() => null);
const FPS = M.fps, N = M.frames, DUR = N / FPS;
const [CX, CY, CW, CH] = M.crop;
// 공개판(index에 노래·원작 영상이 없음)은 같은 모양의 시계로 돈다
function makeClock() {
  let base = 0, at = 0, rate = 1, paused = true;
  const now = () => performance.now() / 1000;
  return {
    get currentTime() { return paused ? base : Math.min(base + (now() - at) * rate, M.frames / M.fps); },
    set currentTime(v) { base = v; at = now(); },
    get paused() { return paused; },
    get playbackRate() { return rate; },
    set playbackRate(v) { base = this.currentTime; at = now(); rate = v; },
    play() { if (paused) { at = now(); paused = false; } return Promise.resolve(); },
    pause() { base = this.currentTime; paused = true; },
    onended: null,
  };
}
const audio = $('audio') ?? makeClock();
const video = $('video') ?? { currentTime: 0, playbackRate: 1, play: () => Promise.resolve(), pause() {} };

// ── 관절 표본 ─────────────────────────────────────────────
// MediaPipe 좌표는 화면 그대로(x 오른쪽)이고, 왼쪽 표식(11,13,15…)은 카메라를 본 댄서의 왼쪽 = 화면 오른쪽이다.
// 봉식이도 +z(카메라)를 보고 Left가 화면 오른쪽이므로 같은 이름끼리 잇는다 → 화면에 보이는 원본 모양 그대로.
const MP = {
  Left: { sh: 11, el: 13, wr: 15, pk: 17, ix: 19, hip: 23, kn: 25, an: 27, ft: 31, hl: 29, ear: 7, hand: 'L' },
  Right: { sh: 12, el: 14, wr: 16, pk: 18, ix: 20, hip: 24, kn: 26, an: 28, ft: 32, hl: 30, ear: 8, hand: 'R' },
};
const frameAt = t => { const f = THREE.MathUtils.clamp(t * FPS, 0, N - 1.001); const i = Math.floor(f); return [i, f - i]; };
function P3(t) {                 // MediaPipe 3D(엉덩이 중심, y 아래, z 카메라 쪽 음수) → three(y 위, 카메라 쪽 +z)
  const [i, a] = frameAt(t), A = M.world[i], B = M.world[i + 1];
  const out = [];
  for (let k = 0; k < 33; k++) {
    const x = A[3 * k] + (B[3 * k] - A[3 * k]) * a, y = A[3 * k + 1] + (B[3 * k + 1] - A[3 * k + 1]) * a, z = A[3 * k + 2] + (B[3 * k + 2] - A[3 * k + 2]) * a;
    out.push(new THREE.Vector3(x, -y, -z));
  }
  return out;
}
function P2(t) {
  const [i, a] = frameAt(t), A = M.lm[i], B = M.lm[i + 1];
  const out = [];
  for (let k = 0; k < 33; k++) out.push([A[2 * k] + (B[2 * k] - A[2 * k]) * a, A[2 * k + 1] + (B[2 * k + 1] - A[2 * k + 1]) * a]);
  return out;
}
const mid = (a, b) => a.clone().add(b).multiplyScalar(.5);

// ── 졸라맨 그리기 ───────────────────────────────────────────
const LIMBS = [[11, 13, 'a'], [13, 15, 'a'], [15, 19, 'a'], [12, 14, 'b'], [14, 16, 'b'], [16, 20, 'b'], [11, 12, 'c'], [11, 23, 'c'], [12, 24, 'c'], [23, 24, 'c'],
  [23, 25, 'a'], [25, 27, 'a'], [27, 31, 'a'], [24, 26, 'b'], [26, 28, 'b'], [28, 32, 'b']];
const COL = { a: '#28c2c9', b: '#ff5a4e', c: '#f2b632' };
function fitCanvas(cv) {
  const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1;
  if (cv.width !== Math.round(r.width * d) || cv.height !== Math.round(r.height * d)) { cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d); }
  const s = Math.min(cv.width / CW, cv.height / CH);
  return { s, ox: (cv.width - CW * s) / 2, oy: (cv.height - CH * s) / 2 };
}
function drawStick(cv, t, dark) {
  const g = cv.getContext('2d'), m = fitCanvas(cv), p = P2(t);
  const X = q => m.ox + (q[0] - CX) * m.s, Y = q => m.oy + (q[1] - CY) * m.s;
  g.clearRect(0, 0, cv.width, cv.height);
  if (dark) {
    g.fillStyle = '#1b1720'; g.fillRect(m.ox, m.oy, CW * m.s, CH * m.s);
    const fy = Math.max(p[31][1], p[32][1], p[29][1], p[30][1]);
    g.strokeStyle = '#3a3244'; g.lineWidth = 2 * devicePixelRatio; g.beginPath(); g.moveTo(m.ox, Y([0, fy]) + 6); g.lineTo(m.ox + CW * m.s, Y([0, fy]) + 6); g.stroke();
  }
  const w = (dark ? 7 : 4) * devicePixelRatio;
  g.lineCap = 'round';
  for (const [a, b, c] of LIMBS) {
    g.strokeStyle = COL[c]; g.lineWidth = w;
    g.beginPath(); g.moveTo(X(p[a]), Y(p[a])); g.lineTo(X(p[b]), Y(p[b])); g.stroke();
  }
  const sh = [(p[11][0] + p[12][0]) / 2, (p[11][1] + p[12][1]) / 2];
  const hd = [(p[7][0] + p[8][0]) / 2, (p[7][1] + p[8][1]) / 2];
  g.strokeStyle = COL.c; g.lineWidth = w; g.beginPath(); g.moveTo(X(sh), Y(sh)); g.lineTo(X(hd), Y(hd)); g.stroke();
  const r = Math.hypot(p[7][0] - p[8][0], p[7][1] - p[8][1]) * .75 * m.s + 4;
  g.fillStyle = dark ? '#f1ebe2' : 'rgba(241,235,226,.35)'; g.beginPath(); g.arc(X(hd), Y(hd), r, 0, 7); g.fill();
  g.fillStyle = '#17141c'; g.beginPath(); g.arc(X(p[0]), Y(p[0]), 3 * devicePixelRatio, 0, 7); g.fill();
}

// ── 3D 무대 ────────────────────────────────────────────────
const canvas = $('three');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color('#2a2232');
const camera = new THREE.PerspectiveCamera(30, 1, .05, 50);
function gradTex(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, inner); gr.addColorStop(1, outer); g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const floor = new THREE.Mesh(new THREE.CircleGeometry(3.2, 96), new THREE.MeshBasicMaterial({ map: gradTex('#5a4a66', '#2a2232') }));
floor.rotation.x = -Math.PI / 2; scene.add(floor);
for (const r of [0.9, 1.6, 2.3]) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(r - .006, r + .006, 128), new THREE.MeshBasicMaterial({ color: '#6e5c7c', transparent: true, opacity: .5 }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = .001; scene.add(ring);
}
const shadow = new THREE.Mesh(new THREE.CircleGeometry(.42, 48), new THREE.MeshBasicMaterial({ map: gradTex('rgba(0,0,0,0.55)', 'rgba(0,0,0,0)'), transparent: true, depthWrite: false }));
shadow.rotation.x = -Math.PI / 2; shadow.position.y = .003; shadow.scale.set(1, .6, 1); scene.add(shadow);

const gltf = await new GLTFLoader().loadAsync(MODEL);
const model = gltf.scene;
scene.add(model);
let skinned;
// 손 모양별 손 메시(Hand_Left_open …): 박자마다 하나만 보이게 바꿔 끼운다
const swapHands = { Left: {}, Right: {} };
model.traverse(o => {
  const m = /^Hand_(Left|Right)_(\w+)$/.exec(o.name);
  if (m) swapHands[m[1]][m[2]] = o;
  if (o.isSkinnedMesh) { o.frustumCulled = false; if (!m && (!skinned || o.geometry.attributes.position.count > skinned.geometry.attributes.position.count)) skinned = o; }
});
const HAS_SWAP = Object.keys(swapHands.Left).length > 0;
// ── 입 모양: 얼굴 텍스처(ChatGPT 입 그림을 원화 얼굴에 맞춰 붙인 것)를 노래 시간표(data/visemes.json, 30fps)대로 바꾼다.
// 노래용 입(open1~4: 소리 크기만큼 아래턱이 내려감, round1·o·round2: 둥근 입) — 쓰는 그림 목록은 VIS.shapes
const MOUTHS = {};
if (MODEL_KEY === 'remake' && VIS) {
  const tl = new THREE.TextureLoader();
  await Promise.all([...new Set([...(VIS.shapes ?? []), 'rest', 'm', 'teeth', 'open1', 'open2', 'open3', 'open4', 'round1', 'o', 'round2', 'u'])].map(async v => {   // 고치다 새 입이 나와도 바로 보이게 전부
    const t = await tl.loadAsync(`media/mouth/texture-${v}.jpg`).catch(() => null);   // 없는 그림은 rest로
    if (!t) return;
    t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    MOUTHS[v] = t;
  }));
  for (const t of Object.values(MOUTHS)) renderer.initTexture(t);
}
const bodyMat = skinned.material;
let shownMouth = null;
// 가사 자막(로컬 전용 data/lyrics.srt — 공개본에는 없어서 자막도 안 나온다)과 단어 시간(lyrics.json)으로 지금 부르는 단어를 강조
const SRT = await fetch('data/lyrics.srt').then(r => r.ok ? r.text() : '').catch(() => '');
const WORDS = await fetch('data/lyrics.json').then(r => r.ok ? r.json() : null).then(j => j?.words ?? []).catch(() => []);
const srtSec = s => { const [h, m, x] = s.trim().replace(',', '.').split(':'); return +h * 3600 + +m * 60 + +x; };
const LINES = SRT.split(/\n\s*\n/).map(b => b.trim().split('\n')).filter(b => b.length >= 3)
  .map(([, tc, ...txt]) => { const [a, b] = tc.split('-->').map(srtSec); return { a, b, words: WORDS.filter(w => w.t0 >= a - .01 && w.t1 <= b + .01) }; });
const lyricEl = document.getElementById('lyric');
// 노래만(입 교정) 모드: 춤 없이 서서 노래하고, 지금 음절의 입 모양 글자(data/syllables.srt, 한국어 립싱크 A~G)와 입 그림을 보여 준다
const parseSyl = text => text.split(/\n\s*\n/).map(b => b.trim().split('\n'))
  .filter(b => b.length >= 3).map(([n, tc, txt]) => { const [a, b] = tc.split('-->').map(srtSec); return { n: +n, a, b, txt }; });
let SYL = parseSyl(await fetch('data/syllables.srt').then(r => r.ok ? r.text() : '').catch(() => ''));
const sylEl = document.getElementById('syl');
const singBox = document.getElementById('singOnly');
singBox.checked = new URLSearchParams(location.search).get('sing') === '1';
const MOUTH_NAME = { rest: '쉼', m: 'A 다문 입', teeth: 'B 이 다문 입', open1: '살짝(open1)', open2: 'C 약간(open2)', open3: '벌림(open3)', open4: 'D 크게(open4)',
  round1: '둥근 작게(round1)', o: '둥근(o)', round2: '둥근 크게(round2)', u: '내민(u)' };
const CODE = { rest: '.', m: 'm', teeth: 't', open1: '1', open2: '2', open3: '3', open4: '4', round1: 'r', o: 'o', round2: 'R', u: 'u' };
let shownSyl = '';
function applySyl(t) {
  sylEl.hidden = !singBox.checked;
  if (!singBox.checked) { seEl.hidden = true; return; }
  const i = SYL.findIndex(s => t >= s.a - .07 && t < s.b);
  const nx = i >= 0 ? i + 1 : SYL.findIndex(s => s.a > t);               // 쉬는 곳이면 다음에 올 음절
  const pick = i >= 0 ? i : nx;
  if (pick >= 0 && pick !== selI && !seDirty) { selI = pick; showEdit(); }   // 재생·이동하는 곳의 음절을 따라간다(고치는 중엔 고정)
  seEl.hidden = selI < 0;
  const cur = SYL[i], k = Math.round(t * (VIS?.fps ?? 30)), tex = VIS?.frames[Math.max(0, k)] ?? 'rest';
  const fmt2 = s => s ? `${s.n}  ${s.a.toFixed(2)}–${s.b.toFixed(2)}  ${s.txt}` : '';
  // 입 번호 줄: 프레임마다 입 그림 한 글자(. 쉼, m 다문 입, t 이 다문 입, 1~4 벌림 단계, r·o·R 둥근 입, u 내민 입), 지금 프레임은 [ ]
  const code = f => CODE[VIS?.frames[f]] ?? ' ';
  let strip = '';
  for (let f = k - 30; f <= k + 30; f++) strip += f === k ? `<i>[${code(f)}]</i>` : (f < 0 ? ' ' : code(f));
  const html = `${cur ? `<b>#${cur.n} ${cur.txt.split('|')[0].trim()}</b>  ${cur.txt.split('|')[1] ?? ''}` : '<b>·</b>'}\n입 그림: ${MOUTH_NAME[tex] ?? tex}  (프레임 ${k})\n${strip}\n${fmt2(cur)}\n다음: ${fmt2(SYL[nx])}`;
  if (html !== shownSyl) { sylEl.innerHTML = html; shownSyl = html; }
}
let shownLyric = '';
function applyLyric(t) {
  const l = LINES.find(l => t >= l.a && t <= l.b + .3);
  const html = l ? l.words.map(w => t >= w.t0 && t < w.t1 ? `<b>${w.text}</b>` : w.text).join(' ') : '';
  if (html !== shownLyric) { lyricEl.innerHTML = html; shownLyric = html; }
}
// 턱 벌림(모프 JawOpen, b003/remake-v1/jaw_morph.py): 그림만 바뀌면 입이 스티커처럼 보여 입 단계만큼 실제 턱을 내린다.
// 프레임마다 목표값을 [¼ ½ ¼]로 부드럽게 하고 프레임 사이는 선형 보간(화면 주사율과 무관하게 같은 움직임).
// 노래할 때 입이 작다(2026-10-31 사용자) → 턱을 더 내린다. 1을 넘는 값은 모프를 더 늘린 것(1 = 1.6cm, 1.5 = 2.4cm)
// 이어서 벌린 높이 80%(사용자) → 모두 0.8배
// 가장 크게 벌린 입(open4·round2)만 10%씩 두 번 줄임(같은 날 사용자: 과하게 벌린다)
const JAW_OF = Object.fromEntries(Object.entries({ rest: 0, m: 0, teeth: .05, u: .3, open1: .4, round1: .4, open2: .75, o: 1, open3: 1.1, round2: 1.35 * .81, open4: 1.5 * .81 }).map(([k, v]) => [k, v * .8]));
const jawIdx = skinned.morphTargetDictionary?.JawOpen;
const buildJaw = () => VIS && jawIdx !== undefined ? VIS.frames.map((_, k, f) => {
  const g = i => JAW_OF[f[Math.min(f.length - 1, Math.max(0, i))]] ?? 0;
  return .25 * g(k - 1) + .5 * g(k) + .25 * g(k + 1);
}) : null;
let JAW = buildJaw();
function applyJaw(t) {
  if (!JAW) return;
  const x = Math.max(0, t * VIS.fps), k = Math.min(JAW.length - 2, Math.floor(x)), a = Math.min(1, x - k);
  skinned.morphTargetInfluences[jawIdx] = JAW[k] + (JAW[k + 1] - JAW[k]) * a;
}
// ── 음절 고치기(노래만 모드): 지금 음절의 첫소리·모음·받침 입 모양 글자와 시작·끝 시간을 바꿔 저장하면
// 서버가 data/syllables.srt를 쓰고 scripts/lyrics.py --keep 으로 입 시간표(visemes.json·mouth.srt)를 다시 만든다(2026-10-31 사용자: 쉽게 바꾸고 싶다)
const SE_OPTS = [['-', '없음'], ['A', 'A 다문 입(ㅁㅂㅍ)'], ['B', 'B 이 다문 입(ㅅㅈㅊ)'], ['c', 'c 중간 입'], ['C', 'C 약간(ㅏㅐㅔㅡㅣ)'], ['D', 'D 크게(ㅑ, 긴 ㅏ)'],
  ['E', 'E 좁게(ㅓㅕ)'], ['F', 'F 둥근(ㅗㅛ)'], ['G', 'G 내민(ㅜㅠ)'], ['F+C', 'F+C(ㅘ)'], ['G+C', 'G+C(ㅟ)'], ['G+E', 'G+E(ㅝ)'], ['N', 'N 쉼']];
let selI = -1, seDirty = false, listenUntil = 0;
const seEl = document.getElementById('sylEdit');
for (const id of ['seOn', 'seVw', 'seCo']) $(id).innerHTML = SE_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
const sylParts = s => { const [ch, ms = ''] = s.txt.split('|'); const tk = ms.trim().split(/\s+/); return { ch: ch.trim(), tk: tk.length === 3 ? tk : ['-', tk[0] || 'C', '-'] }; };
function showEdit() {
  seEl.hidden = !singBox.checked || selI < 0;
  const s = SYL[selI]; if (!s) return;
  const { ch, tk } = sylParts(s);
  $('seName').textContent = `#${s.n} ${ch}`; [$('seOn').value, $('seVw').value, $('seCo').value] = tk;
  $('seA').textContent = s.a.toFixed(3); $('seB').textContent = s.b.toFixed(3);
  $('seSave').classList.toggle('dirty', seDirty);
}
function editTok() {
  const s = SYL[selI]; if (!s) return;
  s.txt = `${sylParts(s).ch} | ${[$('seOn').value, $('seVw').value, $('seCo').value].join(' ')}`; seDirty = true; showEdit();
}
for (const id of ['seOn', 'seVw', 'seCo']) $(id).onchange = editTok;
for (const b of seEl.querySelectorAll('[data-se]')) b.onclick = () => {
  const s = SYL[selI]; if (!s) return;
  const [key, d] = b.dataset.se.split(','); s[key] = Math.round((s[key] + d / 30) * 1000) / 1000;
  if (key === 'a' && SYL[selI - 1] && SYL[selI - 1].b > s.a) SYL[selI - 1].b = s.a;      // 앞 음절 끝을 따라 줄인다
  if (key === 'b' && SYL[selI + 1] && SYL[selI + 1].a < s.b) SYL[selI + 1].a = s.b;
  seDirty = true; showEdit();
};
const goSyl = i => { selI = Math.max(0, Math.min(SYL.length - 1, i)); setPlaying(false); audio.currentTime = video.currentTime = SYL[selI].a; showEdit(); };
$('sePrev').onclick = () => goSyl(selI - 1);
$('seGo').onkeydown = e => { if (e.key === 'Enter' && +e.target.value) goSyl(SYL.findIndex(s => s.n === +e.target.value)); };   // 음절 번호로 이동
$('seNext').onclick = () => goSyl(selI + 1);
// 늘여 부르기 연음 나누기(2026-10-31 사용자: '당신'을 '다앙신'으로 부른다): 멈춘 위치(음절 밖이면 가운데)에서
// 앞 = 첫소리+모음(받침 뺌, 입: 첫소리·모음), 뒤 = ㅇ+같은 모음+받침(입: 모음·받침)으로 나눈다
$('seSplit').onclick = () => {
  const s = SYL[selI]; if (!s) return;
  const { ch, tk } = sylParts(s), c = ch.charCodeAt(0) - 0xAC00;
  if (c < 0 || c >= 11172) { $('seMsg').textContent = '한글 음절만 나눌 수 있음'; return; }
  const cho = Math.floor(c / 588), jung = Math.floor(c % 588 / 28), jong = c % 28;
  const t = audio.currentTime > s.a + .05 && audio.currentTime < s.b - .05 ? audio.currentTime : (s.a + s.b) / 2;
  const first = String.fromCharCode(0xAC00 + (cho * 21 + jung) * 28), second = String.fromCharCode(0xAC00 + (11 * 21 + jung) * 28 + jong);
  const vw = tk[1].split('+').pop();
  const b = { n: s.n + 1, a: Math.round(t * 1000) / 1000, b: s.b, txt: `${second} | - ${vw} ${tk[2]}` };
  s.b = b.a; s.txt = `${first} | ${tk[0]} ${tk[1]} -`;
  SYL.splice(selI + 1, 0, b); SYL.forEach((x, i) => x.n = i + 1);
  seDirty = true; showEdit(); $('seMsg').textContent = `${ch} → ${first} + ${second} (저장하면 적용)`;
};
$('seListen').onclick = () => { const s = SYL[selI]; if (!s) return; audio.currentTime = video.currentTime = Math.max(0, s.a - .3); listenUntil = s.b + .3; setPlaying(true); };
$('seSave').onclick = async () => {
  const ts = t => { const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  const srt = SYL.map((s, i) => `${i + 1}\n${ts(s.a)} --> ${ts(s.b)}\n${s.txt}\n`).join('\n');
  $('seMsg').textContent = '다시 계산 중…';
  const r = await fetch('api/syllables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ srt }) }).catch(() => null);
  if (!r || !r.ok) { $('seMsg').textContent = '저장 실패(로컬 서버에서만 됨)'; return; }
  Object.assign(VIS, await fetch('data/visemes.json', { cache: 'no-store' }).then(x => x.json()));
  JAW = buildJaw(); SYL = parseSyl(await fetch('data/syllables.srt', { cache: 'no-store' }).then(x => x.text()));
  shownMouth = null; shownSyl = ''; seDirty = false; $('seMsg').textContent = '적용됨'; showEdit();
};
function applyMouth(t) {
  applyJaw(t);
  if (!VIS || !MOUTHS.rest) return;
  const v = VIS.frames[Math.min(VIS.frames.length - 1, Math.max(0, Math.round(t * VIS.fps)))] ?? 'rest';
  if (v === shownMouth) return;
  shownMouth = v; bodyMat.map = MOUTHS[v] ?? MOUTHS.rest; bodyMat.needsUpdate = true;
}
// 머리 크기·목: 2/3(0.67)은 너무 작다 → ×1.5 = 1.0(2026-10-31). 목이 없어 보여 머리를 목 방향으로 NECK_UP만큼 올려
// 턱~깃 사이 목 살을 드러낸다(목·머리 경계 정점이 늘어나며 목이 생긴다). ?head=, ?neck= 로 바꿔 볼 수 있다.
const QS = new URLSearchParams(location.search);
let SHOULDER_K = +(QS.get('shoulder') ?? 0);           // 팔 들 때 쇄골이 따라 올라가는 비율. 0.4는 옆구리가 뾰족하게 끌려 기본은 끔(?shoulder=.4로 비교)
let HEAD_SCALE = +(QS.get('head') ?? (MODEL_KEY === 'dance2' ? .85 : 1));   // remake는 원화에서부터 비율을 맞춰 1   // 0.67·0.75·0.8·0.85·0.9·1.0 비교 후 0.85(2026-10-31, 사용자: 보기 좋게 맞춰 달라)
let NECK_UP = +(QS.get('neck') ?? 0);   // 목은 모델에 넣었다(b003 neck_fix.py: 턱 깎기 + 목 원기둥). 머리 뼈를 올리면 턱 살이 늘어나 이중턱이 됐다
for (const S of ['Left', 'Right']) for (const o of Object.values(swapHands[S])) o.traverse(x => { x.frustumCulled = false; });
const bone = {};
for (const b of skinned.skeleton.bones) bone[b.name.replace(/^mixamorig:?/, '')] = b;
const helper = new THREE.SkeletonHelper(model); helper.visible = false; scene.add(helper);
$('loading').remove();

model.updateMatrixWorld(true);
const wpos = (b, o = new THREE.Vector3()) => b.getWorldPosition(o);
const wquat = (b, o = new THREE.Quaternion()) => b.getWorldQuaternion(o);
const rest = {};
for (const [n, b] of Object.entries(bone)) rest[n] = { q: b.quaternion.clone(), p: b.position.clone(), wq: wquat(b) };
function basis(across, up) {
  const x = across.clone().normalize();
  const y = up.clone().addScaledVector(x, -up.dot(x)).normalize();
  return new THREE.Matrix4().makeBasis(x, y, new THREE.Vector3().crossVectors(x, y));
}
const delta = (Bt, Br) => new THREE.Quaternion().setFromRotationMatrix(Bt.clone().multiply(Br.clone().transpose()));
const restUp = wpos(bone.Neck).sub(wpos(bone.Hips));
const BrHip = basis(wpos(bone.LeftUpLeg).sub(wpos(bone.RightUpLeg)), restUp);
const BrChest = basis(wpos(bone.LeftArm).sub(wpos(bone.RightArm)), restUp);
const BrHead = basis(wpos(bone.LeftArm).sub(wpos(bone.RightArm)), wpos(bone.Head).sub(wpos(bone.Neck)));
const FEET = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase', 'LeftToe_End', 'RightToe_End'].filter(n => bone[n]);
const restMinY = Math.min(...FEET.map(n => wpos(bone[n]).y));
const restFootDir = {};
for (const S of ['Left', 'Right']) { const d = wpos(bone[`${S}ToeBase`]).sub(wpos(bone[`${S}Foot`])); d.y = 0; restFootDir[S] = d.normalize(); }
const restHips = wpos(bone.Hips);
const legB = wpos(bone.LeftUpLeg).distanceTo(wpos(bone.LeftLeg)) + wpos(bone.LeftLeg).distanceTo(wpos(bone.LeftFoot));

// 화면 이동량: 원본 화소 → 봉식이 미터 (다리 길이 비)
const hipX = [], legPx = [];
for (let i = 0; i < N; i++) {
  const L = M.lm[i];
  hipX.push((L[46] + L[48]) / 2);
  legPx.push(Math.hypot(L[46] - L[50], L[47] - L[51]) + Math.hypot(L[50] - L[54], L[51] - L[55]));
}
const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const hipX0 = med(hipX), mPerPx = legB / [...legPx].sort((x, y) => x - y)[Math.floor(N * .9)];

function setWorldQuat(b, qw) {
  const pq = wquat(b.parent).invert();
  b.quaternion.copy(pq.multiply(qw));
  b.updateMatrixWorld(true);
}
function aim(b, child, dir) {
  const cur = wpos(child).sub(wpos(b)).normalize();
  setWorldQuat(b, new THREE.Quaternion().setFromUnitVectors(cur, dir.clone().normalize()).multiply(wquat(b)));
}
function twist(b, child, curSide, tgtSide, amount = 1) {
  const ax = wpos(child).sub(wpos(b)).normalize();
  const c = curSide.clone().addScaledVector(ax, -curSide.dot(ax)), g = tgtSide.clone().addScaledVector(ax, -tgtSide.dot(ax));
  if (c.lengthSq() < 1e-8 || g.lengthSq() < 1e-8) return 0;
  const ang = Math.atan2(ax.dot(new THREE.Vector3().crossVectors(c, g)), c.dot(g));
  setWorldQuat(b, new THREE.Quaternion().setFromAxisAngle(ax, ang * amount).multiply(wquat(b)));
  return ang;
}

// ── 손 모양: 박자마다 하나(data/hands-beats.json, 아래 표에서 고침) → 손가락 마디 굽힘 ───────────────
// 각 손가락 [1·2·3마디 굽힘°]. b004(Flow)에서 또렷하게 읽히던 손 모양들을 사전으로 둔다.
const F_OPEN = [8, 12, 8], F_FLAT = [0, 0, 0], F_CURL = [80, 95, 70];
const SHAPES = {
  open: { Thumb: [0, 10, 10], Index: F_OPEN, Middle: F_OPEN, Ring: [10, 14, 10], Pinky: [12, 16, 10] },
  palm: { Thumb: [0, 0, 0], Index: F_FLAT, Middle: F_FLAT, Ring: F_FLAT, Pinky: F_FLAT },
  thumb: { Thumb: [0, 0, 0], Index: F_CURL, Middle: F_CURL, Ring: F_CURL, Pinky: F_CURL },
  gun: { Thumb: [0, 0, 0], Index: F_FLAT, Middle: F_CURL, Ring: F_CURL, Pinky: F_CURL },
  point: { Thumb: [0, 30, 40], Index: F_FLAT, Middle: F_CURL, Ring: F_CURL, Pinky: F_CURL },
  fist: { Thumb: [0, 30, 40], Index: F_CURL, Middle: F_CURL, Ring: F_CURL, Pinky: F_CURL },
};
const SHAPE_NAMES = { open: '편 손', palm: '손바닥', thumb: '엄지척', gun: '총', point: '가리키기', fist: '주먹' };
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const beatIndex = t => { let i = 0; while (i + 1 < HB.beats.length && HB.beats[i + 1].t <= t) i++; return i; };
const xAxis = new THREE.Vector3(1, 0, 0);
function shapeAt(side, t) {        // 박이 바뀌기 0.1초 전부터 다음 모양으로 넘어간다
  const i = beatIndex(t), B = HB.beats;
  const cur = SHAPES[B[i][side]] ?? SHAPES.open;
  const nx = B[i + 1] ? SHAPES[B[i + 1][side]] ?? SHAPES.open : cur;
  const k = B[i + 1] ? THREE.MathUtils.smoothstep(t, B[i + 1].t - .1, B[i + 1].t) : 0;
  const out = {};
  for (const f of FINGERS) out[f] = cur[f].map((v, j) => v + (nx[f][j] - v) * k);
  return out;
}
function applySwap(mixSide, t) {
  const B = HB.beats, i = beatIndex(t), side = MP[mixSide].hand;
  // 다음 박 바로 앞(0.06초)에 바꿔 끼워 박자에 손 모양이 맞게
  const k = B[i + 1] && t > B[i + 1].t - .06 ? i + 1 : i;
  const want = swapHands[mixSide][B[k][side]] ? B[k][side] : 'open';
  for (const [n, o] of Object.entries(swapHands[mixSide])) o.visible = n === want;
}
function applyFingers(mixSide, t) {
  if (HAS_SWAP) return applySwap(mixSide, t);
  const sh = shapeAt(MP[mixSide].hand, t);
  for (const f of FINGERS) for (let k = 1; k <= 3; k++) {
    const b = bone[`${mixSide}Hand${f}${k}`];
    if (b) b.quaternion.copy(rest[`${mixSide}Hand${f}${k}`].q).multiply(new THREE.Quaternion().setFromAxisAngle(xAxis, THREE.MathUtils.degToRad(sh[f][k - 1])));
  }
}

// ── 몸 충돌: 손·팔꿈치가 몸통 타원체·머리 구 안에 들어가면 표면 밖으로 밀고 팔을 두 마디 IK로 다시 편다 ─────
const shapes = [];
if (COLLIDE) {
  model.updateMatrixWorld(true);
  const t = COLLIDE.torso, h = COLLIDE.head;
  shapes.push({ bone: bone[t.bone], restInv: bone[t.bone].matrixWorld.clone().invert(), c: new THREE.Vector3(...t.center), r: new THREE.Vector3(...t.radii).multiplyScalar(1.06) });
  shapes.push({ bone: bone[h.bone], restInv: bone[h.bone].matrixWorld.clone().invert(), c: new THREE.Vector3(...h.center), r: new THREE.Vector3(1, 1, 1).multiplyScalar(h.radius * 1.05) });
}
function pushOut(p) {              // 세계 좌표 점 → 몸 밖으로 민 점(안 들어갔으면 그대로)
  let q = p.clone(), moved = false;
  for (const S of shapes) {
    const M = S.bone.matrixWorld.clone().multiply(S.restInv), Mi = M.clone().invert();
    const l = q.clone().applyMatrix4(Mi).sub(S.c);
    const n = Math.hypot(l.x / S.r.x, l.y / S.r.y, l.z / S.r.z);
    if (n < 1) { l.multiplyScalar(1 / Math.max(n, 1e-3)); q = l.add(S.c).applyMatrix4(M); moved = true; }
  }
  return moved ? q : null;
}
function solveArm(S, target, pole) {
  const sh = wpos(bone[`${S}Arm`]), el = wpos(bone[`${S}ForeArm`]), wr = wpos(bone[`${S}Hand`]);
  const a = sh.distanceTo(el), b = el.distanceTo(wr);
  const dv = target.clone().sub(sh), d = THREE.MathUtils.clamp(dv.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
  const u = dv.normalize();
  const pv = pole.clone().sub(sh); pv.addScaledVector(u, -pv.dot(u));
  if (pv.lengthSq() < 1e-8) pv.set(0, -1, 0);
  pv.normalize();
  const x = (a * a - b * b + d * d) / (2 * d), y = Math.sqrt(Math.max(a * a - x * x, 0));
  const e2 = sh.clone().addScaledVector(u, x).addScaledVector(pv, y), w2 = sh.clone().addScaledVector(u, d);
  aim(bone[`${S}Arm`], bone[`${S}ForeArm`], e2.clone().sub(sh));
  aim(bone[`${S}ForeArm`], bone[`${S}Hand`], w2.clone().sub(e2));
}

// ── 숙임: 원작은 허리를 90° 가까이 접고 머리를 턴다(11.9·22.9·26.4·31.3·39.2·51.7초 부근).
// 이때 MediaPipe는 머리카락에 가린 어깨·팔을 잘못 잡아 몸통이 뒤집히거나(최대 156°) 팔이 뒤로 뻗친다.
// 프레임마다 엉덩이가 보는 방향 기준 숙임각을 재서 튀는 값을 거르고(중앙값 9프레임, -20~95°),
// 숙임 정도(35~65° → 0~1)만큼 몸통은 엉덩이 방향 그대로 깨끗하게 접고 팔은 무릎 쪽으로 늘어뜨린다(b004처럼).
const UPY = new THREE.Vector3(0, 1, 0);
const bendDeg = new Float32Array(N), bendW = new Float32Array(N);
{
  const raw = [];
  for (let i = 0; i < N; i++) {
    const w = M.world[i], v = k => new THREE.Vector3(w[3 * k], -w[3 * k + 1], -w[3 * k + 2]);
    const across = v(MP.Left.hip).sub(v(MP.Right.hip)); across.y = 0;
    const f = new THREE.Vector3().crossVectors(across, UPY).normalize();
    const up = mid(v(MP.Left.sh), v(MP.Right.sh)).sub(mid(v(MP.Left.hip), v(MP.Right.hip)));
    raw.push(THREE.MathUtils.radToDeg(Math.atan2(up.dot(f), up.dot(UPY))));
  }
  for (let i = 0; i < N; i++) {
    const win = raw.slice(Math.max(0, i - 4), i + 5).sort((x, y) => x - y);
    bendDeg[i] = THREE.MathUtils.clamp(win[win.length >> 1], -20, 95);
    bendW[i] = THREE.MathUtils.smoothstep(bendDeg[i], 35, 65);
  }
}
function bendAt(t) { const [i, a] = frameAt(t); return [bendDeg[i] + (bendDeg[i + 1] - bendDeg[i]) * a, bendW[i] + (bendW[i + 1] - bendW[i]) * a]; }

function pose(t) {
  for (const [n, b] of Object.entries(bone)) { b.quaternion.copy(rest[n].q); b.position.copy(rest[n].p); }
  model.updateMatrixWorld(true);
  if (singBox.checked) {                             // 노래만: 차렷 자세로 입만 움직인다
    bone.Head.scale.setScalar(HEAD_SCALE); model.updateMatrixWorld(true);
    applyMouth(t); applyLyric(t); applySyl(t);
    model.updateMatrixWorld(true);
    return;
  }
  applySyl(t);
  const p = P3(t), L = MP.Left, R = MP.Right;
  const hipM = mid(p[L.hip], p[R.hip]), shM = mid(p[L.sh], p[R.sh]);
  const [bend, bw] = bendAt(t);
  const hipAcross = p[L.hip].clone().sub(p[R.hip]);
  let up = shM.clone().sub(hipM).normalize(), chestAcross = p[L.sh].clone().sub(p[R.sh]).normalize();
  if (bw > 0) {
    const fh = new THREE.Vector3().crossVectors(new THREE.Vector3(hipAcross.x, 0, hipAcross.z), UPY).normalize();
    const b = THREE.MathUtils.degToRad(bend);
    up.lerp(UPY.clone().multiplyScalar(Math.cos(b)).addScaledVector(fh, Math.sin(b)), bw).normalize();
    chestAcross.lerp(hipAcross.clone().normalize(), bw);
  }
  const hang = new THREE.Vector3(0, -1, 0);          // 숙일 때 팔이 늘어지는 방향(아래 + 무릎 쪽 조금)
  const qH = delta(basis(hipAcross, up), BrHip);
  const qC = delta(basis(chestAcross, up), BrChest);
  const W = n => rest[n].wq.clone();
  setWorldQuat(bone.Hips, qH.clone().multiply(W('Hips')));
  setWorldQuat(bone.Spine, qH.clone().slerp(qC, 1 / 3).multiply(W('Spine')));
  setWorldQuat(bone.Spine1, qH.clone().slerp(qC, 2 / 3).multiply(W('Spine1')));
  setWorldQuat(bone.Spine2, qC.clone().multiply(W('Spine2')));
  const earM = mid(p[L.ear], p[R.ear]);
  const qHd = delta(basis(p[L.ear].clone().sub(p[R.ear]), earM.clone().sub(shM)), BrHead);
  if (bw > 0) qHd.slerp(qC, bw);                    // 숙일 때 머리는 등줄기를 따라 아래로
  {                                                  // 머리를 털 때 귀 인식이 흔들려 고개가 크게 꺾이므로 몸통 기준 30° 안으로
    const rel = qC.clone().invert().multiply(qHd), ang = 2 * Math.acos(Math.min(1, Math.abs(rel.w))), MAX = THREE.MathUtils.degToRad(30);
    if (ang > MAX) qHd.copy(qC).multiply(new THREE.Quaternion().slerp(rel, MAX / ang));
  }
  setWorldQuat(bone.Neck, qC.clone().slerp(qHd, .5).multiply(W('Neck')));
  setWorldQuat(bone.Head, qHd.clone().multiply(W('Head')));
  bone.Head.scale.setScalar(HEAD_SCALE);
  if (NECK_UP) bone.Head.position.copy(rest.Head.p).add(rest.Head.p.clone().normalize().multiplyScalar(NECK_UP / bone.Neck.getWorldScale(new THREE.Vector3()).y));
  bone.Head.updateMatrixWorld(true);
  for (const S of ['Left', 'Right']) {
    const m = MP[S];
    const toKnee = p[m.kn].clone().sub(p[m.sh]).normalize();
    const hangS = hang.clone().multiplyScalar(.7).addScaledVector(toKnee, .3).normalize();
    const lim = (d, k = 1) => (bw > 0 ? d.normalize().lerp(hangS, bw * k).normalize() : d);
    const upDir = lim(p[m.el].clone().sub(p[m.sh]));
    // 팔을 어깨 위로 들면 쇄골(Shoulder)도 따라 올린다: 위팔이 몸통 아래 방향에서 70°를 넘으면 넘은 각의 40%(최대 28°).
    // 겨드랑이에 붙어 만들어진 재킷 옆판이 팔 하나에만 끌려 날개처럼 늘어나는 것을 어깨 전체로 나눈다(2026-10-31).
    if (bone[`${S}Shoulder`]) {
      const down = new THREE.Vector3(0, -1, 0).applyQuaternion(wquat(bone.Spine2)), d = upDir.clone().normalize();
      const elev = Math.acos(THREE.MathUtils.clamp(down.dot(d), -1, 1)), over = elev - THREE.MathUtils.degToRad(70);
      const ax = new THREE.Vector3().crossVectors(down, d);
      if (over > 0 && ax.lengthSq() > 1e-6)
        setWorldQuat(bone[`${S}Shoulder`], new THREE.Quaternion().setFromAxisAngle(ax.normalize(), Math.min(over * SHOULDER_K, THREE.MathUtils.degToRad(28))).multiply(wquat(bone[`${S}Shoulder`])));
    }
    aim(bone[`${S}Arm`], bone[`${S}ForeArm`], upDir);
    aim(bone[`${S}ForeArm`], bone[`${S}Hand`], lim(p[m.wr].clone().sub(p[m.el])));
    const handDir = lim(mid(p[m.ix], p[m.pk]).sub(p[m.wr])), tgt = p[m.ix].clone().sub(p[m.pk]);
    const orientHand = () => {
      aim(bone[`${S}Hand`], bone[`${S}HandMiddle1`] ?? bone[`${S}HandIndex1`], handDir);
      // 손바닥 방향: 검지-새끼 마디 선을 맞춘다. 절반은 아래팔이 비틀어 손목이 꼬이지 않게
      const side = () => wpos(bone[`${S}HandIndex1`]).sub(wpos(bone[`${S}HandPinky1`] ?? bone[`${S}HandIndex1`]));
      twist(bone[`${S}ForeArm`], bone[`${S}Hand`], side(), tgt, .5);
      twist(bone[`${S}Hand`], bone[`${S}HandMiddle1`] ?? bone[`${S}HandIndex1`], side(), tgt, 1);
    };
    orientHand();
    if (shapes.length) {
      // 손바닥 가운데·손목·팔꿈치가 몸에 묻히면 밖으로 민 자리로 팔을 다시 편다
      const palm = wpos(bone[`${S}HandMiddle1`] ?? bone[`${S}Hand`]), wr = wpos(bone[`${S}Hand`]);
      const pp = pushOut(palm), pw = pushOut(wr);
      let target = null;
      if (pp || pw) target = wr.clone().add(pp ? pp.sub(palm) : new THREE.Vector3()).add(pw && !pp ? pw.sub(wr) : new THREE.Vector3());
      const el = wpos(bone[`${S}ForeArm`]), pe = pushOut(el);
      if (target || pe) {
        const pole = pe ? pe.clone().addScaledVector(pe.clone().sub(el), 2) : el;
        solveArm(S, target ?? wr, pole);
        orientHand();
      }
    }
    aim(bone[`${S}UpLeg`], bone[`${S}Leg`], p[m.kn].clone().sub(p[m.hip]));
    aim(bone[`${S}Leg`], bone[`${S}Foot`], p[m.an].clone().sub(p[m.kn]));
    // 발: 원본 발끝 인식이 흔들려 발끝이 50~70°씩 아래로 꺾이면 신발이 앞뒤로 비틀려 늘어난다(사용자 지적).
    // 발바닥은 쉬는 자세처럼 바닥과 나란히 두고, 발이 향하는 좌우 방향(뒤꿈치→발끝을 바닥에 눕힌 방향)만 따른다.
    // 엉덩이가 보는 방향에서 ±45° 안으로 제한한다.
    {
      const fd = p[m.ft].clone().sub(p[m.hl]); fd.y = 0;
      const hipF = new THREE.Vector3().crossVectors(new THREE.Vector3(hipAcross.x, 0, hipAcross.z), UPY).normalize();
      if (fd.lengthSq() < 1e-6) fd.copy(hipF); else fd.normalize();
      const yawRel = Math.atan2(new THREE.Vector3().crossVectors(hipF, fd).y, hipF.dot(fd));
      const lim = THREE.MathUtils.clamp(yawRel, -Math.PI / 4, Math.PI / 4);
      const want = hipF.clone().applyAxisAngle(UPY, lim);
      const restDir = restFootDir[S];                      // 쉬는 자세 발 방향(바닥에 눕힌 것)
      const qYaw = new THREE.Quaternion().setFromUnitVectors(restDir, want);
      setWorldQuat(bone[`${S}Foot`], qYaw.multiply(rest[`${S}Foot`].wq.clone()));
    }
  }
  applyFingers('Left', t); applyFingers('Right', t);
  applyMouth(t); applyLyric(t);
  model.updateMatrixWorld(true);
  // 이동: 좌우는 원본 엉덩이 화면 이동, 높이는 가장 낮은 발을 바닥에 붙인다
  const [i, a] = frameAt(t);
  const dx = ((hipX[i] + (hipX[i + 1] - hipX[i]) * a) - hipX0) * mPerPx;
  const minY = Math.min(...FEET.map(n => wpos(bone[n]).y));
  const hw = wpos(bone.Hips);
  hw.x = restHips.x + dx; hw.y += restMinY - minY;
  bone.Hips.position.copy(bone.Hips.parent.worldToLocal(hw));
  model.updateMatrixWorld(true);
}

// ── 카메라 ────────────────────────────────────────────────
const R0 = MODEL_KEY === 'dance2' || MODEL_KEY === 'remake' ? 4.1 : 3.6;
const CAMS = { front: [0, .12, R0], three4: [.65, .2, R0], side: [Math.PI / 2, .1, R0] };
const cam = { az: 0, el: .12, r: R0 };
let follow = 0;
function placeCamera() {
  if (singBox.checked) {                             // 노래만: 얼굴 가까이(끌기·휠로 돌리고 당길 수 있다)
    const h = wpos(bone.Head), r = Math.min(cam.r, 4.1) * .36;
    const ty = h.y + .03;                            // 입이 위 정보 칸과 아래 편집 칸 사이 가운데에 오게
    camera.position.set(h.x + r * Math.sin(cam.az) * Math.cos(cam.el), ty + r * Math.sin(cam.el), h.z + r * Math.cos(cam.az) * Math.cos(cam.el));
    camera.lookAt(h.x, ty, h.z);
    return;
  }
  const tx = follow, ty = MODEL_KEY === 'dance2' || MODEL_KEY === 'remake' ? .92 : .78;   // 다리 늘린 몸은 키가 1.84m
  camera.position.set(tx + cam.r * Math.sin(cam.az) * Math.cos(cam.el), ty + cam.r * Math.sin(cam.el), cam.r * Math.cos(cam.az) * Math.cos(cam.el));
  camera.lookAt(tx, ty, 0);
}
for (const b of document.querySelectorAll('[data-cam]')) b.onclick = () => {
  [cam.az, cam.el, cam.r] = CAMS[b.dataset.cam];
  for (const x of document.querySelectorAll('[data-cam]')) x.setAttribute('aria-pressed', x === b);
};
let drag = null;
canvas.addEventListener('pointerdown', e => { drag = [e.clientX, e.clientY, cam.az, cam.el]; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', e => {
  if (!drag) return;
  cam.az = drag[2] - (e.clientX - drag[0]) * .008;
  cam.el = THREE.MathUtils.clamp(drag[3] + (e.clientY - drag[1]) * .006, -.2, 1.2);
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', e => { e.preventDefault(); cam.r = THREE.MathUtils.clamp(cam.r * (1 + e.deltaY * .001), 1.2, 9); }, { passive: false });

// ── 재생 ─────────────────────────────────────────────────
const fmt = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
function setPlaying(on) {
  if (on) { if (audio.currentTime >= DUR - .05) audio.currentTime = 0; audio.play(); video.play().catch(() => {}); }
  else { audio.pause(); video.pause(); }
  $('play').textContent = on ? '❚❚ 정지' : '▶ 재생';
}
$('play').onclick = () => setPlaying(audio.paused);
audio.onended = () => setPlaying(false);
$('seek').oninput = e => { audio.currentTime = +e.target.value; video.currentTime = +e.target.value; };
$('speed').onchange = e => { audio.playbackRate = video.playbackRate = +e.target.value; $('half').setAttribute('aria-pressed', +e.target.value === .5); };
// 발음 교정용 ½ 속도(사용자 요청): 누르면 0.5×, 다시 누르면 1×. ?speed=.5 로 시작할 수도 있다
const setSpeed = v => { $('speed').value = String(v); $('speed').onchange({ target: $('speed') }); };
$('half').onclick = () => setSpeed(audio.playbackRate === .5 ? 1 : .5);
if (new URLSearchParams(location.search).get('speed')) setSpeed(+new URLSearchParams(location.search).get('speed'));
$('showBones').onchange = e => { helper.visible = e.target.checked; };
addEventListener('keydown', e => { if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); setPlaying(audio.paused); } });
// 손 모양 표: 지금 박의 왼손·오른손을 고르면 그 박에 저장(서버 data/hands-beats.json)
const selL = $('handL'), selR = $('handR');
if (selL) for (const sel of [selL, selR]) for (const [k, v] of Object.entries(SHAPE_NAMES)) sel.add(new Option(v, k));
let shownBeat = -1;
function syncHandUI(t) {
  if (!selL) return;
  const i = beatIndex(t);
  if (i === shownBeat) return;
  shownBeat = i;
  $('beatNo').textContent = `${i + 1}박 / ${HB.beats.length}`;
  selL.value = HB.beats[i].L; selR.value = HB.beats[i].R;
}
async function saveHands() {
  HB.edited = true;
  const r = await fetch('api/hands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(HB) });
  $('saved').textContent = r.ok ? '저장됨' : '저장 실패';
  setTimeout(() => { $('saved').textContent = ''; }, 1500);
}
const setShape = (side, v) => { HB.beats[beatIndex(audio.currentTime)][side] = v; saveHands(); };
if (selL) {
selL.onchange = () => setShape('L', selL.value);
selR.onchange = () => setShape('R', selR.value);
$('beatPrev').onclick = () => { const i = Math.max(beatIndex(audio.currentTime) - 1, 0); audio.currentTime = video.currentTime = HB.beats[i].t + .01; };
$('beatNext').onclick = () => { const i = Math.min(beatIndex(audio.currentTime) + 1, HB.beats.length - 1); audio.currentTime = video.currentTime = HB.beats[i].t + .01; };
}

function resize() {
  const r = canvas.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

function frame() {
  const t = Math.min(audio.currentTime, DUR - 1e-3);
  if (listenUntil && t >= listenUntil) { listenUntil = 0; setPlaying(false); audio.currentTime = video.currentTime = SYL[selI]?.a ?? t; }
  if (!audio.paused && !$('audio') && audio.currentTime >= DUR - 1e-3) setPlaying(false);
  if (!audio.paused && Math.abs(video.currentTime - t) > .12) video.currentTime = t;
  if (audio.paused && Math.abs(video.currentTime - t) > .02) video.currentTime = t;
  pose(t);
  follow += (bone.Hips.getWorldPosition(new THREE.Vector3()).x - follow) * .08;
  shadow.position.x = wpos(bone.Hips).x; shadow.position.z = wpos(bone.Hips).z;
  placeCamera();
  renderer.render(scene, camera);
  drawStick($('stick'), t, true);
  const ov = $('overlay');
  if (ov) { if ($('showOverlay').checked) drawStick(ov, t, false); else ov.getContext('2d').clearRect(0, 0, ov.width, ov.height); }
  $('seek').value = t; $('clock').textContent = `${fmt(t)} / ${fmt(DUR)}`;
  syncHandUI(t);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__v2 = { setShoulder: k => { SHOULDER_K = k; }, setBody: (h, n) => { HEAD_SCALE = h; NECK_UP = n; }, bendAt, pose, renderer, scene, camera, bone, audio, cam, M, setT: t => { audio.currentTime = t; video.currentTime = t; } };
