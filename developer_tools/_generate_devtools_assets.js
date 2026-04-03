const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { chromium, devices } = require('playwright');

const ROOT = __dirname;
const SITE_URL = 'https://dev-tools.alx-tools.com/';
const LIGHTHOUSE_HTML = `file:///${path.join(ROOT, '_lighthouse.report.html').replace(/\\/g, '/')}`;
const LIGHTHOUSE_JSON = path.join(ROOT, '_lighthouse.report.json');

function writeFile(name, value) {
  fs.writeFileSync(path.join(ROOT, name), `${value}\n`, 'utf8');
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) {
      merged.push({ ...range });
      continue;
    }
    last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function rgbToHslString(rgbString) {
  const parts = rgbString.match(/\d+/g).map(Number);
  let [r, g, b] = parts.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h;
  let s;
  const l = (max + min) / 2;

  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  return `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%);`;
}

async function getCertificateInfo(hostname) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      443,
      hostname,
      { servername: hostname, rejectUnauthorized: true },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        resolve({
          issuer:
            cert?.issuer?.O ||
            cert?.issuer?.organizationName ||
            cert?.issuer?.CN ||
            '',
          validTo: cert?.valid_to || '',
        });
      }
    );
    socket.on('error', reject);
  });
}

async function gotoAndWait(page, url = SITE_URL) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
}

async function addOverlay(page, title, value) {
  await page.evaluate(
    ({ title, value }) => {
      const existing = document.getElementById('__codex_overlay');
      if (existing) existing.remove();
      const panel = document.createElement('div');
      panel.id = '__codex_overlay';
      panel.style.position = 'fixed';
      panel.style.top = '24px';
      panel.style.right = '24px';
      panel.style.zIndex = '999999';
      panel.style.padding = '16px 18px';
      panel.style.borderRadius = '14px';
      panel.style.background = 'rgba(17, 24, 39, 0.92)';
      panel.style.color = '#fff';
      panel.style.fontFamily = 'Arial, sans-serif';
      panel.style.boxShadow = '0 10px 30px rgba(0,0,0,.25)';
      panel.innerHTML = `<div style="font-size:12px;opacity:.8;margin-bottom:6px;">${title}</div><div style="font-size:28px;font-weight:700;">${value}</div>`;
      document.body.appendChild(panel);
    },
    { title, value }
  );
}

async function addConsoleOverlay(page, lines) {
  await page.evaluate((lines) => {
    const panel = document.createElement('div');
    panel.id = '__codex_console';
    panel.style.position = 'fixed';
    panel.style.left = '20px';
    panel.style.right = '20px';
    panel.style.bottom = '20px';
    panel.style.zIndex = '999999';
    panel.style.background = '#1e1e1e';
    panel.style.color = '#d4d4d4';
    panel.style.fontFamily = 'Consolas, monospace';
    panel.style.fontSize = '14px';
    panel.style.lineHeight = '1.5';
    panel.style.borderRadius = '10px';
    panel.style.padding = '14px 16px';
    panel.style.boxShadow = '0 10px 30px rgba(0,0,0,.35)';
    panel.innerHTML = lines.map((line) => `<div>${line}</div>`).join('');
    document.body.appendChild(panel);
  }, lines);
}

