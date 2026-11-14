const $ = (id) => document.getElementById(id);
const floatBtn = $('float');
const label = $('float-label');
const hint = $('hint');

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const ask = (msg) => chrome.runtime.sendMessage({ ...msg, tabId: tab && tab.id });

function showHint(text) {
  hint.textContent = text || '';
  hint.hidden = !text;
}

async function refresh() {
  const s = await ask({ type: 'popup:status' });
  if (!s) return;

  const chip = $('helper');
  chip.hidden = false;
  chip.textContent = s.helper ? 'Helper on' : 'Helper off';
  chip.classList.toggle('ok', s.helper);
  $('install').hidden = s.helper;
  $('all').checked = s.allSites;
  $('back-all').hidden = s.count === 0;

  if (s.floating) {
    floatBtn.disabled = false;
    label.textContent = 'Bring it back';
    showHint('');
  } else if (s.blocked) {
    floatBtn.disabled = true;
    label.textContent = 'Can’t run on this page';
    showHint('Browser pages and the Web Store don’t allow extensions.');
  } else if (s.canFloat) {
    floatBtn.disabled = false;
    label.textContent = 'Float this video';
    showHint(s.helper ? '' : 'Without the helper it floats as a normal window.');
  } else {
    floatBtn.disabled = true;
    label.textContent = 'No video on this page';
    showHint('Start the video, then press Alt+P or come back here.');
  }
  if (s.helper && s.hotkeys === false) showHint('Another app already uses one of the Ctrl+Alt shortcuts.');
}

floatBtn.addEventListener('click', async () => {
  floatBtn.disabled = true;
  label.textContent = 'Floating…';
  const res = await ask({ type: 'popup:float' });
  if (res && res.ok) {
    window.close();
    return;
  }
  label.textContent = 'Couldn’t float it';
  showHint(res && res.reason === 'novideo' ? 'No video big enough to float was found.' : (res && res.error) || 'Try reloading the page.');
  setTimeout(refresh, 1600);
});

$('all').addEventListener('change', async (e) => {
  const on = e.target.checked;
  const ok = on
    ? await chrome.permissions.request({ origins: ['<all_urls>'] })
    : await chrome.permissions.remove({ origins: ['<all_urls>'] });
  if (!ok) e.target.checked = !on;
  await ask({ type: 'popup:allSites' });
});

$('back-all').addEventListener('click', async () => {
  await ask({ type: 'popup:backAll' });
  refresh();
});

refresh();
