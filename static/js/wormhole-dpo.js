(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var lot = null;

  /* fatal locks the tool and is only for a failed self-test. A bad input is a problem,
     not a reason to brick the page. */
  function fatal(msg) {
    var el = $('fatal'); el.textContent = msg; el.style.display = 'block';
    $('issue-btn').disabled = true; $('claim-btn').disabled = true;
  }
  function problem(msg) {
    var el = $('fatal'); el.textContent = msg; el.style.display = msg ? 'block' : 'none';
  }
  function csvCell(v) {
    v = String(v == null ? '' : v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function csv(rows) { return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\n') + '\n'; }
  function shq(s) { return '"' + String(s).replace(/(["\\$`])/g, '\\$1') + '"'; }
  function download(name, content, type) {
    var blob = new Blob([content], { type: type });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }
  function drawQR(hostId, metaId, text, label) {
    var host = $(hostId); host.innerHTML = '';
    try {
      var q = QR.encode(text, { ecl: 'M' });
      host.innerHTML = QR.toSVG(q, { scale: 4, label: label });
      $(metaId).textContent = text;
    } catch (e) {
      host.innerHTML = '<div class="st no">no symbol: ' + e.message + '</div>';
      $(metaId).textContent = '';
    }
  }
  function gate(rows, bodyId, tableId) {
    var body = $(bodyId); body.innerHTML = '';
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var cls = r.checked === false ? 'un' : (r.ok ? 'ok' : 'no');
      var st = r.checked === false ? 'not checked' : (r.ok ? 'pass' : 'FAIL');
      tr.innerHTML = '<td>' + r.name + '</td><td class="st ' + cls + '">' + st + '</td><td>' + r.detail + '</td>';
      body.appendChild(tr);
    });
    $(tableId).style.display = '';
  }

  function isRef(s) { return /^@[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(String(s).trim()); }

  function recordValue(v, serial, secretOtp, claim, owner) {
    var lines = ['Item=' + v.item];
    if (v.desc) lines.push('Description=' + v.desc);
    if (v.photo) lines.push('Photo=' + v.photo);
    lines.push('OTP=' + secretOtp);
    if (claim) lines.push('CLAIM=' + claim);
    lines.push('Owner=' + owner);
    if (v.sshreq) lines.push('SSHPOLICY=required');
    lines.push('Updated=1');
    return lines.join('\n');
  }

  /* The gateway form fields are name / days / address / value. otp is carried for the
     entitlement check; the gateway ignores unknown parameters. Minimum lease there is 100 days. */
  function claimLink(page, gw, name, days, value, secret) {
    var base = String(page || '').replace(/\?.*$/, '');
    return base + '?name=' + encodeURIComponent(name) +
      '&days=' + encodeURIComponent(Math.max(100, parseInt(days, 10) || 100)) +
      '&value=' + encodeURIComponent(value) +
      '&otp=' + encodeURIComponent(secret) +
      '&gw=' + encodeURIComponent(gw || 'https://nvs.ness.cx/');
  }

  function bookmark(gw, name, days, value, address, secret) {
    var base = String(gw || 'https://nvs.ness.cx/').replace(/\?.*$/, '');
    if (base.slice(-1) !== '/') base += '/';
    return base + '?name=' + encodeURIComponent(name) +
      '&days=' + encodeURIComponent(Math.max(100, parseInt(days, 10) || 100)) +
      '&address=' + encodeURIComponent(address || '') +
      '&value=' + encodeURIComponent(value) +
      '&otp=' + encodeURIComponent(secret);
  }

  /* value the buyer submits: same record, Owner rewritten, Updated incremented */
  function successorValue(value, newOwner, sshRef) {
    var seen = false, sawSsh = false;
    var out = value.split('\n').map(function (line) {
      if (/^Owner=/.test(line)) { seen = true; return 'Owner=' + newOwner; }
      if (/^SSH=/.test(line)) { sawSsh = true; return sshRef ? 'SSH=' + sshRef : line; }
      var u = line.match(/^Updated=(\d+)$/);
      if (u) return 'Updated=' + (parseInt(u[1], 10) + 1);
      return line;
    }).join('\n');
    if (!seen) out += '\nOwner=' + newOwner;
    if (sshRef && !sawSsh) out += '\nSSH=' + sshRef;
    return out;
  }

  async function issue() {
    var v = {
      vendor: $('vendor').value.trim(), item: $('item').value.trim(),
      desc: $('desc').value.trim(), photo: $('photo').value.trim(),
      prefix: $('prefix').value.trim(), salt: $('salt').value.trim(),
      owner: $('owner').value.trim(), days: $('days').value.trim(),
      base: $('baseurl').value.trim().replace(/\/+$/, ''),
      rail: $('rail').value, gateway: $('gateway').value.trim(),
      claimpage: $('claimpage').value.trim(), sshreq: $('sshreq').checked,
      addclaim: $('addclaim').checked
    };
    var first = parseInt($('first').value, 10), last = parseInt($('last').value, 10);
    if (!v.vendor || !v.salt) throw new Error('vendor and salt are both required');
    if (!(first <= last)) throw new Error('serial range is empty');
    if (last - first > 4999) throw new Error('refusing to generate more than 5000 items in one pass');

    var items = [];
    for (var n = first; n <= last; n++) {
      var serial = v.prefix + n;
      var secret = CORE.base32(CORE.randomBytes(10));           /* 80 bits */
      var otp = await CORE.sha256hex(CORE.md5hex(secret + v.salt));
      var claim = v.addclaim ? await CORE.sha256hex(secret) : '';
      var triple = await CORE.tripleFromString(secret);
      var name = 'dpo:' + v.vendor + ':' + serial + ':0';
      var value = recordValue(v, serial, otp, claim, v.owner);
      var bm = bookmark(v.gateway, name, v.days, successorValue(value, '', ''), '', secret);
      var cl = claimLink(v.claimpage, v.gateway, name, v.days, value, secret);
      items.push({
        serial: serial, secret: secret, otp: otp, claim: claim, triple: triple,
        name: name, value: value, bookmark: bm, claimlink: cl,
        pub: v.base + '/key/' + serial,
        priv: v.base + '/key/' + serial + '?otp=' + encodeURIComponent(secret),
        cmd: 'emc name_new ' + shq(name) + ' ' + shq(value) + ' ' + v.days
      });
    }
    lot = { v: v, items: items };

    var f = items[0];
    $('issue-meta').textContent = items.length + ' items · ' + items[0].serial + ' … ' +
      items[items.length - 1].serial + ' · secrets 80 bits each';
    $('issue-triple').textContent = f.triple;
    drawQR('qr1', 'meta1', f.pub, 'public DPO code');
    var sealed = v.rail === 'claim' ? f.claimlink : (v.rail === 'nvs' ? f.bookmark : f.priv);
    $('qr2role').textContent = v.rail === 'claim' ? 'one screen, one button'
      : v.rail === 'nvs' ? 'opens the gateway form' : 'claims the object';
    drawQR('qr2', 'meta2', sealed, 'sealed DPO code');
    $('rail-note').innerHTML = v.rail === 'claim'
      ? '<strong>What the buyer meets.</strong> QR 2 opens the claim page: the object\'s name, one ' +
        'sentence about whether it checks out, one button, then their key and their name. No serial ' +
        'numbers to copy, no form fields, no vocabulary from this page. Host ' +
        '<code>ness-claim.html</code> at the address above; it hands off to the gateway at the end. ' +
        'Same precondition as the raw rail: issue these items <em>through</em> the gateway with the ' +
        'address left blank, or the gateway cannot sign the handover.'
      : v.rail === 'nvs'
      ? '<strong>Precondition.</strong> Only the record\'s current owner can sign a <code>name_update</code>. ' +
        'For the gateway to hand an item over, issue it <em>through</em> nvs.ness.cx with the address field ' +
        'left blank, so the gateway wallet holds it until a buyer claims it. If you run these ' +
        '<code>name_new</code> commands from your own wallet instead, the bookmark cannot work.<br><br>' +
        '<strong>State of the rail.</strong> Checked against the live gateway on 2026-09-09: the page ignores ' +
        'query parameters — a GET with and without them returns byte-identical HTML — so the bookmark does not ' +
        'prefill yet. The four form fields are <code>name</code>, <code>days</code>, <code>address</code>, ' +
        '<code>value</code>; the URL below uses those exact names, plus <code>otp</code> for the entitlement ' +
        'check. Echoing them into the form values server-side is what makes the scan one-click.'
      : '<strong>Reference rail.</strong> QR 2 is the emcdpo private URL. The web app verifies the secret ' +
        'against <code>OTP=</code> using the vendor salt, which means the salt must live on that server.';
    $('rec-preview').value = 'name : ' + f.name + '\n\nvalue:\n' + f.value +
      '\n\nsecret (never on-chain): ' + f.secret + '\ntriple: ' + f.triple + '\n\n' + f.cmd;
    $('issue-out').style.display = '';
  }

  function lotFile(kind) {
    if (!lot) return '';
    var it = lot.items;
    if (kind === 'private') {
      return csv([['serial', 'nvs_name', 'secret', 'otp', 'claim', 'triple', 'value', 'command']].concat(
        it.map(function (r) { return [r.serial, r.name, r.secret, r.otp, r.claim, r.triple, r.value, r.cmd]; })));
    }
    if (kind === 'public') {
      return csv([['serial', 'nvs_name', 'otp', 'claim', 'public_url']].concat(
        it.map(function (r) { return [r.serial, r.name, r.otp, r.claim, r.pub]; })));
    }
    if (kind === 'print') {
      return csv([['serial', 'item', 'qr1_open', 'qr2_sealed', 'triple']].concat(
        it.map(function (r) {
          return [r.serial, lot.v.item, r.pub,
            lot.v.rail === 'claim' ? r.claimlink : lot.v.rail === 'nvs' ? r.bookmark : r.priv, r.triple];
        })));
    }
    if (kind === 'patch') {
      return [
        'Prefilling the NVS gateway form from a bookmark URL',
        '=================================================',
        '',
        'Observed on ' + new Date().toISOString().slice(0, 10) + ': a GET to ' + lot.v.gateway +
          ' with query parameters returns',
        'HTML identical to a GET without them, so the form does not prefill today and a scanned',
        'bookmark lands on an empty form.',
        '',
        'The form already uses these input names, so no field renaming is needed:',
        '',
        '  name     text      the NVS name',
        '  days     number    min 100',
        '  address  text      optional; the address the record is exported to',
        '  value    textarea  max 20480 characters',
        '',
        'What the bookmark adds:',
        '',
        '  otp      the claim secret, not a form field. Echo it into a hidden input and check it',
        '           server-side before performing the update.',
        '',
        'Change needed: echo each parameter into the corresponding value attribute, escaped.',
        'In PHP that is one expression per field, for example:',
        '',
        '  value="<?= htmlspecialchars($_GET[\'name\'] ?? \'\', ENT_QUOTES) ?>"',
        '',
        'and for the textarea, the parameter goes between the tags rather than in an attribute.',
        'Escape on output, never trust the value, and keep the 20480-character limit enforced',
        'server-side as well as in the browser.',
        '',
        'Entitlement check before the update:',
        '',
        '  1. name_show the requested name.',
        '  2. Read CLAIM= from its current value.',
        '  3. Accept only if sha256(otp parameter) equals CLAIM. This needs no vendor salt,',
        '     which is the reason CLAIM exists alongside the legacy OTP= line.',
        '  4. Only then perform name_update assigning the record to the submitted address.',
        '',
        'Precondition that no amount of code removes: the gateway wallet must be the current',
        'owner of the record. Items meant for this rail have to be issued through the gateway',
        'with the address field left blank.',
        ''
      ].join('\n');
    }
    return '# EmerDPO lot for ' + lot.v.vendor + '\n' +
      '# Review every line. name_new is irreversible and costs a fee per record.\n' +
      '# The vendor salt is NOT in this file and is not recoverable from it: ' +
      'store it before running anything.\n\n' +
      it.map(function (r) { return r.cmd; }).join('\n') + '\n';
  }

  async function claim() {
    var raw = $('claim-in').value.trim();
    var rows = [], secret = '', serial = $('c-serial').value.trim(), fromName = '';
    $('claim-out').style.display = 'none';
    $('claim-cmd').value = ''; $('claim-bookmark').value = '';

    var m = raw.match(/^(https?:\/\/[^?\s]*?)\/key\/([^/?\s]+)\?otp=([^&\s]+)/i);
    if (m) {
      serial = decodeURIComponent(m[2]); secret = decodeURIComponent(m[3]);
      rows.push({ checked: true, ok: true, name: 'Sealed code', detail: 'emcdpo private URL for ' + serial });
    } else if (/^https?:\/\//i.test(raw) && /[?&]otp=/.test(raw)) {
      var q = {};
      raw.slice(raw.indexOf('?') + 1).split('&').forEach(function (p) {
        var i = p.indexOf('=');
        if (i > 0) q[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1).replace(/\+/g, ' '));
      });
      secret = q.otp || '';
      fromName = q.name || '';
      var parts = fromName.split(':');
      if (parts.length >= 4 && parts[0] === 'dpo') {
        $('c-vendor').value = parts[1];
        serial = parts.slice(2, parts.length - 1).join(':');
        $('c-index').value = parts[parts.length - 1];
      }
      if (q.value && !$('c-value').value.trim()) $('c-value').value = q.value;
      if (q.days) $('days').value = q.days;
      rows.push({
        checked: true, ok: !!secret && !!fromName,
        name: 'Sealed code',
        detail: fromName ? 'gateway bookmark for ' + fromName : 'gateway URL without a name parameter'
      });
      if (!secret || !fromName) return gate(rows, 'c-body', 'c-gates');
    } else if (raw && raw.indexOf('://') === -1) {
      secret = raw;
      rows.push({ checked: true, ok: true, name: 'Sealed code', detail: 'bare secret, ' + secret.length + ' characters' });
    } else {
      rows.push({ checked: true, ok: false, name: 'Sealed code', detail: 'not a private URL, not a gateway bookmark, not a bare secret' });
      return gate(rows, 'c-body', 'c-gates');
    }
    $('c-serial').value = serial;

    var triple = await CORE.tripleFromString(secret);
    rows.push({ checked: true, ok: true, name: 'Triple', detail: triple + ' — compare with the label' });

    var value = $('c-value').value.trim();
    var salt = $('c-salt').value.trim();
    var onchainOtp = $('c-otp').value.trim().toLowerCase();
    var vLine = function (k) {
      var mm = value.match(new RegExp('^' + k + '=(.*)$', 'm'));
      return mm ? mm[1].trim().toLowerCase() : '';
    };
    if (!onchainOtp) onchainOtp = vLine('OTP');

    /* salt-free check first: anyone can run it */
    var claimLine = vLine('CLAIM');
    if (claimLine) {
      var mine = await CORE.sha256hex(secret);
      var okc = mine === claimLine;
      rows.push({
        checked: true, ok: okc, name: 'CLAIM (salt-free)',
        detail: okc ? 'sha256(secret) matches the record — no vendor salt needed'
                    : 'sha256(secret) is ' + mine + ', the record says ' + claimLine
      });
      if (!okc) return gate(rows, 'c-body', 'c-gates');
    } else {
      rows.push({
        checked: false, name: 'CLAIM (salt-free)',
        detail: 'the record carries no CLAIM= line, so this secret cannot be checked without the vendor salt'
      });
    }

    /* legacy OTP check, only possible with the salt */
    if (salt) {
      var otp = await CORE.sha256hex(CORE.md5hex(secret + salt));
      if (onchainOtp) {
        var oko = otp === onchainOtp;
        rows.push({
          checked: true, ok: oko, name: 'OTP against the record',
          detail: oko ? 'the secret belongs to this record'
                      : 'recomputed OTP does not match. Wrong salt, wrong item, or a forged label.'
        });
        if (!oko) return gate(rows, 'c-body', 'c-gates');
      } else {
        rows.push({ checked: false, name: 'OTP against the record', detail: 'recomputed as ' + otp + ', compared against nothing' });
      }
    } else {
      rows.push({ checked: false, name: 'OTP against the record', detail: 'no vendor salt given, so no OTP was computed' });
    }

    var addr = $('c-address').value.trim();
    var newOwner = $('c-newowner').value.trim();
    var sshRef = $('c-ssh').value.trim();
    var required = /^SSHPOLICY=required$/m.test(value);
    if (required || sshRef) {
      var okRef = isRef(sshRef);
      rows.push({
        checked: true, ok: okRef, name: 'EmerSSH identity',
        detail: okRef ? sshRef + ' will be written as the object\'s access list'
          : (sshRef ? '"' + sshRef + '" is not a reference. It has to look like @name.'
                    : 'this record demands one and none was given')
      });
      if (!okRef) { $('claim-out').style.display = ''; return gate(rows, 'c-body', 'c-gates'); }
      rows.push({
        checked: false, name: 'ssh:' + sshRef.slice(1) + ' exists',
        detail: 'only a node can answer that. Run: emc name_show "ssh:' + sshRef.slice(1) +
          '" — an empty or missing list locks the owner out of their own object.'
      });
    }
    var idx = parseInt($('c-index').value, 10); if (isNaN(idx)) idx = 0;
    var vendor = $('c-vendor').value.trim();
    var name = fromName || ('dpo:' + vendor + ':' + serial + ':' + idx);
    var custody = $('c-custody').value;
    var days = $('days').value.trim();

    rows.push({
      checked: custody !== 'unknown', ok: custody === 'yes', name: 'Gateway holds the record',
      detail: custody === 'yes' ? 'you confirmed name_show returns the gateway address'
        : custody === 'no' ? 'the vendor holds it, so the gateway cannot sign the update — ask them to transfer, or use the command below'
        : 'run name_show through your own node and read the address before paying for a slot'
    });

    $('claim-out').style.display = '';

    if (!value || !addr || !newOwner) {
      rows.push({
        checked: false, name: 'Claim built',
        detail: 'needs the current record value, your name for Owner=, and your address. This page will not guess a record value.'
      });
      return gate(rows, 'c-body', 'c-gates');
    }

    var newValue = successorValue(value, newOwner, sshRef);
    $('claim-bookmark').value = bookmark($('gateway').value, name, days, newValue, addr, secret);
    $('claim-cmd').value =
      '# Reassigns ' + name + ' to ' + addr + '.\n' +
      '# Irreversible. After this the vendor cannot take the record back.\n' +
      '# Verify the address character by character first. Lease days come from the Issue panel.\n\n' +
      'emc name_show ' + shq(name) + '\n\n' +
      'emc name_update ' + shq(name) + ' ' + shq(newValue) + ' ' + days + ' ' + shq(addr) + '\n\n' +
      '# The reference generator instead writes the next generation, dpo:<vendor>:<serial>:' + (idx + 1) + ',\n' +
      '# leaving :' + idx + ' as the record that now reads VERIFICATION: FAILED — sold, not broken.\n';
    rows.push({
      checked: true, ok: true, name: 'Claim built',
      detail: 'gateway bookmark and a direct name_update, both assigning the record to ' + addr
    });
    gate(rows, 'c-body', 'c-gates');
  }

  async function selfTest() {
    if (CORE.md5hex('abc') !== '900150983cd24fb0d6963f7d28e17f72') throw new Error('md5 vector');
    var otp = await CORE.sha256hex(CORE.md5hex('maifeB32' + 'johNah2koosie3iG'));
    if (otp.length !== 64) throw new Error('otp shape');
    var t = await CORE.tripleFromString('maifeB32');
    if (!/^\d{1,3}-[A-Za-z]+-[A-Za-z]+$/.test(t)) throw new Error('triple shape');
    var q = QR.encode('http://emcdpo.info/dpo/key/CK-1001?otp=ABCDEFGHJKMNPQRS', { ecl: 'M' });
    if (q.size !== q.version * 4 + 17) throw new Error('QR geometry');
    if (CORE.base32(CORE.randomBytes(10)).length !== 16) throw new Error('secret length');
    var bm = bookmark('https://nvs.ness.cx/', 'dpo:V:S:0', 10, 'Owner=\nUpdated=2', '', 'SEC');
    if (bm.indexOf('name=dpo%3AV%3AS%3A0') === -1 || bm.indexOf('days=100') === -1 ||
        bm.indexOf('otp=SEC') === -1) throw new Error('bookmark shape');
    if (successorValue('Owner=A\nUpdated=1', 'B', '') !== 'Owner=B\nUpdated=2') throw new Error('successor value');
    if (successorValue('Owner=A\nUpdated=1', 'B', '@ops').indexOf('SSH=@ops') === -1) throw new Error('ssh ref');
    if (isRef('ops') || !isRef('@ops')) throw new Error('reference shape');
  }

  $('salt').value = CORE.base32(CORE.randomBytes(15));
  $('regen-salt').addEventListener('click', function () { $('salt').value = CORE.base32(CORE.randomBytes(15)); });
  $('issue-btn').addEventListener('click', function () {
    problem(''); issue().catch(function (e) { problem(e.message); });
  });
  $('claim-btn').addEventListener('click', function () {
    problem(''); claim().catch(function (e) { problem(e.message); });
  });
  document.querySelectorAll('[data-dl]').forEach(function (b) {
    b.addEventListener('click', function () {
      var kind = b.getAttribute('data-dl');
      if (!lot) return;
      var fname = kind === 'commands' ? 'commands.txt'
        : kind === 'patch' ? 'gateway-prefill.txt' : kind + '.csv';
      download(fname, lotFile(kind), kind === 'commands' || kind === 'patch' ? 'text/plain' : 'text/csv');
    });
  });

  selfTest().catch(function (e) {
    fatal('Self-test failed (' + e.message + '). The tool is locked rather than issuing material it cannot prove correct.');
  });
})();