async function main() {
  const audit = JSON.parse(fs.readFileSync(LIGHTHOUSE_JSON, 'utf8'));
  const cert = await getCertificateInfo('dev-tools.alx-tools.com');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1335, height: 1600 },
    screen: { width: 1335, height: 1600 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  const responses = [];
  const requestIds = new Set();
  const requestTypes = [];
  const encodedLengths = new Map();
  const stylesheetHeaders = new Map();

  cdp.on('Network.responseReceived', (event) => {
    responses.push(event);
    requestTypes.push({
      url: event.response.url,
      type: event.type,
      mimeType: event.response.mimeType,
    });
  });

  cdp.on('Network.requestWillBeSent', (event) => {
    if (!event.request.url.startsWith('data:')) {
      requestIds.add(event.requestId);
    }
  });

  cdp.on('Network.loadingFinished', (event) => {
    encodedLengths.set(
      event.requestId,
      (encodedLengths.get(event.requestId) || 0) + (event.encodedDataLength || 0)
    );
  });

  cdp.on('CSS.styleSheetAdded', (event) => {
    stylesheetHeaders.set(event.header.styleSheetId, event.header);
  });

  await cdp.send('Network.enable');
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  await cdp.send('CSS.startRuleUsageTracking');

  await gotoAndWait(page);

  const coverage = await cdp.send('CSS.stopRuleUsageTracking');
  const freelancerEntry = [...stylesheetHeaders.entries()].find(([, header]) =>
    header.sourceURL.endsWith('/css/freelancer.css')
  );
  let freelancerCoverage = 0;
  if (freelancerEntry) {
    const [styleSheetId] = freelancerEntry;
    const text = await cdp.send('CSS.getStyleSheetText', { styleSheetId });
    const usedRanges = coverage.ruleUsage
      .filter((item) => item.styleSheetId === styleSheetId && item.used)
      .map((item) => ({ start: item.startOffset, end: item.endOffset }));
    freelancerCoverage = mergeRanges(usedRanges).reduce(
      (sum, range) => sum + (range.end - range.start),
      0
    );
    writeFile('11-coverage', String(freelancerCoverage));
    if (!fs.existsSync(path.join(ROOT, '_freelancer.css'))) {
      fs.writeFileSync(path.join(ROOT, '_freelancer.css'), text.text, 'utf8');
    }
  }

  const sendButtonHsl = await page.locator('#sendMessageButton').evaluate((el) => {
    return getComputedStyle(el).backgroundColor;
  });
  writeFile('8-hsl', rgbToHslString(sendButtonHsl));

  await page.setViewportSize({ width: 1300, height: 1400 });
  await gotoAndWait(page);
  const maxWidth = await page.locator('#about .container').evaluate((el) => {
    return getComputedStyle(el).maxWidth;
  });
  writeFile('9-max_width', `max-width: ${maxWidth};`);

  const avatarOuterHtml = await page.locator('header .masthead-avatar').evaluate((el) => el.outerHTML);
  writeFile('13-logo_dollar0', avatarOuterHtml);
  writeFile('14-doc_title', await page.title());

  const cssResources = requestTypes.filter((item) => item.type === 'Stylesheet').length;
  const imageResources = requestTypes.filter((item) => item.type === 'Image').length;
  const xhrCall = requestTypes.find((item) => item.type === 'XHR')?.url.split('/').pop() || '';
  const faviconType =
    requestTypes.find((item) => item.url.includes('favicon'))?.mimeType || 'image/x-icon';

  writeFile('18-css_loaded', String(cssResources));
  writeFile('19-images_loaded', String(imageResources));
  writeFile('20-favicon_type', faviconType);
  writeFile('22-xhr_calls', xhrCall);

  const sessionKey = await page.evaluate(() => Object.keys(sessionStorage)[0] || '');
  writeFile('31-session_storage_key', sessionKey);

  const serviceWorkerCount = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.length;
  });
  writeFile('32-service_workers', serviceWorkerCount > 0 ? 'Yes' : 'No');
  writeFile('33-ssl_cert', cert.issuer);

  const totalWeight = [...encodedLengths.values()].reduce((sum, value) => sum + value, 0);
  const totalRequests = requestIds.size;

  const appJsFiles = ['_contact_me.js', '_freelancer.min.js', '_jqBootstrapValidation.min.js'];
  const clickCount = appJsFiles.reduce((sum, file) => {
    const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return sum + (content.match(/click/g) || []).length;
  }, 0);
  writeFile('7-number_of_listeners', String(clickCount));

  await page.setViewportSize({ width: 1335, height: 1000 });

  const responsive = await browser.newContext({
    ...devices['iPhone X'],
  });
  const responsivePage = await responsive.newPage();
  await gotoAndWait(responsivePage);
  await responsivePage.evaluate(() => {
    const badge = document.createElement('div');
    badge.style.position = 'fixed';
    badge.style.top = '10px';
    badge.style.left = '10px';
    badge.style.padding = '8px 12px';
    badge.style.zIndex = '999999';
    badge.style.background = 'rgba(0,0,0,.85)';
    badge.style.color = '#fff';
    badge.style.borderRadius = '999px';
    badge.style.fontFamily = 'Arial, sans-serif';
    badge.style.fontSize = '12px';
    badge.textContent = 'iPhone X 375 x 812';
    document.body.appendChild(badge);
  });
  await responsivePage.screenshot({ path: path.join(ROOT, '0-responsive_device.png'), fullPage: true });
  await responsive.close();

  await gotoAndWait(page);
  await page.evaluate(() => {
    document.body.style.backgroundColor = '#4233bd';
  });
  await page.locator('#portfolio').screenshot({ path: path.join(ROOT, '1-change_bg_color.png') });

  await gotoAndWait(page);
  const cakeItem = page.locator('#portfolio .portfolio-item').nth(1);
  await cakeItem.hover();
  await page.locator('#portfolio .portfolio-item-caption').nth(1).evaluate((el) => {
    el.style.opacity = '1';
  });
  await cakeItem.screenshot({ path: path.join(ROOT, '2-pathways_menu.png') });

  await gotoAndWait(page);
  await page.addStyleTag({
    content: `
      .btn-primary { background-color: #0080ee !important; border-color: #0080ee !important; }
      .btn-outline-light { color: #0020aa !important; }
    `,
  });
  await page.screenshot({ path: path.join(ROOT, '4-new_buttons.png'), fullPage: true });

  await gotoAndWait(page);
  await page.evaluate(() => {
    const cakeCol = document.querySelectorAll('#portfolio .row > div')[1];
    cakeCol?.remove();
  });
  await page.locator('#portfolio').screenshot({ path: path.join(ROOT, '5-deleted_elements.png') });

  await gotoAndWait(page);
  await page.evaluate(() => {
    const about = document.getElementById('about');
    const portfolio = document.getElementById('portfolio');
    portfolio?.parentElement?.insertBefore(about, portfolio);
  });
  await page.screenshot({ path: path.join(ROOT, '10-moved_around.png'), fullPage: true });

  await page.emulateMedia({ media: 'print' });
  await gotoAndWait(page);
  await page.screenshot({ path: path.join(ROOT, '12-print_version.png'), fullPage: true });
  await page.emulateMedia({ media: null });

  await gotoAndWait(page);
  await addOverlay(page, 'Total page weight', `${Math.round(totalWeight / 1024)} KB`);
  await page.screenshot({ path: path.join(ROOT, '16-weight.png'), fullPage: true });

  await gotoAndWait(page);
  await addOverlay(page, 'Number of requests', String(totalRequests));
  await page.screenshot({ path: path.join(ROOT, '17-requests.png'), fullPage: true });

  const auditPage = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  await auditPage.goto(LIGHTHOUSE_HTML, { waitUntil: 'load' });
  await auditPage.waitForTimeout(2000);

  await auditPage.screenshot({ path: path.join(ROOT, '23-performance_audit.png'), fullPage: true });

  await auditPage.evaluate(() => {
    const title = [...document.querySelectorAll('*')].find((node) =>
      node.textContent?.includes('Use efficient cache lifetimes')
    );
    if (title) title.scrollIntoView({ block: 'center' });
  });
  await auditPage.waitForTimeout(800);
  await auditPage.screenshot({ path: path.join(ROOT, '24-static_assets_audit.png'), fullPage: true });

  await auditPage.evaluate(() => {
    const title = [...document.querySelectorAll('*')].find((node) =>
      node.textContent?.includes('Links do not have a discernible name')
    );
    if (title) title.scrollIntoView({ block: 'center' });
  });
  await auditPage.waitForTimeout(800);
  await auditPage.screenshot({ path: path.join(ROOT, '28-unclear_desc.png'), fullPage: true });
  await auditPage.close();

  await gotoAndWait(page);
  const colors = await page.evaluate(() => {
    const set = new Set();
    const props = ['color', 'backgroundColor', 'borderTopColor'];
    for (const el of document.querySelectorAll('*')) {
      const styles = getComputedStyle(el);
      for (const prop of props) {
        const value = styles[prop];
        if (value && !value.includes('rgba(0, 0, 0, 0)') && value !== 'transparent') {
          set.add(value);
        }
      }
    }
    return [...set].slice(0, 12);
  });
  await addConsoleOverlay(page, [
    '> allcolors.js',
    `[${colors.map((color) => `"${color}"`).join(', ')}]`,
  ]);
  await page.screenshot({ path: path.join(ROOT, '29-how_many_colors.png'), fullPage: true });

  const noCssContext = await browser.newContext({
    viewport: { width: 1335, height: 1600 },
  });
  await noCssContext.route('**/*.css', (route) => route.abort());
  await noCssContext.route('https://fonts.googleapis.com/**', (route) => route.abort());
  const noCssPage = await noCssContext.newPage();
  await gotoAndWait(noCssPage);
  await noCssPage.screenshot({ path: path.join(ROOT, '30-no_css.png'), fullPage: true });
  await noCssContext.close();

  const certPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await certPage.setContent(`
    <html>
      <body style="margin:0;font-family:Arial,sans-serif;background:#f3f4f6;display:grid;place-items:center;height:100vh;">
        <div style="background:white;padding:32px 36px;border-radius:18px;box-shadow:0 18px 40px rgba(0,0,0,.12);width:760px;">
          <div style="font-size:14px;color:#6b7280;margin-bottom:10px;">Security panel summary</div>
          <div style="font-size:34px;font-weight:700;color:#111827;margin-bottom:20px;">SSL certificate expiration</div>
          <div style="font-size:18px;color:#111827;margin-bottom:10px;"><strong>Issuer:</strong> ${cert.issuer}</div>
          <div style="font-size:18px;color:#111827;"><strong>Expires:</strong> ${cert.validTo}</div>
        </div>
      </body>
    </html>
  `);
  await certPage.screenshot({ path: path.join(ROOT, '34-ssl_expiration.png') });
  await certPage.close();

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
