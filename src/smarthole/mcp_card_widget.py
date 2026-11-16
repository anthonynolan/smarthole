"""MCP Apps widget for selectable Anki card proposals.

Mirrors the grimoire workout widget (``mcp_workout_widget.py`` there):
``propose_cards`` renders this checkbox list (with select-all) at its tool
call position, and the widget calls ``create_cards`` with only the ticked
boxes — so cards are never created in the background.
"""

from __future__ import annotations

WIDGET_URI = "ui://widget/card-proposal-v1.html"
WIDGET_MIME = "text/html;profile=mcp-app"

WIDGET_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Proposed cards</title>
<style>
  :root { color-scheme: light dark; font-family: var(--font-sans, -apple-system, system-ui, sans-serif); }
  body { margin: 0; padding: 12px 14px 16px; }
  h3 { margin: 4px 0 2px; font-size: 15px; }
  p.sub { margin: 0 0 10px; font-size: 12px; opacity: .75; }
  label.select-all { display: flex; gap: 8px; align-items: center; font-weight: 600; font-size: 13px;
    padding: 8px 10px; border: 1px solid rgba(127,127,127,.4); border-radius: 10px; margin-bottom: 8px; cursor: pointer; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  li.row { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px;
    border: 1px solid rgba(127,127,127,.35); border-radius: 10px; cursor: pointer; }
  li.row input { margin-top: 3px; width: 16px; height: 16px; flex-shrink: 0; }
  .front { font-size: 13.5px; font-weight: 600; }
  .back { font-size: 12px; opacity: .8; margin-top: 2px; white-space: pre-wrap; }
  button.add { margin-top: 10px; width: 100%; padding: 10px; font-size: 14px; font-weight: 700;
    border: 0; border-radius: 10px; background: #10a37f; color: #fff; cursor: pointer; }
  button.add:disabled { opacity: .5; cursor: default; }
  #status { margin-top: 8px; font-size: 12.5px; min-height: 18px; }
  #status.ok { color: #2f9e44; } #status.err { color: #e03131; }
</style>
</head>
<body>
<h3 id="title">Proposed cards</h3>
<p class="sub" id="subtitle">Tick cards, then add them to the deck.</p>
<label class="select-all"><input type="checkbox" id="selectAll" checked /> Select all</label>
<ul id="list"></ul>
<button class="add" id="addBtn">Add to deck</button>
<div id="status" role="status"></div>
<script>
(function () {
  var listEl = document.getElementById('list');
  var selectAllEl = document.getElementById('selectAll');
  var addBtn = document.getElementById('addBtn');
  var statusEl = document.getElementById('status');
  var titleEl = document.getElementById('title');
  var cards = [];
  var deckId = null;
  var requestId = 0;
  var pending = {};
  var bridgeReady = false;
  var hostCapabilities = {};

  function asObject(out) {
    if (typeof out === 'string') {
      try { return JSON.parse(out); } catch (e) { return null; }
    }
    return out;
  }
  function extractCards(out, depth) {
    out = asObject(out);
    if (!out || typeof out !== 'object' || depth > 2) return [];
    if (Array.isArray(out.cards) && out.cards.length) return out.cards;
    var wrappers = [out.structuredContent, out.result, out.data, out.proposal];
    for (var i = 0; i < wrappers.length; i++) {
      var found = extractCards(wrappers[i], depth + 1);
      if (found.length) return found;
    }
    if (Array.isArray(out.content)) {
      for (var j = 0; j < out.content.length; j++) {
        var part = out.content[j] || {};
        var text = typeof part === 'string' ? part : part.text;
        if (text) {
          var parsed = extractCards(text, depth + 1);
          if (parsed.length) return parsed;
        }
      }
    }
    return [];
  }
  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = kind || '';
  }
  function checked() {
    return Array.prototype.slice.call(listEl.querySelectorAll('input[type=checkbox]'))
      .filter(function (c) { return c.checked; })
      .map(function (c) { return cards[Number(c.dataset.index)]; });
  }
  function syncSelectAll() {
    var boxes = listEl.querySelectorAll('input[type=checkbox]');
    var all = boxes.length && Array.prototype.every.call(boxes, function (c) { return c.checked; });
    selectAllEl.checked = !!all;
    var n = checked().length;
    addBtn.textContent = n ? ('Add ' + n + ' to deck') : 'Add to deck';
    addBtn.disabled = !n;
  }
  selectAllEl.addEventListener('change', function () {
    Array.prototype.forEach.call(listEl.querySelectorAll('input[type=checkbox]'), function (c) {
      c.checked = selectAllEl.checked;
    });
    syncSelectAll();
  });

  function notifySize() {
    if (!bridgeReady) return;
    notify('ui/notifications/size-changed', {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight
    });
  }

  function render(output) {
    output = asObject(output) || {};
    if (output.deck_id) deckId = output.deck_id;
    if (output.deck_name) titleEl.textContent = 'Proposed cards for ' + output.deck_name;
    cards = extractCards(output, 0);
    listEl.innerHTML = '';
    selectAllEl.disabled = !cards.length;
    addBtn.disabled = !cards.length;
    if (!cards.length) {
      listEl.innerHTML = '<li class="row"><div class="back">Preparing card suggestions\\u2026</div></li>';
      notifySize();
      return;
    }
    cards.forEach(function (card, i) {
      var li = document.createElement('li');
      li.className = 'row';
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = true; cb.dataset.index = i;
      cb.addEventListener('change', syncSelectAll);
      li.appendChild(cb);
      var div = document.createElement('div');
      var front = document.createElement('div');
      front.className = 'front';
      front.textContent = card.front || ('Card ' + (i + 1));
      div.appendChild(front);
      if (card.back) {
        var back = document.createElement('div');
        back.className = 'back';
        back.textContent = card.back;
        div.appendChild(back);
      }
      li.appendChild(div);
      li.addEventListener('click', function (ev) {
        if (ev.target !== cb) { cb.checked = !cb.checked; syncSelectAll(); }
      });
      listEl.appendChild(li);
    });
    syncSelectAll();
    notifySize();
  }

  function post(message) { window.parent.postMessage(message, '*'); }
  function notify(method, params) {
    var message = { jsonrpc: '2.0', method: method };
    if (params) message.params = params;
    post(message);
  }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++requestId;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id != null && pending[message.id]) {
      var waiter = pending[message.id];
      delete pending[message.id];
      if (message.error) waiter.reject(new Error(message.error.message || 'Host request failed'));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') {
      var params = message.params || {};
      render(params.structuredContent || params.result || params);
    }
  }, { passive: true });

  window.addEventListener('openai:set_globals', function (event) {
    var globals = event.detail && event.detail.globals;
    if (globals && globals.toolOutput !== undefined) render(globals.toolOutput);
  }, { passive: true });

  render((window.openai && window.openai.toolOutput) || null);
  request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'smarthole-card-proposal', version: '1.0.0' },
    appCapabilities: { availableDisplayModes: ['inline'] }
  }).then(function (result) {
    hostCapabilities = (result && result.hostCapabilities) || {};
    bridgeReady = true;
    notify('ui/notifications/initialized');
    notifySize();
  }).catch(function () {
    bridgeReady = false;
  });

  addBtn.addEventListener('click', function () {
    var sel = checked();
    if (!sel.length || !deckId) return;
    addBtn.disabled = true;
    setStatus('Adding ' + sel.length + ' card(s)\\u2026');
    var args = { deck_id: deckId, cards: sel.map(function (c) { return { front: c.front, back: c.back }; }) };
    var call;
    if (bridgeReady && hostCapabilities.serverTools) {
      call = request('tools/call', { name: 'create_cards', arguments: args });
    } else if (window.openai && window.openai.callTool) {
      call = window.openai.callTool('create_cards', args);
    } else {
      call = Promise.reject(new Error('This host does not allow apps to call server tools'));
    }
    call
      .then(function (res) {
        var text = '';
        try {
          var data = (res && res.structuredContent) || {};
          if (!Object.keys(data).length) {
            var payload = res && res.content && res.content[0] ? res.content[0].text : '';
            data = JSON.parse(payload || '{}');
          }
          var n = data.count != null ? data.count : (data.created_card_ids || []).length;
          text = 'Added ' + n + ' card(s) to the deck.';
        } catch (e) { text = 'Added to deck.'; }
        setStatus(text, 'ok');
      })
      .catch(function (err) {
        setStatus('Could not add: ' + ((err && err.message) || err), 'err');
      })
      .finally(function () { addBtn.disabled = false; syncSelectAll(); });
  });
})();
</script>
</body>
</html>
"""


def get_card_widget_html() -> str:
    """Return the card proposal widget HTML (MCP Apps MIME type)."""
    return WIDGET_HTML
