// 先 Google、再通行金鑰（團員與幹部）：有通行金鑰的帳號綁 Google 回來看到確認卡（按一下用通行金鑰確認、取消）；
//   新手機新增通行金鑰被擋下時的說明與「Google 已確認」後按一下新增；協會強制兩步驟的幹部用 Google 登入後跳出的驗證面板（驗證、稍後、還沒有通行金鑰）
//   通行金鑰用 Chrome 的虛擬驗證器（CDP WebAuthn）；Google 登入用 /api/dev/google（e2e 伺服器沒有設定 Google，畫面上沒有 Google 按鈕）
//   幹部兩步驟驗證只在最後一個測試打開，結束時關掉並拿掉替理事長新增的通行金鑰（workers＝1，不會影響同時跑的其他測試）
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { acceptPrivacyIfAsked, BASE } from './helpers.mjs';

const axeBad = async (page) => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations
  .filter((v) => ['critical', 'serious'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
const noScrollX = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const toast = (page) => page.locator('#toasts .toast');
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const origin = () => { try { return test.info().project.use.baseURL || BASE; } catch { return BASE; } };
const devGoogle = (q) => `/api/dev/google?${new URLSearchParams(q)}`;
// 虛擬驗證器（像手機的 Face ID）：回傳 CDP 工作階段與驗證器 id
async function authenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  return { cdp, authenticatorId };
}
async function joinFresh(page, label) {
  await page.addInitScript(() => { try { localStorage.setItem('cil-start', JSON.stringify({ v: 1, dismissed: 1 })); } catch {} });
  const res = await page.request.post('/api/join', { headers: { origin: origin(), 'content-type': 'application/json' },
    data: JSON.stringify({ code: 'test-join', name: `${label}${stamp().slice(-4)}`, dist: 'fm', grp: 'D', consent: true }) });
  expect(res.ok(), `加入失敗 ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()).member.id;
}
const meOf = async (page) => (await (await page.request.get('/api/me')).json()).member;
// 在帳號與安全新增一把通行金鑰（新增後 App 會順便驗證一次）
async function addPasskey(page) {
  await page.goto('/#/me/security'); await acceptPrivacyIfAsked(page);
  await page.locator('#pkAdd').click();
  await expect(toast(page)).toContainText('已新增通行金鑰');
  await expect(page.locator('#pkList .r')).not.toHaveCount(0);
}
// 開發登入（同一個帳號開一個沒用通行金鑰驗證過的工作階段）
const devLogin = async (page, id) => { await page.goto(`/api/dev/login?id=${id}`); await page.waitForURL(/#\//); };

test('帳號與安全：有通行金鑰的帳號綁 Google，回來是確認卡；按一下用通行金鑰確認就綁上', async ({ page }) => {
  await authenticator(page);
  const id = await joinFresh(page, '確認卡');
  await addPasskey(page);
  await devLogin(page, id);
  await page.goto(devGoogle({ link: '1', sub: `e2e_gc_${stamp()}`, name: '確認卡' }));
  await page.waitForURL(/google=confirm/);
  const card = page.locator('#gConfirm');
  await expect(card.locator('h2')).toHaveText('最後一步：用通行金鑰確認綁定這個 Google 帳號');
  await expect(card.locator('h2')).toBeFocused();
  await expect(page.locator('#view .notice')).toHaveCount(0);   // 以前的「請先按驗證一次再重新綁定」不見了
  const go = card.getByRole('button', { name: '用通行金鑰確認' });
  expect((await go.boundingBox()).height).toBeGreaterThanOrEqual(44);
  expect(await axeBad(page)).toEqual([]);
  expect(await noScrollX(page)).toBe(true);
  expect((await meOf(page)).google).toBe(false);
  await go.click();
  await expect(page.locator('#gNote')).toHaveText('已綁定 Google，之後可以直接用 Google 登入。');
  await expect(page.locator('#gNote')).toBeFocused();
  await expect(page.locator('#gConfirm')).toHaveCount(0);
  expect(page.url()).not.toContain('google=confirm');
  expect((await meOf(page)).google).toBe(true);
});

test('推薦人頁：確認卡按「取消」就不綁，焦點回到我的推薦人', async ({ page }) => {
  await authenticator(page);
  const id = await joinFresh(page, '取消卡');
  await addPasskey(page);
  await devLogin(page, id);
  await page.goto(devGoogle({ link: '1', from: 'ref', sub: `e2e_gx_${stamp()}`, name: '取消卡' }));
  await page.waitForURL(/#\/me\/referral\?google=confirm/);
  await expect(page.locator('#gConfirm h2')).toBeFocused();
  expect(await axeBad(page)).toEqual([]);
  await page.locator('#gConfirm').getByRole('button', { name: '取消' }).click();
  await expect(toast(page)).toContainText('已取消綁定 Google');
  await expect(page.locator('#gConfirm')).toHaveCount(0);
  await expect(page.locator('#refMine')).toBeFocused();
  expect((await meOf(page)).google).toBe(false);
  const r = await page.request.post('/api/google/confirm-link', { headers: { origin: origin(), 'content-type': 'application/json' }, data: '{}' });
  expect(r.status()).not.toBe(200);
});

test('新手機：新增被擋下時說明能怎麼確認；用 Google 重新確認回來，按一下就新增', async ({ page }) => {
  const { cdp, authenticatorId } = await authenticator(page);
  const sub = `e2e_np_${stamp()}`;
  await page.addInitScript(() => { try { localStorage.setItem('cil-start', JSON.stringify({ v: 1, dismissed: 1 })); } catch {} });
  await page.goto(devGoogle({ sub, name: '換手機' }));
  await page.waitForURL(/#\/me/);
  await acceptPrivacyIfAsked(page);
  const id = (await meOf(page)).id;
  await addPasskey(page);
  // 換一台手機：舊的通行金鑰不在這台，工作階段也不是剛用 Google 登入的
  await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
  await devLogin(page, id);
  await page.goto('/#/me/security');
  await page.locator('#pkAdd').click();
  await expect(page.locator('#pkGateT')).toBeFocused();
  await expect(page.locator('#pkGate')).toContainText('新增另一把前，先確認是你本人');
  await expect(page.locator('#pkGate').getByRole('button', { name: '用現有的通行金鑰驗證' })).toBeVisible();
  expect(await axeBad(page)).toEqual([]);
  await page.goto(devGoogle({ link: '1', from: 'pk', sub }));
  await page.waitForURL(/google=pkok/);
  await expect(page.locator('#pkOk h2')).toBeFocused();
  await page.locator('#pkOk').getByRole('button', { name: '新增通行金鑰' }).click();
  await expect(toast(page)).toContainText('已新增通行金鑰');
  await expect(page.locator('#pkOk')).toHaveCount(0);
  const { passkeys } = await (await page.request.get('/api/passkeys')).json();
  expect(passkeys.length).toBe(2);
});

// 理事長的通行金鑰用軟體驗證器在測試程式這邊產生（開啟兩步驟驗證前理事長要先有一把），結束時移除
const te = new TextEncoder(), b64u = (b) => Buffer.from(b).toString('base64url'), unb64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const head = (mt, n) => (n < 24 ? [mt << 5 | n] : n < 256 ? [mt << 5 | 24, n] : [mt << 5 | 25, n >> 8, n & 255]);
function cbor(v) {
  if (typeof v === 'number') return new Uint8Array(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === 'string') { const b = te.encode(v); return cat(new Uint8Array(head(3, b.length)), b); }
  if (v instanceof Uint8Array) return cat(new Uint8Array(head(2, v.length)), v);
  return cat(new Uint8Array(head(5, v.size)), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
}
async function mfaCall(request, id, path, { method = 'GET', body } = {}) {
  const sc = (await request.get(`/api/dev/login?id=${id}&mfa=1`, { maxRedirects: 0 })).headers()['set-cookie'];
  const res = await request.fetch(`/api${path}`, { method, headers: { cookie: sc.split(';')[0], origin: origin(), 'content-type': 'application/json' }, data: body ? JSON.stringify(body) : undefined });
  return { status: res.status(), json: await res.json().catch(() => ({})) };
}
async function chairPasskey(request) {
  const sc = (await request.get('/api/dev/login?id=t_chair&mfa=1', { maxRedirects: 0 })).headers()['set-cookie'].split(';')[0];
  const post = async (path, body) => (await request.fetch(`/api${path}`, { method: 'POST', headers: { cookie: sc, origin: origin(), 'content-type': 'application/json' }, data: JSON.stringify(body) })).json();
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey), credId = crypto.getRandomValues(new Uint8Array(32));
  const o = await post('/passkey/options', { purpose: 'register' });
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, unb64u(jwk.x)], [-3, unb64u(jwk.y)]]);
  const rp = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(new URL(origin()).hostname)));
  const ad = cat(rp, new Uint8Array([0x45, 0, 0, 0, 1]), new Uint8Array(16), new Uint8Array([0, 32]), credId, cbor(cose));
  const cd = te.encode(JSON.stringify({ type: 'webauthn.create', challenge: o.publicKey.challenge, origin: origin() }));
  const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
  const v = await post('/passkey/verify', { cid: o.cid, credential: { id: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(cd), attestationObject: b64u(att) } } });
  expect(v.ok, JSON.stringify(v)).toBe(true);
  return b64u(credId);
}

test('協會強制兩步驟：幹部用 Google 登入後跳出驗證面板（按一下驗證、稍後留提示列）；還沒有通行金鑰的引導到帳號與安全', async ({ page, request }) => {
  await authenticator(page);
  await page.addInitScript(() => { try { localStorage.setItem('cil-start', JSON.stringify({ v: 1, dismissed: 1 })); } catch {} });
  const sub = `e2e_mf_${stamp()}`, bare = `e2e_mb_${stamp()}`;
  // 兩個新帳號，理事長把他們改成教練；其中一個先新增通行金鑰（還沒開兩步驟）
  const ids = [];
  for (const s of [sub, bare]) {
    await page.goto(devGoogle({ sub: s, name: '兩步驟幹部' })); await page.waitForURL(/#\/me/);
    ids.push((await meOf(page)).id);
  }
  for (const id of ids) expect((await mfaCall(request, 't_chair', `/members/${id}/role`, { method: 'POST', body: { role: 'coach' } })).status).toBe(200);
  await page.goto(devGoogle({ sub, name: '兩步驟幹部' })); await page.waitForURL(/#\//);
  await addPasskey(page);
  let chairKey = null;
  try {
    chairKey = await chairPasskey(request);
    expect((await mfaCall(request, 't_chair', '/settings/security', { method: 'POST', body: { require_mfa: true } })).status).toBe(200);
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(devGoogle({ sub, name: '兩步驟幹部' }));
    await page.waitForURL(/#\/(\?|$)/);
    const sheet = page.locator('.sheet[role="dialog"]');
    await expect(sheet.locator('#mfaT')).toHaveText('完成登入：用通行金鑰驗證');
    await expect(sheet).toContainText('協會要求幹部用通行金鑰再確認一次，驗證後才有管理權限。');
    const go = sheet.getByRole('button', { name: '用通行金鑰驗證' });
    await expect(go).toBeFocused();
    expect((await go.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(page.url()).not.toContain('mfa=');
    expect(await axeBad(page)).toEqual([]);
    // 稍後：面板關掉、首頁留著提示列；這個分頁不再自動跳出
    await sheet.getByRole('button', { name: '稍後' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.mfabar')).toBeVisible();
    await expect(page.locator('.mfabar [data-stepup]')).toBeFocused();
    await page.reload();
    await expect(page.locator('#view h1')).toHaveText('團練');
    await expect(page.locator('.sheet[role="dialog"]')).toHaveCount(0);
    // 再用 Google 登入一次：按「用通行金鑰驗證」
    await page.goto(devGoogle({ sub, name: '兩步驟幹部' }));
    await page.waitForURL(/#\/(\?|$)/);
    await page.locator('.sheet[role="dialog"]').getByRole('button', { name: '用通行金鑰驗證' }).click();
    await expect(toast(page)).toContainText('驗證完成，可以使用管理功能了');
    await expect(page.locator('.sheet[role="dialog"]')).toHaveCount(0);
    await expect(page.locator('.mfabar')).toHaveCount(0);
    expect((await meOf(page)).mfaPending).toBe(false);
    // 還沒有通行金鑰的幹部：引導到帳號與安全
    await page.goto(devGoogle({ sub: bare, name: '兩步驟幹部' }));
    await page.waitForURL(/#\/(\?|$)/);
    const s2 = page.locator('.sheet[role="dialog"]');
    await expect(s2.locator('#mfaT')).toHaveText('完成登入：先新增一把通行金鑰');
    await s2.getByRole('link', { name: '前往帳號與安全' }).click();
    await page.waitForURL(/#\/me\/security/);
    await expect(page.locator('#view h1')).toHaveText('帳號與安全');
  } finally {
    await mfaCall(request, 't_chair', '/settings/security', { method: 'POST', body: { require_mfa: false } });
    if (chairKey) await mfaCall(request, 't_chair', `/passkeys/${encodeURIComponent(chairKey)}`, { method: 'DELETE' });
  }
});
